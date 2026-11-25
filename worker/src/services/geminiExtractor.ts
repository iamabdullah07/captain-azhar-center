import { GEMINI_MODEL_CONFIG, resolveModelOrder } from '../config/geminiModels';
import type { Env } from '../types';
import {
  normalizeExtractedDocument,
  type NormalizedExtractedDoc,
  type RawGeminiExtractedDoc,
} from './extractionNormalizer';
import {
  loadActiveGeminiKeyPool,
  pickRoundRobinKey,
  recordGeminiKeyCooldown,
  recordGeminiKeySuccess,
  type PooledGeminiKey,
  type TokenUsageCounts,
} from './geminiKeys';

export interface ExtractionAttemptOutcome {
  modelUsed: string;
  keyHashUsed: string;
  tokenUsage: TokenUsageCounts;
  durationMs: number;
  documents: NormalizedExtractedDoc[];
  attempts: Array<{ model: string; status: 'ok' | 'retry' | 'failed'; reason?: string }>;
}

export class GeminiExtractionError extends Error {
  statusCode: number;
  attempts: Array<{ model: string; status: 'ok' | 'retry' | 'failed'; reason?: string }>;
  constructor(
    message: string,
    statusCode = 502,
    attempts: Array<{ model: string; status: 'ok' | 'retry' | 'failed'; reason?: string }> = []
  ) {
    super(message);
    this.name = 'GeminiExtractionError';
    this.statusCode = statusCode;
    this.attempts = attempts;
  }
}

const EXTRACTION_RESPONSE_JSON_SCHEMA = {
  type: 'object',
  properties: {
    documents: {
      type: 'array',
      description:
        'List of extracted identity records. One object per person/document found in the file or PDF pages.',
      items: {
        type: 'object',
        properties: {
          page_number: {
            type: ['integer', 'null'],
            description: '1-based page number if multi-page PDF, otherwise null.',
          },
          name: {
            type: ['string', 'null'],
            description:
              'Full person name in UPPERCASE Latin letters. If both Arabic and English appear, take English only. Return null if unclear.',
          },
          passport_number: {
            type: ['string', 'null'],
            description: 'Passport number without spaces or dashes if visible, else null.',
          },
          iqama_number: {
            type: ['string', 'null'],
            description: 'Saudi Iqama / Resident ID number without spaces or dashes if visible, else null.',
          },
          national_id_number: {
            type: ['string', 'null'],
            description: 'National ID / CNIC / Aadhaar / Emirates ID number without spaces or dashes if visible, else null.',
          },
          visa_number: {
            type: ['string', 'null'],
            description: 'Visa number without spaces or dashes if visible, else null.',
          },
          nationality: {
            type: ['string', 'null'],
            description:
              'Nationality normalized as an UPPERCASE demonym (e.g., PAKISTANI, INDIAN, SAUDI, BANGLADESHI, FILIPINO, EGYPTIAN). Return null if uncertain.',
          },
          confidence: {
            type: ['number', 'null'],
            description: 'Extraction confidence between 0 and 1.',
          },
        },
        required: [
          'name',
          'passport_number',
          'iqama_number',
          'national_id_number',
          'visa_number',
          'nationality',
        ],
      },
    },
  },
  required: ['documents'],
} as const;

const EXTRACTION_PROMPT = [
  'You are an accurate travel and identity document OCR extractor.',
  'Inspect the entire uploaded image, PDF (every page), or document text and extract each identity document as one item in `documents`.',
  'If a multi-page PDF contains multiple people or identity documents across pages, return one separate object per person/document with its 1-based `page_number`.',
  'Strict rules:',
  '1. NAME: Return the full name in Latin (English) UPPERCASE letters. If both Arabic and English names appear, strictly use the English name. Never guess unreadable names — return null.',
  '2. ID NUMBERS: Extract every visible ID into its matching field (`passport_number`, `iqama_number`, `national_id_number`, `visa_number`) with all spaces and dashes removed. Never invent or guess digits — return null if unreadable.',
  '3. NATIONALITY: Return the nationality normalized as an UPPERCASE demonym (e.g., "PAKISTANI", "INDIAN", "SAUDI", "BANGLADESHI", "FILIPINO", "EGYPTIAN"). If the document says a country name like "Pakistan" or "India", normalize it to "PAKISTANI" / "INDIAN". Return null if uncertain.',
  '4. If a file has no readable identity details, return `{"documents": [{"name": null, "passport_number": null, "iqama_number": null, "national_id_number": null, "visa_number": null, "nationality": null}]}`.',
].join('\n');

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function encodeUint8ToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  const parts: string[] = [];
  for (let i = 0; i < bytes.byteLength; i += CHUNK) {
    const slice = bytes.subarray(i, Math.min(bytes.byteLength, i + CHUNK));
    parts.push(String.fromCharCode(...slice));
  }
  return btoa(parts.join(''));
}

