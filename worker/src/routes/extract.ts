import { Hono, type Context } from 'hono';
import { GEMINI_MODEL_CONFIG } from '../config/geminiModels';
import {
  ArchiveExtractionError,
  getExtensionLower,
  unpackWordDocument,
  unpackZipArchive,
  validateExtractUploadHeader,
  type UnpackedExtractItem,
} from '../services/archiveAndDoc';
import { getStorageStats, HARD_STOP_BYTES, runStorageCleanup } from '../services/cleanup';
import {
  constantTimeEqualStr,
  generateRandomToken,
  generateShortId,
  hmacSign,
  sha256Hex,
} from '../services/cryptoUtils';
import { extractDocumentWithGemini, GeminiExtractionError } from '../services/geminiExtractor';
import {
  getExtractSettings,
  getPublicQuotaSnapshot,
  loadActiveGeminiKeyPool,
} from '../services/geminiKeys';
import { checkRateLimit, formatRateWindowLabel, getClientIp, getUploadRateLimitConfig } from '../services/rateLimit';
import { verifyTurnstileToken } from '../services/turnstile';
import { sanitizeDisplayFilename } from '../services/urlValidator';
import type { Env, ExtractionFileRow } from '../types';

const HEADER_PROBE_LIMIT = 16 * 1024;
const EXTRACT_FILE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours auto-expiry
const BATCH_TICKET_TTL_MS = 15 * 60 * 1000; // 15 minutes batch upload window

async function createBatchUploadTicket(params: {
  secret: string;
  ip: string;
  now: number;
}): Promise<string> {
  const exp = params.now + BATCH_TICKET_TTL_MS;
  const nonce = generateRandomToken(20);
  const ipHash = await sha256Hex(params.ip);
  const payload = `extract-batch:${exp}:${ipHash}:${nonce}`;
  const sig = await hmacSign(payload, params.secret);
  return `${exp}.${nonce}.${sig}`;
}

async function verifyBatchUploadTicket(params: {
  ticket: string;
  secret: string;
  ip: string;
  now: number;
}): Promise<boolean> {
  const parts = params.ticket.trim().split('.');
  if (parts.length !== 3) return false;
  const [expStr, nonce, sig] = parts;
  if (!/^\d+$/.test(expStr) || !/^[A-Za-z0-9_-]{10,40}$/.test(nonce) || !/^[a-f0-9]{64}$/i.test(sig)) {
    return false;
  }
  const exp = Number.parseInt(expStr, 10);
  if (!Number.isFinite(exp) || exp <= params.now) return false;
  const ipHash = await sha256Hex(params.ip);
  const payload = `extract-batch:${exp}:${ipHash}:${nonce}`;
  const expected = await hmacSign(payload, params.secret);
  return constantTimeEqualStr(sig.toLowerCase(), expected.toLowerCase());
}

export interface ExtractRouteDeps {
  geminiFetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
}

async function readStreamHead(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  maxProbe: number
): Promise<{ head: Uint8Array; done: boolean }> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  let doneFlag = false;

  while (total < maxProbe) {
    const { done, value } = await reader.read();
    if (done) {
      doneFlag = true;
      break;
    }
    if (value && value.byteLength > 0) {
      chunks.push(value);
      total += value.byteLength;
    }
  }

  const head = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    head.set(c, offset);
    offset += c.byteLength;
  }
  return { head, done: doneFlag };
}

async function readRemainingBytes(
  firstChunk: Uint8Array,
  restReader: ReadableStreamDefaultReader<Uint8Array> | null,
  maxAllowedBytes: number
): Promise<Uint8Array> {
  if (!restReader) return firstChunk;

  const chunks: Uint8Array[] = [firstChunk];
  let total = firstChunk.byteLength;
  while (true) {
    const { done, value } = await restReader.read();
    if (done) break;
    if (value && value.byteLength > 0) {
      total += value.byteLength;
      if (total > maxAllowedBytes) {
        await restReader.cancel().catch(() => {});
        throw new ArchiveExtractionError('Uploaded file exceeded maximum size limit.', 413);
      }
      chunks.push(value);
    }
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const ch of chunks) {
    out.set(ch, offset);
    offset += ch.byteLength;
  }
  return out;
}

