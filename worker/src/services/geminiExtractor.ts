import {
  GEMINI_MODEL_CONFIG,
  resolveModelOrder,
  type GeminiModelDefinition,
} from '../config/geminiModels';
import type { Env } from '../types';
import {
  normalizeExtractedDocument,
  type NormalizedExtractedDoc,
  type RawGeminiExtractedDoc,
} from './extractionNormalizer';
import {
  loadActiveGeminiKeyPool,
  loadModelCooldownMap,
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

export interface BatchExtractionItemInput {
  fileId: string;
  mimeType: string;
  displayName: string;
  sizeBytes: number;
  loadBytes: () => Promise<Uint8Array>;
}

export interface BatchExtractionOutcome {
  modelUsed: string;
  keyHashUsed: string;
  tokenUsage: TokenUsageCounts;
  durationMs: number;
  attempts: Array<{ model: string; status: 'ok' | 'retry' | 'failed'; reason?: string }>;
  items: Array<{ fileId: string; documents: NormalizedExtractedDoc[] }>;
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

const EXTRACTION_DOC_ITEM_SCHEMA = {
  type: 'object',
  properties: {
    page_number: {
      type: ['integer', 'null'],
      description: '1-based page number or table row index if multiple records exist, otherwise null.',
    },
    arabic_name: {
      type: ['string', 'null'],
      description:
        'Exact Arabic holder name next to الاسم / الإسم / الاسم الكامل / اسم المقيم / اسم العامل if Arabic appears (NEVER sponsor/employer الكفيل/صاحب العمل, profession المهنة, or headers), else null.',
    },
    name: {
      type: ['string', 'null'],
      description:
        'Holder full name in UPPERCASE Latin letters. If printed in English, copy the printed English holder name exactly. If only Arabic appears, transliterate arabic_name accurately into UPPERCASE Latin letters. Never return sponsor, profession, city, or card header text.',
    },
    passport_number: {
      type: ['string', 'null'],
      description: 'Passport number (رقم الجواز) in ASCII alphanumeric without spaces or dashes if visible, else null.',
    },
    iqama_number: {
      type: ['string', 'null'],
      description: 'Saudi Iqama / Resident ID number (رقم الإقامة / هوية مقيم, typically 10 digits starting with 2) in ASCII digits without spaces or dashes if visible, else null.',
    },
    national_id_number: {
      type: ['string', 'null'],
      description: 'National ID / Saudi National ID (رقم الهوية / السجل المدني, typically 10 digits starting with 1) / CNIC / Aadhaar / Emirates ID in ASCII digits without spaces or dashes if visible, else null.',
    },
    visa_number: {
      type: ['string', 'null'],
      description: 'Visa number (رقم التأشيرة) in ASCII alphanumeric without spaces or dashes if visible, else null.',
    },
    arabic_nationality: {
      type: ['string', 'null'],
      description:
        'Exact Arabic nationality/country word next to الجنسية / البلد if Arabic appears (NEVER place of issue مكان الإصدار, religion الديانة, or Saudi header المملكة العربية السعودية unless holder is Saudi), else null.',
    },
    nationality: {
      type: ['string', 'null'],
      description:
        'Holder nationality normalized as an UPPERCASE English demonym (e.g., PAKISTANI, INDIAN, SAUDI, SUDANESE, BANGLADESHI, FILIPINO, EGYPTIAN, YEMENI, NEPALI, SYRIAN, JORDANIAN). Translate arabic_nationality accurately; return null if uncertain.',
    },
    confidence: {
      type: ['number', 'null'],
      description: 'Extraction confidence between 0 and 1.',
    },
  },
  required: [
    'arabic_name',
    'name',
    'passport_number',
    'iqama_number',
    'national_id_number',
    'visa_number',
    'arabic_nationality',
    'nationality',
  ],
} as const;

const EXTRACTION_RESPONSE_JSON_SCHEMA = {
  type: 'object',
  properties: {
    documents: {
      type: 'array',
      description:
        'List of extracted identity records. One object per person/document found in the file, table, spreadsheet, or PDF pages.',
      items: EXTRACTION_DOC_ITEM_SCHEMA,
    },
  },
  required: ['documents'],
} as const;

const BATCH_EXTRACTION_RESPONSE_JSON_SCHEMA = {
  type: 'object',
  properties: {
    batch_items: {
      type: 'array',
      description:
        'One object per FILE_INDEX (0 to N-1), preserving each file index and containing only records from that file.',
      items: {
        type: 'object',
        properties: {
          file_index: {
            type: 'integer',
            description: '0-based FILE_INDEX matching the input marker.',
          },
          documents: {
            type: 'array',
            description: 'Extracted identity records belonging to this FILE_INDEX only.',
            items: EXTRACTION_DOC_ITEM_SCHEMA,
          },
        },
        required: ['file_index', 'documents'],
      },
    },
  },
  required: ['batch_items'],
} as const;

const SHARED_EXTRACTION_RULES = [
  '1. TABLES, SPREADSHEETS, PDFS & LISTS: If the input is a Word document, PDF, spreadsheet, CSV, or table containing multiple rows or people, extract EVERY person/row as a separate object (skip header/title/footer rows). In Arabic RTL tables and cards, labels sit to the right of or above their values. If a multi-page PDF contains multiple people or identity documents across pages, return one separate object per person/document with its 1-based `page_number`.',
  '2. HOLDER NAME (`arabic_name` & `name`): Extract ONLY the person/holder name (labeled `Name`, `Full Name`, `الاسم`, `الإسم`, `الاسم الكامل`, `اسم المقيم`, `اسم العامل`, `اسم الموظف`, `اسم المسافر`, `اسم حامل الجواز`). NEVER pick sponsor/employer (`الكفيل`, `صاحب العمل`, `المؤسسة`, `الشركة`, `Sponsor`, `Employer`), profession (`المهنة`), religion (`الديانة`), city/place of issue (`مكان الإصدار`, `مكان الميلاد`), or document titles (`المملكة العربية السعودية`, `وزارة الداخلية`, `هوية مقيم`, `الهوية الوطنية`). Copy any Arabic holder name into `arabic_name`. For `name`, if English is printed for the holder, strictly use that English name in UPPERCASE; if ONLY Arabic appears, transliterate the full Arabic holder name accurately into UPPERCASE Latin letters (e.g., `محمد علي خان` -> `MUHAMMAD ALI KHAN`, `عبد الله` -> `ABDULLAH`). Never leave `name` null when a readable Arabic name is present.',
  '3. ID NUMBERS: Extract every visible ID into its matching field (`passport_number`, `iqama_number`, `national_id_number`, `visa_number`) using Western ASCII digits `0-9` (convert any Eastern Arabic numerals `٠١٢٣٤٥٦٧٨٩` to `0-9`) with all spaces and dashes removed. Match labels accurately: `Passport` / `رقم الجواز` -> `passport_number`; `Iqama` / `رقم الإقامة` / `هوية مقيم` (10 digits starting with `2`) -> `iqama_number`; `National ID` / `CNIC` / `Emirates ID` / `رقم الهوية` / `السجل المدني` / `الهوية الوطنية` (Saudi IDs start with `1`) -> `national_id_number`; `Visa` / `رقم التأشيرة` -> `visa_number`. Do not confuse birth/expiry dates with ID numbers. Never invent digits — return null if unreadable.',
  '4. NATIONALITY (`arabic_nationality` & `nationality`): Look specifically at the `Nationality` / `الجنسية` / `جنسية` / `البلد` field. Copy any Arabic nationality/country word into `arabic_nationality`. Normalize `nationality` as an UPPERCASE English demonym (e.g., `PAKISTANI`, `INDIAN`, `SAUDI`, `SUDANESE`, `BANGLADESHI`, `FILIPINO`, `EGYPTIAN`, `YEMENI`, `NEPALI`, `SRI LANKAN`, `SYRIAN`, `JORDANIAN`, `ETHIOPIAN`, `INDONESIAN`). Translate Arabic nationalities accurately (e.g., `باكستاني`/`باكستان` -> `PAKISTANI`, `هندي`/`الهند` -> `INDIAN`, `سوداني`/`السودان` -> `SUDANESE`, `بنغلاديشي` -> `BANGLADESHI`, `مصري` -> `EGYPTIAN`, `يمني` -> `YEMENI`, `نيبالي` -> `NEPALI`, `فلبيني` -> `FILIPINO`). CRITICAL FOR SAUDI CARDS: `المملكة العربية السعودية` / `Kingdom of Saudi Arabia` at the top is the issuing country, NOT the holder nationality; never return `SAUDI` from the header, city (`الرياض`/`جدة`/`الدمام`), or religion (`مسلم`) unless `الجنسية` says `سعودي`/`السعودية` or the document is explicitly a Saudi National ID (`الهوية الوطنية` with `1xxxxxxxxx` ID and no foreign nationality).',
  '5. EMPTY / UNREADABLE: If a file has no readable identity details, return one empty record: `{"arabic_name": null, "name": null, "passport_number": null, "iqama_number": null, "national_id_number": null, "visa_number": null, "arabic_nationality": null, "nationality": null}`.',
];

const EXTRACTION_PROMPT = [
  'You are an accurate travel and identity document OCR extractor.',
  'Inspect the entire uploaded image, PDF (every page), Word/spreadsheet table, or document text and extract each identity record as one item in `documents`.',
  'Strict rules:',
  ...SHARED_EXTRACTION_RULES,
].join('\n');

const BATCH_EXTRACTION_PROMPT = [
  'You are an accurate travel and identity document OCR extractor.',
  'You will receive multiple independent files labeled `FILE_INDEX 0`, `FILE_INDEX 1`, etc.',
  'Return `batch_items` containing one object for EVERY `FILE_INDEX` from `0` to `N-1`. Extract all identity records found inside that specific file into its `documents` array. Never mix people or IDs across different files.',
  'Strict rules:',
  ...SHARED_EXTRACTION_RULES,
].join('\n');

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function decodeTextBytesSmart(bytes: Uint8Array): string {
  if (bytes.byteLength >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(bytes);
  }
  if (bytes.byteLength >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(bytes);
  }
  if (bytes.byteLength >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(bytes);
  }

  // Detect BOM-less UTF-16LE (common in Windows/Excel Arabic text exports)
  if (bytes.byteLength >= 4 && bytes.byteLength % 2 === 0) {
    const samplePairs = Math.min(80, Math.floor(bytes.byteLength / 2));
    let utf16LikePairs = 0;
    for (let i = 0; i < samplePairs * 2; i += 2) {
      if ((bytes[i + 1] === 0x00 || bytes[i + 1] === 0x06) && bytes[i] !== 0x00) {
        utf16LikePairs += 1;
      }
    }
    if (utf16LikePairs >= samplePairs * 0.45) {
      try {
        return new TextDecoder('utf-16le').decode(bytes);
      } catch {
        // Fall through
      }
    }
  }

  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    try {
      return new TextDecoder('windows-1256').decode(bytes);
    } catch {
      return new TextDecoder('utf-8').decode(bytes);
    }
  }
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

function parseGeminiBatchJson(
  rawText: string,
  expectedCount: number
): Map<number, RawGeminiExtractedDoc[]> | null {
  const cleaned = stripMarkdownFences(rawText);
  if (!cleaned) return null;

  try {
    const parsed = JSON.parse(cleaned) as {
      batch_items?: Array<{ file_index?: unknown; documents?: unknown }>;
    };
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.batch_items)) {
      return null;
    }

    const byIndex = new Map<number, RawGeminiExtractedDoc[]>();
    for (const item of parsed.batch_items) {
      if (!item || typeof item !== 'object') continue;
      const idx = typeof item.file_index === 'number' ? Math.trunc(item.file_index) : -1;
      if (idx < 0 || idx >= expectedCount) continue;
      const docs = Array.isArray(item.documents) ? (item.documents as RawGeminiExtractedDoc[]) : [];
      const existing = byIndex.get(idx);
      byIndex.set(idx, existing ? [...existing, ...docs] : docs);
    }

    for (let i = 0; i < expectedCount; i++) {
      if (!byIndex.has(i)) {
        return null;
      }
    }
    return byIndex;
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

interface ClassifiedGeminiFailure {
  isQuotaOrRate: boolean;
  isPerModelLimit: boolean;
  retryDelayMs: number | null;
  isRetryable: boolean;
  message: string;
}

function parseRetryDelayFromErrorBody(bodyText: string): {
  retryDelayMs: number | null;
  isDailyQuota: boolean;
} {
  let retryDelayMs: number | null = null;
  let isDailyQuota = false;

  try {
    const parsed = JSON.parse(bodyText) as {
      error?: {
        message?: string;
        details?: Array<{
          retryDelay?: string;
          violations?: Array<{ quotaId?: string }>;
        }>;
      };
    };
    for (const detail of parsed?.error?.details ?? []) {
      if (typeof detail.retryDelay === 'string') {
        const m = detail.retryDelay.match(/(\d+(?:\.\d+)?)s/i);
        if (m) {
          retryDelayMs = Math.ceil(parseFloat(m[1]) * 1000);
        }
      }
      for (const v of detail.violations ?? []) {
        const qid = (v.quotaId ?? '').toLowerCase();
        if (qid.includes('perday') || qid.includes('free_tier')) {
          isDailyQuota = true;
        }
      }
    }
  } catch {
    // Fallback to regex matching below for plain/partial error payloads.
  }

  if (retryDelayMs === null) {
    const match =
      bodyText.match(/retryDelay["']?\s*:\s*["'](\d+(?:\.\d+)?)s["']/i) ??
      bodyText.match(/retry in\s+(\d+(?:\.\d+)?)s/i);
    if (match) {
      retryDelayMs = Math.ceil(parseFloat(match[1]) * 1000);
    }
  }

  const lower = bodyText.toLowerCase();
  if (lower.includes('perday') || lower.includes('free_tier_requests')) {
    isDailyQuota = true;
  }

  return { retryDelayMs, isDailyQuota };
}

function classifyGeminiHttpFailure(status: number, bodyText: string): ClassifiedGeminiFailure {
  const lower = bodyText.toLowerCase();
  if (
    status === 429 ||
    lower.includes('resource_exhausted') ||
    lower.includes('quota') ||
    lower.includes('rate limit')
  ) {
    const { retryDelayMs, isDailyQuota } = parseRetryDelayFromErrorBody(bodyText);
    let cooldownMs: number | null = null;
    if (retryDelayMs !== null) {
      cooldownMs =
        isDailyQuota || retryDelayMs > 300_000
          ? Math.min(Math.max(retryDelayMs, 120_000), 30 * 60_000)
          : Math.max(15_000, Math.min(retryDelayMs, 120_000));
    }

    return {
      isQuotaOrRate: true,
      isPerModelLimit: true,
      retryDelayMs: cooldownMs,
      isRetryable: true,
      message: isDailyQuota ? `Daily model quota reached (${status})` : `Rate/quota limit (${status})`,
    };
  }
  if (status === 401 || status === 403 || lower.includes('api_key_invalid')) {
    return {
      isQuotaOrRate: true,
      isPerModelLimit: false,
      retryDelayMs: null,
      isRetryable: true,
      message: `API key rejected (${status})`,
    };
  }
  if (status === 408 || status === 500 || status === 502 || status === 503 || status === 504) {
    return {
      isQuotaOrRate: false,
      isPerModelLimit: false,
      retryDelayMs: null,
      isRetryable: true,
      message: `Model busy or unavailable (${status})`,
    };
  }
  return {
    isQuotaOrRate: false,
    isPerModelLimit: false,
    retryDelayMs: null,
    isRetryable: false,
    message: `Gemini request failed (${status})`,
  };
}

function normalizeDocumentsOrEmpty(rawDocs: RawGeminiExtractedDoc[]): NormalizedExtractedDoc[] {
  return rawDocs.length > 0
    ? rawDocs.map((d) => normalizeExtractedDocument(d))
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
}

async function runGeminiStructuredGeneration<TParsed>(params: {
  env: Env;
  requestedModel?: string | null;
  allowFallback?: boolean;
  excludeModels?: string[];
  fetchImpl: typeof fetch;
  sleepImpl: (ms: number) => Promise<void>;
  responseJsonSchema: unknown;
  buildParts: (activeKey: PooledGeminiKey, model: GeminiModelDefinition) => Promise<Array<Record<string, unknown>>>;
  parseTextResponse: (rawText: string) => TParsed | null;
}): Promise<{
  modelUsed: string;
  keyHashUsed: string;
  tokenUsage: TokenUsageCounts;
  durationMs: number;
  attempts: Array<{ model: string; status: 'ok' | 'retry' | 'failed'; reason?: string }>;
  parsed: TParsed;
}> {
  const {
    env,
    requestedModel,
    allowFallback = false,
    excludeModels = [],
    fetchImpl,
    sleepImpl,
    responseJsonSchema,
    buildParts,
    parseTextResponse,
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

  const modelCooldownMap = await loadModelCooldownMap(env.DB);
  const startedAt = Date.now();
  const attempts: Array<{ model: string; status: 'ok' | 'retry' | 'failed'; reason?: string }> = [];

  let lastErrorMessage = 'Extraction failed across all attempted models.';
  let lastStatusCode = 502;

  for (const model of modelResolution.models) {
    const maxAttemptsForModel = Math.min(
      4,
      Math.max(1 + GEMINI_MODEL_CONFIG.maxRetriesPerModel, keyPool.length)
    );
    const excludedKeyHashesForAttempt = new Set<string>();

    for (let attemptIdx = 0; attemptIdx < maxAttemptsForModel; attemptIdx++) {
      const picked = await pickRoundRobinKey({
        pool: keyPool,
        db: env.DB,
        modelId: model.id,
        modelCooldownMap,
        excludedKeyHashes: excludedKeyHashesForAttempt,
      });

      if (!picked.ok) {
        if (picked.reason === 'all_cooldown') {
          lastErrorMessage = `All Gemini API keys are temporarily rate-limited. Try again in ${picked.retryAfterSeconds}s.`;
          lastStatusCode = 429;
          attempts.push({ model: model.id, status: 'failed', reason: lastErrorMessage });
          break;
        }
        throw new GeminiExtractionError('No Gemini API keys available.', 503, attempts);
      }

      const activeKey = picked.key;

      try {
        const parts = await buildParts(activeKey, model);
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
                parts,
              },
            ],
            generationConfig: {
              temperature: GEMINI_MODEL_CONFIG.temperature,
              thinkingConfig: {
                thinkingLevel: model.thinkingLevel,
              },
              responseMimeType: 'application/json',
              responseJsonSchema,
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
              cooldownMs: classified.retryDelayMs ?? GEMINI_MODEL_CONFIG.keyCooldownMs,
              errorMessage: classified.message,
              ...(classified.isPerModelLimit ? { modelId: model.id, modelCooldownMap } : {}),
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
        const parsed = parseTextResponse(textParts);

        if (!parsed) {
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
        const outputTokens = Math.max(0, Math.floor(payload?.usageMetadata?.candidatesTokenCount ?? 0));
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

        attempts.push({ model: model.id, status: 'ok' });
        return {
          modelUsed: model.id,
          keyHashUsed: activeKey.keyHash,
          tokenUsage,
          durationMs: Math.max(1, Date.now() - startedAt),
          attempts,
          parsed,
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
            modelId: model.id,
            modelCooldownMap,
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
}

/**
 * Runs a single structured-output Gemini extraction across the configured model priority
 * and API key pool with minimal thinking latency, exponential backoff, per-model cooldown
 * rotation, and fallback support.
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

  const uploadedFilesByKeyHash = new Map<string, { apiKey: string; fileName: string; fileUri: string }>();
  let cachedInlineBase64: string | null = null;
  let cachedPlainText: string | null = null;

  const isPlainText = mimeType === 'text/plain';
  const useInline = !isPlainText && sizeBytes <= inlineThresholdBytes;

  try {
    if (isPlainText) {
      cachedPlainText = decodeTextBytesSmart(await loadBytes());
    } else if (useInline) {
      cachedInlineBase64 = encodeUint8ToBase64(await loadBytes());
    }

    const outcome = await runGeminiStructuredGeneration<RawGeminiExtractedDoc[]>({
      env,
      requestedModel,
      allowFallback,
      excludeModels,
      fetchImpl,
      sleepImpl,
      responseJsonSchema: EXTRACTION_RESPONSE_JSON_SCHEMA,
      buildParts: async (activeKey) => {
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
        return [{ text: EXTRACTION_PROMPT }, mediaPart];
      },
      parseTextResponse: parseGeminiDocumentsJson,
    });

    return {
      modelUsed: outcome.modelUsed,
      keyHashUsed: outcome.keyHashUsed,
      tokenUsage: outcome.tokenUsage,
      durationMs: outcome.durationMs,
      documents: normalizeDocumentsOrEmpty(outcome.parsed),
      attempts: outcome.attempts,
    };
  } finally {
    await Promise.all(
      Array.from(uploadedFilesByKeyHash.values()).map((u) =>
        deleteGeminiUploadedFile({ apiKey: u.apiKey, fileName: u.fileName, fetchImpl })
      )
    );
  }
}

/**
 * Extracts up to `maxBatchItems` inline files in a single Gemini generateContent call,
 * preserving strict `file_index` isolation across items while cutting multi-image latency.
 */
export async function extractBatchWithGemini(params: {
  env: Env;
  items: BatchExtractionItemInput[];
  requestedModel?: string | null;
  allowFallback?: boolean;
  excludeModels?: string[];
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
}): Promise<BatchExtractionOutcome> {
  const {
    env,
    items,
    requestedModel,
    allowFallback = false,
    excludeModels = [],
    fetchImpl = fetch,
    sleepImpl = sleep,
  } = params;

  if (items.length === 0) {
    throw new GeminiExtractionError('At least one file is required for batch extraction.', 400);
  }
  if (items.length > GEMINI_MODEL_CONFIG.maxBatchItems) {
    throw new GeminiExtractionError(
      `Batch size ${items.length} exceeds limit of ${GEMINI_MODEL_CONFIG.maxBatchItems}.`,
      400
    );
  }

  const staticParts: Array<Record<string, unknown>> = [{ text: BATCH_EXTRACTION_PROMPT }];
  for (let idx = 0; idx < items.length; idx++) {
    const item = items[idx];
    staticParts.push({
      text: `--- FILE_INDEX ${idx}: ${item.displayName} (${item.mimeType}) ---`,
    });
    const bytes = await item.loadBytes();
    if (item.mimeType === 'text/plain') {
      staticParts.push({ text: decodeTextBytesSmart(bytes) });
    } else {
      staticParts.push({
        inlineData: {
          mimeType: item.mimeType,
          data: encodeUint8ToBase64(bytes),
        },
      });
    }
  }

  const outcome = await runGeminiStructuredGeneration<Map<number, RawGeminiExtractedDoc[]>>({
    env,
    requestedModel,
    allowFallback,
    excludeModels,
    fetchImpl,
    sleepImpl,
    responseJsonSchema: BATCH_EXTRACTION_RESPONSE_JSON_SCHEMA,
    buildParts: async () => staticParts,
    parseTextResponse: (raw) => parseGeminiBatchJson(raw, items.length),
  });

  return {
    modelUsed: outcome.modelUsed,
    keyHashUsed: outcome.keyHashUsed,
    tokenUsage: outcome.tokenUsage,
    durationMs: outcome.durationMs,
    attempts: outcome.attempts,
    items: items.map((item, idx) => ({
      fileId: item.fileId,
      documents: normalizeDocumentsOrEmpty(outcome.parsed.get(idx) ?? []),
    })),
  };
}