function stripMarkdownFences(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('```')) {
    return trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  }
  return trimmed;
}

function parseGeminiDocumentsJson(rawText: string): RawGeminiExtractedDoc[] | null {
  const cleaned = stripMarkdownFences(rawText);
  if (!cleaned) return null;

  try {
    const parsed = JSON.parse(cleaned) as { documents?: unknown } | RawGeminiExtractedDoc[];
    if (Array.isArray(parsed)) {
      return parsed;
    }
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.documents)) {
      return parsed.documents as RawGeminiExtractedDoc[];
    }
    return null;
  } catch {
    return null;
  }
}

async function uploadToGeminiFilesApi(params: {
  apiKey: string;
  mimeType: string;
  displayName: string;
  sizeBytes: number;
  streamOrBytes: ReadableStream<Uint8Array> | Uint8Array;
  fetchImpl: typeof fetch;
}): Promise<{ fileName: string; fileUri: string }> {
  const { apiKey, mimeType, displayName, sizeBytes, streamOrBytes, fetchImpl } = params;
  const baseUrl = GEMINI_MODEL_CONFIG.apiBaseUrl;
  const apiVer = GEMINI_MODEL_CONFIG.apiVersion;

  const startRes = await fetchImpl(`${baseUrl}/upload/${apiVer}/files`, {
    method: 'POST',
    headers: {
      'x-goog-api-key': apiKey,
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(sizeBytes),
      'X-Goog-Upload-Header-Content-Type': mimeType,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ file: { displayName: displayName.slice(0, 120) } }),
    signal: AbortSignal.timeout(GEMINI_MODEL_CONFIG.requestTimeoutMs),
  });

  if (!startRes.ok) {
    const errText = await startRes.text().catch(() => '');
    const err = new Error(`Files API start failed (${startRes.status}): ${errText.slice(0, 180)}`);
    (err as Error & { status?: number }).status = startRes.status;
    throw err;
  }

  const uploadUrl = startRes.headers.get('x-goog-upload-url');
  if (!uploadUrl) {
    throw new Error('Files API did not return an upload URL.');
  }

  const bodyPayload =
    streamOrBytes instanceof Uint8Array
      ? (streamOrBytes.slice().buffer as ArrayBuffer)
      : streamOrBytes;

  const uploadRes = await fetchImpl(uploadUrl, {
    method: 'POST',
    headers: {
      'Content-Length': String(sizeBytes),
      'X-Goog-Upload-Offset': '0',
      'X-Goog-Upload-Command': 'upload, finalize',
    },
    body: bodyPayload,
    signal: AbortSignal.timeout(GEMINI_MODEL_CONFIG.filesUploadTimeoutMs),
  });

  if (!uploadRes.ok) {
    const errText = await uploadRes.text().catch(() => '');
    const err = new Error(`Files API upload failed (${uploadRes.status}): ${errText.slice(0, 180)}`);
    (err as Error & { status?: number }).status = uploadRes.status;
    throw err;
  }

  const meta = (await uploadRes.json()) as {
    file?: { name?: string; uri?: string; state?: string };
  };
  const fileName = meta.file?.name;
  const fileUri = meta.file?.uri;
  if (!fileName || !fileUri) {
    throw new Error('Files API upload response missing file metadata.');
  }

  let state = meta.file?.state ?? 'ACTIVE';
  for (let i = 0; i < GEMINI_MODEL_CONFIG.filesPollMaxAttempts && state === 'PROCESSING'; i++) {
    await sleep(GEMINI_MODEL_CONFIG.filesPollIntervalMs);
    const pollRes = await fetchImpl(`${baseUrl}/${apiVer}/${fileName}`, {
      method: 'GET',
      headers: { 'x-goog-api-key': apiKey },
      signal: AbortSignal.timeout(GEMINI_MODEL_CONFIG.requestTimeoutMs),
    });
    if (!pollRes.ok) break;
    const pollData = (await pollRes.json()) as { state?: string };
    state = pollData.state ?? state;
    if (state === 'FAILED') {
      throw new Error('Gemini Files API processing failed for this document.');
    }
  }

  if (state === 'PROCESSING') {
    throw new Error('Gemini Files API processing timed out.');
  }

  return { fileName, fileUri };
}

