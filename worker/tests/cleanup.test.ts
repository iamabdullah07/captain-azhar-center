import { describe, expect, it, vi } from 'vitest';
import workerEntry, { createApp } from '../src/index';
import { maybeSendStorageAlert, runStorageCleanup, STORAGE_LIMIT_BYTES } from '../src/services/cleanup';
import { sendEmail } from '../src/services/email';
import { createTestEnv } from './helpers/mockCloudflare';

describe('FIFO Storage Auto-Cleanup, Cron & 70% Email Alerts (Part C7 & E6)', () => {
  it('deletes oldest uploaded files of any type above 80% down to <= 70%, keeps newest & links untouched', async () => {
    const env = createTestEnv();
    const app = createApp();

    const GB = 1024 * 1024 * 1024;
    const seeded = [
      { id: 'old_img1', type: 'image', size: 2 * GB, created: 1000, r2: 'image/1.png' },
      { id: 'old_doc2', type: 'document', size: 1.5 * GB, created: 2000, r2: 'document/2.pdf' },
      { id: 'mid_vid3', type: 'video', size: 2 * GB, created: 3000, r2: 'video/3.mp4' },
      { id: 'new_img4', type: 'image', size: 2 * GB, created: 4000, r2: 'image/4.png' },
      { id: 'newest_5', type: 'video', size: 1 * GB, created: 5000, r2: 'video/5.mp4' },
    ];

    let total = 0;
    for (const item of seeded) {
      await env.FILES.put(item.r2, new Uint8Array([1, 2, 3]));
      await env.DB
        .prepare(
          `INSERT INTO links_files (id, type, original_name, mime_type, size_bytes, r2_key, created_at, status)
           VALUES (?, ?, 'file', 'application/octet-stream', ?, ?, ?, 'active')`
        )
        .bind(item.id, item.type, item.size, item.r2, item.created)
        .run();
      total += item.size;
    }

    await env.DB
      .prepare(
        `INSERT INTO links_files (id, type, target_url, size_bytes, created_at, status)
         VALUES ('keep_lnk', 'link', 'https://example.com', 0, 500, 'active')`
      )
      .run();

    await env.DB.prepare('UPDATE storage_stats SET total_bytes = ? WHERE id = 1').bind(total).run();

    const res = await runStorageCleanup({
      env,
      trigger: 'upload',
      excludeId: 'newest_5',
      originUrl: 'https://worker.local',
    });

    expect(res.ran).toBe(true);
    expect(res.filesDeleted).toBe(1);
    expect(res.totalAfter).toBeLessThanOrEqual(0.7 * STORAGE_LIMIT_BYTES);

    expect(env.FILES.store.has('image/1.png')).toBe(false);
    const removedRes = await app.request('https://worker.local/f/old_img1', {}, env);
    expect(removedRes.status).toBe(410);
    expect(await removedRes.text()).toContain('This file was removed to free up storage');

    const linkRes = await app.request('https://worker.local/f/keep_lnk', {}, env);
    expect(linkRes.status).toBe(302);

    const logRow = await env.DB.prepare('SELECT * FROM cleanup_log ORDER BY id DESC LIMIT 1').first<{
      files_deleted: number;
      trigger: string;
    }>();
    expect(logRow?.files_deleted).toBe(1);
    expect(logRow?.trigger).toBe('upload');
  });

  it('never deletes the just-uploaded file even when no older files exist above 80%', async () => {
    const env = createTestEnv();
    const GB = 1024 * 1024 * 1024;
    await env.FILES.put('video/just_uploaded.mp4', new Uint8Array([1, 2, 3]));
    await env.DB
      .prepare(
        `INSERT INTO links_files (id, type, original_name, mime_type, size_bytes, r2_key, created_at, status)
         VALUES ('just_new', 'video', 'new.mp4', 'video/mp4', ?, 'video/just_uploaded.mp4', 9999, 'active')`
      )
      .bind(8.5 * GB)
      .run();
    await env.DB.prepare('UPDATE storage_stats SET total_bytes = ? WHERE id = 1').bind(8.5 * GB).run();

    const res = await runStorageCleanup({
      env,
      trigger: 'upload',
      excludeId: 'just_new',
    });

    expect(res.filesDeleted).toBe(0);
    expect(env.FILES.store.has('video/just_uploaded.mp4')).toBe(true);
  });

  it('skips email safely when EMAIL_API_KEY is missing and limits 70% alerts to at most once per day', async () => {
    const envNoKey = createTestEnv({ EMAIL_API_KEY: undefined });
    const GB = 1024 * 1024 * 1024;
    await envNoKey.DB.prepare('UPDATE storage_stats SET total_bytes = ? WHERE id = 1').bind(7.5 * GB).run();

    // Missing EMAIL_API_KEY must skip without throwing
    await expect(
      sendEmail(envNoKey, {
        to: 'darkjutt7777@gmail.com',
        subject: 'Test',
        html: '<p>Test</p>',
        text: 'Test',
      })
    ).resolves.toBe(false);
    await expect(maybeSendStorageAlert(envNoKey, 1_000_000)).resolves.toBe(false);

    // With EMAIL_API_KEY set, sends once at 70%+ and suppresses duplicate within 24 hours
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 'email_123' }), { status: 200 })
    );

    try {
      const envWithKey = createTestEnv({ EMAIL_API_KEY: 're_dummy_test_key' });
      await envWithKey.DB.prepare('UPDATE storage_stats SET total_bytes = ? WHERE id = 1').bind(7.5 * GB).run();

      const t0 = 1_700_000_000_000;
      const firstAlert = await maybeSendStorageAlert(envWithKey, t0);
      expect(firstAlert).toBe(true);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(fetchSpy.mock.calls[0][0]).toBe('https://api.resend.com/emails');

      const secondSameDay = await maybeSendStorageAlert(envWithKey, t0 + 60 * 60 * 1000);
      expect(secondSameDay).toBe(false);
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      const nextDay = await maybeSendStorageAlert(envWithKey, t0 + 25 * 60 * 60 * 1000);
      expect(nextDay).toBe(true);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('runs daily cron cleanup safely via scheduled handler', async () => {
    const env = createTestEnv();
    const GB = 1024 * 1024 * 1024;
    await env.FILES.put('image/cron_old.png', new Uint8Array([1, 2, 3]));
    await env.DB
      .prepare(
        `INSERT INTO links_files (id, type, original_name, mime_type, size_bytes, r2_key, created_at, status)
         VALUES ('cron_old1', 'image', 'old.png', 'image/png', ?, 'image/cron_old.png', 100, 'active')`
      )
      .bind(8.2 * GB)
      .run();
    await env.DB.prepare('UPDATE storage_stats SET total_bytes = ? WHERE id = 1').bind(8.2 * GB).run();

    const waitPromises: Promise<unknown>[] = [];
    await workerEntry.scheduled(
      { cron: '0 2 * * *', scheduledTime: Date.now() } as ScheduledController,
      env,
      { waitUntil: (p: Promise<unknown>) => waitPromises.push(p) } as unknown as ExecutionContext
    );
    await Promise.all(waitPromises);

    expect(env.FILES.store.has('image/cron_old.png')).toBe(false);
    const logRow = await env.DB.prepare('SELECT trigger, files_deleted FROM cleanup_log ORDER BY id DESC LIMIT 1').first<{
      trigger: string;
      files_deleted: number;
    }>();
    expect(logRow?.trigger).toBe('daily');
    expect(logRow?.files_deleted).toBe(1);
  });
});
