import type { Env } from '../types';

export const UPLOAD_RATE_LIMIT_CONFIG = {
  maxUploads: 10,
  windowSeconds: 120,
} as const;

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return fallback;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Resolves upload rate limit settings from Worker env vars with a single constant fallback.
 */
export function getUploadRateLimitConfig(
  env: Pick<Env, 'UPLOAD_RATE_LIMIT_MAX' | 'UPLOAD_RATE_LIMIT_WINDOW_SECONDS'>
): { maxUploads: number; windowSeconds: number; windowMs: number } {
  const maxUploads = parsePositiveInt(
    env.UPLOAD_RATE_LIMIT_MAX,
    UPLOAD_RATE_LIMIT_CONFIG.maxUploads
  );
  const windowSeconds = parsePositiveInt(
    env.UPLOAD_RATE_LIMIT_WINDOW_SECONDS,
    UPLOAD_RATE_LIMIT_CONFIG.windowSeconds
  );
  return {
    maxUploads,
    windowSeconds,
    windowMs: windowSeconds * 1000,
  };
}

export function formatRateWindowLabel(windowSeconds: number): string {
  if (windowSeconds === 3600) return 'hour';
  if (windowSeconds % 3600 === 0 && windowSeconds > 3600) {
    return `${windowSeconds / 3600} hours`;
  }
  if (windowSeconds === 60) return 'min';
  if (windowSeconds % 60 === 0) {
    return `${windowSeconds / 60} min`;
  }
  return `${windowSeconds}s`;
}

function computeRetryAfterSeconds(windowStart: number, windowMs: number, now: number): number {
  const maxWaitSeconds = Math.max(1, Math.ceil(windowMs / 1000));
  const remainingSeconds = Math.ceil((windowStart + windowMs - now) / 1000);
  return Math.min(maxWaitSeconds, Math.max(1, remainingSeconds));
}

export function getClientIp(request: Request): string {
  const cfIp = request.headers.get('CF-Connecting-IP');
  if (cfIp) return cfIp.trim();
  const xff = request.headers.get('X-Forwarded-For');
  if (xff) return xff.split(',')[0].trim();
  return '127.0.0.1';
}

/**
 * Fixed-window rate limiter backed by D1 (avoids KV's 1,000 writes/day free limit).
 */
export async function checkRateLimit(params: {
  db: D1Database;
  key: string;
  limit: number;
  windowMs: number;
  now?: number;
}): Promise<{ allowed: boolean; remaining: number; retryAfterSeconds: number }> {
  const { db, key, limit, windowMs } = params;
  const now = params.now ?? Date.now();

  const existing = await db
    .prepare('SELECT count, window_start FROM rate_limits WHERE key = ?')
    .bind(key)
    .first<{ count: number; window_start: number }>();

  if (!existing || now - existing.window_start >= windowMs) {
    await db
      .prepare(
        `INSERT INTO rate_limits (key, count, window_start) VALUES (?, 1, ?)
         ON CONFLICT(key) DO UPDATE SET count = 1, window_start = excluded.window_start`
      )
      .bind(key, now)
      .run();

    return {
      allowed: true,
      remaining: Math.max(0, limit - 1),
      retryAfterSeconds: 0,
    };
  }

  if (existing.count >= limit) {
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: computeRetryAfterSeconds(existing.window_start, windowMs, now),
    };
  }

  await db
    .prepare('UPDATE rate_limits SET count = count + 1 WHERE key = ?')
    .bind(key)
    .run();

  return {
    allowed: true,
    remaining: Math.max(0, limit - (existing.count + 1)),
    retryAfterSeconds: 0,
  };
}

/** Check current counter without incrementing (used for failed login lockout). */
export async function isRateLimited(params: {
  db: D1Database;
  key: string;
  limit: number;
  windowMs: number;
  now?: number;
}): Promise<{ limited: boolean; retryAfterSeconds: number }> {
  const { db, key, limit, windowMs } = params;
  const now = params.now ?? Date.now();
  const existing = await db
    .prepare('SELECT count, window_start FROM rate_limits WHERE key = ?')
    .bind(key)
    .first<{ count: number; window_start: number }>();

  if (!existing || now - existing.window_start >= windowMs) {
    return { limited: false, retryAfterSeconds: 0 };
  }

  if (existing.count >= limit) {
    return {
      limited: true,
      retryAfterSeconds: computeRetryAfterSeconds(existing.window_start, windowMs, now),
    };
  }
  return { limited: false, retryAfterSeconds: 0 };
}

export async function clearRateLimit(db: D1Database, key: string): Promise<void> {
  await db.prepare('DELETE FROM rate_limits WHERE key = ?').bind(key).run();
}