function getExtensionForMimeOrName(mimeType: string, fileName: string): string {
  const ext = getExtensionLower(fileName);
  if (ext) return ext;
  if (mimeType === 'application/pdf') return 'pdf';
  if (mimeType === 'image/jpeg') return 'jpg';
  if (mimeType === 'image/png') return 'png';
  if (mimeType === 'image/webp') return 'webp';
  if (mimeType === 'image/heic') return 'heic';
  if (mimeType === 'image/heif') return 'heif';
  if (mimeType === 'text/plain') return 'txt';
  return 'bin';
}

async function verifyExtractionFileToken(
  c: Context<{ Bindings: Env }>,
  fileId: string
): Promise<{ ok: true; row: ExtractionFileRow } | { ok: false; response: Response }> {
  const token = (c.req.header('X-Extract-Token') ?? '').trim();
  if (!token) {
    return { ok: false, response: c.json({ error: 'Missing extraction access token.' }, 401) };
  }

  const row = await c.env.DB
    .prepare('SELECT * FROM extraction_files WHERE id = ?')
    .bind(fileId)
    .first<ExtractionFileRow>();

  if (!row || row.status !== 'active') {
    return { ok: false, response: c.json({ error: 'File not found or already deleted.' }, 404) };
  }
  if (row.expires_at <= Date.now()) {
    return { ok: false, response: c.json({ error: 'Temporary extraction file has expired.' }, 410) };
  }

  const incomingHash = await sha256Hex(token);
  if (!constantTimeEqualStr(incomingHash, row.access_token_hash)) {
    return { ok: false, response: c.json({ error: 'Invalid extraction access token.' }, 403) };
  }

  return { ok: true, row };
}

async function persistExtractItemsBatch(params: {
  env: Env;
  items: UnpackedExtractItem[];
  now: number;
}): Promise<
  Array<{
    fileId: string;
    accessToken: string;
    fileName: string;
    mimeType: string;
    sizeBytes: number;
    kind: UnpackedExtractItem['kind'];
    sourceArchive?: string;
  }>
> {
  const { env, items, now } = params;
  const prepared: Array<{
    fileId: string;
    accessToken: string;
    accessTokenHash: string;
    r2Key: string;
    safeName: string;
    item: UnpackedExtractItem;
  }> = [];

  for (const item of items) {
    const fileId = generateShortId(12);
    const accessToken = generateRandomToken(32);
    const accessTokenHash = await sha256Hex(accessToken);
    const ext = getExtensionForMimeOrName(item.mimeType, item.fileName);
    const r2Key = `extract-tmp/${crypto.randomUUID()}.${ext}`;
    const safeName = sanitizeDisplayFilename(item.fileName);
    prepared.push({ fileId, accessToken, accessTokenHash, r2Key, safeName, item });
  }

  // Upload to R2 in bounded parallel groups of 5
  const CHUNK_SIZE = 5;
  for (let i = 0; i < prepared.length; i += CHUNK_SIZE) {
    await Promise.all(
      prepared.slice(i, i + CHUNK_SIZE).map((p) =>
        env.FILES.put(p.r2Key, p.item.bytes, {
          httpMetadata: { contentType: p.item.mimeType },
        })
      )
    );
  }

  let totalBytes = 0;
  const stmts: D1PreparedStatement[] = prepared.map((p) => {
    totalBytes += p.item.bytes.byteLength;
    return env.DB
      .prepare(
        `INSERT INTO extraction_files
         (id, r2_key, original_name, mime_type, size_bytes, access_token_hash, created_at, expires_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')`
      )
      .bind(
        p.fileId,
        p.r2Key,
        p.safeName,
        p.item.mimeType,
        p.item.bytes.byteLength,
        p.accessTokenHash,
        now,
        now + EXTRACT_FILE_TTL_MS
      );
  });
  if (totalBytes > 0) {
    stmts.push(
      env.DB.prepare('UPDATE storage_stats SET total_bytes = total_bytes + ? WHERE id = 1').bind(totalBytes)
    );
  }
  await env.DB.batch(stmts);

  return prepared.map((p) => ({
    fileId: p.fileId,
    accessToken: p.accessToken,
    fileName: p.safeName,
    mimeType: p.item.mimeType,
    sizeBytes: p.item.bytes.byteLength,
    kind: p.item.kind,
    ...(p.item.sourceArchive ? { sourceArchive: p.item.sourceArchive } : {}),
  }));
}

