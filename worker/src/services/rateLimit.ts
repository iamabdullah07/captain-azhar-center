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
    const retryAfterSeconds = Math.max(1, Math.ceil((existing.window_start + windowMs - now) / 1000));
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds,
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
      retryAfterSeconds: Math.max(1, Math.ceil((existing.window_start + windowMs - now) / 1000)),
    };
  }
  return { limited: false, retryAfterSeconds: 0 };
}

export async function clearRateLimit(db: D1Database, key: string): Promise<void> {
  await db.prepare('DELETE FROM rate_limits WHERE key = ?').bind(key).run();
}
