import type { Env, StorageStatsRow } from '../types';
import { buildStorageAlertEmail, sendEmail } from './email';

export const STORAGE_LIMIT_BYTES = 10 * 1024 * 1024 * 1024; // 10 GB
export const HARD_STOP_BYTES = Math.floor(9.5 * 1024 * 1024 * 1024); // 9.5 GB
const LOCK_DURATION_MS = 5 * 60 * 1000;
const BATCH_SIZE = 100;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface CleanupResult {
  ran: boolean;
  filesDeleted: number;
  bytesFreed: number;
  totalAfter: number;
  skippedReason?: string;
}

export async function getStorageStats(db: D1Database): Promise<StorageStatsRow> {
  const row = await db
    .prepare('SELECT * FROM storage_stats WHERE id = 1')
    .first<StorageStatsRow>();

  if (row) return row;

  await db
    .prepare('INSERT OR IGNORE INTO storage_stats (id, total_bytes, trigger_pct, target_pct) VALUES (1, 0, 80, 70)')
    .run();
  return {
    id: 1,
    total_bytes: 0,
    trigger_pct: 80,
    target_pct: 70,
    expire_links_months: null,
    cleanup_lock_until: 0,
    last_alert_at: 0,
  };
}

/**
 * Purges edge cache for a given short link ID so deleted/blocked items stop serving immediately.
 */
export async function purgeShortLinkCache(originUrl: string | undefined, id: string): Promise<void> {
  if (!originUrl || typeof caches === 'undefined') return;
  try {
    const cache = (caches as unknown as { default: Cache }).default;
    const url = new URL(`/f/${id}`, originUrl).toString();
    await cache.delete(url);
  } catch {
    // Ignore cache delete errors in test/local environments
  }
}

/**
 * FIFO Storage Auto-Cleanup:
 * - Runs when total_bytes > triggerBytes (default 80% = 8 GB), or when forced manually.
 * - Deletes oldest active uploaded files (image, document, video) regardless of type until <= targetBytes (default 70% = 7 GB).
 * - Never deletes excludeId (the newly uploaded file) or link-type QR records.
 * - Uses a D1 lease lock to avoid concurrent cleanups and processes in batches of 100.
 */
export async function runStorageCleanup(params: {
  env: Env;
  trigger: 'upload' | 'daily' | 'manual';
  excludeId?: string;
  force?: boolean;
  originUrl?: string;
  now?: number;
}): Promise<CleanupResult> {
  const { env, trigger, excludeId = '', force = false, originUrl } = params;
  const now = params.now ?? Date.now();
  const db = env.DB;

  const stats = await getStorageStats(db);
  const triggerBytes = Math.floor((stats.trigger_pct / 100) * STORAGE_LIMIT_BYTES);
  const targetBytes = Math.floor((stats.target_pct / 100) * STORAGE_LIMIT_BYTES);

  if (!force && stats.total_bytes <= triggerBytes) {
    return {
      ran: false,
      filesDeleted: 0,
      bytesFreed: 0,
      totalAfter: stats.total_bytes,
      skippedReason: 'below_trigger',
    };
  }

  // Acquire exclusive lease lock
  const lockUntil = now + LOCK_DURATION_MS;
  const lockRes = await db
    .prepare(
      'UPDATE storage_stats SET cleanup_lock_until = ? WHERE id = 1 AND cleanup_lock_until < ?'
    )
    .bind(lockUntil, now)
    .run();

  if (!lockRes.meta.changes) {
    return {
      ran: false,
      filesDeleted: 0,
      bytesFreed: 0,
      totalAfter: stats.total_bytes,
      skippedReason: 'locked',
    };
  }

  let runningTotal = stats.total_bytes;
  let totalDeleted = 0;
  let totalFreed = 0;

  try {
    // Process up to 10 batches per invocation to stay comfortably inside Worker execution budgets
    for (let batch = 0; batch < 10 && runningTotal > targetBytes; batch++) {
      const candidates = await db
        .prepare(
          `SELECT id, r2_key, size_bytes
           FROM links_files
           WHERE status = 'active'
             AND type IN ('image', 'document', 'video')
             AND id != ?
           ORDER BY created_at ASC, id ASC
           LIMIT ?`
        )
        .bind(excludeId, BATCH_SIZE)
        .all<{ id: string; r2_key: string | null; size_bytes: number }>();

      const rows = candidates.results ?? [];
      if (rows.length === 0) break;

      const toDelete: Array<{ id: string; r2_key: string | null; size_bytes: number }> = [];
      let simulated = runningTotal;

      for (const row of rows) {
        if (simulated <= targetBytes) break;
        toDelete.push(row);
        simulated = Math.max(0, simulated - row.size_bytes);
      }

      if (toDelete.length === 0) break;

      let batchFreed = 0;
      const statements: D1PreparedStatement[] = [];

      for (const item of toDelete) {
        if (item.r2_key) {
          await env.FILES.delete(item.r2_key);
        }
        await purgeShortLinkCache(originUrl, item.id);
        statements.push(
          db
            .prepare(
              `UPDATE links_files
               SET status = 'removed', removed_reason = 'cleanup_fifo'
               WHERE id = ? AND status = 'active'`
            )
            .bind(item.id)
        );
        batchFreed += item.size_bytes;
      }

      runningTotal = Math.max(0, runningTotal - batchFreed);
      totalDeleted += toDelete.length;
      totalFreed += batchFreed;

      statements.push(
        db
          .prepare('UPDATE storage_stats SET total_bytes = ? WHERE id = 1')
          .bind(runningTotal)
      );

      await db.batch(statements);

      if (toDelete.length < rows.length) {
        // Reached <= targetBytes inside this batch
        break;
      }
    }

    if (totalDeleted > 0 || trigger === 'manual') {
      await db
        .prepare(
          `INSERT INTO cleanup_log (run_time, files_deleted, bytes_freed, total_after, trigger)
           VALUES (?, ?, ?, ?, ?)`
        )
        .bind(now, totalDeleted, totalFreed, runningTotal, trigger)
        .run();
    }

    // Optional owner-configured link expiration (OFF by default when expire_links_months IS NULL)
    if (trigger === 'daily' && stats.expire_links_months && stats.expire_links_months > 0) {
      const cutoff = now - stats.expire_links_months * 30 * DAY_MS;
      await db
        .prepare(
          `UPDATE links_files
           SET status = 'removed', removed_reason = 'link_expired'
           WHERE status = 'active' AND type = 'link' AND created_at < ?`
        )
        .bind(cutoff)
        .run();
    }
  } finally {
    await db
      .prepare('UPDATE storage_stats SET cleanup_lock_until = 0 WHERE id = 1')
      .run();
  }

  return {
    ran: true,
    filesDeleted: totalDeleted,
    bytesFreed: totalFreed,
    totalAfter: runningTotal,
  };
}

