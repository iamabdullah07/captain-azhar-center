import { Hono, type Context } from 'hono';
import type { Env, ItemType, LinkFileRow } from '../types';
import {
  constantTimeEqualStr,
  generateRandomToken,
  generateShortId,
  sha256Hex,
} from '../services/cryptoUtils';
import { FILE_SIZE_LIMITS, validateUploadedFileHeader } from '../services/magicBytes';
import { sanitizeDisplayFilename, validateTargetUrl } from '../services/urlValidator';
import {
  checkRateLimit,
  formatRateWindowLabel,
  getClientIp,
  getUploadRateLimitConfig,
} from '../services/rateLimit';
import { verifyTurnstileToken } from '../services/turnstile';
import {
  getStorageStats,
  HARD_STOP_BYTES,
  maybeSendStorageAlert,
  purgeShortLinkCache,
  runStorageCleanup,
} from '../services/cleanup';
import { renderStatusHtml } from '../views/statusPages';
import { renderOfficeViewerHtml, type OfficeExtension } from '../views/officeViewer';

const HOUR_MS = 60 * 60 * 1000;
const RESERVATION_TTL_MS = 30 * 60 * 1000;
const SOURCE_TICKET_TTL_MS = 2 * HOUR_MS;
const HEADER_PROBE_LIMIT = 16 * 1024; // 16 KB magic-byte peek

const OFFICE_MIME_TO_EXT: Record<string, OfficeExtension> = {
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
};

const OFFICE_EXTENSIONS = new Set<OfficeExtension>(['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx']);

function getPathExtension(value: string | null | undefined): string {
  if (!value) return '';
  const clean = value.trim().toLowerCase();
  const dot = clean.lastIndexOf('.');
  if (dot < 0 || dot === clean.length - 1) return '';
  return clean.slice(dot + 1);
}

function getOfficeExtension(row: LinkFileRow): OfficeExtension | null {
  if (row.type !== 'document') return null;
  const mime = (row.mime_type ?? '').trim().toLowerCase();
  if (mime && OFFICE_MIME_TO_EXT[mime]) {
    return OFFICE_MIME_TO_EXT[mime];
  }
  const keyExt = getPathExtension(row.r2_key);
  if (OFFICE_EXTENSIONS.has(keyExt as OfficeExtension)) {
    return keyExt as OfficeExtension;
  }
  const nameExt = getPathExtension(row.original_name);
  if (OFFICE_EXTENSIONS.has(nameExt as OfficeExtension)) {
    return nameExt as OfficeExtension;
  }
  return null;
}

function buildOfficeRawFilename(safeFilename: string, ext: OfficeExtension): string {
  const suffix = `.${ext}`;
  const lower = safeFilename.toLowerCase();
  const stemRaw = lower.endsWith(suffix)
    ? safeFilename.slice(0, safeFilename.length - suffix.length)
    : safeFilename;
  const slug = stemRaw
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 90);
  return `${slug || 'document'}${suffix}`;
}

function isPdfRow(row: LinkFileRow): boolean {
  if (row.type !== 'document') return false;
  const mime = (row.mime_type ?? '').trim().toLowerCase();
  if (mime === 'application/pdf') return true;
  return getPathExtension(row.r2_key) === 'pdf' || getPathExtension(row.original_name) === 'pdf';
}

function isBlockedSvgRow(row: LinkFileRow): boolean {
  const mime = (row.mime_type ?? '').trim().toLowerCase();
  if (mime.includes('svg')) return true;
  return getPathExtension(row.r2_key) === 'svg' || getPathExtension(row.original_name) === 'svg';
}

function getFileCspHeader(kind: 'image' | 'video' | 'pdf' | 'office'): string {
  if (kind === 'image') {
    return "default-src 'none'; media-src 'self'; img-src 'self'; sandbox";
  }
  if (kind === 'video') {
    return "default-src 'none'; media-src 'self' blob:; style-src 'unsafe-inline'; img-src 'self'";
  }
  if (kind === 'pdf') {
    return "default-src 'none'; object-src 'self' blob:; frame-src 'self' blob:; style-src 'unsafe-inline'; img-src 'self'; media-src 'self'";
  }
  return "default-src 'none'; sandbox";
}

function buildShortUrl(reqUrl: string, id: string): string {
  const url = new URL(reqUrl);
  return `${url.origin}/f/${id}`;
}

function runInBackground(c: Context<{ Bindings: Env }>, promise: Promise<unknown>): void {
  try {
    c.executionCtx.waitUntil(promise);
  } catch {
    // No ExecutionContext in non-Worker test environments
  }
}

async function allocateUniqueId(db: D1Database, now = Date.now()): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = generateShortId(9);
    const exists = await db.prepare('SELECT 1 FROM links_files WHERE id = ?').bind(candidate).first();
    if (exists) continue;
    const reserved = await db
      .prepare('SELECT 1 FROM upload_reservations WHERE id = ? AND used_at IS NULL AND expires_at > ?')
      .bind(candidate, now)
      .first();
    if (!reserved) return candidate;
  }
  return generateShortId(10);
}

