import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AdminUserRow, CleanupLogRow, Env, LinkFileRow, ReportRow } from '../types';
import { GEMINI_MODEL_CONFIG } from '../config/geminiModels';
import {
  constantTimeEqualStr,
  createSessionToken,
  generateRandomToken,
  hashPassword,
  sha256Hex,
  verifyPassword,
  verifySignedSessionToken,
} from '../services/cryptoUtils';
import { checkRateLimit, clearRateLimit, getClientIp, isRateLimited } from '../services/rateLimit';
import { verifyTurnstileToken } from '../services/turnstile';
import { buildPasswordResetEmail, sendEmail } from '../services/email';
import {
  getStorageStats,
  purgeShortLinkCache,
  runStorageCleanup,
  STORAGE_LIMIT_BYTES,
} from '../services/cleanup';
import {
  encryptGeminiApiKey,
  getExtractSettings,
  listMaskedKeysForAdmin,
  maskGeminiApiKey,
  validateGeminiApiKeyFormat,
} from '../services/geminiKeys';

const SESSION_COOKIE_NAME = 'ck_admin_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const RESET_TTL_MS = 30 * 60 * 1000; // 30 minutes
const LOGIN_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const MIN_PASSWORD_LENGTH = 14;
const REQUIRED_CSRF_HEADER = 'CaptainAzharAdmin';

