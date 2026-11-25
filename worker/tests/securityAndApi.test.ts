import { describe, expect, it } from 'vitest';
import { createApp } from '../src/index';
import { createTestEnv } from './helpers/mockCloudflare';

const ORIGIN = 'https://owner.github.io';
const CSRF = 'CaptainAzharAdmin';
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
const PDF_BYTES = new TextEncoder().encode('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF');
const MP4_BYTES = new Uint8Array([
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32,
  0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,
]);

describe('Public API & Security Verification (Part D7)', () => {
  it('creates short links, blocks unsafe schemes & loops, and redirects with 302', async () => {
    const app = createApp();
    const env = createTestEnv();

    // Unsafe URLs rejected
    for (const badUrl of ['javascript:alert(1)', 'data:text/html,hi', 'https://worker.local/f/abc']) {
      const bad = await app.request(
        'https://worker.local/api/link',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: badUrl }),
        },
        env
      );
      expect(bad.status).toBe(400);
    }

    // Valid URL works and redirects in one 302 hop
    const res = await app.request(
      'https://worker.local/api/link',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://example.com/hello' }),
      },
      env
    );
    expect(res.status).toBe(201);
    const data = (await res.json()) as { id: string; shortUrl: string };
    expect(data.id.length).toBeGreaterThanOrEqual(8);

    const redir = await app.request(`https://worker.local/f/${data.id}`, {}, env);
    expect(redir.status).toBe(302);
    expect(redir.headers.get('Location')).toBe('https://example.com/hello');
  });

  it('uploads verified files with safe serving headers, supports video Range, and honors delete token', async () => {
    const app = createApp();
    const env = createTestEnv();

    // Spoofed HTML uploaded as PNG must fail
    const badUpload = await app.request(
      'https://worker.local/api/upload',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': '25',
          'X-File-Name': 'fake.png',
          'X-File-Category': 'image',
        },
        body: new TextEncoder().encode('<html><script>1</script>'),
      },
      env
    );
    expect(badUpload.status).toBe(400);

    // Document PDF upload serves with attachment + nosniff
    const docUpload = await app.request(
      'https://worker.local/api/upload',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(PDF_BYTES.byteLength),
          'X-File-Name': 'manual.pdf',
          'X-File-Category': 'document',
        },
        body: PDF_BYTES,
      },
      env
    );
    expect(docUpload.status).toBe(201);
    const docData = (await docUpload.json()) as { id: string; deleteToken: string };

    const docGet = await app.request(`https://worker.local/f/${docData.id}`, {}, env);
    expect(docGet.status).toBe(200);
    expect(docGet.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(docGet.headers.get('Content-Disposition')).toContain('attachment;');

    // Video upload supports 206 Partial Content Range requests
    const vidUpload = await app.request(
      'https://worker.local/api/upload',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(MP4_BYTES.byteLength),
          'X-File-Name': 'demo.mp4',
          'X-File-Category': 'video',
        },
        body: MP4_BYTES,
      },
      env
    );
    expect(vidUpload.status).toBe(201);
    const vidData = (await vidUpload.json()) as { id: string };

    const vidRange = await app.request(
      `https://worker.local/f/${vidData.id}`,
      { headers: { Range: 'bytes=0-7' } },
      env
    );
    expect(vidRange.status).toBe(206);
    expect(vidRange.headers.get('Content-Range')).toBe(`bytes 0-7/${MP4_BYTES.byteLength}`);

    // Wrong delete token fails; right delete token removes item
    const wrongDel = await app.request(
      `https://worker.local/api/f/${docData.id}`,
      { method: 'DELETE', headers: { 'X-Delete-Token': 'wrong-token' } },
      env
    );
    expect(wrongDel.status).toBe(403);

    const rightDel = await app.request(
      `https://worker.local/api/f/${docData.id}`,
      { method: 'DELETE', headers: { 'X-Delete-Token': docData.deleteToken } },
      env
    );
    expect(rightDel.status).toBe(200);

    const afterDel = await app.request(`https://worker.local/f/${docData.id}`, {}, env);
    expect(afterDel.status).toBe(410);
  });

  it('enforces single-owner signup lock, admin auth, rate limit, and CSRF protection', async () => {
    const app = createApp();
    const env = createTestEnv();

    // Unauthenticated admin endpoints must reject with 401
    expect((await app.request('https://worker.local/api/admin/stats', {}, env)).status).toBe(401);
    expect((await app.request('https://worker.local/api/admin/files', {}, env)).status).toBe(401);

    // Wrong email on signup rejected
    const wrongEmail = await app.request(
      'https://worker.local/api/admin/signup',
      {
        method: 'POST',
        headers: {
          Origin: ORIGIN,
          'X-Requested-With': CSRF,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ email: 'attacker@evil.com', password: 'super-long-passphrase-123' }),
      },
      env
    );
    expect(wrongEmail.status).toBe(403);

    // Short password rejected
    const shortPass = await app.request(
      'https://worker.local/api/admin/signup',
      {
        method: 'POST',
        headers: {
          Origin: ORIGIN,
          'X-Requested-With': CSRF,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ email: 'darkjutt7777@gmail.com', password: 'short' }),
      },
      env
    );
    expect(shortPass.status).toBe(400);

    // Valid owner signup succeeds once
    const ownerSignup = await app.request(
      'https://worker.local/api/admin/signup',
      {
        method: 'POST',
        headers: {
          Origin: ORIGIN,
          'X-Requested-With': CSRF,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email: 'darkjutt7777@gmail.com',
          password: 'Captain-Azhar-Secure-Passphrase-2026!',
        }),
      },
      env
    );
    expect(ownerSignup.status).toBe(201);
    const cookieHeader = ownerSignup.headers.get('Set-Cookie') ?? '';
    const sessionCookie = cookieHeader.split(';')[0];
    expect(sessionCookie).toContain('ck_admin_session=');
    expect(cookieHeader).toContain('HttpOnly');
    expect(cookieHeader).toContain('Secure');

    // Second signup attempt is permanently disabled
    const secondSignup = await app.request(
      'https://worker.local/api/admin/signup',
      {
        method: 'POST',
        headers: {
          Origin: ORIGIN,
          'X-Requested-With': CSRF,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email: 'darkjutt7777@gmail.com',
          password: 'Another-Long-Password-2026!',
        }),
      },
      env
    );
    expect(secondSignup.status).toBe(403);

    // Authenticated stats works
    const statsRes = await app.request(
      'https://worker.local/api/admin/stats',
      { headers: { Cookie: sessionCookie } },
      env
    );
    expect(statsRes.status).toBe(200);

    // CSRF checks: foreign Origin or missing X-Requested-With on mutation must return 403
    const badOrigin = await app.request(
      'https://worker.local/api/admin/cleanup',
      {
        method: 'POST',
        headers: {
          Origin: 'https://evil-site.example',
          'X-Requested-With': CSRF,
          Cookie: sessionCookie,
        },
      },
      env
    );
    expect(badOrigin.status).toBe(403);

    const missingCsrfHeader = await app.request(
      'https://worker.local/api/admin/cleanup',
      {
        method: 'POST',
        headers: {
          Origin: ORIGIN,
          Cookie: sessionCookie,
        },
      },
      env
    );
    expect(missingCsrfHeader.status).toBe(403);

    // Valid CSRF passes
    const goodCleanup = await app.request(
      'https://worker.local/api/admin/cleanup',
      {
        method: 'POST',
        headers: {
          Origin: ORIGIN,
          'X-Requested-With': CSRF,
          Cookie: sessionCookie,
        },
      },
      env
    );
    expect(goodCleanup.status).toBe(200);

    // Upload an image and verify admin cannot leak r2_key or delete_token_hash in /files
    await app.request(
      'https://worker.local/api/upload',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(PNG_BYTES.byteLength),
          'X-File-Name': 'secret-check.png',
          'X-File-Category': 'image',
        },
        body: PNG_BYTES,
      },
      env
    );

    const filesRes = await app.request(
      'https://worker.local/api/admin/files',
      { headers: { Cookie: sessionCookie } },
      env
    );
    const filesJson = (await filesRes.json()) as { items: Array<Record<string, unknown>> };
    expect(filesJson.items.length).toBe(1);
    expect(filesJson.items[0]).not.toHaveProperty('r2_key');
    expect(filesJson.items[0]).not.toHaveProperty('delete_token_hash');
    const uploadedId = filesJson.items[0].id as string;

    // Public report + Admin block/unblock flow
    const repRes = await app.request(
      'https://worker.local/api/report',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          idOrUrl: `https://worker.local/f/${uploadedId}`,
          reason: 'Suspicious test item report',
        }),
      },
      env
    );
    expect(repRes.status).toBe(201);

    const blockRes = await app.request(
      `https://worker.local/api/admin/block/${uploadedId}`,
      {
        method: 'POST',
        headers: {
          Origin: ORIGIN,
          'X-Requested-With': CSRF,
          Cookie: sessionCookie,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ action: 'block' }),
      },
      env
    );
    expect(blockRes.status).toBe(200);

    const blockedView = await app.request(`https://worker.local/f/${uploadedId}`, {}, env);
    expect(blockedView.status).toBe(451);

    // Admin delete permanently removes R2 file, updates status, and serves 410
    const adminDelete = await app.request(
      `https://worker.local/api/admin/f/${uploadedId}`,
      {
        method: 'DELETE',
        headers: {
          Origin: ORIGIN,
          'X-Requested-With': CSRF,
          Cookie: sessionCookie,
        },
      },
      env
    );
    expect(adminDelete.status).toBe(200);
    expect(env.FILES.store.size).toBe(0);
    const deletedView = await app.request(`https://worker.local/f/${uploadedId}`, {}, env);
    expect(deletedView.status).toBe(410);
  });

  it('enforces login rate limiting, uniform forgot-password, and single-use password reset', async () => {
    const app = createApp();
    const env = createTestEnv();

    // Sign up owner first
    const signup = await app.request(
      'https://worker.local/api/admin/signup',
      {
        method: 'POST',
        headers: {
          Origin: ORIGIN,
          'X-Requested-With': CSRF,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email: 'darkjutt7777@gmail.com',
          password: 'Initial-Passphrase-2026-Strong!',
        }),
      },
      env
    );
    expect(signup.status).toBe(201);
    const oldSessionCookie = (signup.headers.get('Set-Cookie') ?? '').split(';')[0];

    // 5 failed login attempts trigger 429 rate limit
    for (let i = 0; i < 5; i++) {
      const fail = await app.request(
        'https://worker.local/api/admin/login',
        {
          method: 'POST',
          headers: {
            Origin: ORIGIN,
            'X-Requested-With': CSRF,
            'CF-Connecting-IP': '198.51.100.42',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            email: 'darkjutt7777@gmail.com',
            password: 'wrong-password',
          }),
        },
        env
      );
      expect(fail.status).toBe(401);
    }

    const lockedOut = await app.request(
      'https://worker.local/api/admin/login',
      {
        method: 'POST',
        headers: {
          Origin: ORIGIN,
          'X-Requested-With': CSRF,
          'CF-Connecting-IP': '198.51.100.42',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email: 'darkjutt7777@gmail.com',
          password: 'Initial-Passphrase-2026-Strong!',
        }),
      },
      env
    );
    expect(lockedOut.status).toBe(429);

    // Forgot password returns identical message for unknown vs owner email
    const forgotUnknown = await app.request(
      'https://worker.local/api/admin/forgot',
      {
        method: 'POST',
        headers: {
          Origin: ORIGIN,
          'X-Requested-With': CSRF,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ email: 'stranger@example.com' }),
      },
      env
    );
    expect(forgotUnknown.status).toBe(200);
    const unknownMsg = ((await forgotUnknown.json()) as { message: string }).message;

    // Simulate issued reset token directly in D1 and verify single-use + session invalidation
    const { sha256Hex } = await import('../src/services/cryptoUtils');
    const resetToken = 'valid-one-time-reset-token-example-12345';
    await env.DB
      .prepare('INSERT INTO password_resets (token_hash, expires_at, used_at) VALUES (?, ?, NULL)')
      .bind(await sha256Hex(resetToken), Date.now() + 60_000)
      .run();

    const forgotOwner = await app.request(
      'https://worker.local/api/admin/forgot',
      {
        method: 'POST',
        headers: {
          Origin: ORIGIN,
          'X-Requested-With': CSRF,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ email: 'darkjutt7777@gmail.com' }),
      },
      env
    );
    expect(((await forgotOwner.json()) as { message: string }).message).toBe(unknownMsg);

    // Expired (> 30 min) reset token is rejected
    const expiredToken = 'expired-reset-token-12345';
    await env.DB
      .prepare('INSERT INTO password_resets (token_hash, expires_at, used_at) VALUES (?, ?, NULL)')
      .bind(await sha256Hex(expiredToken), Date.now() - 1000)
      .run();

    const expiredReset = await app.request(
      'https://worker.local/api/admin/reset',
      {
        method: 'POST',
        headers: {
          Origin: ORIGIN,
          'X-Requested-With': CSRF,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          token: expiredToken,
          newPassword: 'Should-Not-Work-2026!',
        }),
      },
      env
    );
    expect(expiredReset.status).toBe(400);

    // Reset works once
    const resetOk = await app.request(
      'https://worker.local/api/admin/reset',
      {
        method: 'POST',
        headers: {
          Origin: ORIGIN,
          'X-Requested-With': CSRF,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          token: resetToken,
          newPassword: 'Updated-Owner-Passphrase-2026!',
        }),
      },
      env
    );
    expect(resetOk.status).toBe(200);

    // Old session cookie is invalidated immediately after password reset
    const oldSessionAfterReset = await app.request(
      'https://worker.local/api/admin/stats',
      { headers: { Cookie: oldSessionCookie } },
      env
    );
    expect(oldSessionAfterReset.status).toBe(401);

    // Reusing same reset token is rejected
    const resetReuse = await app.request(
      'https://worker.local/api/admin/reset',
      {
        method: 'POST',
        headers: {
          Origin: ORIGIN,
          'X-Requested-With': CSRF,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          token: resetToken,
          newPassword: 'Another-Passphrase-2026!',
        }),
      },
      env
    );
    expect(resetReuse.status).toBe(400);

    // New password logs in cleanly from a fresh IP
    const loginNew = await app.request(
      'https://worker.local/api/admin/login',
      {
        method: 'POST',
        headers: {
          Origin: ORIGIN,
          'X-Requested-With': CSRF,
          'CF-Connecting-IP': '203.0.113.9',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email: 'darkjutt7777@gmail.com',
          password: 'Updated-Owner-Passphrase-2026!',
        }),
      },
      env
    );
    expect(loginNew.status).toBe(200);
  });
});