async function verifySourceUploadTicket(params: {
  db: D1Database;
  sourceId: string;
  deleteToken: string;
  now: number;
}): Promise<boolean> {
  const { db, sourceId, deleteToken, now } = params;
  if (!sourceId || !deleteToken) return false;
  const row = await db
    .prepare('SELECT delete_token_hash, status, created_at FROM links_files WHERE id = ?')
    .bind(sourceId)
    .first<Pick<LinkFileRow, 'delete_token_hash' | 'status' | 'created_at'>>();
  if (!row || row.status !== 'active') return false;
  if (now - row.created_at > SOURCE_TICKET_TTL_MS) return false;
  if (!row.delete_token_hash) return false;
  const incomingHash = await sha256Hex(deleteToken);
  return constantTimeEqualStr(incomingHash, row.delete_token_hash);
}

function parseByteRange(
  rangeHeader: string | null,
  totalSize: number
): { offset: number; length: number; start: number; end: number } | 'invalid' | null {
  if (!rangeHeader) return null;
  const match = rangeHeader.trim().match(/^bytes=(\d*)-(\d*)$/i);
  if (!match) return 'invalid';

  const [, startStr, endStr] = match;
  if (!startStr && !endStr) return 'invalid';

  let start: number;
  let end: number;

  if (!startStr) {
    // Suffix range: bytes=-500
    const suffix = Number.parseInt(endStr, 10);
    if (Number.isNaN(suffix) || suffix <= 0) return 'invalid';
    start = Math.max(0, totalSize - suffix);
    end = totalSize - 1;
  } else {
    start = Number.parseInt(startStr, 10);
    end = endStr ? Number.parseInt(endStr, 10) : totalSize - 1;
    if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= totalSize) {
      return 'invalid';
    }
    end = Math.min(end, totalSize - 1);
  }

  return {
    offset: start,
    length: end - start + 1,
    start,
    end,
  };
}

/**
 * Reads up to `maxProbe` bytes from a ReadableStream without buffering the rest of the body.
 */
async function readStreamHead(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  maxProbe: number
): Promise<{ head: Uint8Array; done: boolean }> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  let streamDone = false;

  while (total < maxProbe) {
    const { done, value } = await reader.read();
    if (done) {
      streamDone = true;
      break;
    }
    if (value && value.byteLength > 0) {
      chunks.push(value);
      total += value.byteLength;
    }
  }

  const head = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    head.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { head, done: streamDone };
}