export function parseAllowedOrigins(env: Env, requestUrl: string): string[] {
  const configured = (env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const reqOrigin = new URL(requestUrl).origin;
  const set = new Set<string>(configured);

  // Automatically allow localhost dev origins only when the Worker itself is hit on localhost/test
  const reqHost = new URL(requestUrl).hostname;
  if (reqHost === 'localhost' || reqHost === '127.0.0.1' || reqHost === 'test.local') {
    set.add('http://localhost:5173');
    set.add('http://127.0.0.1:5173');
    set.add(reqOrigin);
  }
  return Array.from(set);
}

function getCookieValue(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  const parts = cookieHeader.split(';');
  for (const part of parts) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    if (key === name) {
      return decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return null;
}

function buildSessionCookieHeader(params: {
  value: string;
  maxAgeSeconds: number;
  requestUrl: string;
  sameOrigin?: boolean;
}): string {
  const { value, maxAgeSeconds, requestUrl, sameOrigin = false } = params;
  const isHttps = new URL(requestUrl).protocol === 'https:';
  const parts = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(value)}`,
    'HttpOnly',
    'Path=/api/admin',
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (isHttps) {
    parts.push('Secure');
    parts.push(sameOrigin ? 'SameSite=Strict' : 'SameSite=None');
  } else {
    parts.push('SameSite=Lax');
  }
  return parts.join('; ');
}

async function authenticateAdminRequest(
  c: Context<{ Bindings: Env }>
): Promise<AdminUserRow | null> {
  const secret = c.env.SESSION_SECRET;
  if (!secret) return null;

  const token = getCookieValue(c.req.header('Cookie'), SESSION_COOKIE_NAME);
  if (!token) return null;

  const validSig = await verifySignedSessionToken(token, secret);
  if (!validSig) return null;

  const tokenHash = await sha256Hex(token);
  const now = Date.now();
  const session = await c.env.DB
    .prepare('SELECT token_hash FROM admin_sessions WHERE token_hash = ? AND expires_at > ?')
    .bind(tokenHash, now)
    .first<{ token_hash: string }>();

  if (!session) return null;

  const admin = await c.env.DB
    .prepare('SELECT * FROM admin_user WHERE id = 1')
    .first<AdminUserRow>();

  return admin ?? null;
}

export function createAdminRoutes() {
  const app = new Hono<{ Bindings: Env }>();

  // Strict CSRF & Origin check on ALL state-changing admin routes
  app.use('*', async (c, next) => {
    const method = c.req.method.toUpperCase();
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
      return next();
    }

    const origin = c.req.header('Origin');
    const allowedOrigins = parseAllowedOrigins(c.env, c.req.url);
    if (!origin || !allowedOrigins.includes(origin)) {
      return c.json({ error: 'Forbidden origin.' }, 403);
    }

    const xRequestedWith = c.req.header('X-Requested-With');
    if (xRequestedWith !== REQUIRED_CSRF_HEADER) {
      return c.json({ error: 'Missing required CSRF verification header.' }, 403);
    }

    return next();
  });

  // Safe bootstrap check (never reveals owner email or secrets)
  app.get('/bootstrap', async (c) => {
    const row = await c.env.DB
      .prepare('SELECT COUNT(*) AS cnt FROM admin_user')
      .first<{ cnt: number }>();
    return c.json({ initialized: (row?.cnt ?? 0) > 0 });
  });

  // One-time owner sign-up (permanently locked once 1 row exists)
  app.post('/signup', async (c) => {
    if (!c.env.ADMIN_EMAIL || !c.env.SESSION_SECRET) {
      return c.json({ error: 'Server admin configuration is incomplete.' }, 500);
    }

    const existing = await c.env.DB
      .prepare('SELECT COUNT(*) AS cnt FROM admin_user')
      .first<{ cnt: number }>();

    if ((existing?.cnt ?? 0) > 0) {
      return c.json({ error: 'Admin sign-up is permanently disabled.' }, 403);
    }

    let body: { email?: string; password?: string; turnstileToken?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON request body.' }, 400);
    }

    const ip = getClientIp(c.req.raw);
    const turnstile = await verifyTurnstileToken({
      token: body.turnstileToken,
      secretKey: c.env.TURNSTILE_SECRET_KEY,
      remoteIp: ip,
    });
    if (!turnstile.ok) {
      return c.json({ error: turnstile.error ?? 'Security verification failed.' }, 403);
    }

    const submittedEmail = (body.email ?? '').trim().toLowerCase();
    const ownerEmail = c.env.ADMIN_EMAIL.trim().toLowerCase();
    if (!submittedEmail || !constantTimeEqualStr(submittedEmail, ownerEmail)) {
      return c.json({ error: 'Sign-up is restricted to the designated owner email.' }, 403);
    }

    const password = body.password ?? '';
    if (password.length < MIN_PASSWORD_LENGTH || password.length > 256) {
      return c.json(
        { error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters long.` },
        400
      );
    }

    const { hashHex, saltHex } = await hashPassword(password);
    const now = Date.now();

    try {
      const insertRes = await c.env.DB
        .prepare(
          `INSERT INTO admin_user (id, email, password_hash, salt, created_at)
           VALUES (1, ?, ?, ?, ?)`
        )
        .bind(ownerEmail, hashHex, saltHex, now)
        .run();

      if (!insertRes.meta.changes) {
        return c.json({ error: 'Admin sign-up is permanently disabled.' }, 403);
      }
    } catch {
      return c.json({ error: 'Admin sign-up is permanently disabled.' }, 403);
    }

    const { token, tokenHash } = await createSessionToken(c.env.SESSION_SECRET);
    await c.env.DB
      .prepare('INSERT INTO admin_sessions (token_hash, created_at, expires_at) VALUES (?, ?, ?)')
      .bind(tokenHash, now, now + SESSION_TTL_MS)
      .run();

    c.header(
      'Set-Cookie',
      buildSessionCookieHeader({
        value: token,
        maxAgeSeconds: Math.floor(SESSION_TTL_MS / 1000),
        requestUrl: c.req.url,
        sameOrigin: c.env.SAME_ORIGIN_COOKIES === 'true',
      })
    );

    return c.json({ ok: true, email: ownerEmail }, 201);
  });

  // Owner login (rate-limited + Turnstile + PBKDF2 constant-time)
  app.post('/login', async (c) => {
    if (!c.env.ADMIN_EMAIL || !c.env.SESSION_SECRET) {
      return c.json({ error: 'Server admin configuration is incomplete.' }, 500);
    }

    const ip = getClientIp(c.req.raw);
    const rateKey = `login_fail:${ip}`;
    const lockStatus = await isRateLimited({
      db: c.env.DB,
      key: rateKey,
      limit: 5,
      windowMs: LOGIN_WINDOW_MS,
    });
    if (lockStatus.limited) {
      return c.json(
        { error: `Too many failed login attempts. Try again in ${lockStatus.retryAfterSeconds}s.` },
        429
      );
    }

    let body: { email?: string; password?: string; turnstileToken?: string };
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
      return c.json({ error: turnstile.error ?? 'Security verification failed.' }, 403);
    }

    const submittedEmail = (body.email ?? '').trim().toLowerCase();
    const ownerEmail = c.env.ADMIN_EMAIL.trim().toLowerCase();
    const password = body.password ?? '';
    const now = Date.now();

    const admin = await c.env.DB
      .prepare('SELECT * FROM admin_user WHERE id = 1')
      .first<AdminUserRow>();

    let ok = false;
    if (
      admin &&
      constantTimeEqualStr(submittedEmail, ownerEmail) &&
      constantTimeEqualStr(admin.email.toLowerCase(), ownerEmail)
    ) {
      ok = await verifyPassword(password, admin.password_hash, admin.salt);
    } else {
      // Perform dummy PBKDF2 work to keep failure timing consistent
      await hashPassword(password || 'dummy-timing-password-padding');
    }

    await c.env.DB
      .prepare('INSERT INTO login_attempts (time, ip, success) VALUES (?, ?, ?)')
      .bind(now, ip, ok ? 1 : 0)
      .run();

    if (!ok) {
      await checkRateLimit({
        db: c.env.DB,
        key: rateKey,
        limit: 5,
        windowMs: LOGIN_WINDOW_MS,
        now,
      });
      return c.json({ error: 'Invalid email or password.' }, 401);
    }

    await clearRateLimit(c.env.DB, rateKey);

    const { token, tokenHash } = await createSessionToken(c.env.SESSION_SECRET);
    await c.env.DB
      .prepare('INSERT INTO admin_sessions (token_hash, created_at, expires_at) VALUES (?, ?, ?)')
      .bind(tokenHash, now, now + SESSION_TTL_MS)
      .run();

    c.header(
      'Set-Cookie',
      buildSessionCookieHeader({
        value: token,
        maxAgeSeconds: Math.floor(SESSION_TTL_MS / 1000),
        requestUrl: c.req.url,
        sameOrigin: c.env.SAME_ORIGIN_COOKIES === 'true',
      })
    );

    return c.json({ ok: true, email: admin!.email });
  });

  // Logout
  app.post('/logout', async (c) => {
    const token = getCookieValue(c.req.header('Cookie'), SESSION_COOKIE_NAME);
    if (token) {
      const tokenHash = await sha256Hex(token);
      await c.env.DB.prepare('DELETE FROM admin_sessions WHERE token_hash = ?').bind(tokenHash).run();
    }

    c.header(
      'Set-Cookie',
      buildSessionCookieHeader({
        value: '',
        maxAgeSeconds: 0,
        requestUrl: c.req.url,
        sameOrigin: c.env.SAME_ORIGIN_COOKIES === 'true',
      })
    );
    return c.json({ ok: true });
  });

  // Forgot password (always returns uniform response; emails only ADMIN_EMAIL)
  app.post('/forgot', async (c) => {
    const ip = getClientIp(c.req.raw);
    const rate = await checkRateLimit({
      db: c.env.DB,
      key: `forgot:${ip}`,
      limit: 3,
      windowMs: LOGIN_WINDOW_MS,
    });
    if (!rate.allowed) {
      return c.json({ error: 'Too many reset requests. Please try again later.' }, 429);
    }

    let body: { email?: string; turnstileToken?: string };
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
      return c.json({ error: turnstile.error ?? 'Security verification failed.' }, 403);
    }

    const uniformMessage = 'If this matches the owner account, a one-time reset link has been sent.';
    const submittedEmail = (body.email ?? '').trim().toLowerCase();
    const ownerEmail = (c.env.ADMIN_EMAIL ?? '').trim().toLowerCase();

    if (ownerEmail && submittedEmail && constantTimeEqualStr(submittedEmail, ownerEmail)) {
      const admin = await c.env.DB
        .prepare('SELECT id FROM admin_user WHERE id = 1')
        .first<{ id: number }>();

      if (admin) {
        const rawToken = generateRandomToken(43);
        const tokenHash = await sha256Hex(rawToken);
        const now = Date.now();

        await c.env.DB
          .prepare('INSERT INTO password_resets (token_hash, expires_at, used_at) VALUES (?, ?, NULL)')
          .bind(tokenHash, now + RESET_TTL_MS)
          .run();

        const baseFrontend = (c.env.FRONTEND_URL ?? new URL(c.req.url).origin).replace(/\/+$/, '');
        const resetUrl = `${baseFrontend}/#/admin/reset?token=${encodeURIComponent(rawToken)}`;
        const emailContent = buildPasswordResetEmail(resetUrl, c.env.APP_NAME ?? 'Captain Azhar Center');
        await sendEmail(c.env, { to: ownerEmail, ...emailContent });
      }
    }

    return c.json({ ok: true, message: uniformMessage });
  });

  // Reset password using one-time token (expires in 30 min, invalidates all sessions)
  app.post('/reset', async (c) => {
    let body: { token?: string; newPassword?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON request body.' }, 400);
    }

    const rawToken = (body.token ?? '').trim();
    const newPassword = body.newPassword ?? '';

    if (!rawToken) {
      return c.json({ error: 'Reset token is required.' }, 400);
    }
    if (newPassword.length < MIN_PASSWORD_LENGTH || newPassword.length > 256) {
      return c.json(
        { error: `New password must be at least ${MIN_PASSWORD_LENGTH} characters long.` },
        400
      );
    }

    const tokenHash = await sha256Hex(rawToken);
    const now = Date.now();

    const updateReset = await c.env.DB
      .prepare(
        `UPDATE password_resets
         SET used_at = ?
         WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?`
      )
      .bind(now, tokenHash, now)
      .run();

    if (!updateReset.meta.changes) {
      return c.json({ error: 'Reset link is invalid or has expired.' }, 400);
    }

    const { hashHex, saltHex } = await hashPassword(newPassword);
    await c.env.DB.batch([
      c.env.DB
        .prepare('UPDATE admin_user SET password_hash = ?, salt = ? WHERE id = 1')
        .bind(hashHex, saltHex),
      c.env.DB.prepare('DELETE FROM admin_sessions'),
    ]);

    c.header(
      'Set-Cookie',
      buildSessionCookieHeader({
        value: '',
        maxAgeSeconds: 0,
        requestUrl: c.req.url,
        sameOrigin: c.env.SAME_ORIGIN_COOKIES === 'true',
      })
    );

    return c.json({ ok: true, message: 'Password updated. Please sign in with your new password.' });
  });

  // ---- Authenticated Endpoints Below ----
  app.use('*', async (c, next) => {
    const path = c.req.path;
    if (
      path.endsWith('/bootstrap') ||
      path.endsWith('/signup') ||
      path.endsWith('/login') ||
      path.endsWith('/logout') ||
      path.endsWith('/forgot') ||
      path.endsWith('/reset')
    ) {
      return next();
    }

    const admin = await authenticateAdminRequest(c);
    if (!admin) {
      return c.json({ error: 'Unauthorized. Please log in as admin.' }, 401);
    }
    return next();
  });

  app.get('/me', async (c) => {
    const admin = await authenticateAdminRequest(c);
    if (!admin) return c.json({ error: 'Unauthorized' }, 401);
    return c.json({ authenticated: true, email: admin.email });
  });

  app.get('/stats', async (c) => {
    const stats = await getStorageStats(c.env.DB);
    const countsRes = await c.env.DB
      .prepare(
        `SELECT type, COUNT(*) AS cnt
         FROM links_files
         WHERE status = 'active'
         GROUP BY type`
      )
      .all<{ type: string; cnt: number }>();

    const countsByType: Record<string, number> = {
      image: 0,
      document: 0,
      video: 0,
      link: 0,
    };
    for (const row of countsRes.results ?? []) {
      countsByType[row.type] = row.cnt;
    }

    const oldestFile = await c.env.DB
      .prepare(
        `SELECT created_at
         FROM links_files
         WHERE status = 'active' AND type IN ('image', 'document', 'video')
         ORDER BY created_at ASC
         LIMIT 1`
      )
      .first<{ created_at: number }>();

    const unresolvedReports = await c.env.DB
      .prepare('SELECT COUNT(*) AS cnt FROM reports WHERE resolved = 0')
      .first<{ cnt: number }>();

    const cleanupLogs = await c.env.DB
      .prepare('SELECT * FROM cleanup_log ORDER BY run_time DESC LIMIT 20')
      .all<CleanupLogRow>();

    const loginAttempts = await c.env.DB
      .prepare('SELECT id, time, ip, success FROM login_attempts ORDER BY time DESC LIMIT 20')
      .all<{ id: number; time: number; ip: string; success: number }>();

    return c.json({
      totalBytes: stats.total_bytes,
      limitBytes: STORAGE_LIMIT_BYTES,
      percentUsed: Number(((stats.total_bytes / STORAGE_LIMIT_BYTES) * 100).toFixed(2)),
      triggerPct: stats.trigger_pct,
      targetPct: stats.target_pct,
      expireLinksMonths: stats.expire_links_months,
      countsByType,
      oldestActiveFileDate: oldestFile?.created_at ?? null,
      unresolvedReportsCount: unresolvedReports?.cnt ?? 0,
      cleanupLogs: cleanupLogs.results ?? [],
      loginAttempts: loginAttempts.results ?? [],
    });
  });

  app.get('/files', async (c) => {
    const q = (c.req.query('q') ?? '').trim();
    const typeFilter = (c.req.query('type') ?? '').trim();
    const statusFilter = (c.req.query('status') ?? '').trim();
    const page = Math.max(1, Number.parseInt(c.req.query('page') ?? '1', 10) || 1);
    const pageSize = Math.min(50, Math.max(5, Number.parseInt(c.req.query('pageSize') ?? '20', 10) || 20));
    const offset = (page - 1) * pageSize;

    const conditions: string[] = [];
    const bindings: (string | number)[] = [];

    if (typeFilter && ['link', 'image', 'document', 'video'].includes(typeFilter)) {
      conditions.push('type = ?');
      bindings.push(typeFilter);
    }
    if (statusFilter && ['active', 'removed', 'blocked'].includes(statusFilter)) {
      conditions.push('status = ?');
      bindings.push(statusFilter);
    }
    if (q) {
      conditions.push('(id LIKE ? OR original_name LIKE ? OR target_url LIKE ?)');
      const like = `%${q}%`;
      bindings.push(like, like, like);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const countRow = await c.env.DB
      .prepare(`SELECT COUNT(*) AS total FROM links_files ${where}`)
      .bind(...bindings)
      .first<{ total: number }>();

    // Explicitly project ONLY safe fields (NEVER r2_key or delete_token_hash)
    const rows = await c.env.DB
      .prepare(
        `SELECT id, type, original_name, mime_type, size_bytes, target_url, created_at, status, removed_reason
         FROM links_files
         ${where}
         ORDER BY created_at DESC
         LIMIT ? OFFSET ?`
      )
      .bind(...bindings, pageSize, offset)
      .all<Omit<LinkFileRow, 'r2_key' | 'delete_token_hash'>>();

    return c.json({
      items: rows.results ?? [],
      total: countRow?.total ?? 0,
      page,
      pageSize,
    });
  });

  app.delete('/f/:id', async (c) => {
    const id = c.req.param('id').trim();
    const row = await c.env.DB
      .prepare('SELECT id, r2_key, size_bytes, status FROM links_files WHERE id = ?')
      .bind(id)
      .first<Pick<LinkFileRow, 'id' | 'r2_key' | 'size_bytes' | 'status'>>();

    if (!row) {
      return c.json({ error: 'Item not found.' }, 404);
    }

    if (row.r2_key) {
      await c.env.FILES.delete(row.r2_key);
    }

    const stmts: D1PreparedStatement[] = [
      c.env.DB
        .prepare("UPDATE links_files SET status = 'removed', removed_reason = 'owner_delete' WHERE id = ?")
        .bind(id),
    ];

    if (row.status === 'active' && row.size_bytes > 0) {
      stmts.push(
        c.env.DB
          .prepare('UPDATE storage_stats SET total_bytes = MAX(0, total_bytes - ?) WHERE id = 1')
          .bind(row.size_bytes)
      );
    }

    await c.env.DB.batch(stmts);
    await purgeShortLinkCache(new URL(c.req.url).origin, id);

    return c.json({ ok: true, id });
  });

  app.post('/block/:id', async (c) => {
    const id = c.req.param('id').trim();
    let body: { action?: 'block' | 'unblock' } = {};
    try {
      body = await c.req.json();
    } catch {
      // default to block
    }

    const row = await c.env.DB
      .prepare('SELECT id, status, r2_key FROM links_files WHERE id = ?')
      .bind(id)
      .first<Pick<LinkFileRow, 'id' | 'status' | 'r2_key'>>();

    if (!row) {
      return c.json({ error: 'Item not found.' }, 404);
    }

    const targetAction = body.action ?? (row.status === 'blocked' ? 'unblock' : 'block');
    if (targetAction === 'block') {
      await c.env.DB.batch([
        c.env.DB
          .prepare("UPDATE links_files SET status = 'blocked', removed_reason = 'abuse_blocked' WHERE id = ?")
          .bind(id),
        c.env.DB.prepare('UPDATE reports SET resolved = 1 WHERE file_id = ?').bind(id),
      ]);
      await purgeShortLinkCache(new URL(c.req.url).origin, id);
      return c.json({ ok: true, id, status: 'blocked' });
    }

    await c.env.DB
      .prepare("UPDATE links_files SET status = 'active', removed_reason = NULL WHERE id = ?")
      .bind(id)
      .run();
    await purgeShortLinkCache(new URL(c.req.url).origin, id);
    return c.json({ ok: true, id, status: 'active' });
  });

  app.post('/cleanup', async (c) => {
    const result = await runStorageCleanup({
      env: c.env,
      trigger: 'manual',
      force: true,
      originUrl: new URL(c.req.url).origin,
    });
    return c.json({ ok: true, ...result });
  });

  app.get('/reports', async (c) => {
    const res = await c.env.DB
      .prepare(
        `SELECT r.id, r.file_id, r.reason, r.time, r.resolved,
                l.type, l.original_name, l.target_url, l.status AS item_status
         FROM reports r
         LEFT JOIN links_files l ON l.id = r.file_id
         ORDER BY r.resolved ASC, r.time DESC
         LIMIT 50`
      )
      .all<ReportRow & { type?: string; original_name?: string; target_url?: string; item_status?: string }>();
    return c.json({ reports: res.results ?? [] });
  });

  app.post('/reports/:id/resolve', async (c) => {
    const id = Number.parseInt(c.req.param('id'), 10);
    if (!Number.isFinite(id)) return c.json({ error: 'Invalid report ID' }, 400);
    await c.env.DB.prepare('UPDATE reports SET resolved = 1 WHERE id = ?').bind(id).run();
    return c.json({ ok: true });
  });

  app.patch('/settings', async (c) => {
    let body: {
      triggerPct?: number;
      targetPct?: number;
      expireLinksMonths?: number | null;
    };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON request body.' }, 400);
    }

    const stats = await getStorageStats(c.env.DB);
    const triggerPct = body.triggerPct ?? stats.trigger_pct;
    const targetPct = body.targetPct ?? stats.target_pct;
    const expireLinksMonths = body.expireLinksMonths === undefined
      ? stats.expire_links_months
      : body.expireLinksMonths;

    if (!Number.isInteger(triggerPct) || triggerPct < 50 || triggerPct > 90) {
      return c.json({ error: 'Trigger threshold must be an integer between 50% and 90%.' }, 400);
    }
    if (!Number.isInteger(targetPct) || targetPct < 30 || targetPct > 85) {
      return c.json({ error: 'Target threshold must be an integer between 30% and 85%.' }, 400);
    }
    if (targetPct > triggerPct - 5) {
      return c.json({ error: 'Target percentage must be at least 5% lower than trigger percentage.' }, 400);
    }
    if (
      expireLinksMonths !== null &&
      (!Number.isInteger(expireLinksMonths) || expireLinksMonths < 1 || expireLinksMonths > 60)
    ) {
      return c.json({ error: 'Link expiry must be disabled (null) or between 1 and 60 months.' }, 400);
    }

    await c.env.DB
      .prepare(
        `UPDATE storage_stats
         SET trigger_pct = ?, target_pct = ?, expire_links_months = ?
         WHERE id = 1`
      )
      .bind(triggerPct, targetPct, expireLinksMonths)
      .run();

    return c.json({ ok: true, triggerPct, targetPct, expireLinksMonths });
  });

  // ---- Gemini API Keys & Extraction Settings (never exposes raw keys) ----
  app.get('/extract-settings', async (c) => {
    const settings = await getExtractSettings(c.env);
    const keyInfo = await listMaskedKeysForAdmin(c.env);
    return c.json({
      maxPdfMb: settings.max_pdf_mb,
      concurrency: settings.concurrency,
      inlineThresholdMb: settings.inline_threshold_mb,
      maxKeysLimit: GEMINI_MODEL_CONFIG.maxApiKeys,
      envKeysCount: keyInfo.envKeysCount,
      totalConfiguredCount: keyInfo.totalConfiguredCount,
      keys: keyInfo.keys,
    });
  });

  app.patch('/extract-settings', async (c) => {
    let body: { maxPdfMb?: number; concurrency?: number; inlineThresholdMb?: number };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON request body.' }, 400);
    }

    const current = await getExtractSettings(c.env);
    const maxPdfMb = body.maxPdfMb ?? current.max_pdf_mb;
    const concurrency = body.concurrency ?? current.concurrency;
    const inlineThresholdMb = body.inlineThresholdMb ?? current.inline_threshold_mb;

    if (!Number.isInteger(maxPdfMb) || maxPdfMb < 5 || maxPdfMb > 50) {
      return c.json({ error: 'Max PDF size must be an integer between 5 MB and 50 MB.' }, 400);
    }
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 20) {
      return c.json({ error: 'Concurrency must be an integer between 1 and 20.' }, 400);
    }
    if (!Number.isInteger(inlineThresholdMb) || inlineThresholdMb < 1 || inlineThresholdMb > 15) {
      return c.json({ error: 'Inline threshold must be an integer between 1 MB and 15 MB.' }, 400);
    }

    await c.env.DB
      .prepare(
        `UPDATE extract_settings
         SET max_pdf_mb = ?, concurrency = ?, inline_threshold_mb = ?
         WHERE id = 1`
      )
      .bind(maxPdfMb, concurrency, inlineThresholdMb)
      .run();

    return c.json({ ok: true, maxPdfMb, concurrency, inlineThresholdMb });
  });

  app.post('/gemini-keys', async (c) => {
    const secret = (c.env.SESSION_SECRET ?? '').trim();
    if (!secret) {
      return c.json({ error: 'Server SESSION_SECRET is not configured for encrypting keys.' }, 500);
    }

    let body: { apiKey?: string; label?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON request body.' }, 400);
    }

    const check = validateGeminiApiKeyFormat(body.apiKey ?? '');
    if (!check.ok) {
      return c.json({ error: check.error }, 400);
    }

    const keyInfo = await listMaskedKeysForAdmin(c.env);
    if (keyInfo.keys.length >= GEMINI_MODEL_CONFIG.maxApiKeys) {
      return c.json(
        { error: `Maximum ${GEMINI_MODEL_CONFIG.maxApiKeys} Gemini API keys are allowed.` },
        400
      );
    }

    const keyHash = await sha256Hex(check.cleaned);
    const existing = await c.env.DB
      .prepare('SELECT id FROM gemini_api_keys WHERE key_hash = ?')
      .bind(keyHash)
      .first<{ id: string }>();
    if (existing) {
      return c.json({ error: 'This Gemini API key is already added.' }, 409);
    }

    const id = crypto.randomUUID();
    const maskedKey = maskGeminiApiKey(check.cleaned);
    const encryptedKey = await encryptGeminiApiKey(check.cleaned, secret);
    const label = (body.label ?? '').trim().slice(0, 60) || `Key ${keyInfo.keys.length + 1}`;
    const now = Date.now();

    await c.env.DB
      .prepare(
        `INSERT INTO gemini_api_keys
         (id, label, encrypted_key, masked_key, key_hash, enabled, cooldown_until, last_used_at, success_count, error_count, last_error, created_at)
         VALUES (?, ?, ?, ?, ?, 1, 0, 0, 0, 0, NULL, ?)`
      )
      .bind(id, label, encryptedKey, maskedKey, keyHash, now)
      .run();

    return c.json(
      {
        ok: true,
        key: {
          id,
          source: 'db' as const,
          label,
          maskedKey,
          enabled: true,
          cooldownUntil: 0,
          lastUsedAt: 0,
          successCount: 0,
          errorCount: 0,
          lastError: null,
          createdAt: now,
        },
      },
      201
    );
  });

  app.patch('/gemini-keys/:id', async (c) => {
    const id = c.req.param('id').trim();
    let body: { enabled?: boolean; label?: string; clearCooldown?: boolean };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON request body.' }, 400);
    }

    const existing = await c.env.DB
      .prepare('SELECT id, label, enabled, cooldown_until FROM gemini_api_keys WHERE id = ?')
      .bind(id)
      .first<{ id: string; label: string | null; enabled: number; cooldown_until: number }>();

    if (!existing) {
      return c.json({ error: 'API key not found.' }, 404);
    }

    const nextEnabled = body.enabled === undefined ? existing.enabled : body.enabled ? 1 : 0;
    const nextLabel =
      body.label === undefined ? existing.label : body.label.trim().slice(0, 60) || existing.label;
    const nextCooldown = body.clearCooldown ? 0 : existing.cooldown_until;

    await c.env.DB
      .prepare(
        'UPDATE gemini_api_keys SET enabled = ?, label = ?, cooldown_until = ? WHERE id = ?'
      )
      .bind(nextEnabled, nextLabel, nextCooldown, id)
      .run();

    return c.json({ ok: true, id, enabled: nextEnabled === 1, label: nextLabel });
  });

  app.delete('/gemini-keys/:id', async (c) => {
    const id = c.req.param('id').trim();
    const res = await c.env.DB
      .prepare('DELETE FROM gemini_api_keys WHERE id = ?')
      .bind(id)
      .run();

    if (!res.meta.changes) {
      return c.json({ error: 'API key not found.' }, 404);
    }
    return c.json({ ok: true, id });
  });

  return app;
}
