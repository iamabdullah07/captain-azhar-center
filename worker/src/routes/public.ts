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
import { checkRateLimit, getClientIp } from '../services/rateLimit';
import { verifyTurnstileToken } from '../services/turnstile';
import {
  getStorageStats,
  HARD_STOP_BYTES,
  maybeSendStorageAlert,
  purgeShortLinkCache,
  runStorageCleanup,
} from '../services/cleanup';
import { renderStatusHtml } from '../views/statusPages';

const HOUR_MS = 60 * 60 * 1000;
const HEADER_PROBE_LIMIT = 16 * 1024; // 16 KB magic-byte peek

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

async function allocateUniqueId(db: D1Database): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = generateShortId(9);
    const exists = await db.prepare('SELECT 1 FROM links_files WHERE id = ?').bind(candidate).first();
    if (!exists) return candidate;
  }
  return generateShortId(10);
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
    return c.json({ ok: true, service: c.env.APP_NAME ?? 'Captain Azhar Center' });
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

  // 2. Upload file (image, document, video)
  // Supports raw binary streaming (X-File-Name + X-File-Category + Content-Length) to stay well within
  // 128 MB Worker RAM even on 50 MB video uploads, as well as standard multipart/form-data.
  app.post('/api/upload', async (c) => {
    const ip = getClientIp(c.req.raw);
    const rate = await checkRateLimit({
      db: c.env.DB,
      key: `upload:${ip}`,
      limit: 10,
      windowMs: HOUR_MS,
    });

    if (!rate.allowed) {
      return c.json(
        { error: `Upload limit reached (10/hour). Please try again in ${rate.retryAfterSeconds}s.` },
        429
      );
    }

    const contentType = (c.req.header('Content-Type') ?? '').toLowerCase();
    const isMultipart = contentType.startsWith('multipart/form-data');

    let filename = '';
    let categoryRaw = '';
    let turnstileToken: string | undefined;
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

    const id = await allocateUniqueId(c.env.DB);
    const r2Key = `${category}/${crypto.randomUUID()}.${validation.meta.extension}`;
    const safeName = sanitizeDisplayFilename(filename);
    const deleteToken = generateRandomToken(32);
    const deleteTokenHash = await sha256Hex(deleteToken);
    const now = Date.now();

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

  // 3. Fast QR resolution route (GET /f/:id)
  app.get('/f/:id', async (c) => {
    const id = c.req.param('id').trim();
    const rangeHeader = c.req.header('Range') ?? null;
    const canonicalCacheUrl = new URL(`/f/${id}`, c.req.url).toString();

    // Edge cache check (skip for Range requests so partial video chunks work accurately)
    const cache = typeof caches !== 'undefined'
      ? (caches as unknown as { default: Cache }).default
      : null;

    if (cache && !rangeHeader) {
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
      if (!row.target_url) {
        return c.text('Invalid redirect target', 404);
      }
      const response = new Response(null, {
        status: 302,
        headers: {
          Location: row.target_url,
          'Cache-Control': 'public, max-age=0, s-maxage=300, must-revalidate',
          'X-Content-Type-Options': 'nosniff',
        },
      });
      if (cache) {
        runInBackground(c, cache.put(canonicalCacheUrl, response.clone()));
      }
      return response;
    }

    if (!row.r2_key) {
      return c.text('File reference missing', 404);
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

    const safeFilename = sanitizeDisplayFilename(row.original_name ?? `${row.id}`);
    const disposition = row.type === 'document'
      ? `attachment; filename="${safeFilename}"`
      : `inline; filename="${safeFilename}"`;

    const headers = new Headers({
      'Content-Type': row.mime_type ?? 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': disposition,
      'Accept-Ranges': 'bytes',
      'Content-Security-Policy': "default-src 'none'; media-src 'self'; img-src 'self'; sandbox",
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

    // Edge cache files under 15 MB to reduce R2 read counts on heavily scanned QRs
    if (cache && row.size_bytes <= 15 * 1024 * 1024) {
      runInBackground(c, cache.put(canonicalCacheUrl, response.clone()));
    }

    return response;
  });

  // 4. Uploader self-delete using deleteToken
  app.delete('/api/f/:id', async (c) => {
    const id = c.req.param('id').trim();
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
