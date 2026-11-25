import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/index';
import { getUploadRateLimitConfig, UPLOAD_RATE_LIMIT_CONFIG } from '../src/services/rateLimit';
import { createTestEnv } from './helpers/mockCloudflare';

const ORIGIN = 'https://owner.github.io';
const CSRF = 'CaptainAzharAdmin';
const ENC = new TextEncoder();
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
const PDF_BYTES = ENC.encode('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF');
const MP4_BYTES = new Uint8Array([
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32,
  0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,
]);
const MOV_BYTES = new Uint8Array([
  0x00, 0x00, 0x00, 0x14, 0x66, 0x74, 0x79, 0x70, 0x71, 0x74, 0x20, 0x20,
  0x11, 0x22, 0x33, 0x44, 0x55, 0x66,
]);
const WEBM_BYTES = (() => {
  const b = new Uint8Array(32);
  b.set([0x1a, 0x45, 0xdf, 0xa3], 0);
  b.set(ENC.encode('webm'), 16);
  return b;
})();

function makeFakeOoxmlBytes(marker = '[Content_Types].xml'): Uint8Array {
  const b = new Uint8Array(64);
  b.set([0x50, 0x4b, 0x03, 0x04], 0);
  b.set(ENC.encode(marker), 30);
  return b;
}