/**
 * Sends a daily warning email to the owner when storage usage crosses 70%.
 */
export async function maybeSendStorageAlert(env: Env, now = Date.now()): Promise<boolean> {
  if (!env.ADMIN_EMAIL || !env.EMAIL_API_KEY) return false;
  const stats = await getStorageStats(env.DB);
  const warningBytes = Math.floor(0.7 * STORAGE_LIMIT_BYTES);

  if (stats.total_bytes < warningBytes) return false;
  if (now - stats.last_alert_at < DAY_MS) return false;

  const email = buildStorageAlertEmail({
    usedBytes: stats.total_bytes,
    limitBytes: STORAGE_LIMIT_BYTES,
    triggerPct: stats.trigger_pct,
    appName: env.APP_NAME ?? 'Captain Azhar Center',
  });

  const sent = await sendEmail(env, {
    to: env.ADMIN_EMAIL,
    ...email,
  });

  if (sent) {
    await env.DB
      .prepare('UPDATE storage_stats SET last_alert_at = ? WHERE id = 1')
      .bind(now)
      .run();
  }
  return sent;
}

/**
 * Deletes expired temporary files created by the AI extraction section (`ALL FILES DATA`)
 * and reclaims their R2 storage quota.
 */
export async function cleanupExpiredExtractionFiles(env: Env, now = Date.now()): Promise<number> {
  const expired = await env.DB
    .prepare(
      `SELECT id, r2_key, size_bytes
       FROM extraction_files
       WHERE status = 'active' AND expires_at <= ?
       LIMIT 100`
    )
    .bind(now)
    .all<{ id: string; r2_key: string; size_bytes: number }>();

  const rows = expired.results ?? [];
  if (rows.length === 0) return 0;

  let freed = 0;
  const stmts: D1PreparedStatement[] = [];
  for (const row of rows) {
    await env.FILES.delete(row.r2_key).catch(() => {});
    stmts.push(
      env.DB.prepare("UPDATE extraction_files SET status = 'removed' WHERE id = ?").bind(row.id)
    );
    freed += row.size_bytes;
  }

  if (freed > 0) {
    stmts.push(
      env.DB
        .prepare('UPDATE storage_stats SET total_bytes = MAX(0, total_bytes - ?) WHERE id = 1')
        .bind(freed)
    );
  }

  await env.DB.batch(stmts);
  return rows.length;
}