async function deleteGeminiUploadedFile(params: {
  apiKey: string;
  fileName: string;
  fetchImpl: typeof fetch;
}): Promise<void> {
  const { apiKey, fileName, fetchImpl } = params;
  await fetchImpl(`${GEMINI_MODEL_CONFIG.apiBaseUrl}/${GEMINI_MODEL_CONFIG.apiVersion}/${fileName}`, {
    method: 'DELETE',
    headers: { 'x-goog-api-key': apiKey },
    signal: AbortSignal.timeout(10_000),
  }).catch(() => {});
}

function classifyGeminiHttpFailure(status: number, bodyText: string): {
  isQuotaOrRate: boolean;
  isRetryable: boolean;
  message: string;
} {
  const lower = bodyText.toLowerCase();
  if (
    status === 429 ||
    lower.includes('resource_exhausted') ||
    lower.includes('quota') ||
    lower.includes('rate limit')
  ) {
    return { isQuotaOrRate: true, isRetryable: true, message: `Rate/quota limit (${status})` };
  }
  if (status === 401 || status === 403 || lower.includes('api_key_invalid')) {
    return { isQuotaOrRate: true, isRetryable: true, message: `API key rejected (${status})` };
  }
  if (status === 408 || status === 500 || status === 502 || status === 503 || status === 504) {
    return { isQuotaOrRate: false, isRetryable: true, message: `Model busy or unavailable (${status})` };
  }
  return { isQuotaOrRate: false, isRetryable: false, message: `Gemini request failed (${status})` };
}

/**
 * Runs a single structured-output Gemini extraction across the configured model priority
 * and API key pool with exponential backoff, cooldown rotation, and fallback support.
 */