const OLE2_BYTES = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x01, 0x02, 0x03, 0x04]);

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

  it('uploads verified files with inline PDF/video/image headers, Range 206 streaming, SVG block, and honors delete token', async () => {
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

    // SVG upload must remain blocked
    const svgUpload = await app.request(
      'https://worker.local/api/upload',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': '64',
          'X-File-Name': 'vector.svg',
          'X-File-Category': 'image',
        },
        body: ENC.encode('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>'),
      },
      env
    );
    expect(svgUpload.status).toBe(400);

    // Image upload keeps existing inline + sandbox CSP behavior
    const imgUpload = await app.request(
      'https://worker.local/api/upload',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(PNG_BYTES.byteLength),
          'X-File-Name': 'photo.png',
          'X-File-Category': 'image',
        },
        body: PNG_BYTES,
      },
      env
    );
    expect(imgUpload.status).toBe(201);
    const imgData = (await imgUpload.json()) as { id: string };
    const imgGet = await app.request(`https://worker.local/f/${imgData.id}`, {}, env);
    expect(imgGet.status).toBe(200);
    expect(imgGet.headers.get('Content-Type')).toBe('image/png');
    expect(imgGet.headers.get('Content-Disposition')).toBe('inline; filename="photo.png"');
    expect(imgGet.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(imgGet.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    expect(imgGet.headers.get('Content-Security-Policy')).toContain('sandbox');

    // Document PDF upload serves inline with application/pdf + nosniff + PDF-compatible CSP (no sandbox)
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
    expect(docGet.headers.get('Content-Type')).toBe('application/pdf');
    expect(docGet.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(docGet.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    expect(docGet.headers.get('Content-Disposition')).toBe('inline; filename="manual.pdf"');
    expect(docGet.headers.get('Accept-Ranges')).toBe('bytes');
    const pdfCsp = docGet.headers.get('Content-Security-Policy') ?? '';
    expect(pdfCsp).toContain("default-src 'none'");
    expect(pdfCsp).toContain("object-src 'self'");
    expect(pdfCsp).toContain("frame-src 'self'");
    expect(pdfCsp).not.toContain('sandbox');
    expect(new Uint8Array(await docGet.arrayBuffer())).toEqual(PDF_BYTES);

    const docDownload = await app.request(`https://worker.local/f/${docData.id}?download=1`, {}, env);
    expect(docDownload.status).toBe(200);
    expect(docDownload.headers.get('Content-Disposition')).toBe('attachment; filename="manual.pdf"');

    // Video uploads (MP4, WEBM, MOV) serve inline with accurate MIME type and 206 Range streaming
    const videoCases = [
      { filename: 'demo.mp4', bytes: MP4_BYTES, mime: 'video/mp4' },
      { filename: 'demo.webm', bytes: WEBM_BYTES, mime: 'video/webm' },
      { filename: 'demo.mov', bytes: MOV_BYTES, mime: 'video/quicktime' },
    ];

    for (const vc of videoCases) {
      const vidUpload = await app.request(
        'https://worker.local/api/upload',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/octet-stream',
            'Content-Length': String(vc.bytes.byteLength),
            'X-File-Name': vc.filename,
            'X-File-Category': 'video',
          },
          body: vc.bytes,
        },
        env
      );
      expect(vidUpload.status).toBe(201);
      const vidData = (await vidUpload.json()) as { id: string };

      const vidFull = await app.request(`https://worker.local/f/${vidData.id}`, {}, env);
      expect(vidFull.status).toBe(200);
      expect(vidFull.headers.get('Content-Type')).toBe(vc.mime);
      expect(vidFull.headers.get('Content-Disposition')).toBe(`inline; filename="${vc.filename}"`);
      expect(vidFull.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(vidFull.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
      expect(vidFull.headers.get('Accept-Ranges')).toBe('bytes');
      expect(vidFull.headers.get('Content-Security-Policy')).toContain("media-src 'self'");

      const vidRange = await app.request(
        `https://worker.local/f/${vidData.id}`,
        { headers: { Range: 'bytes=0-7' } },
        env
      );
      expect(vidRange.status).toBe(206);
      expect(vidRange.headers.get('Content-Type')).toBe(vc.mime);
      expect(vidRange.headers.get('Content-Disposition')).toBe(`inline; filename="${vc.filename}"`);
      expect(vidRange.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(vidRange.headers.get('Content-Range')).toBe(`bytes 0-7/${vc.bytes.byteLength}`);
      expect(vidRange.headers.get('Content-Length')).toBe('8');
      expect(new Uint8Array(await vidRange.arrayBuffer())).toEqual(vc.bytes.subarray(0, 8));
    }

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

  it('serves full-screen Microsoft Office Online viewer page for DOC/DOCX/XLS/XLSX/PPT/PPTX with corner download, fallback, and /f/:id/raw/:filename', async () => {
    const app = createApp();
    const env = createTestEnv();

    const officeCases = [
      { ext: 'doc', filename: 'legacy-memo.doc', bytes: OLE2_BYTES, mime: 'application/msword' },
      {
        ext: 'docx',
        filename: "Q4 Report & Plan's.docx",
        bytes: makeFakeOoxmlBytes('word/'),
        mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      },
      { ext: 'xls', filename: 'ledger.xls', bytes: OLE2_BYTES, mime: 'application/vnd.ms-excel' },
      {
        ext: 'xlsx',
        filename: 'budget.xlsx',
        bytes: makeFakeOoxmlBytes('xl/'),
        mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      },
      { ext: 'ppt', filename: 'deck.ppt', bytes: OLE2_BYTES, mime: 'application/vnd.ms-powerpoint' },
      {
        ext: 'pptx',
        filename: 'slides.pptx',
        bytes: makeFakeOoxmlBytes('ppt/'),
        mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      },
    ];

    for (const oc of officeCases) {
      const upload = await app.request(
        'https://worker.local/api/upload',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/octet-stream',
            'Content-Length': String(oc.bytes.byteLength),
            'X-File-Name': encodeURIComponent(oc.filename),
            'X-File-Category': 'document',
          },
          body: oc.bytes,
        },
        env
      );
      expect(upload.status).toBe(201);
      const created = (await upload.json()) as { id: string; deleteToken: string };

      // 1. Scanning QR (GET /f/:id) returns full-screen Microsoft Office Online viewer HTML (no top banner/text, no Google viewer)
      const pageRes = await app.request(`https://worker.local/f/${created.id}`, {}, env);
      expect(pageRes.status).toBe(200);
      expect(pageRes.headers.get('Content-Type')).toContain('text/html');
      expect(pageRes.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(pageRes.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
      const csp = pageRes.headers.get('Content-Security-Policy') ?? '';
      expect(csp).toContain('frame-src https://view.officeapps.live.com');
      expect(csp).not.toContain('docs.google.com');
      const nonceMatch = csp.match(/script-src 'nonce-([^']+)'/);
      expect(nonceMatch).not.toBeNull();

      const html = await pageRes.text();
      expect(html).toContain(`<script nonce="${nonceMatch![1]}">`);
      expect(html).toContain('https://view.officeapps.live.com/op/embed.aspx?src=');
      expect(html).toContain('class="corner-download"');
      expect(html).toContain('id="viewer-fallback"');
      expect(html).not.toContain('<header');
      expect(html).not.toContain('docs.google.com/gview');

      const rawPathMatch = html.match(new RegExp(`/f/${created.id}/raw/[^"?]+\\.${oc.ext}`));
      expect(rawPathMatch).not.toBeNull();
      const rawPath = rawPathMatch![0];

      // 2. Raw public URL serves exact Office MIME type with inline disposition for Microsoft Office Online Viewer
      const rawRes = await app.request(`https://worker.local${rawPath}`, {}, env);
      expect(rawRes.status).toBe(200);
      expect(rawRes.headers.get('Content-Type')).toBe(oc.mime);
      expect(rawRes.headers.get('Content-Disposition')).toBe(`inline; filename="${oc.filename}"`);
      expect(rawRes.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(rawRes.headers.get('Accept-Ranges')).toBe('bytes');
      expect(new Uint8Array(await rawRes.arrayBuffer())).toEqual(oc.bytes);

      // 3. Download link (?download=1) serves attachment disposition
      const dlRes = await app.request(`https://worker.local${rawPath}?download=1`, {}, env);
      expect(dlRes.status).toBe(200);
      expect(dlRes.headers.get('Content-Type')).toBe(oc.mime);
      expect(dlRes.headers.get('Content-Disposition')).toBe(`attachment; filename="${oc.filename}"`);
      expect(dlRes.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(new Uint8Array(await dlRes.arrayBuffer())).toEqual(oc.bytes);

      // 4. Direct /f/:id?download=1 also forces attachment download
      const directDlRes = await app.request(`https://worker.local/f/${created.id}?download=1`, {}, env);
      expect(directDlRes.status).toBe(200);
      expect(directDlRes.headers.get('Content-Disposition')).toBe(`attachment; filename="${oc.filename}"`);

      // 5. Deleting item makes both /f/:id and /f/:id/raw/... return 410
      const delRes = await app.request(
        `https://worker.local/api/f/${created.id}`,
        { method: 'DELETE', headers: { 'X-Delete-Token': created.deleteToken } },
        env
      );
      expect(delRes.status).toBe(200);
      expect((await app.request(`https://worker.local/f/${created.id}`, {}, env)).status).toBe(410);
      expect((await app.request(`https://worker.local${rawPath}`, {}, env)).status).toBe(410);
    }
  });

  it('stores two distinct uploaded images under unique IDs/R2 keys and returns distinct content per link', async () => {
    const app = createApp();
    const env = createTestEnv();

    const imgA = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 1, 1, 1, 11]);
    const imgB = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 2, 2, 2, 2, 22, 33]);

    const resA = await app.request(
      'https://worker.local/api/upload',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(imgA.byteLength),
          'X-File-Name': 'first-photo.png',
          'X-File-Category': 'image',
        },
        body: imgA,
      },
      env
    );
    expect(resA.status).toBe(201);
    const dataA = (await resA.json()) as { id: string; shortUrl: string };

    const resB = await app.request(
      'https://worker.local/api/upload',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(imgB.byteLength),
          'X-File-Name': 'second-photo.png',
          'X-File-Category': 'image',
        },
        body: imgB,
      },
      env
    );
    expect(resB.status).toBe(201);
    const dataB = (await resB.json()) as { id: string; shortUrl: string };

    expect(dataA.id).not.toBe(dataB.id);
    expect(dataA.shortUrl).not.toBe(dataB.shortUrl);
    expect(env.FILES.store.size).toBe(2);

    const getA = await app.request(`https://worker.local/f/${dataA.id}`, {}, env);
    const getB = await app.request(`https://worker.local/f/${dataB.id}`, {}, env);
    expect(getA.status).toBe(200);
    expect(getB.status).toBe(200);
    expect(getA.headers.get('Cache-Control')).toContain('must-revalidate');
    expect(getA.headers.get('Vary')).toBe('Range');
    expect(getA.headers.get('ETag')).not.toBe(getB.headers.get('ETag'));

    const bytesA = new Uint8Array(await getA.arrayBuffer());
    const bytesB = new Uint8Array(await getB.arrayBuffer());
    expect(bytesA).toEqual(imgA);
    expect(bytesB).toEqual(imgB);
    expect(bytesA).not.toEqual(bytesB);
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

  it('enforces 10 uploads per 2 minutes (120s) per IP while keeping delete and report limits intact', async () => {
    const app = createApp();
    const env = createTestEnv();
    const baseTime = 1_700_000_000_000;

    vi.useFakeTimers();
    try {
      vi.setSystemTime(baseTime);

      const uploadAs = (ip: string) =>
        app.request(
          'https://worker.local/api/upload',
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/octet-stream',
              'Content-Length': String(PNG_BYTES.byteLength),
              'X-File-Name': 'rate-check.png',
              'X-File-Category': 'image',
              'CF-Connecting-IP': ip,
            },
            body: PNG_BYTES,
          },
          env
        );

      let firstUploaded: { id: string; deleteToken: string } | null = null;
      for (let i = 0; i < 10; i++) {
        const res = await uploadAs('198.51.100.10');
        expect(res.status).toBe(201);
        if (i === 0) {
          firstUploaded = (await res.json()) as { id: string; deleteToken: string };
        }
      }

      // 11th upload inside the 120s window is blocked with <= 120s retry wait
      vi.setSystemTime(baseTime + 5_000);
      const blocked = await uploadAs('198.51.100.10');
      expect(blocked.status).toBe(429);
      expect(blocked.headers.get('Retry-After')).toBe('115');
      const blockedJson = (await blocked.json()) as { error: string };
      expect(blockedJson.error).toBe('Upload limit reached (10/2 min). Please try again in 115s.');
      const waitMatch = blockedJson.error.match(/in (\d+)s\.$/);
      expect(waitMatch).not.toBeNull();
      const waitSec = Number.parseInt(waitMatch![1], 10);
      expect(waitSec).toBeGreaterThanOrEqual(1);
      expect(waitSec).toBeLessThanOrEqual(120);

      // Delete remains unrestricted when upload rate limit is active
      const delRes = await app.request(
        `https://worker.local/api/f/${firstUploaded!.id}`,
        {
          method: 'DELETE',
          headers: {
            'X-Delete-Token': firstUploaded!.deleteToken,
            'CF-Connecting-IP': '198.51.100.10',
          },
        },
        env
      );
      expect(delRes.status).toBe(200);

      // Different IP is unaffected
      const otherIp = await uploadAs('203.0.113.55');
      expect(otherIp.status).toBe(201);

      // Still blocked at 119s, succeeds at 120s
      vi.setSystemTime(baseTime + 119_000);
      const stillBlocked = await uploadAs('198.51.100.10');
      expect(stillBlocked.status).toBe(429);
      const stillBlockedJson = (await stillBlocked.json()) as { error: string };
      expect(stillBlockedJson.error).toBe('Upload limit reached (10/2 min). Please try again in 1s.');

      vi.setSystemTime(baseTime + 120_000);
      const resetOk = await uploadAs('198.51.100.10');
      expect(resetOk.status).toBe(201);

      // Report rate limit stays 10/hour (still blocked after 2 minutes)
      for (let i = 0; i < 10; i++) {
        const rep = await app.request(
          'https://worker.local/api/report',
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'CF-Connecting-IP': '198.51.100.77',
            },
            body: JSON.stringify({ idOrUrl: 'AbC123xY', reason: 'Spam test report entry' }),
          },
          env
        );
        expect(rep.status).toBe(201);
      }

      const repBlocked = await app.request(
        'https://worker.local/api/report',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'CF-Connecting-IP': '198.51.100.77',
          },
          body: JSON.stringify({ idOrUrl: 'AbC123xY', reason: 'Spam test report entry' }),
        },
        env
      );
      expect(repBlocked.status).toBe(429);

      vi.setSystemTime(baseTime + 125_000);
      const repStillBlocked = await app.request(
        'https://worker.local/api/report',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'CF-Connecting-IP': '198.51.100.77',
          },
          body: JSON.stringify({ idOrUrl: 'AbC123xY', reason: 'Spam test report entry' }),
        },
        env
      );
      expect(repStillBlocked.status).toBe(429);
    } finally {
      vi.useRealTimers();
    }
  });

  it('supports configuring upload rate limit via env vars with safe default fallback', async () => {
    expect(getUploadRateLimitConfig({})).toEqual({
      maxUploads: UPLOAD_RATE_LIMIT_CONFIG.maxUploads,
      windowSeconds: UPLOAD_RATE_LIMIT_CONFIG.windowSeconds,
      windowMs: 120_000,
    });
    expect(
      getUploadRateLimitConfig({
        UPLOAD_RATE_LIMIT_MAX: '0',
        UPLOAD_RATE_LIMIT_WINDOW_SECONDS: 'invalid',
      })
    ).toEqual({
      maxUploads: 10,
      windowSeconds: 120,
      windowMs: 120_000,
    });

    const app = createApp();
    const env = createTestEnv({
      UPLOAD_RATE_LIMIT_MAX: '2',
      UPLOAD_RATE_LIMIT_WINDOW_SECONDS: '90',
    });

    const upload = () =>
      app.request(
        'https://worker.local/api/upload',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/octet-stream',
            'Content-Length': String(PNG_BYTES.byteLength),
            'X-File-Name': 'env-check.png',
            'X-File-Category': 'image',
            'CF-Connecting-IP': '198.51.100.99',
          },
          body: PNG_BYTES,
        },
        env
      );

    expect((await upload()).status).toBe(201);
    expect((await upload()).status).toBe(201);
    const third = await upload();
    expect(third.status).toBe(429);
    const thirdJson = (await third.json()) as { error: string };
    expect(thirdJson.error).toMatch(/^Upload limit reached \(2\/90s\)\. Please try again in \d+s\.$/);
  });

  it('reserves a short ID first, commits the final PDF under that ID, keeps original intact, and blocks replay', async () => {
    const app = createApp();
    const env = createTestEnv();

    // 1. Upload original PDF
    const origRes = await app.request(
      'https://worker.local/api/upload',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(PDF_BYTES.byteLength),
          'X-File-Name': 'original.pdf',
          'X-File-Category': 'document',
        },
        body: PDF_BYTES,
      },
      env
    );
    expect(origRes.status).toBe(201);
    const orig = (await origRes.json()) as { id: string; deleteToken: string; shortUrl: string };

    // 2. Reserve a new short ID using source ticket (bad token rejected first)
    const badReserve = await app.request(
      'https://worker.local/api/upload/reserve',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceId: orig.id, deleteToken: 'wrong-token' }),
      },
      env
    );
    expect(badReserve.status).toBe(403);

    const reserveRes = await app.request(
      'https://worker.local/api/upload/reserve',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceId: orig.id, deleteToken: orig.deleteToken }),
      },
      env
    );
    expect(reserveRes.status).toBe(201);
    const reserved = (await reserveRes.json()) as {
      id: string;
      shortUrl: string;
      reserveToken: string;
      expiresAt: number;
    };
    expect(reserved.id).not.toBe(orig.id);
    expect(reserved.shortUrl).toBe(`https://worker.local/f/${reserved.id}`);

    // 3. Upload tampered reserve token -> 403
    const badCommit = await app.request(
      'https://worker.local/api/upload',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(PDF_BYTES.byteLength),
          'X-File-Name': 'final-with-qr.pdf',
          'X-File-Category': 'document',
          'X-Reserved-Id': reserved.id,
          'X-Reserve-Token': 'tampered-token',
        },
        body: PDF_BYTES,
      },
      env
    );
    expect(badCommit.status).toBe(403);

    // 4. Commit final PDF under the reserved ID
    const finalPdfBytes = ENC.encode('%PDF-1.7\n%final-with-qr\n%%EOF');
    const commitRes = await app.request(
      'https://worker.local/api/upload',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(finalPdfBytes.byteLength),
          'X-File-Name': 'original-with-qr.pdf',
          'X-File-Category': 'document',
          'X-Reserved-Id': reserved.id,
          'X-Reserve-Token': reserved.reserveToken,
        },
        body: finalPdfBytes,
      },
      env
    );
    expect(commitRes.status).toBe(201);
    const committed = (await commitRes.json()) as { id: string; shortUrl: string };
    expect(committed.id).toBe(reserved.id);
    expect(committed.shortUrl).toBe(reserved.shortUrl);

    // Both original and final PDFs are accessible independently
    const getOrig = await app.request(`https://worker.local/f/${orig.id}`, {}, env);
    expect(getOrig.status).toBe(200);
    expect(new Uint8Array(await getOrig.arrayBuffer())).toEqual(PDF_BYTES);

    const getFinal = await app.request(`https://worker.local/f/${reserved.id}`, {}, env);
    expect(getFinal.status).toBe(200);
    expect(new Uint8Array(await getFinal.arrayBuffer())).toEqual(finalPdfBytes);

    // 5. Replaying same reservation fails
    const replayRes = await app.request(
      'https://worker.local/api/upload',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(finalPdfBytes.byteLength),
          'X-File-Name': 'replay.pdf',
          'X-File-Category': 'document',
          'X-Reserved-Id': reserved.id,
          'X-Reserve-Token': reserved.reserveToken,
        },
        body: finalPdfBytes,
      },
      env
    );
    expect(replayRes.status).toBe(403);
  });

  it('reports Word converter capability on /api/health and handles /api/convert-word securely', async () => {
    const app = createApp();
    const envDisabled = createTestEnv();

    const healthOff = await app.request('https://worker.local/api/health', {}, envDisabled);
    expect(healthOff.status).toBe(200);
    expect(((await healthOff.json()) as { wordToPdfEnabled: boolean }).wordToPdfEnabled).toBe(false);

    const docxBytes = makeFakeOoxmlBytes('word/');
    const convOff = await app.request(
      'https://worker.local/api/convert-word',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(docxBytes.byteLength),
          'X-File-Name': 'letter.docx',
        },
        body: docxBytes,
      },
      envDisabled
    );
    expect(convOff.status).toBe(503);

    const envEnabled = createTestEnv({
      WORD_CONVERTER_URL: 'https://converter.example.test',
      WORD_CONVERTER_SECRET: 'super-secret-conv',
    });

    const healthOn = await app.request('https://worker.local/api/health', {}, envEnabled);
    expect(((await healthOn.json()) as { wordToPdfEnabled: boolean }).wordToPdfEnabled).toBe(true);

    // Non-Word extension rejected before hitting converter
    const badExt = await app.request(
      'https://worker.local/api/convert-word',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(PDF_BYTES.byteLength),
          'X-File-Name': 'not-word.pdf',
        },
        body: PDF_BYTES,
      },
      envEnabled
    );
    expect(badExt.status).toBe(400);

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(PDF_BYTES, {
        status: 200,
        headers: { 'Content-Type': 'application/pdf' },
      })
    );

    try {
      const convOk = await app.request(
        'https://worker.local/api/convert-word',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/octet-stream',
            'Content-Length': String(docxBytes.byteLength),
            'X-File-Name': 'letter.docx',
          },
          body: docxBytes,
        },
        envEnabled
      );
      expect(convOk.status).toBe(200);
      expect(convOk.headers.get('Content-Type')).toBe('application/pdf');
      expect(new Uint8Array(await convOk.arrayBuffer())).toEqual(PDF_BYTES);

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(fetchSpy.mock.calls[0][0]).toBe('https://converter.example.test/convert');
      const sentInit = fetchSpy.mock.calls[0][1] as RequestInit;
      expect((sentInit.headers as Record<string, string>)['Authorization']).toBe(
        'Bearer super-secret-conv'
      );
      expect((sentInit.headers as Record<string, string>)['X-File-Ext']).toBe('docx');
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('pre-reserves next short ID inline when X-Reserve-Next: 1 is sent on initial upload', async () => {
    const app = createApp();
    const env = createTestEnv();

    const origRes = await app.request(
      'https://worker.local/api/upload',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(PDF_BYTES.byteLength),
          'X-File-Name': 'inline-orig.pdf',
          'X-File-Category': 'document',
          'X-Reserve-Next': '1',
        },
        body: PDF_BYTES,
      },
      env
    );
    expect(origRes.status).toBe(201);
    const orig = (await origRes.json()) as {
      id: string;
      nextReservation?: { id: string; shortUrl: string; reserveToken: string; expiresAt: number };
    };
    expect(orig.nextReservation).toBeDefined();
    expect(orig.nextReservation?.id).not.toBe(orig.id);

    const finalRes = await app.request(
      'https://worker.local/api/upload',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(PDF_BYTES.byteLength),
          'X-File-Name': 'inline-final.pdf',
          'X-File-Category': 'document',
          'X-Reserved-Id': orig.nextReservation!.id,
          'X-Reserve-Token': orig.nextReservation!.reserveToken,
        },
        body: PDF_BYTES,
      },
      env
    );
    expect(finalRes.status).toBe(201);
    const fin = (await finalRes.json()) as { id: string; nextReservation?: unknown };
    expect(fin.id).toBe(orig.nextReservation!.id);
    expect(fin.nextReservation).toBeUndefined();
  });
});
