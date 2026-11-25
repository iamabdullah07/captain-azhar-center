import { zipSync } from 'fflate';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { GEMINI_MODEL_CONFIG, resolveModelOrder } from '../src/config/geminiModels';
import { createApp } from '../src/index';
import { createExtractRoutes } from '../src/routes/extract';
import { cleanupExpiredExtractionFiles } from '../src/services/cleanup';
import {
  normalizeExtractedDocument,
  normalizeNationalityDemonym,
  pickPriorityId,
} from '../src/services/extractionNormalizer';
import { createTestEnv } from './helpers/mockCloudflare';

const ENC = new TextEncoder();
const ORIGIN = 'https://owner.github.io';
const CSRF = 'CaptainAzharAdmin';
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
const JPG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
const PDF_BYTES = ENC.encode('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF');

function makeDocxWithTextAndImage(text: string): Uint8Array {
  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
      <w:body>
        <w:p><w:r><w:t>${text}</w:t></w:r></w:p>
      </w:body>
    </w:document>`;
  return zipSync({
    '[Content_Types].xml': ENC.encode('<?xml version="1.0"?><Types></Types>'),
    'word/document.xml': ENC.encode(xml),
    'word/media/passport_scan.png': PNG_BYTES,
  });
}

async function signupAndGetCookie(app: ReturnType<typeof createApp>, env: ReturnType<typeof createTestEnv>) {
  const res = await app.request(
    'https://worker.local/api/admin/signup',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: ORIGIN,
        'X-Requested-With': CSRF,
      },
      body: JSON.stringify({
        email: env.ADMIN_EMAIL,
        password: 'MySuperSecureAdminPass123!',
      }),
    },
    env
  );
  expect(res.status).toBe(201);
  const setCookie = res.headers.get('Set-Cookie') ?? '';
  return setCookie.split(';')[0];
}

describe('Phase 1: Extraction Normalizer, Model Config, Archives, Key Rotation & API', () => {
  it('enforces strict ID priority (passport > iqama > national_id > visa) and normalizations', () => {
    // 1. Passport beats iqama, national_id, visa
    const p1 = pickPriorityId({
      passport_number: 'AB-123 4567',
      iqama_number: '2456789012',
      national_id_number: '35202-1234567-1',
      visa_number: 'V99887766',
    });
    expect(p1).toEqual({ idNumber: 'AB1234567', idType: 'passport' });

    // 2. Iqama beats national_id & visa when no passport
    const p2 = pickPriorityId({
      passport_number: null,
      iqama_number: '2456-7890-12',
      national_id_number: '3520212345671',
      visa_number: 'V11223344',
    });
    expect(p2).toEqual({ idNumber: '2456789012', idType: 'iqama' });

    // 3. National ID beats visa
    const p3 = pickPriorityId({
      national_id_number: '35202-9876543-2',
      visa_number: 'V11223344',
    });
    expect(p3).toEqual({ idNumber: '3520298765432', idType: 'national_id' });

    // 4. Visa used only when top 3 are absent
    const p4 = pickPriorityId({
      passport_number: 'N/A',
      visa_number: '6012-3344-55',
    });
    expect(p4).toEqual({ idNumber: '6012334455', idType: 'visa' });

    // Name & nationality demonym normalization
    const norm = normalizeExtractedDocument({
      name: 'محمد علي / Muhammad Ali Khan',
      passport_number: 'pk 9988-776',
      nationality: 'Islamic Republic of Pakistan',
      confidence: 0.94,
    });
    expect(norm.name).toBe('MUHAMMAD ALI KHAN');
    expect(norm.idNumber).toBe('PK9988776');
    expect(norm.idType).toBe('passport');
    expect(norm.nationality).toBe('PAKISTANI');
    expect(normalizeNationalityDemonym('India')).toBe('INDIAN');
    expect(normalizeNationalityDemonym('KSA')).toBe('SAUDI');
    expect(normalizeNationalityDemonym('Unknown')).toBeNull();
  });

  it('resolves model priority order from centralized config for auto and manual modes', () => {
    expect(GEMINI_MODEL_CONFIG.models.map((m) => m.id)).toEqual([
      'gemini-3.6-flash',
      'gemini-3.5-flash-lite',
      'gemini-3.8-flash',
    ]);

    const autoOrder = resolveModelOrder({ requestedModel: 'auto' });
    expect(autoOrder.ok).toBe(true);
    if (autoOrder.ok) {
      expect(autoOrder.models.map((m) => m.id)).toEqual([
        'gemini-3.6-flash',
        'gemini-3.5-flash-lite',
        'gemini-3.8-flash',
      ]);
    }

    const manualNoFallback = resolveModelOrder({
      requestedModel: 'gemini-3.8-flash',
      allowFallback: false,
    });
    expect(manualNoFallback.ok).toBe(true);
    if (manualNoFallback.ok) {
      expect(manualNoFallback.models.map((m) => m.id)).toEqual(['gemini-3.8-flash']);
    }

    const manualWithFallback = resolveModelOrder({
      requestedModel: 'gemini-3.5-flash-lite',
      allowFallback: true,
    });
    expect(manualWithFallback.ok).toBe(true);
    if (manualWithFallback.ok) {
      expect(manualWithFallback.models.map((m) => m.id)).toEqual([
        'gemini-3.5-flash-lite',
        'gemini-3.6-flash',
        'gemini-3.8-flash',
      ]);
    }
  });

  it('unpacks nested ZIP & DOCX safely, blocks path traversal, and skips unsupported files', async () => {
    const app = createApp();
    const env = createTestEnv();

    // Path traversal zip rejected
    const evilZip = zipSync({
      '../../etc/passwd.png': PNG_BYTES,
    });
    const evilRes = await app.request(
      'https://worker.local/api/extract/ingest',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(evilZip.byteLength),
          'X-File-Name': 'evil.zip',
        },
        body: evilZip,
      },
      env
    );
    expect(evilRes.status).toBe(400);

    // Nested ZIP + valid image + DOCX + unsupported txt
    const innerZip = zipSync({
      'nested_iqama.jpg': JPG_BYTES,
    });
    const docxBytes = makeDocxWithTextAndImage('PASSPORT HOLDER: ZAINAB AHMED, ID: 77889900, INDIA');
    const outerZip = zipSync({
      '__MACOSX/._ignore.jpg': JPG_BYTES,
      'person1.png': PNG_BYTES,
      'sub/archive.zip': innerZip,
      'manifest.docx': docxBytes,
      'notes.csv': ENC.encode('a,b,c'),
    });

    const okRes = await app.request(
      'https://worker.local/api/extract/ingest',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(outerZip.byteLength),
          'X-File-Name': 'batch.zip',
        },
        body: outerZip,
      },
      env
    );
    expect(okRes.status).toBe(201);
    const data = (await okRes.json()) as {
      items: Array<{ fileId: string; accessToken: string; fileName: string; kind: string }>;
      skipped: Array<{ fileName: string; reason: string }>;
    };

    expect(data.items.length).toBe(4); // person1.png, nested_iqama.jpg, manifest/passport_scan.png, manifest.txt
    expect(data.skipped.some((s) => s.fileName === 'notes.csv')).toBe(true);
  });

  it('rotates 1-20 API keys round-robin, cools down 429 keys, falls back across models, and deletes securely', async () => {
    const env = createTestEnv({
      GEMINI_API_KEYS: 'dummy-test-key-One-1111111111, dummy-test-key-Two-2222222222',
    });

    const seenKeys: string[] = [];
    const seenModels: string[] = [];

    const mockFetch: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      const headers = new Headers(init?.headers);
      const apiKey = headers.get('x-goog-api-key') ?? '';
      seenKeys.push(apiKey);

      const match = url.match(/models\/([^:]+):generateContent/);
      const model = match?.[1] ?? '';
      seenModels.push(model);

      // Simulate Key 1 hitting 429 on gemini-3.6-flash, and gemini-3.6-flash also 503 on Key 2 -> fallback to gemini-3.5-flash-lite
      if (apiKey.includes('One')) {
        return new Response(JSON.stringify({ error: { code: 429, message: 'RESOURCE_EXHAUSTED' } }), {
          status: 429,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (model === 'gemini-3.6-flash') {
        return new Response(JSON.stringify({ error: { code: 503, message: 'Overloaded' } }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      documents: [
                        {
                          page_number: 1,
                          name: 'AHMED RAZA',
                          passport_number: null,
                          iqama_number: '2345-6789-01',
                          national_id_number: null,
                          visa_number: 'V887766',
                          nationality: 'Pakistan',
                          confidence: 0.92,
                        },
                      ],
                    }),
                  },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    };

    const app = new Hono<{ Bindings: typeof env }>();
    app.route('/api/extract', createExtractRoutes({ geminiFetchImpl: mockFetch, sleepImpl: async () => {} }));

    // Ingest PNG
    const ingestRes = await app.request(
      'https://worker.local/api/extract/ingest',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(PNG_BYTES.byteLength),
          'X-File-Name': 'iqama.png',
        },
        body: PNG_BYTES,
      },
      env
    );
    expect(ingestRes.status).toBe(201);
    const ingestData = (await ingestRes.json()) as {
      items: Array<{ fileId: string; accessToken: string }>;
    };
    const { fileId, accessToken } = ingestData.items[0];

    // Run extraction with Auto fallback
    const runRes = await app.request(
      'https://worker.local/api/extract/run',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Extract-Token': accessToken,
        },
        body: JSON.stringify({ fileId, model: 'auto' }),
      },
      env
    );
    expect(runRes.status).toBe(200);
    const runData = (await runRes.json()) as {
      modelUsed: string;
      documents: Array<{ name: string; idNumber: string; idType: string; nationality: string }>;
    };

    expect(runData.modelUsed).toBe('gemini-3.5-flash-lite');
    expect(runData.documents[0]).toMatchObject({
      name: 'AHMED RAZA',
      idNumber: '2345678901',
      idType: 'iqama',
      nationality: 'PAKISTANI',
    });
    expect(seenKeys.some((k) => k.includes('One'))).toBe(true);
    expect(seenKeys.some((k) => k.includes('Two'))).toBe(true);
    expect(seenModels).toContain('gemini-3.6-flash');
    expect(seenModels).toContain('gemini-3.5-flash-lite');

    // Manual model without fallback fails cleanly when selected model returns 503
    const manualFail = await app.request(
      'https://worker.local/api/extract/run',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Extract-Token': accessToken,
        },
        body: JSON.stringify({ fileId, model: 'gemini-3.6-flash', allowFallback: false }),
      },
      env
    );
    expect(manualFail.status).toBe(502);

    // Token-gated preview works with valid token and blocks missing/wrong token
    const deniedPreview = await app.request(`https://worker.local/api/extract/file/${fileId}`, {}, env);
    expect(deniedPreview.status).toBe(401);

    const okPreview = await app.request(
      `https://worker.local/api/extract/file/${fileId}`,
      { headers: { 'X-Extract-Token': accessToken } },
      env
    );
    expect(okPreview.status).toBe(200);
    expect(okPreview.headers.get('Content-Type')).toBe('image/png');

    // Delete removes R2 file and DB active status
    const delRes = await app.request(
      `https://worker.local/api/extract/file/${fileId}`,
      { method: 'DELETE', headers: { 'X-Extract-Token': accessToken } },
      env
    );
    expect(delRes.status).toBe(200);
    expect(env.FILES.store.size).toBe(0);
  });

  it('uses Gemini Files API for files larger than inline_threshold_mb', async () => {
    const env = createTestEnv({
      GEMINI_API_KEYS: 'dummy-test-files-api-key-11111',
    });
    // Set inline threshold to 1 MB via DB and upload a 1.2 MB PDF? Even simpler: update threshold to 0? Or test 1.2 MB with threshold 1 MB!
    await env.DB.prepare('UPDATE extract_settings SET inline_threshold_mb = 1 WHERE id = 1').run();
    const largePdf = new Uint8Array(1.2 * 1024 * 1024);
    largePdf.set(PDF_BYTES, 0);

    let filesUploadCalled = false;
    let filesDeleteCalled = false;

    const mockFetch: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/upload/v1beta/files')) {
        return new Response(null, {
          status: 200,
          headers: { 'x-goog-upload-url': 'https://upload.example.local/session/1' },
        });
      }
      if (url === 'https://upload.example.local/session/1') {
        filesUploadCalled = true;
        return new Response(
          JSON.stringify({
            file: {
              name: 'files/abc123',
              uri: 'https://generativelanguage.googleapis.com/v1beta/files/abc123',
              state: 'ACTIVE',
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      if (url.endsWith('/files/abc123') && init?.method === 'DELETE') {
        filesDeleteCalled = true;
        return new Response('{}', { status: 200 });
      }
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      documents: [
                        {
                          page_number: 1,
                          name: 'SARA KHAN',
                          passport_number: 'P5566778',
                          nationality: 'SAUDI',
                        },
                        {
                          page_number: 2,
                          name: 'OMAR FAROOQ',
                          national_id_number: '42101-5566778-9',
                          nationality: 'UAE',
                        },
                      ],
                    }),
                  },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    };

    const app = new Hono<{ Bindings: typeof env }>();
    app.route('/api/extract', createExtractRoutes({ geminiFetchImpl: mockFetch, sleepImpl: async () => {} }));

    const ingestRes = await app.request(
      'https://worker.local/api/extract/ingest',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(largePdf.byteLength),
          'X-File-Name': 'multi.pdf',
        },
        body: largePdf,
      },
      env
    );
    expect(ingestRes.status).toBe(201);
    const { items } = (await ingestRes.json()) as { items: Array<{ fileId: string; accessToken: string }> };

    const runRes = await app.request(
      'https://worker.local/api/extract/run',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Extract-Token': items[0].accessToken },
        body: JSON.stringify({ fileId: items[0].fileId }),
      },
      env
    );
    expect(runRes.status).toBe(200);
    const body = (await runRes.json()) as {
      documents: Array<{ pageNumber: number; name: string; idNumber: string; idType: string; nationality: string }>;
    };
    expect(filesUploadCalled).toBe(true);
    expect(filesDeleteCalled).toBe(true);
    expect(body.documents).toHaveLength(2);
    expect(body.documents[1]).toMatchObject({
      pageNumber: 2,
      name: 'OMAR FAROOQ',
      idNumber: '4210155667789',
      idType: 'national_id',
      nationality: 'EMIRATI',
    });
  });

  it('manages encrypted Gemini keys in Admin API (masked only) and cleans up expired files', async () => {
    const app = createApp();
    const env = createTestEnv();
    const cookie = await signupAndGetCookie(app, env);

    const secretKey = 'dummy-test-managed-key-99887766554433';
    const addRes = await app.request(
      'https://worker.local/api/admin/gemini-keys',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: ORIGIN,
          'X-Requested-With': CSRF,
          Cookie: cookie,
        },
        body: JSON.stringify({ apiKey: secretKey, label: 'Primary Key' }),
      },
      env
    );
    expect(addRes.status).toBe(201);
    const addBody = await addRes.json();
    // Raw key must NEVER appear in response
    expect(JSON.stringify(addBody)).not.toContain(secretKey);

    const listRes = await app.request(
      'https://worker.local/api/admin/extract-settings',
      { headers: { Cookie: cookie } },
      env
    );
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as {
      keys: Array<{ id: string; maskedKey: string; label: string }>;
      maxPdfMb: number;
      concurrency: number;
    };
    expect(JSON.stringify(listBody)).not.toContain(secretKey);
    expect(listBody.keys).toHaveLength(1);
    expect(listBody.keys[0].maskedKey).toContain('••••••');

    // Update settings
    const patchSettings = await app.request(
      'https://worker.local/api/admin/extract-settings',
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Origin: ORIGIN,
          'X-Requested-With': CSRF,
          Cookie: cookie,
        },
        body: JSON.stringify({ maxPdfMb: 40, concurrency: 4 }),
      },
      env
    );
    expect(patchSettings.status).toBe(200);

    // Public config reflects activeKeyCount without exposing keys
    const pubCfg = await app.request('https://worker.local/api/extract/config', {}, env);
    expect(pubCfg.status).toBe(200);
    const pubCfgData = (await pubCfg.json()) as {
      maxPdfMb: number;
      effectiveConcurrency: number;
      activeKeyCount: number;
    };
    expect(pubCfgData.maxPdfMb).toBe(40);
    expect(pubCfgData.activeKeyCount).toBe(1);
    expect(pubCfgData.effectiveConcurrency).toBe(1);
    expect(JSON.stringify(pubCfgData)).not.toContain(secretKey);

    // Delete key
    const delKeyRes = await app.request(
      `https://worker.local/api/admin/gemini-keys/${listBody.keys[0].id}`,
      {
        method: 'DELETE',
        headers: { Origin: ORIGIN, 'X-Requested-With': CSRF, Cookie: cookie },
      },
      env
    );
    expect(delKeyRes.status).toBe(200);

    // Verify expired extraction files cleanup
    const ingestRes = await app.request(
      'https://worker.local/api/extract/ingest',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(PNG_BYTES.byteLength),
          'X-File-Name': 'temp.png',
        },
        body: PNG_BYTES,
      },
      env
    );
    expect(ingestRes.status).toBe(201);
    expect(env.FILES.store.size).toBe(1);
    const deletedCount = await cleanupExpiredExtractionFiles(env, Date.now() + 25 * 60 * 60 * 1000);
    expect(deletedCount).toBe(1);
    expect(env.FILES.store.size).toBe(0);
  });

  it('issues batch upload tickets from /session for multi-file Turnstile ingest', async () => {
    const app = createApp();
    const env = createTestEnv({
      TURNSTILE_SECRET_KEY: 'test-turnstile-secret',
    });

    // Without turnstile or batch ticket -> 403
    const denied = await app.request(
      'https://worker.local/api/extract/ingest',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(PNG_BYTES.byteLength),
          'X-File-Name': 'a.png',
        },
        body: PNG_BYTES,
      },
      env
    );
    expect(denied.status).toBe(403);

    // Mock global fetch temporarily only for Turnstile siteverify in /session
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });

    try {
      const sessionRes = await app.request(
        'https://worker.local/api/extract/session',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ turnstileToken: 'valid-turnstile-token-12345' }),
        },
        env
      );
      expect(sessionRes.status).toBe(200);
      const { batchTicket } = (await sessionRes.json()) as { batchTicket: string };
      expect(batchTicket).toContain('.');

      // Multiple parallel uploads using the same batchTicket succeed
      const [u1, u2] = await Promise.all([
        app.request(
          'https://worker.local/api/extract/ingest',
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/octet-stream',
              'Content-Length': String(PNG_BYTES.byteLength),
              'X-File-Name': 'one.png',
              'X-Extract-Batch-Token': batchTicket,
            },
            body: PNG_BYTES,
          },
          env
        ),
        app.request(
          'https://worker.local/api/extract/ingest',
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/octet-stream',
              'Content-Length': String(JPG_BYTES.byteLength),
              'X-File-Name': 'two.jpg',
              'X-Extract-Batch-Token': batchTicket,
            },
            body: JPG_BYTES,
          },
          env
        ),
      ]);
      expect(u1.status).toBe(201);
      expect(u2.status).toBe(201);
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