export async function extractDocumentWithGemini(params: {
  env: Env;
  mimeType: string;
  displayName: string;
  sizeBytes: number;
  inlineThresholdBytes: number;
  loadBytes: () => Promise<Uint8Array>;
  openStream: () => Promise<ReadableStream<Uint8Array>>;
  requestedModel?: string | null;
  allowFallback?: boolean;
  excludeModels?: string[];
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
}): Promise<ExtractionAttemptOutcome> {
  const {
    env,
    mimeType,
    displayName,
    sizeBytes,
    inlineThresholdBytes,
    loadBytes,
    openStream,
    requestedModel,
    allowFallback = false,
    excludeModels = [],
    fetchImpl = fetch,
    sleepImpl = sleep,
  } = params;

  const modelResolution = resolveModelOrder({
    requestedModel,
    allowFallback,
    excludeModels,
  });
  if (!modelResolution.ok) {
    throw new GeminiExtractionError(modelResolution.error, 400);
  }

  const keyPool = await loadActiveGeminiKeyPool(env);
  if (keyPool.length === 0) {
    throw new GeminiExtractionError(
      'No Gemini API keys are configured. Add at least one API key in the Admin Dashboard.',
      503
    );
  }

  const startedAt = Date.now();
  const attempts: Array<{ model: string; status: 'ok' | 'retry' | 'failed'; reason?: string }> = [];
  const uploadedFilesByKeyHash = new Map<string, { apiKey: string; fileName: string; fileUri: string }>();
  let cachedInlineBase64: string | null = null;
  let cachedPlainText: string | null = null;

  const isPlainText = mimeType === 'text/plain';
  const useInline = !isPlainText && sizeBytes <= inlineThresholdBytes;

  try {
    if (isPlainText) {
      cachedPlainText = new TextDecoder('utf-8').decode(await loadBytes());
    } else if (useInline) {
      cachedInlineBase64 = encodeUint8ToBase64(await loadBytes());
    }

    let lastErrorMessage = 'Extraction failed across all attempted models.';
    let lastStatusCode = 502;

    for (const model of modelResolution.models) {
      const maxAttemptsForModel = 1 + GEMINI_MODEL_CONFIG.maxRetriesPerModel;
      const excludedKeyHashesForAttempt = new Set<string>();

      for (let attemptIdx = 0; attemptIdx < maxAttemptsForModel; attemptIdx++) {
        const picked = await pickRoundRobinKey({
          pool: keyPool,
          db: env.DB,
          excludedKeyHashes: excludedKeyHashesForAttempt,
        });

        let activeKey: PooledGeminiKey;
        if (!picked.ok) {
          if (picked.reason === 'all_cooldown') {
            lastErrorMessage = `All Gemini API keys are temporarily rate-limited. Try again in ${picked.retryAfterSeconds}s.`;
            lastStatusCode = 429;
            break;
          }
          throw new GeminiExtractionError('No Gemini API keys available.', 503, attempts);
        }
        activeKey = picked.key;

        try {
          let mediaPart: Record<string, unknown>;
          if (isPlainText) {
            mediaPart = { text: `DOCUMENT CONTENT (${displayName}):\n${cachedPlainText ?? ''}` };
          } else if (useInline) {
            mediaPart = {
              inlineData: {
                mimeType,
                data: cachedInlineBase64,
              },
            };
          } else {
            let uploaded = uploadedFilesByKeyHash.get(activeKey.keyHash);
            if (!uploaded) {
              const stream = await openStream();
              const res = await uploadToGeminiFilesApi({
                apiKey: activeKey.apiKey,
                mimeType,
                displayName,
                sizeBytes,
                streamOrBytes: stream,
                fetchImpl,
              });
              uploaded = { apiKey: activeKey.apiKey, ...res };
              uploadedFilesByKeyHash.set(activeKey.keyHash, uploaded);
            }
            mediaPart = {
              fileData: {
                mimeType,
                fileUri: uploaded.fileUri,
              },
            };
          }

          const url = `${GEMINI_MODEL_CONFIG.apiBaseUrl}/${GEMINI_MODEL_CONFIG.apiVersion}/models/${encodeURIComponent(
            model.id
          )}:generateContent`;

          const response = await fetchImpl(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-goog-api-key': activeKey.apiKey,
            },
            body: JSON.stringify({
              contents: [
                {
                  role: 'user',
                  parts: [{ text: EXTRACTION_PROMPT }, mediaPart],
                },
              ],
              generationConfig: {
                temperature: GEMINI_MODEL_CONFIG.temperature,
                responseMimeType: 'application/json',
                responseJsonSchema: EXTRACTION_RESPONSE_JSON_SCHEMA,
              },
            }),
            signal: AbortSignal.timeout(GEMINI_MODEL_CONFIG.requestTimeoutMs),
          });

          if (!response.ok) {
            const errText = await response.text().catch(() => '');
            const classified = classifyGeminiHttpFailure(response.status, errText);
            lastErrorMessage = classified.message;
            lastStatusCode = response.status === 429 ? 429 : 502;

            if (classified.isQuotaOrRate) {
              excludedKeyHashesForAttempt.add(activeKey.keyHash);
              await recordGeminiKeyCooldown({
                db: env.DB,
                key: activeKey,
                cooldownMs: GEMINI_MODEL_CONFIG.keyCooldownMs,
                errorMessage: classified.message,
              });
            }

            if (attemptIdx + 1 < maxAttemptsForModel && classified.isRetryable) {
              attempts.push({ model: model.id, status: 'retry', reason: classified.message });
              if (!classified.isQuotaOrRate) {
                const backoff = GEMINI_MODEL_CONFIG.baseBackoffMs * Math.pow(2, attemptIdx);
                await sleepImpl(backoff);
              }
              continue;
            }

            attempts.push({ model: model.id, status: 'failed', reason: classified.message });
            break;
          }

          const payload = (await response.json().catch(() => null)) as {
            candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
            usageMetadata?: {
              promptTokenCount?: number;
              candidatesTokenCount?: number;
              totalTokenCount?: number;
            };
          } | null;

          const textParts = (payload?.candidates?.[0]?.content?.parts ?? [])
            .map((p) => p.text ?? '')
            .join('');
          const parsedDocs = parseGeminiDocumentsJson(textParts);

          if (!parsedDocs) {
            lastErrorMessage = 'Model returned empty or invalid JSON response.';
            lastStatusCode = 502;
            if (attemptIdx + 1 < maxAttemptsForModel) {
              attempts.push({ model: model.id, status: 'retry', reason: lastErrorMessage });
              const backoff = GEMINI_MODEL_CONFIG.baseBackoffMs * Math.pow(2, attemptIdx);
              await sleepImpl(backoff);
              continue;
            }
            attempts.push({ model: model.id, status: 'failed', reason: lastErrorMessage });
            break;
          }

          const promptTokens = Math.max(0, Math.floor(payload?.usageMetadata?.promptTokenCount ?? 0));
          const outputTokens = Math.max(
            0,
            Math.floor(payload?.usageMetadata?.candidatesTokenCount ?? 0)
          );
          const totalTokens = Math.max(
            0,
            Math.floor(payload?.usageMetadata?.totalTokenCount ?? promptTokens + outputTokens)
          );
          const tokenUsage: TokenUsageCounts = {
            promptTokens,
            outputTokens,
            totalTokens,
          };

          await recordGeminiKeySuccess(env.DB, activeKey, Date.now(), tokenUsage);

          const normalizedDocs =
            parsedDocs.length > 0
              ? parsedDocs.map((d) => normalizeExtractedDocument(d))
              : [
                  normalizeExtractedDocument({
                    name: null,
                    passport_number: null,
                    iqama_number: null,
                    national_id_number: null,
                    visa_number: null,
                    nationality: null,
                  }),
                ];

          attempts.push({ model: model.id, status: 'ok' });
          return {
            modelUsed: model.id,
            keyHashUsed: activeKey.keyHash,
            tokenUsage,
            durationMs: Math.max(1, Date.now() - startedAt),
            documents: normalizedDocs,
            attempts,
          };
        } catch (err) {
          const statusProp = (err as Error & { status?: number })?.status;
          const msg = err instanceof Error ? err.message : 'Network/timeout error calling Gemini';
          const isRate = statusProp === 429 || msg.toLowerCase().includes('429');
          if (isRate) {
            excludedKeyHashesForAttempt.add(activeKey.keyHash);
            await recordGeminiKeyCooldown({
              db: env.DB,
              key: activeKey,
              cooldownMs: GEMINI_MODEL_CONFIG.keyCooldownMs,
              errorMessage: msg,
            });
          }

          lastErrorMessage = msg;
          lastStatusCode = isRate ? 429 : 504;

          if (attemptIdx + 1 < maxAttemptsForModel) {
            attempts.push({ model: model.id, status: 'retry', reason: msg.slice(0, 120) });
            const backoff = GEMINI_MODEL_CONFIG.baseBackoffMs * Math.pow(2, attemptIdx);
            await sleepImpl(backoff);
            continue;
          }

          attempts.push({ model: model.id, status: 'failed', reason: msg.slice(0, 120) });
          break;
        }
      }
    }

    throw new GeminiExtractionError(lastErrorMessage, lastStatusCode, attempts);
  } finally {
    // Clean up temporary Gemini Files API objects best-effort
    await Promise.all(
      Array.from(uploadedFilesByKeyHash.values()).map((u) =>
        deleteGeminiUploadedFile({ apiKey: u.apiKey, fileName: u.fileName, fetchImpl })
      )
    );
  }
}