export function createExtractRoutes(deps: ExtractRouteDeps = {}) {
  const app = new Hono<{ Bindings: Env }>();

  app.get('/config', async (c) => {
    const settings = await getExtractSettings(c.env);
    const pool = await loadActiveGeminiKeyPool(c.env);
    const activeKeyCount = pool.length;
    const effectiveConcurrency =
      activeKeyCount > 0 ? Math.max(1, Math.min(settings.concurrency, activeKeyCount)) : 1;
    const quota = await getPublicQuotaSnapshot({ env: c.env });

    return c.json({
      ok: true,
      maxPdfMb: settings.max_pdf_mb,
      concurrency: settings.concurrency,
      effectiveConcurrency,
      inlineThresholdMb: settings.inline_threshold_mb,
      activeKeyCount,
      wordToPdfEnabled: Boolean((c.env.WORD_CONVERTER_URL ?? '').trim()),
      models: GEMINI_MODEL_CONFIG.models,
      quota,
    });
  });

  // Exchange a single Turnstile verification for a short-lived batch upload ticket (allows multi-file parallel ingest)
  app.post('/session', async (c) => {
    const ip = getClientIp(c.req.raw);
    let body: { turnstileToken?: string } = {};
    try {
      body = await c.req.json();
    } catch {
      // Allow empty body when Turnstile is disabled
    }

    const turnstile = await verifyTurnstileToken({
      token: body.turnstileToken,
      secretKey: c.env.TURNSTILE_SECRET_KEY,
      remoteIp: ip,
    });
    if (!turnstile.ok) {
      return c.json({ error: turnstile.error ?? 'Security check failed.' }, 403);
    }

    const secret = (c.env.SESSION_SECRET || c.env.TURNSTILE_SECRET_KEY || '').trim();
    const now = Date.now();
    const batchTicket = secret ? await createBatchUploadTicket({ secret, ip, now }) : 'dev-batch-ok';
    return c.json({ ok: true, batchTicket, expiresAt: now + BATCH_TICKET_TTL_MS });
  });

  // Upload & unpack (supports direct images, PDFs, DOCX/DOC, and ZIP/nested ZIP archives)
  app.post('/ingest', async (c) => {
    const ip = getClientIp(c.req.raw);
    const uploadRateLimit = getUploadRateLimitConfig(c.env);
    const ingestLimit = Math.max(uploadRateLimit.maxUploads * 4, 40);
    const rate = await checkRateLimit({
      db: c.env.DB,
      key: `extract_ingest:${ip}`,
      limit: ingestLimit,
      windowMs: uploadRateLimit.windowMs,
    });

    if (!rate.allowed) {
      const windowLabel = formatRateWindowLabel(uploadRateLimit.windowSeconds);
      c.header('Retry-After', String(rate.retryAfterSeconds));
      return c.json(
        {
          error: `Upload limit reached (${ingestLimit}/${windowLabel}). Please try again in ${rate.retryAfterSeconds}s.`,
        },
        429
      );
    }

    const settings = await getExtractSettings(c.env);
    const maxPdfBytes = settings.max_pdf_mb * 1024 * 1024;
    const contentType = (c.req.header('Content-Type') ?? '').toLowerCase();
    const isMultipart = contentType.startsWith('multipart/form-data');

    let filename = '';
    let turnstileToken = '';
    let declaredSize = 0;
    let firstChunk: Uint8Array;
    let restReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    let fullMultipartBytes: Uint8Array | null = null;

    if (isMultipart) {
      let formData: FormData;
      try {
        formData = await c.req.formData();
      } catch {
        return c.json({ error: 'Invalid multipart upload request.' }, 400);
      }
      const fileEntry = formData.get('file');
      if (!fileEntry || typeof fileEntry === 'string') {
        return c.json({ error: 'No file attached.' }, 400);
      }
      const file = fileEntry as File;
      filename = file.name || 'upload';
      turnstileToken = String(formData.get('turnstileToken') ?? '');
      declaredSize = file.size;

      const headBuf = await file.slice(0, HEADER_PROBE_LIMIT).arrayBuffer();
      firstChunk = new Uint8Array(headBuf);
      if (file.size <= HEADER_PROBE_LIMIT) {
        fullMultipartBytes = new Uint8Array(await file.arrayBuffer());
      } else {
        restReader = file.stream().getReader();
      }
    } else {
      const encodedName = c.req.header('X-File-Name') ?? '';
      try {
        filename = decodeURIComponent(encodedName);
      } catch {
        filename = encodedName;
      }
      turnstileToken = c.req.header('X-Turnstile-Token') ?? '';
      declaredSize = Number.parseInt(c.req.header('Content-Length') ?? '0', 10);

      if (!c.req.raw.body) {
        return c.json({ error: 'Empty upload stream.' }, 400);
      }
      if (!Number.isFinite(declaredSize) || declaredSize <= 0) {
        return c.json({ error: 'Valid Content-Length header is required.' }, 411);
      }

      const reader = c.req.raw.body.getReader();
      const probed = await readStreamHead(reader, HEADER_PROBE_LIMIT);
      firstChunk = probed.head;
      if (!probed.done) {
        restReader = reader;
      } else {
        declaredSize = firstChunk.byteLength;
      }
    }

    // Verify either a valid batch upload ticket OR a Turnstile token
    const batchTicket = (c.req.header('X-Extract-Batch-Token') ?? '').trim();
    const ticketSecret = (c.env.SESSION_SECRET || c.env.TURNSTILE_SECRET_KEY || '').trim();
    let authorizedIngest = false;

    if (batchTicket && ticketSecret) {
      authorizedIngest = await verifyBatchUploadTicket({
        ticket: batchTicket,
        secret: ticketSecret,
        ip,
        now: Date.now(),
      });
    }

    if (!authorizedIngest) {
      const turnstile = await verifyTurnstileToken({
        token: turnstileToken,
        secretKey: c.env.TURNSTILE_SECRET_KEY,
        remoteIp: ip,
      });
      if (!turnstile.ok) {
        if (restReader) await restReader.cancel().catch(() => {});
        return c.json({ error: turnstile.error ?? 'Security check failed.' }, 403);
      }
    }

    const validation = validateExtractUploadHeader({
      filename,
      sizeBytes: declaredSize,
      headerBytes: firstChunk,
      maxPdfBytes,
    });
    if (!validation.ok) {
      if (restReader) await restReader.cancel().catch(() => {});
      return c.json({ error: validation.error }, 400);
    }

    let stats = await getStorageStats(c.env.DB);
    if (stats.total_bytes + declaredSize > HARD_STOP_BYTES) {
      await runStorageCleanup({
        env: c.env,
        trigger: 'upload',
        force: true,
        originUrl: new URL(c.req.url).origin,
      });
      stats = await getStorageStats(c.env.DB);
      if (stats.total_bytes + declaredSize > HARD_STOP_BYTES) {
        if (restReader) await restReader.cancel().catch(() => {});
        return c.json({ error: 'Temporary storage is full. Please try again shortly.' }, 507);
      }
    }

    const now = Date.now();
    const spec = validation.spec;

    // Fast streaming path for single image or PDF (no full-file RAM buffering for huge 50 MB PDFs!)
    if (spec.kind === 'image' || spec.kind === 'pdf') {
      const fileId = generateShortId(12);
      const accessToken = generateRandomToken(32);
      const accessTokenHash = await sha256Hex(accessToken);
      const r2Key = `extract-tmp/${crypto.randomUUID()}.${spec.extension}`;
      const safeName = sanitizeDisplayFilename(filename);
      let actualSize = 0;

      try {
        if (isMultipart) {
          if (fullMultipartBytes) {
            actualSize = fullMultipartBytes.byteLength;
            await c.env.FILES.put(r2Key, fullMultipartBytes, {
              httpMetadata: { contentType: spec.mimeType },
            });
          } else if (restReader) {
            if (typeof FixedLengthStream !== 'undefined') {
              const fixed = new FixedLengthStream(declaredSize);
              const writer = fixed.writable.getWriter();
              const pump = (async () => {
                let written = 0;
                try {
                  while (true) {
                    const { done, value } = await restReader!.read();
                    if (done) break;
                    if (value && value.byteLength > 0) {
                      written += value.byteLength;
                      if (written > maxPdfBytes) throw new Error('SIZE_LIMIT_EXCEEDED');
                      await writer.write(value);
                    }
                  }
                  if (written !== declaredSize) throw new Error('SIZE_MISMATCH');
                  actualSize = written;
                  await writer.close();
                } catch (err) {
                  await writer.abort(err).catch(() => {});
                  throw err;
                }
              })();
              await Promise.all([
                pump,
                c.env.FILES.put(r2Key, fixed.readable, { httpMetadata: { contentType: spec.mimeType } }),
              ]);
            } else {
              const buf = await readRemainingBytes(new Uint8Array(0), restReader, maxPdfBytes);
              actualSize = buf.byteLength;
              await c.env.FILES.put(r2Key, buf, { httpMetadata: { contentType: spec.mimeType } });
            }
          }
        } else if (!restReader) {
          actualSize = firstChunk.byteLength;
          await c.env.FILES.put(r2Key, firstChunk, { httpMetadata: { contentType: spec.mimeType } });
        } else if (typeof FixedLengthStream !== 'undefined') {
          const fixed = new FixedLengthStream(declaredSize);
          const writer = fixed.writable.getWriter();
          const pump = (async () => {
            let written = 0;
            try {
              if (firstChunk.byteLength > 0) {
                written += firstChunk.byteLength;
                await writer.write(firstChunk);
              }
              while (true) {
                const { done, value } = await restReader!.read();
                if (done) break;
                if (value && value.byteLength > 0) {
                  written += value.byteLength;
                  if (written > maxPdfBytes || written > declaredSize) {
                    throw new Error('SIZE_LIMIT_EXCEEDED');
                  }
                  await writer.write(value);
                }
              }
              if (written !== declaredSize) throw new Error('SIZE_MISMATCH');
              actualSize = written;
              await writer.close();
            } catch (err) {
              await writer.abort(err).catch(() => {});
              throw err;
            }
          })();
          await Promise.all([
            pump,
            c.env.FILES.put(r2Key, fixed.readable, { httpMetadata: { contentType: spec.mimeType } }),
          ]);
        } else {
          const buf = await readRemainingBytes(firstChunk, restReader, maxPdfBytes);
          actualSize = buf.byteLength;
          await c.env.FILES.put(r2Key, buf, { httpMetadata: { contentType: spec.mimeType } });
        }
      } catch (err) {
        await c.env.FILES.delete(r2Key).catch(() => {});
        const msg =
          err instanceof Error && err.message === 'SIZE_LIMIT_EXCEEDED'
            ? 'File exceeded allowed size limit.'
            : 'Upload stream interrupted or incomplete. Please try again.';
        return c.json({ error: msg }, 400);
      }

      await c.env.DB.batch([
        c.env.DB
          .prepare(
            `INSERT INTO extraction_files
             (id, r2_key, original_name, mime_type, size_bytes, access_token_hash, created_at, expires_at, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')`
          )
          .bind(fileId, r2Key, safeName, spec.mimeType, actualSize, accessTokenHash, now, now + EXTRACT_FILE_TTL_MS),
        c.env.DB
          .prepare('UPDATE storage_stats SET total_bytes = total_bytes + ? WHERE id = 1')
          .bind(actualSize),
      ]);

      return c.json(
        {
          ok: true,
          items: [
            {
              fileId,
              accessToken,
              fileName: safeName,
              mimeType: spec.mimeType,
              sizeBytes: actualSize,
              kind: spec.kind,
            },
          ],
          skipped: [],
        },
        201
      );
    }

    // Archive (ZIP / nested ZIP) or Word (DOCX / DOC) path
    let rawBytes: Uint8Array;
    try {
      if (isMultipart) {
        rawBytes = fullMultipartBytes ?? (await readRemainingBytes(new Uint8Array(0), restReader, maxPdfBytes));
      } else {
        rawBytes = await readRemainingBytes(firstChunk, restReader, maxPdfBytes);
      }
    } catch (err) {
      if (err instanceof ArchiveExtractionError) {
        return c.json({ error: err.message }, err.statusCode as 400 | 413);
      }
      return c.json({ error: 'Failed to read uploaded archive stream.' }, 400);
    }

    try {
      const unpacked =
        spec.kind === 'zip'
          ? await unpackZipArchive({
              zipBytes: rawBytes,
              archiveName: sanitizeDisplayFilename(filename),
              maxPdfBytes,
              env: c.env,
            })
          : await unpackWordDocument({
              bytes: rawBytes,
              fileName: sanitizeDisplayFilename(filename),
              ext: spec.kind,
              env: c.env,
            });

      if (unpacked.items.length === 0) {
        return c.json(
          {
            error: 'No supported images or PDF documents were found inside this file.',
            skipped: unpacked.skipped,
          },
          400
        );
      }

      const persisted = await persistExtractItemsBatch({
        env: c.env,
        items: unpacked.items,
        now,
      });

      return c.json(
        {
          ok: true,
          items: persisted,
          skipped: unpacked.skipped,
        },
        201
      );
    } catch (err) {
      if (err instanceof ArchiveExtractionError) {
        return c.json({ error: err.message }, err.statusCode as 400 | 413);
      }
      return c.json(
        { error: err instanceof Error ? err.message : 'Unable to unpack uploaded file.' },
        400
      );
    }
  });

  // Run AI extraction for one ingested file
  app.post('/run', async (c) => {
    const ip = getClientIp(c.req.raw);
    const rate = await checkRateLimit({
      db: c.env.DB,
      key: `extract_run:${ip}`,
      limit: 60,
      windowMs: 60 * 1000,
    });
    if (!rate.allowed) {
      c.header('Retry-After', String(rate.retryAfterSeconds));
      return c.json(
        { error: `Extraction rate limit reached. Try again in ${rate.retryAfterSeconds}s.` },
        429
      );
    }

    let body: {
      fileId?: string;
      model?: string;
      allowFallback?: boolean;
      excludeModels?: string[];
    };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON request body.' }, 400);
    }

    const fileId = (body.fileId ?? '').trim();
    if (!fileId) {
      return c.json({ error: 'fileId is required.' }, 400);
    }

    const auth = await verifyExtractionFileToken(c, fileId);
    if (!auth.ok) return auth.response;
    const row = auth.row;

    const settings = await getExtractSettings(c.env);
    const inlineThresholdBytes = settings.inline_threshold_mb * 1024 * 1024;

    try {
      const outcome = await extractDocumentWithGemini({
        env: c.env,
        mimeType: row.mime_type,
        displayName: row.original_name,
        sizeBytes: row.size_bytes,
        inlineThresholdBytes,
        loadBytes: async () => {
          const obj = await c.env.FILES.get(row.r2_key);
          if (!obj) throw new GeminiExtractionError('Uploaded source file is missing from storage.', 404);
          return new Uint8Array(await obj.arrayBuffer());
        },
        openStream: async () => {
          const obj = await c.env.FILES.get(row.r2_key);
          if (!obj) throw new GeminiExtractionError('Uploaded source file is missing from storage.', 404);
          return obj.body;
        },
        requestedModel: body.model ?? 'auto',
        allowFallback: Boolean(body.allowFallback),
        excludeModels: Array.isArray(body.excludeModels) ? body.excludeModels : [],
        fetchImpl: deps.geminiFetchImpl,
        sleepImpl: deps.sleepImpl,
      });

      const quota = await getPublicQuotaSnapshot({
        env: c.env,
        preferredKeyHash: outcome.keyHashUsed,
      });

      return c.json({
        ok: true,
        fileId: row.id,
        modelUsed: outcome.modelUsed,
        durationMs: outcome.durationMs,
        tokenUsage: outcome.tokenUsage,
        quota,
        documents: outcome.documents,
        attempts: outcome.attempts,
      });
    } catch (err) {
      const quota = await getPublicQuotaSnapshot({ env: c.env }).catch(() => undefined);
      if (err instanceof GeminiExtractionError) {
        return c.json(
          { error: err.message, attempts: err.attempts, ...(quota ? { quota } : {}) },
          err.statusCode as 400 | 429 | 502 | 503 | 504
        );
      }
      return c.json(
        { error: err instanceof Error ? err.message : 'Extraction failed.', ...(quota ? { quota } : {}) },
        502
      );
    }
  });

  // Private token-gated preview stream for row thumbnails
  app.get('/file/:fileId', async (c) => {
    const fileId = (c.req.param('fileId') ?? '').trim();
    const auth = await verifyExtractionFileToken(c, fileId);
    if (!auth.ok) return auth.response;

    const r2Object = await c.env.FILES.get(auth.row.r2_key);
    if (!r2Object) {
      return c.json({ error: 'File no longer exists in storage.' }, 404);
    }

    return new Response(r2Object.body, {
      status: 200,
      headers: {
        'Content-Type': auth.row.mime_type,
        'Content-Length': String(auth.row.size_bytes),
        'Content-Disposition': `inline; filename="${sanitizeDisplayFilename(auth.row.original_name)}"`,
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'Cache-Control': 'private, no-store',
        'Content-Security-Policy': "default-src 'none'; sandbox",
      },
    });
  });

  // Delete uploaded extraction source file when user removes row(s)
  app.delete('/file/:fileId', async (c) => {
    const fileId = (c.req.param('fileId') ?? '').trim();
    const auth = await verifyExtractionFileToken(c, fileId);
    if (!auth.ok) return auth.response;

    const row = auth.row;
    await c.env.FILES.delete(row.r2_key).catch(() => {});

    const stmts: D1PreparedStatement[] = [
      c.env.DB
        .prepare("UPDATE extraction_files SET status = 'removed' WHERE id = ?")
        .bind(row.id),
    ];
    if (row.size_bytes > 0) {
      stmts.push(
        c.env.DB
          .prepare('UPDATE storage_stats SET total_bytes = MAX(0, total_bytes - ?) WHERE id = 1')
          .bind(row.size_bytes)
      );
    }
    await c.env.DB.batch(stmts);

    return c.json({ ok: true, fileId: row.id });
  });

  return app;
}
