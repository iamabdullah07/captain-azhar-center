import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const PORT = Number.parseInt(process.env.PORT || '8788', 10);
const SECRET = (process.env.WORD_CONVERTER_SECRET || '').trim();
const MAX_BYTES = 25 * 1024 * 1024; // 25 MB
const CONVERT_TIMEOUT_MS = 35_000;

function resolveSofficeBinary() {
  const configured = (process.env.LIBREOFFICE_BIN || '').trim();
  if (configured) return configured;

  if (process.platform === 'win32') {
    const candidates = [
      'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
      'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
    ];
    for (const c of candidates) {
      if (existsSync(c)) return c;
    }
    return 'soffice.exe';
  }
  return 'soffice';
}

const SOFFICE_BIN = resolveSofficeBinary();

function constantTimeMatch(a, b) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function isAuthorized(req) {
  if (!SECRET) return true;
  const auth = String(req.headers.authorization || '');
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  const headerSecret = String(req.headers['x-converter-secret'] || '').trim();
  const candidate = bearer || headerSecret;
  return Boolean(candidate && constantTimeMatch(candidate, SECRET));
}

function validateWordBytes(bytes, ext) {
  if (bytes.length < 8 || bytes.length > MAX_BYTES) return false;
  if (ext === 'docx') {
    if (bytes[0] !== 0x50 || bytes[1] !== 0x4b || bytes[2] !== 0x03 || bytes[3] !== 0x04) {
      return false;
    }
    const probe = bytes.subarray(0, Math.min(bytes.length, 16384)).toString('latin1');
    return (
      probe.includes('[Content_Types].xml') ||
      probe.includes('word/') ||
      probe.includes('_rels/')
    );
  }
  if (ext === 'doc') {
    const ole = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
    return ole.every((b, idx) => bytes[idx] === b);
  }
  return false;
}

function readRequestBody(req, maxBytes) {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks = [];
    let total = 0;
    let settled = false;

    req.on('data', (chunk) => {
      if (settled) return;
      total += chunk.length;
      if (total > maxBytes) {
        settled = true;
        rejectPromise(new Error('FILE_TOO_LARGE'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!settled) {
        settled = true;
        resolvePromise(Buffer.concat(chunks, total));
      }
    });
    req.on('error', (err) => {
      if (!settled) {
        settled = true;
        rejectPromise(err);
      }
    });
  });
}

const MACRO_DISABLE_XCU = `<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item>
  <item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="DisableMacrosExecution" oor:op="fuse"><value>true</value></prop></item>
</oor:items>
`;

async function runSofficeConvert(inputPath, outDir, profileDir) {
  const userDir = join(profileDir, 'user');
  await mkdir(userDir, { recursive: true });
  await writeFile(join(userDir, 'registrymodifications.xcu'), MACRO_DISABLE_XCU, 'utf8');

  return new Promise((resolvePromise, rejectPromise) => {
    const profileUrl = pathToFileURL(resolve(profileDir)).href;
    const args = [
      '--headless',
      '--invisible',
      '--nodefault',
      '--nofirststartwizard',
      '--nolockcheck',
      '--nologo',
      '--norestore',
      `-env:UserInstallation=${profileUrl}`,
      '--convert-to',
      'pdf:writer_pdf_Export',
      '--outdir',
      outDir,
      inputPath,
    ];

    execFile(
      SOFFICE_BIN,
      args,
      {
        timeout: CONVERT_TIMEOUT_MS,
        killSignal: 'SIGKILL',
        windowsHide: true,
      },
      (err, _stdout, stderr) => {
        if (err) {
          rejectPromise(new Error(stderr || err.message || 'LibreOffice conversion failed.'));
          return;
        }
        resolvePromise();
      }
    );
  });
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);

  if (req.method === 'GET' && url.pathname === '/health') {
    const hasBinary = SOFFICE_BIN.includes('\\') || SOFFICE_BIN.includes('/')
      ? existsSync(SOFFICE_BIN)
      : true;
    sendJson(res, hasBinary ? 200 : 503, { ok: hasBinary, engine: 'libreoffice' });
    return;
  }

  if (req.method !== 'POST' || url.pathname !== '/convert') {
    sendJson(res, 404, { error: 'Not found.' });
    return;
  }

  if (!isAuthorized(req)) {
    sendJson(res, 401, { error: 'Unauthorized converter request.' });
    return;
  }

  const rawExt = String(req.headers['x-file-ext'] || '').trim().toLowerCase();
  const ext = rawExt === 'doc' || rawExt === 'docx' ? rawExt : '';
  if (!ext) {
    sendJson(res, 400, { error: 'Only .doc and .docx extensions are supported.' });
    return;
  }

  let body;
  try {
    body = await readRequestBody(req, MAX_BYTES);
  } catch (err) {
    const tooLarge = err instanceof Error && err.message === 'FILE_TOO_LARGE';
    sendJson(res, tooLarge ? 413 : 400, {
      error: tooLarge ? 'File exceeds the 25 MB limit.' : 'Invalid upload stream.',
    });
    return;
  }

  if (!validateWordBytes(body, ext)) {
    sendJson(res, 400, { error: 'Invalid or corrupted Word document bytes.' });
    return;
  }

  const workDir = await mkdtemp(join(tmpdir(), 'cac-word2pdf-'));
  let cleaned = false;
  const cleanupWorkDir = async () => {
    if (cleaned) return;
    cleaned = true;
    await rm(workDir, {
      recursive: true,
      force: true,
      maxRetries: 6,
      retryDelay: 120,
    }).catch(() => {});
  };

  try {
    const inputPath = join(workDir, `input.${ext}`);
    const profileDir = join(workDir, 'lo-profile');
    const expectedPdfPath = join(workDir, 'input.pdf');
    await writeFile(inputPath, body);

    await runSofficeConvert(inputPath, workDir, profileDir);

    const pdfBytes = await readFile(expectedPdfPath);
    if (pdfBytes.length < 8 || !pdfBytes.subarray(0, 32).toString('ascii').includes('%PDF-')) {
      await cleanupWorkDir();
      sendJson(res, 502, { error: 'Converter did not produce a valid PDF.' });
      return;
    }

    await cleanupWorkDir();
    res.writeHead(200, {
      'Content-Type': 'application/pdf',
      'Content-Length': pdfBytes.length,
      'Cache-Control': 'no-store',
    });
    res.end(pdfBytes);
  } catch (err) {
    await cleanupWorkDir();
    const msg = err instanceof Error ? err.message : 'Word conversion failed.';
    sendJson(res, 500, { error: msg });
  } finally {
    await cleanupWorkDir();
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Word-to-PDF converter listening on port ${PORT} using ${SOFFICE_BIN}`);
});