export function createPublicRoutes() {
  const app = new Hono<{ Bindings: Env }>();

  // Root & Health endpoints
  app.get('/', (c) => {
    return c.json({
      ok: true,
      service: c.env.APP_NAME ?? 'Captain Azhar Center',
      health: '/api/health',
    });
  });

  app.get('/api/health', (c) => {
    return c.json({
      ok: true,
      service: c.env.APP_NAME ?? 'Captain Azhar Center',
      wordToPdfEnabled: Boolean((c.env.WORD_CONVERTER_URL ?? '').trim()),
    });
  });

  // 1. Shorten URL (no file upload)
  app.post('/api/link', async (c) => {
    const ip = getClientIp(c.req.raw);
    const rate = await checkRateLimit({
      db: c.env.DB,
      key: `link:${ip}`,
      limit: 30,
      windowMs: HOUR_MS,
    });

    if (!rate.allowed) {
      return c.json(
        { error: `Too many requests. Please wait ${rate.retryAfterSeconds}s and try again.` },
        429
      );
    }

    let body: { url?: string; turnstileToken?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON request body.' }, 400);
    }

    const turnstile = await verifyTurnstileToken({
      token: body.turnstileToken,
      secretKey: c.env.TURNSTILE_SECRET_KEY,
      remoteIp: ip,
    });
    if (!turnstile.ok) {
      return c.json({ error: turnstile.error ?? 'Security check failed.' }, 403);
    }

    const reqOrigin = new URL(c.req.url).origin;
    const validated = validateTargetUrl(body.url ?? '', reqOrigin);
    if (!validated.ok) {
      return c.json({ error: validated.error }, 400);
    }

    const id = await allocateUniqueId(c.env.DB);
    const deleteToken = generateRandomToken(32);
    const deleteTokenHash = await sha256Hex(deleteToken);
    const now = Date.now();

    await c.env.DB
      .prepare(
        `INSERT INTO links_files (
          id, type, original_name, mime_type, size_bytes, r2_key, target_url,
          created_at, delete_token_hash, status, removed_reason
        ) VALUES (?, 'link', NULL, NULL, 0, NULL, ?, ?, ?, 'active', NULL)`
      )
      .bind(id, validated.url, now, deleteTokenHash)
      .run();

    return c.json(
      {
        id,
        type: 'link',
        shortUrl: buildShortUrl(c.req.url, id),
        targetUrl: validated.url,
        deleteToken,
        createdAt: now,
      },
      201
    );
  });

  // 2a. Reserve a short ID before client-side QR embedding so the QR inside a saved PDF points to that PDF itself
  app.post('/api/upload/reserve', async (c) => {
    const ip = getClientIp(c.req.raw);
    const uploadRateLimit = getUploadRateLimitConfig(c.env);
    const rate = await checkRateLimit({
      db: c.env.DB,
      key: `reserve:${ip}`,
      limit: uploadRateLimit.maxUploads * 2,
      windowMs: uploadRateLimit.windowMs,
    });

    if (!rate.allowed) {
      const windowLabel = formatRateWindowLabel(uploadRateLimit.windowSeconds);
      c.header('Retry-After', String(rate.retryAfterSeconds));
      return c.json(
        {
          error: `Reservation limit reached (${uploadRateLimit.maxUploads * 2}/${windowLabel}). Please try again in ${rate.retryAfterSeconds}s.`,
        },
        429
      );
    }

    let body: { sourceId?: string; deleteToken?: string; turnstileToken?: string } = {};
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON request body.' }, 400);
    }

    const now = Date.now();
    const sourceId = (body.sourceId ?? '').trim();
    const deleteToken = (body.deleteToken ?? '').trim();

    if (sourceId || deleteToken) {
      const validTicket = await verifySourceUploadTicket({
        db: c.env.DB,
        sourceId,
        deleteToken,
        now,
      });
      if (!validTicket) {
        return c.json({ error: 'Invalid or expired source upload token.' }, 403);
      }
    } else {
      const turnstile = await verifyTurnstileToken({
        token: body.turnstileToken,
        secretKey: c.env.TURNSTILE_SECRET_KEY,
        remoteIp: ip,
      });
      if (!turnstile.ok) {
        return c.json({ error: turnstile.error ?? 'Security check failed.' }, 403);
      }
    }

    const id = await allocateUniqueId(c.env.DB, now);
    const reserveToken = generateRandomToken(32);
    const tokenHash = await sha256Hex(reserveToken);
    const expiresAt = now + RESERVATION_TTL_MS;

    await c.env.DB
      .prepare(
        `INSERT INTO upload_reservations (id, token_hash, source_id, expires_at, used_at)
         VALUES (?, ?, ?, ?, NULL)`
      )
      .bind(id, tokenHash, sourceId || null, expiresAt)
      .run();

    return c.json(
      {
        id,
        shortUrl: buildShortUrl(c.req.url, id),
        reserveToken,
        expiresAt,
      },
      201
    );
  });

  // 2. Upload file (image, document, video)
  // Supports raw binary streaming (X-File-Name + X-File-Category + Content-Length) to stay well within
  // 128 MB Worker RAM even on 50 MB video uploads, as well as standard multipart/form-data.
  app.post('/api/upload', async (c) => {
    const ip = getClientIp(c.req.raw);
    const uploadRateLimit = getUploadRateLimitConfig(c.env);
    const rate = await checkRateLimit({
      db: c.env.DB,
      key: `upload:${ip}`,
      limit: uploadRateLimit.maxUploads,
      windowMs: uploadRateLimit.windowMs,
    });

    if (!rate.allowed) {
      const windowLabel = formatRateWindowLabel(uploadRateLimit.windowSeconds);
      c.header('Retry-After', String(rate.retryAfterSeconds));
      return c.json(
        {
          error: `Upload limit reached (${uploadRateLimit.maxUploads}/${windowLabel}). Please try again in ${rate.retryAfterSeconds}s.`,
        },
        429
      );
    }

    const contentType = (c.req.header('Content-Type') ?? '').toLowerCase();
    const isMultipart = contentType.startsWith('multipart/form-data');

    let filename = '';
    let categoryRaw = '';
    let turnstileToken: string | undefined;
    let reservedId = '';
    let reserveToken = '';
    let declaredSize = 0;
    let firstChunk: Uint8Array;
    let restReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    let fullMultipartBytes: Uint8Array | null = null;

    if (isMultipart) {
      let formData: FormData;
      try {
        formData = await c.req.formData();
      } catch {
        return c.json({ error: 'Invalid multipart form upload.' }, 400);
      }

      const fileEntry = formData.get('file');
      if (!fileEntry || typeof fileEntry === 'string') {
        return c.json({ error: 'No file attached.' }, 400);
      }
      const file = fileEntry as File;
      filename = file.name || 'upload';
      categoryRaw = String(formData.get('category') ?? '');
      turnstileToken = String(formData.get('turnstileToken') ?? '');
      reservedId = String(formData.get('reservedId') ?? '').trim();
      reserveToken = String(formData.get('reserveToken') ?? '').trim();
      declaredSize = file.size;

      const headBuf = await file.slice(0, HEADER_PROBE_LIMIT).arrayBuffer();
      firstChunk = new Uint8Array(headBuf);
      if (file.size <= HEADER_PROBE_LIMIT) {
        fullMultipartBytes = new Uint8Array(await file.arrayBuffer());
      } else {
        restReader = file.stream().getReader();
        // Discard probe bytes already read from stream? Wait: reading file.stream() starts at 0!
        // So if > HEADER_PROBE_LIMIT, pass restReader starting from 0 and ignore firstChunk duplicate.
        firstChunk = new Uint8Array(headBuf);
        // Better: skip file.slice() duplicate by streaming from file.stream() directly below!
      }
    } else {
      const encodedName = c.req.header('X-File-Name') ?? '';
      try {
        filename = decodeURIComponent(encodedName);
      } catch {
        filename = encodedName;
      }
      categoryRaw = c.req.header('X-File-Category') ?? '';
      turnstileToken = c.req.header('X-Turnstile-Token') ?? '';
      reservedId = (c.req.header('X-Reserved-Id') ?? '').trim();
      reserveToken = (c.req.header('X-Reserve-Token') ?? '').trim();
      declaredSize = Number.parseInt(c.req.header('Content-Length') ?? '0', 10);

      if (!c.req.raw.body) {
        return c.json({ error: 'Empty upload stream.' }, 400);
      }
      if (!Number.isFinite(declaredSize) || declaredSize <= 0) {
        return c.json({ error: 'Valid Content-Length header is required for file uploads.' }, 411);
      }

      const reader = c.req.raw.body.getReader();
      const probed = await readStreamHead(reader, HEADER_PROBE_LIMIT);
      firstChunk = probed.head;
      if (!probed.done) {
        restReader = reader;
      } else {
        // Entire small file arrived inside the initial 16 KB probe
        declaredSize = firstChunk.byteLength;
      }
    }

    if (categoryRaw !== 'image' && categoryRaw !== 'document' && categoryRaw !== 'video') {
      if (restReader) await restReader.cancel().catch(() => {});
      return c.json({ error: 'Category must be image, document, or video.' }, 400);
    }
    const category = categoryRaw as Exclude<ItemType, 'link'>;

    if ((reservedId && !reserveToken) || (!reservedId && reserveToken)) {
      if (restReader) await restReader.cancel().catch(() => {});
      return c.json({ error: 'Both reserved ID and reservation token are required.' }, 400);
    }

    const now = Date.now();
    if (reservedId) {
      const reservation = await c.env.DB
        .prepare('SELECT token_hash, expires_at, used_at FROM upload_reservations WHERE id = ?')
        .bind(reservedId)
        .first<{ token_hash: string; expires_at: number; used_at: number | null }>();

      const incomingHash = await sha256Hex(reserveToken);
      if (
        !reservation ||
        reservation.used_at !== null ||
        reservation.expires_at <= now ||
        !constantTimeEqualStr(incomingHash, reservation.token_hash)
      ) {
        if (restReader) await restReader.cancel().catch(() => {});
        return c.json({ error: 'Invalid or expired upload reservation.' }, 403);
      }

      const existingFile = await c.env.DB
        .prepare('SELECT 1 FROM links_files WHERE id = ?')
        .bind(reservedId)
        .first();
      if (existingFile) {
        if (restReader) await restReader.cancel().catch(() => {});
        return c.json({ error: 'Reserved ID is already taken.' }, 409);
      }
    } else {
      // Verify Turnstile before accepting file bytes into R2
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

    const sizeLimit = FILE_SIZE_LIMITS[category];
    if (declaredSize > sizeLimit) {
      if (restReader) await restReader.cancel().catch(() => {});
      const mb = Math.round(sizeLimit / (1024 * 1024));
      return c.json({ error: `File exceeds the ${mb} MB maximum limit for ${category}s.` }, 413);
    }

    const validation = validateUploadedFileHeader({
      filename,
      category,
      sizeBytes: declaredSize,
      headerBytes: firstChunk,
    });
    if (!validation.ok) {
      if (restReader) await restReader.cancel().catch(() => {});
      return c.json({ error: validation.error }, 400);
    }

    // Storage space check + emergency cleanup if near 9.5 GB hard stop
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
        return c.json(
          { error: 'Storage is currently full and cannot accommodate this file even after cleanup.' },
          507
        );
      }
    }

    let id: string;
    if (reservedId) {
      const claim = await c.env.DB
        .prepare('UPDATE upload_reservations SET used_at = ? WHERE id = ? AND used_at IS NULL AND expires_at > ?')
        .bind(now, reservedId, now)
        .run();
      if (!claim.meta.changes) {
        if (restReader) await restReader.cancel().catch(() => {});
        return c.json({ error: 'Upload reservation was already used or expired.' }, 409);
      }
      id = reservedId;
    } else {
      id = await allocateUniqueId(c.env.DB, now);
    }

    const r2Key = `${category}/${crypto.randomUUID()}.${validation.meta.extension}`;
    const safeName = sanitizeDisplayFilename(filename);
    const deleteToken = generateRandomToken(32);
    const deleteTokenHash = await sha256Hex(deleteToken);

    let actualSize = 0;

    try {
      if (isMultipart) {
        if (fullMultipartBytes) {
          actualSize = fullMultipartBytes.byteLength;
          await c.env.FILES.put(r2Key, fullMultipartBytes, {
            httpMetadata: { contentType: validation.meta.mimeType },
          });
        } else if (restReader) {
          // For large multipart files, stream directly from file.stream() using FixedLengthStream if available
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
                    if (written > sizeLimit) throw new Error('SIZE_LIMIT_EXCEEDED');
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
              c.env.FILES.put(r2Key, fixed.readable, {
                httpMetadata: { contentType: validation.meta.mimeType },
              }),
            ]);
          } else {
            // Fallback for test environments without FixedLengthStream
            const chunks: Uint8Array[] = [];
            while (true) {
              const { done, value } = await restReader.read();
              if (done) break;
              if (value) {
                actualSize += value.byteLength;
                if (actualSize > sizeLimit) throw new Error('SIZE_LIMIT_EXCEEDED');
                chunks.push(value);
              }
            }
            const buf = new Uint8Array(actualSize);
            let off = 0;
            for (const ch of chunks) {
              buf.set(ch, off);
              off += ch.byteLength;
            }
            await c.env.FILES.put(r2Key, buf, {
              httpMetadata: { contentType: validation.meta.mimeType },
            });
          }
        }
      } else {
        // Raw streaming path: write probed firstChunk + restReader without buffering full file
        if (!restReader) {
          actualSize = firstChunk.byteLength;
          await c.env.FILES.put(r2Key, firstChunk, {
            httpMetadata: { contentType: validation.meta.mimeType },
          });
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
                  if (written > sizeLimit || written > declaredSize) {
                    throw new Error('SIZE_LIMIT_EXCEEDED');
                  }
                  await writer.write(value);
                }
              }
              if (written !== declaredSize) {
                throw new Error('SIZE_MISMATCH');
              }
              actualSize = written;
              await writer.close();
            } catch (err) {
              await writer.abort(err).catch(() => {});
              throw err;
            }
          })();

          await Promise.all([
            pump,
            c.env.FILES.put(r2Key, fixed.readable, {
              httpMetadata: { contentType: validation.meta.mimeType },
            }),
          ]);
        } else {
          // Fallback for Node/Vitest environment lacking FixedLengthStream
          const chunks: Uint8Array[] = [firstChunk];
          actualSize = firstChunk.byteLength;
          while (true) {
            const { done, value } = await restReader.read();
            if (done) break;
            if (value) {
              actualSize += value.byteLength;
              if (actualSize > sizeLimit) throw new Error('SIZE_LIMIT_EXCEEDED');
              chunks.push(value);
            }
          }
          const buf = new Uint8Array(actualSize);
          let off = 0;
          for (const ch of chunks) {
            buf.set(ch, off);
            off += ch.byteLength;
          }
          await c.env.FILES.put(r2Key, buf, {
            httpMetadata: { contentType: validation.meta.mimeType },
          });
        }
      }
    } catch (err) {
      await c.env.FILES.delete(r2Key).catch(() => {});
      const message = err instanceof Error && err.message === 'SIZE_LIMIT_EXCEEDED'
        ? 'Upload exceeded allowed file size limit.'
        : 'Upload stream interrupted or incomplete. Please try again.';
      return c.json({ error: message }, 400);
    }

    // Record in D1 & update running storage ledger atomically
    await c.env.DB.batch([
      c.env.DB
        .prepare(
          `INSERT INTO links_files (
            id, type, original_name, mime_type, size_bytes, r2_key, target_url,
            created_at, delete_token_hash, status, removed_reason
          ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, 'active', NULL)`
        )
        .bind(id, category, safeName, validation.meta.mimeType, actualSize, r2Key, now, deleteTokenHash),
      c.env.DB
        .prepare('UPDATE storage_stats SET total_bytes = total_bytes + ? WHERE id = 1')
        .bind(actualSize),
    ]);

    const originUrl = new URL(c.req.url).origin;
    // Run automatic cleanup check (excludes newly uploaded file)
    await runStorageCleanup({
      env: c.env,
      trigger: 'upload',
      excludeId: id,
      originUrl,
    });

    // Optional background 70% alert email
    runInBackground(c, maybeSendStorageAlert(c.env, now));

    return c.json(
      {
        id,
        type: category,
        originalName: safeName,
        mimeType: validation.meta.mimeType,
        sizeBytes: actualSize,
        shortUrl: buildShortUrl(c.req.url, id),
        deleteToken,
        createdAt: now,
      },
      201
    );
  });

  // 2b. Convert validated DOC/DOCX to PDF via headless LibreOffice microservice (when configured)
  app.post('/api/convert-word', async (c) => {
    const converterBase = (c.env.WORD_CONVERTER_URL ?? '').trim().replace(/\/+$/, '');
    if (!converterBase) {
      return c.json(
        {
          error:
            'Word-to-PDF conversion is coming soon on this server. Please export your document to PDF first.',
        },
        503
      );
    }

    const ip = getClientIp(c.req.raw);
    const uploadRateLimit = getUploadRateLimitConfig(c.env);
    const rate = await checkRateLimit({
      db: c.env.DB,
      key: `convert:${ip}`,
      limit: uploadRateLimit.maxUploads,
      windowMs: uploadRateLimit.windowMs,
    });

    if (!rate.allowed) {
      const windowLabel = formatRateWindowLabel(uploadRateLimit.windowSeconds);
      c.header('Retry-After', String(rate.retryAfterSeconds));
      return c.json(
        {
          error: `Conversion limit reached (${uploadRateLimit.maxUploads}/${windowLabel}). Please try again in ${rate.retryAfterSeconds}s.`,
        },
        429
      );
    }

    const encodedName = c.req.header('X-File-Name') ?? '';
    let filename = '';
    try {
      filename = decodeURIComponent(encodedName);
    } catch {
      filename = encodedName;
    }

    const ext = getPathExtension(filename);
    if (ext !== 'doc' && ext !== 'docx') {
      return c.json({ error: 'Only .doc and .docx Word files can be converted to PDF.' }, 400);
    }

    const declaredSize = Number.parseInt(c.req.header('Content-Length') ?? '0', 10);
    if (!c.req.raw.body) {
      return c.json({ error: 'Empty Word document stream.' }, 400);
    }
    if (!Number.isFinite(declaredSize) || declaredSize <= 0) {
      return c.json({ error: 'Valid Content-Length header is required.' }, 411);
    }

    const sizeLimit = FILE_SIZE_LIMITS.document;
    if (declaredSize > sizeLimit) {
      const mb = Math.round(sizeLimit / (1024 * 1024));
      return c.json({ error: `Word file exceeds the ${mb} MB maximum limit.` }, 413);
    }

    const now = Date.now();
    const sourceId = (c.req.header('X-Source-Id') ?? '').trim();
    const deleteToken = (c.req.header('X-Delete-Token') ?? '').trim();
    const turnstileToken = c.req.header('X-Turnstile-Token') ?? '';

    if (sourceId || deleteToken) {
      const validTicket = await verifySourceUploadTicket({
        db: c.env.DB,
        sourceId,
        deleteToken,
        now,
      });
      if (!validTicket) {
        return c.json({ error: 'Invalid or expired source upload token.' }, 403);
      }
    } else {
      const turnstile = await verifyTurnstileToken({
        token: turnstileToken,
        secretKey: c.env.TURNSTILE_SECRET_KEY,
        remoteIp: ip,
      });
      if (!turnstile.ok) {
        return c.json({ error: turnstile.error ?? 'Security check failed.' }, 403);
      }
    }

    const reader = c.req.raw.body.getReader();
    const probed = await readStreamHead(reader, HEADER_PROBE_LIMIT);
    const firstChunk = probed.head;
    const actualProbeSize = probed.done ? firstChunk.byteLength : declaredSize;

    const validation = validateUploadedFileHeader({
      filename,
      category: 'document',
      sizeBytes: actualProbeSize,
      headerBytes: firstChunk,
    });
    if (!validation.ok) {
      if (!probed.done) await reader.cancel().catch(() => {});
      return c.json({ error: validation.error }, 400);
    }

    let wordBytes: Uint8Array;
    if (probed.done) {
      wordBytes = firstChunk;
    } else {
      const chunks: Uint8Array[] = [firstChunk];
      let total = firstChunk.byteLength;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.byteLength > 0) {
          total += value.byteLength;
          if (total > sizeLimit || total > declaredSize) {
            await reader.cancel().catch(() => {});
            return c.json({ error: 'Word upload exceeded declared size limit.' }, 413);
          }
          chunks.push(value);
        }
      }
      if (total !== declaredSize) {
        return c.json({ error: 'Upload stream interrupted or incomplete.' }, 400);
      }
      wordBytes = new Uint8Array(total);
      let off = 0;
      for (const ch of chunks) {
        wordBytes.set(ch, off);
        off += ch.byteLength;
      }
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/octet-stream',
      'X-File-Ext': validation.meta.extension,
    };
    const converterSecret = (c.env.WORD_CONVERTER_SECRET ?? '').trim();
    if (converterSecret) {
      headers['Authorization'] = `Bearer ${converterSecret}`;
    }

    let convRes: Response;
    try {
      const bodyCopy = new Uint8Array(wordBytes.byteLength);
      bodyCopy.set(wordBytes);
      convRes = await fetch(`${converterBase}/convert`, {
        method: 'POST',
        headers,
        body: bodyCopy,
        signal: AbortSignal.timeout(45_000),
      });
    } catch {
      return c.json({ error: 'Word-to-PDF converter service timed out or could not be reached.' }, 502);
    }

    if (!convRes.ok) {
      const errBody = (await convRes.json().catch(() => ({}))) as { error?: string };
      return c.json(
        { error: errBody.error || `Word-to-PDF conversion failed (${convRes.status}).` },
        502
      );
    }

    const pdfBytes = new Uint8Array(await convRes.arrayBuffer());
    if (pdfBytes.byteLength < 8 || pdfBytes.byteLength > sizeLimit) {
      return c.json({ error: 'Converted PDF has invalid size.' }, 502);
    }
    const pdfSig = new TextDecoder('ascii').decode(pdfBytes.subarray(0, Math.min(32, pdfBytes.byteLength)));
    if (!pdfSig.includes('%PDF-')) {
      return c.json({ error: 'Converter returned invalid PDF content.' }, 502);
    }

    return new Response(pdfBytes, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Length': String(pdfBytes.byteLength),
        'Cache-Control': 'no-store',
      },
    });
  });

  // 3. Fast QR resolution route (GET /f/:id) + raw file route for Open in App / client-side preview
  const handleServeQrItem = async (
    c: Context<{ Bindings: Env }>,
    isRawRoute: boolean
  ): Promise<Response> => {
    const id = (c.req.param('id') ?? '').trim();
    const isGet = c.req.method.toUpperCase() === 'GET';
    const downloadMode = c.req.query('download') === '1';
    const rawMode = isRawRoute || c.req.query('raw') === '1';
    const rangeHeader = c.req.header('Range') ?? null;
    const canonicalCacheUrl = new URL(`/f/${id}`, c.req.url).toString();

    // Edge cache check (only for bare GET /f/:id without Range, raw, or ?download=1)
    const cache = typeof caches !== 'undefined'
      ? (caches as unknown as { default: Cache }).default
      : null;

    if (cache && isGet && !rangeHeader && !downloadMode && !rawMode) {
      const cached = await cache.match(canonicalCacheUrl);
      if (cached) return cached;
    }

    const row = await c.env.DB
      .prepare('SELECT * FROM links_files WHERE id = ?')
      .bind(id)
      .first<LinkFileRow>();

    const appName = c.env.APP_NAME ?? 'Captain Azhar Center';
    const homeUrl = c.env.FRONTEND_URL ?? '/';

    if (!row) {
      return c.html(
        renderStatusHtml({
          title: 'QR Link Not Found',
          heading: 'This QR code link was not found',
          message: 'The link may have been mistyped or no longer exists.',
          appName,
          homeUrl,
        }),
        404,
        { 'Cache-Control': 'no-store' }
      );
    }

    if (row.status === 'removed') {
      const msg = row.removed_reason === 'cleanup_fifo'
        ? 'This file was removed to free up storage.'
        : 'This file was deleted and is no longer available.';
      return c.html(
        renderStatusHtml({
          title: 'File Removed',
          heading: msg,
          message: 'Free storage capacity is recycled automatically from oldest uploads first so new QR codes keep working.',
          appName,
          homeUrl,
        }),
        410,
        { 'Cache-Control': 'no-store' }
      );
    }

    if (row.status === 'blocked') {
      return c.html(
        renderStatusHtml({
          title: 'Link Unavailable',
          heading: 'This item has been blocked',
          message: 'This content was disabled by the administrator for violating service guidelines.',
          appName,
          homeUrl,
        }),
        451,
        { 'Cache-Control': 'no-store' }
      );
    }

    if (row.type === 'link') {
      if (isRawRoute) {
        return c.text('File not found', 404);
      }
      if (!row.target_url) {
        return c.text('Invalid redirect target', 404);
      }
      const response = new Response(null, {
        status: 302,
        headers: {
          Location: row.target_url,
          'Cache-Control': 'public, max-age=0, s-maxage=300, must-revalidate',
          'X-Content-Type-Options': 'nosniff',
          'Referrer-Policy': 'strict-origin-when-cross-origin',
        },
      });
      if (cache && isGet) {
        runInBackground(c, cache.put(canonicalCacheUrl, response.clone()));
      }
      return response;
    }

    if (!row.r2_key) {
      return c.text('File reference missing', 404);
    }

    if (isBlockedSvgRow(row)) {
      return c.text('SVG files are not allowed for security reasons.', 415, {
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
      });
    }

    const safeFilename = sanitizeDisplayFilename(row.original_name ?? `${row.id}`);
    const officeExt = getOfficeExtension(row);

    // Office documents (DOC, DOCX, XLS, XLSX, PPT, PPTX) render the full-screen Microsoft Office Online viewer page
    if (officeExt && !rawMode && !downloadMode) {
      const rawFilename = buildOfficeRawFilename(safeFilename, officeExt);
      const encodedRawName = encodeURIComponent(rawFilename);
      const origin = new URL(c.req.url).origin;
      const rawPublicUrl = `${origin}/f/${id}/raw/${encodedRawName}`;
      const downloadUrl = `/f/${id}/raw/${encodedRawName}?download=1`;
      const nonce = generateRandomToken(16);

      const html = renderOfficeViewerHtml({
        filename: safeFilename,
        extension: officeExt,
        rawPublicUrl,
        downloadUrl,
        nonce,
        appName,
      });

      const response = new Response(html, {
        status: 200,
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'X-Content-Type-Options': 'nosniff',
          'Referrer-Policy': 'strict-origin-when-cross-origin',
          'Content-Security-Policy': [
            "default-src 'none'",
            "style-src 'unsafe-inline'",
            `script-src 'nonce-${nonce}'`,
            'frame-src https://view.officeapps.live.com',
            "base-uri 'none'",
            "form-action 'none'",
            "frame-ancestors 'none'",
          ].join('; '),
          'Cache-Control': 'public, max-age=0, s-maxage=3600, must-revalidate',
          ETag: `"office-viewer-${row.id}-${row.created_at}"`,
        },
      });

      if (cache && isGet && !rangeHeader) {
        runInBackground(c, cache.put(canonicalCacheUrl, response.clone()));
      }
      return response;
    }

    const parsedRange = parseByteRange(rangeHeader, row.size_bytes);
    if (parsedRange === 'invalid') {
      return new Response('Requested Range Not Satisfiable', {
        status: 416,
        headers: { 'Content-Range': `bytes */${row.size_bytes}` },
      });
    }

    const r2Object = parsedRange
      ? await c.env.FILES.get(row.r2_key, {
          range: { offset: parsedRange.offset, length: parsedRange.length },
        })
      : await c.env.FILES.get(row.r2_key);

    if (!r2Object) {
      return c.html(
        renderStatusHtml({
          title: 'File Removed',
          heading: 'This file was removed to free up storage.',
          message: 'The requested file is no longer present in storage.',
          appName,
          homeUrl,
        }),
        410,
        { 'Cache-Control': 'no-store' }
      );
    }

    const disposition = downloadMode
      ? `attachment; filename="${safeFilename}"`
      : `inline; filename="${safeFilename}"`;

    const contentType = row.mime_type
      ?? (isPdfRow(row) ? 'application/pdf' : 'application/octet-stream');

    const cspKind = row.type === 'image'
      ? 'image'
      : row.type === 'video'
        ? 'video'
        : officeExt
          ? 'office'
          : 'pdf';

    const headers = new Headers({
      'Content-Type': contentType,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Content-Disposition': disposition,
      'Accept-Ranges': 'bytes',
      'Content-Security-Policy': getFileCspHeader(cspKind),
      'Cache-Control': 'public, max-age=0, s-maxage=3600, must-revalidate',
      ETag: `"${row.id}-${row.created_at}"`,
      Vary: 'Range',
    });

    if (parsedRange) {
      headers.set('Content-Range', `bytes ${parsedRange.start}-${parsedRange.end}/${row.size_bytes}`);
      headers.set('Content-Length', String(parsedRange.length));
      return new Response(r2Object.body, { status: 206, headers });
    }

    headers.set('Content-Length', String(row.size_bytes));
    const response = new Response(r2Object.body, { status: 200, headers });

    // Edge cache canonical /f/:id files under 15 MB to reduce R2 read counts on heavily scanned QRs
    if (cache && isGet && !rawMode && !downloadMode && !officeExt && row.size_bytes <= 15 * 1024 * 1024) {
      runInBackground(c, cache.put(canonicalCacheUrl, response.clone()));
    }

    return response;
  };

  app.get('/f/:id', (c) => handleServeQrItem(c, false));
  app.get('/f/:id/raw', (c) => handleServeQrItem(c, true));
  app.get('/f/:id/raw/:filename', (c) => handleServeQrItem(c, true));

  // 4. Uploader self-delete using deleteToken
  app.delete('/api/f/:id', async (c) => {
    const id = (c.req.param('id') ?? '').trim();
    let token = c.req.header('X-Delete-Token') ?? c.req.query('token') ?? '';
    if (!token) {
      try {
        const body = (await c.req.json()) as { deleteToken?: string };
        token = body.deleteToken ?? '';
      } catch {
        // Ignore empty body
      }
    }

    if (!token) {
      return c.json({ error: 'Delete token is required.' }, 401);
    }

    const row = await c.env.DB
      .prepare('SELECT * FROM links_files WHERE id = ?')
      .bind(id)
      .first<LinkFileRow>();

    if (!row) {
      return c.json({ error: 'Item not found.' }, 404);
    }
    if (row.status !== 'active') {
      return c.json({ error: 'Item is already removed or blocked.' }, 410);
    }

    const incomingHash = await sha256Hex(token);
    if (!row.delete_token_hash || !constantTimeEqualStr(incomingHash, row.delete_token_hash)) {
      return c.json({ error: 'Invalid delete token.' }, 403);
    }

    if (row.r2_key) {
      await c.env.FILES.delete(row.r2_key);
    }

    const statements: D1PreparedStatement[] = [
      c.env.DB
        .prepare("UPDATE links_files SET status = 'removed', removed_reason = 'uploader_delete' WHERE id = ?")
        .bind(id),
    ];
    if (row.size_bytes > 0) {
      statements.push(
        c.env.DB
          .prepare('UPDATE storage_stats SET total_bytes = MAX(0, total_bytes - ?) WHERE id = 1')
          .bind(row.size_bytes)
      );
    }

    await c.env.DB.batch(statements);
    await purgeShortLinkCache(new URL(c.req.url).origin, id);

    return c.json({ ok: true, id, message: 'Deleted successfully.' });
  });

  // 5. Public abuse report
  app.post('/api/report', async (c) => {
    const ip = getClientIp(c.req.raw);
    const rate = await checkRateLimit({
      db: c.env.DB,
      key: `report:${ip}`,
      limit: 10,
      windowMs: HOUR_MS,
    });
    if (!rate.allowed) {
      return c.json({ error: 'Too many reports submitted. Please try again later.' }, 429);
    }

    let body: { idOrUrl?: string; reason?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON request body.' }, 400);
    }

    const rawRef = (body.idOrUrl ?? '').trim();
    const reason = (body.reason ?? '').trim();
    if (!rawRef || reason.length < 5 || reason.length > 500) {
      return c.json({ error: 'Please provide a valid short link/ID and a reason (5-500 characters).' }, 400);
    }

    let fileId = rawRef;
    const match = rawRef.match(/\/f\/([A-Za-z0-9_-]{4,20})/);
    if (match) {
      fileId = match[1];
    }

    if (!/^[A-Za-z0-9_-]{4,20}$/.test(fileId)) {
      return c.json({ error: 'Could not extract a valid QR short ID.' }, 400);
    }

    await c.env.DB
      .prepare('INSERT INTO reports (file_id, reason, time, resolved) VALUES (?, ?, ?, 0)')
      .bind(fileId, reason, Date.now())
      .run();

    return c.json({ ok: true, message: 'Thank you. Your report has been logged for owner review.' }, 201);
  });

  return app;
}
