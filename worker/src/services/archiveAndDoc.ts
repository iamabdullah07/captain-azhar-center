import { Unzip, UnzipInflate } from 'fflate';
import type { Env } from '../types';

export type SupportedExtractKind = 'image' | 'pdf' | 'zip' | 'docx' | 'doc' | 'xlsx' | 'text';

export interface ValidatedUploadSpec {
  kind: SupportedExtractKind;
  extension: string;
  mimeType: string;
}

export interface UnpackedExtractItem {
  fileName: string;
  mimeType: string;
  bytes: Uint8Array;
  kind: 'image' | 'pdf' | 'text';
  sourceArchive?: string;
}

export interface SkippedArchiveEntry {
  fileName: string;
  reason: string;
}

export const ZIP_SAFETY_LIMITS = {
  maxDepth: 3,
  maxEntries: 100,
  maxTotalUncompressedBytes: 90 * 1024 * 1024, // 90 MB total safety cap in Worker RAM
  maxSingleImageBytes: 20 * 1024 * 1024,       // 20 MB per image
  maxCompressionRatio: 120,
} as const;

const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif']);
const HEIC_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1', 'heif']);
const OOXML_MARKERS = ['[Content_Types].xml', '_rels/', 'docProps/', 'word/', 'xl/'];
const DANGEROUS_PREFIXES = ['<!doctype', '<html', '<svg', '<script', '<?php'];

export class ArchiveExtractionError extends Error {
  statusCode: number;
  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = 'ArchiveExtractionError';
    this.statusCode = statusCode;
  }
}

export function getExtensionLower(filename: string): string {
  const clean = filename.trim().toLowerCase();
  const dot = clean.lastIndexOf('.');
  if (dot < 0 || dot === clean.length - 1) return '';
  return clean.slice(dot + 1);
}

function startsWithBytes(buf: Uint8Array, prefix: number[], offset = 0): boolean {
  if (buf.length < offset + prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (buf[offset + i] !== prefix[i]) return false;
  }
  return true;
}

function asciiAt(buf: Uint8Array, offset: number, length: number): string {
  if (buf.length < offset + length) return '';
  let out = '';
  for (let i = 0; i < length; i++) {
    out += String.fromCharCode(buf[offset + i]);
  }
  return out;
}

function hasDangerousHeader(header: Uint8Array): boolean {
  if (startsWithBytes(header, [0x4d, 0x5a])) return true; // MZ
  if (startsWithBytes(header, [0x7f, 0x45, 0x4c, 0x46])) return true; // ELF
  if (startsWithBytes(header, [0x23, 0x21])) return true; // #!

  const sample = new TextDecoder('utf-8')
    .decode(header.subarray(0, Math.min(header.length, 512)))
    .trimStart()
    .toLowerCase();
  return DANGEROUS_PREFIXES.some((p) => sample.startsWith(p));
}

function isOoxmlDocx(header: Uint8Array): boolean {
  if (!startsWithBytes(header, [0x50, 0x4b, 0x03, 0x04])) return false;
  const probe = new TextDecoder('latin1').decode(header.subarray(0, Math.min(header.length, 16384)));
  return OOXML_MARKERS.some((marker) => probe.includes(marker));
}

function detectImageMime(header: Uint8Array, ext: string): string | null {
  if (!IMAGE_EXTS.has(ext)) return null;

  if (ext === 'png' && startsWithBytes(header, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return 'image/png';
  }
  if ((ext === 'jpg' || ext === 'jpeg') && startsWithBytes(header, [0xff, 0xd8, 0xff])) {
    return 'image/jpeg';
  }
  if (
    ext === 'webp' &&
    startsWithBytes(header, [0x52, 0x49, 0x46, 0x46]) &&
    asciiAt(header, 8, 4) === 'WEBP'
  ) {
    return 'image/webp';
  }
  if ((ext === 'heic' || ext === 'heif') && asciiAt(header, 4, 4) === 'ftyp') {
    const brand = asciiAt(header, 8, 4).toLowerCase();
    if (HEIC_BRANDS.has(brand)) {
      return ext === 'heif' ? 'image/heif' : 'image/heic';
    }
  }
  return null;
}

/**
 * Validates uploaded file extension, magic bytes, and size limits for ALL FILES DATA.
 */
export function validateExtractUploadHeader(params: {
  filename: string;
  sizeBytes: number;
  headerBytes: Uint8Array;
  maxPdfBytes: number;
}): { ok: true; spec: ValidatedUploadSpec } | { ok: false; error: string } {
  const { filename, sizeBytes, headerBytes, maxPdfBytes } = params;
  const ext = getExtensionLower(filename);

  if (!ext) {
    return { ok: false, error: 'File must have a supported extension (JPG, PNG, WEBP, HEIC, PDF, ZIP, DOCX).' };
  }
  if (ext === 'svg' || ext === 'html' || ext === 'htm' || ext === 'js' || ext === 'exe') {
    return { ok: false, error: `Unsupported or blocked file type (.${ext}).` };
  }
  if (sizeBytes <= 0 || headerBytes.length < 4) {
    return { ok: false, error: 'Selected file is empty or corrupted.' };
  }
  if (hasDangerousHeader(headerBytes)) {
    return { ok: false, error: 'File content rejected by security check.' };
  }

  // Images
  if (IMAGE_EXTS.has(ext)) {
    if (sizeBytes > ZIP_SAFETY_LIMITS.maxSingleImageBytes) {
      return { ok: false, error: 'Image file exceeds the 20 MB maximum size limit.' };
    }
    const imgMime = detectImageMime(headerBytes, ext);
    if (!imgMime) {
      return { ok: false, error: `Invalid image content for .${ext} file.` };
    }
    return { ok: true, spec: { kind: 'image', extension: ext, mimeType: imgMime } };
  }

  // PDF
  if (ext === 'pdf') {
    if (sizeBytes > maxPdfBytes) {
      const mb = Math.round(maxPdfBytes / (1024 * 1024));
      return { ok: false, error: `PDF exceeds the ${mb} MB maximum size limit.` };
    }
    const probe = asciiAt(headerBytes, 0, Math.min(headerBytes.length, 32));
    if (!probe.includes('%PDF-')) {
      return { ok: false, error: 'Invalid PDF header signature.' };
    }
    return { ok: true, spec: { kind: 'pdf', extension: 'pdf', mimeType: 'application/pdf' } };
  }

  // ZIP
  if (ext === 'zip') {
    if (sizeBytes > maxPdfBytes) {
      const mb = Math.round(maxPdfBytes / (1024 * 1024));
      return { ok: false, error: `ZIP archive exceeds the ${mb} MB maximum size limit.` };
    }
    const isZip =
      startsWithBytes(headerBytes, [0x50, 0x4b, 0x03, 0x04]) ||
      startsWithBytes(headerBytes, [0x50, 0x4b, 0x05, 0x06]);
    if (!isZip) {
      return { ok: false, error: 'Invalid ZIP archive signature.' };
    }
    return { ok: true, spec: { kind: 'zip', extension: 'zip', mimeType: 'application/zip' } };
  }

  // DOCX / DOC
  if (ext === 'docx') {
    if (sizeBytes > 25 * 1024 * 1024) {
      return { ok: false, error: 'DOCX file exceeds the 25 MB maximum size limit.' };
    }
    if (!isOoxmlDocx(headerBytes)) {
      return { ok: false, error: 'Invalid DOCX document structure.' };
    }
    return {
      ok: true,
      spec: {
        kind: 'docx',
        extension: 'docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      },
    };
  }

  if (ext === 'doc') {
    if (sizeBytes > 25 * 1024 * 1024) {
      return { ok: false, error: 'DOC file exceeds the 25 MB maximum size limit.' };
    }
    if (!startsWithBytes(headerBytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) {
      return { ok: false, error: 'Invalid DOC binary signature.' };
    }
    return { ok: true, spec: { kind: 'doc', extension: 'doc', mimeType: 'application/msword' } };
  }

  // XLSX
  if (ext === 'xlsx') {
    if (sizeBytes > 25 * 1024 * 1024) {
      return { ok: false, error: 'XLSX file exceeds the 25 MB maximum size limit.' };
    }
    if (!isOoxmlDocx(headerBytes)) {
      return { ok: false, error: 'Invalid XLSX spreadsheet structure.' };
    }
    return {
      ok: true,
      spec: {
        kind: 'xlsx',
        extension: 'xlsx',
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      },
    };
  }

  // Plain Text & CSV
  if (ext === 'txt' || ext === 'csv') {
    if (sizeBytes > 10 * 1024 * 1024) {
      return { ok: false, error: `${ext.toUpperCase()} file exceeds the 10 MB maximum size limit.` };
    }
    return {
      ok: true,
      spec: {
        kind: 'text',
        extension: ext,
        mimeType: 'text/plain',
      },
    };
  }

  return {
    ok: false,
    error: `Unsupported file type (.${ext}). Accepted: JPG, JPEG, PNG, WEBP, HEIC, PDF, ZIP, DOCX, DOC, XLSX, CSV, TXT.`,
  };
}

/**
 * Sanitizes archive entry paths and rejects path traversal attempts.
 */
export function sanitizeArchiveEntryPath(rawPath: string): { safe: true; displayName: string; ignore: boolean } | { safe: false } {
  if (!rawPath || rawPath.includes('\0')) return { safe: false };
  const normalized = rawPath.replace(/\\/g, '/').trim();
  if (!normalized) return { safe: false };

  // Reject absolute paths, drive letters, and traversal segments
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
    return { safe: false };
  }

  const segments = normalized.split('/').filter((s) => s.length > 0 && s !== '.');
  if (segments.some((s) => s === '..')) {
    return { safe: false };
  }

  // Skip directory entries and OS metadata clutter
  if (normalized.endsWith('/') || segments.length === 0) {
    return { safe: true, displayName: '', ignore: true };
  }
  const base = segments[segments.length - 1];
  if (
    segments[0] === '__MACOSX' ||
    base === '.DS_Store' ||
    base === 'Thumbs.db' ||
    base === 'desktop.ini' ||
    base.startsWith('._')
  ) {
    return { safe: true, displayName: base, ignore: true };
  }

  const safeDisplay = segments
    .join('/')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .slice(0, 140);
  return { safe: true, displayName: safeDisplay || base, ignore: false };
}

function concatUint8Arrays(chunks: Uint8Array[], totalLength: number): Uint8Array {
  const out = new Uint8Array(totalLength);
  let offset = 0;
  for (const ch of chunks) {
    out.set(ch, offset);
    offset += ch.byteLength;
  }
  return out;
}

interface RawZipEntry {
  name: string;
  bytes: Uint8Array;
}

/**
 * Inflates a ZIP buffer with real-time byte counting to prevent zip-bombs and traversal.
 */
function readZipEntriesSafely(params: {
  zipBytes: Uint8Array;
  maxSingleEntryBytes: number;
  tracker: { totalEntries: number; totalUncompressedBytes: number };
  skippedOversized?: SkippedArchiveEntry[];
}): RawZipEntry[] {
  const { zipBytes, maxSingleEntryBytes, tracker, skippedOversized } = params;
  const entries: RawZipEntry[] = [];
  let fatalError: ArchiveExtractionError | null = null;

  const unzip = new Unzip((file) => {
    if (fatalError) return;

    const pathCheck = sanitizeArchiveEntryPath(file.name);
    if (!pathCheck.safe) {
      fatalError = new ArchiveExtractionError(`Blocked unsafe archive path: ${file.name}`, 400);
      return;
    }
    if (pathCheck.ignore) {
      return;
    }

    tracker.totalEntries += 1;
    if (tracker.totalEntries > ZIP_SAFETY_LIMITS.maxEntries) {
      fatalError = new ArchiveExtractionError(
        `Archive exceeds maximum allowed entry count (${ZIP_SAFETY_LIMITS.maxEntries}).`,
        400
      );
      return;
    }

    if (typeof file.originalSize === 'number') {
      if (file.originalSize > maxSingleEntryBytes) {
        const maxMb = Math.round(maxSingleEntryBytes / (1024 * 1024));
        skippedOversized?.push({
          fileName: pathCheck.displayName,
          reason: `Exceeds ${maxMb} MB maximum file size limit.`,
        });
        return;
      }
      if (tracker.totalUncompressedBytes + file.originalSize > ZIP_SAFETY_LIMITS.maxTotalUncompressedBytes) {
        fatalError = new ArchiveExtractionError(
          'Archive uncompressed size exceeds safety limit (possible zip bomb).',
          400
        );
        return;
      }
    }

    const chunks: Uint8Array[] = [];
    let entryBytes = 0;

    file.ondata = (err, data, final) => {
      if (fatalError) return;
      if (err) {
        fatalError = new ArchiveExtractionError(`Corrupted archive entry: ${pathCheck.displayName}`, 400);
        return;
      }
      if (data && data.byteLength > 0) {
        entryBytes += data.byteLength;
        tracker.totalUncompressedBytes += data.byteLength;

        if (tracker.totalUncompressedBytes > ZIP_SAFETY_LIMITS.maxTotalUncompressedBytes) {
          fatalError = new ArchiveExtractionError(
            'Archive uncompressed size exceeds safety limit (possible zip bomb).',
            400
          );
          return;
        }
        if (entryBytes > maxSingleEntryBytes) {
          fatalError = new ArchiveExtractionError(
            `Archive entry "${pathCheck.displayName}" exceeds maximum size limit.`,
            413
          );
          return;
        }
        if (
          typeof file.size === 'number' &&
          file.size > 0 &&
          entryBytes > 2 * 1024 * 1024 &&
          entryBytes / file.size > ZIP_SAFETY_LIMITS.maxCompressionRatio
        ) {
          fatalError = new ArchiveExtractionError(
            'Archive entry rejected due to suspicious compression ratio.',
            400
          );
          return;
        }
        chunks.push(data);
      }

      if (final && !fatalError) {
        entries.push({
          name: pathCheck.displayName,
          bytes: concatUint8Arrays(chunks, entryBytes),
        });
      }
    };

    file.start();
  });

  unzip.register(UnzipInflate);
  try {
    unzip.push(zipBytes, true);
  } catch (err) {
    if (fatalError) throw fatalError;
    throw new ArchiveExtractionError(
      err instanceof Error ? `Invalid ZIP archive: ${err.message}` : 'Invalid ZIP archive.',
      400
    );
  }

  if (fatalError) {
    throw fatalError;
  }

  return entries;
}

function decodeXmlEntities(input: string): string {
  return input
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, dec) => {
      const code = Number.parseInt(dec, 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : '';
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : '';
    });
}

function extractTextFromWordXml(xml: string): string {
  // Strip DrawingML fallback blocks so textbox contents aren't duplicated
  const cleanedXml = xml.replace(/<mc:Fallback[\s\S]*?<\/mc:Fallback>/gi, '');

  // Format Word tables (<w:tbl>) cleanly row-by-row so columns remain aligned for extraction
  const formattedTables = cleanedXml.replace(/<w:tbl\b[\s\S]*?<\/w:tbl>/gi, (tbl) => {
    const rows = tbl.match(/<w:tr\b[\s\S]*?<\/w:tr>/gi) ?? [];
    const lines: string[] = [];
    for (const tr of rows) {
      const cells = tr.match(/<w:tc\b[\s\S]*?<\/w:tc>/gi) ?? [];
      const cellTexts = cells.map((tc) => {
        const inner = tc
          .replace(/<\/w:p>/g, ' ')
          .replace(/<w:br[^>]*\/>/g, ' ')
          .replace(/<w:tab[^>]*\/>/g, ' ')
          .replace(/<[^>]+>/g, '');
        return decodeXmlEntities(inner).replace(/\s+/g, ' ').trim();
      });
      if (cellTexts.some(Boolean)) {
        lines.push(`| ${cellTexts.join(' | ')} |`);
      }
    }
    return lines.length > 0 ? `\n${lines.join('\n')}\n` : '';
  });

  const withBreaks = formattedTables
    .replace(/<\/w:p>/g, '\n')
    .replace(/<w:br[^>]*\/>/g, '\n')
    .replace(/<w:tab[^>]*\/>/g, ' | ')
    .replace(/<[^>]+>/g, '');

  return decodeXmlEntities(withBreaks)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractReadableTextFromLegacyDoc(bytes: Uint8Array): string {
  // Best-effort readable run extractor from OLE2 .doc binary when LibreOffice converter is absent
  const runs: string[] = [];
  let asciiRun = '';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if ((b >= 32 && b <= 126) || b === 9 || b === 10 || b === 13) {
      asciiRun += b === 13 ? '\n' : String.fromCharCode(b);
    } else {
      if (asciiRun.trim().length >= 8 && /[A-Za-z0-9]{4,}/.test(asciiRun)) {
        runs.push(asciiRun.trim());
      }
      asciiRun = '';
    }
  }
  if (asciiRun.trim().length >= 8 && /[A-Za-z0-9]{4,}/.test(asciiRun)) {
    runs.push(asciiRun.trim());
  }

  // Also scan UTF-16LE runs (standard Word Unicode text storage)
  let utf16Run = '';
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    const code = bytes[i] | (bytes[i + 1] << 8);
    if ((code >= 32 && code <= 126) || code === 9 || code === 10 || code === 13) {
      utf16Run += code === 13 ? '\n' : String.fromCharCode(code);
    } else {
      if (utf16Run.trim().length >= 8 && /[A-Za-z0-9]{4,}/.test(utf16Run)) {
        runs.push(utf16Run.trim());
      }
      utf16Run = '';
    }
  }
  if (utf16Run.trim().length >= 8 && /[A-Za-z0-9]{4,}/.test(utf16Run)) {
    runs.push(utf16Run.trim());
  }

  const filtered = Array.from(new Set(runs)).filter(
    (r) =>
      !/^(Root Entry|WordDocument|1Table|0Table|SummaryInformation|DocumentSummaryInformation|Microsoft Word|Normal\.dotm)/i.test(
        r
      )
  );
  return filtered.join('\n').trim();
}

function parseSharedStringsXml(xml: string): string[] {
  const strings: string[] = [];
  const siMatches = xml.match(/<si\b[\s\S]*?<\/si>/gi) ?? [];
  for (const si of siMatches) {
    const stripped = si.replace(/<[^>]+>/g, '');
    strings.push(decodeXmlEntities(stripped));
  }
  return strings;
}

export function unpackExcelSpreadsheet(params: {
  bytes: Uint8Array;
  fileName: string;
  sourceArchive?: string;
}): { items: UnpackedExtractItem[]; skipped: SkippedArchiveEntry[] } {
  const { bytes, fileName, sourceArchive } = params;
  const tracker = { totalEntries: 0, totalUncompressedBytes: 0 };
  const entries = readZipEntriesSafely({
    zipBytes: bytes,
    maxSingleEntryBytes: 25 * 1024 * 1024,
    tracker,
  });

  let sharedStrings: string[] = [];
  const sheetEntries: RawZipEntry[] = [];

  for (const entry of entries) {
    const lower = entry.name.toLowerCase();
    if (lower === 'xl/sharedstrings.xml') {
      sharedStrings = parseSharedStringsXml(new TextDecoder('utf-8').decode(entry.bytes));
    } else if (/^xl\/worksheets\/sheet\d+\.xml$/.test(lower)) {
      sheetEntries.push(entry);
    }
  }

  const sheetTexts: string[] = [];
  for (const sheet of sheetEntries) {
    const xml = new TextDecoder('utf-8').decode(sheet.bytes);
    const rows = xml.match(/<row\b[\s\S]*?<\/row>/gi) ?? [];
    const lines: string[] = [];
    for (const row of rows) {
      const cells = row.match(/<c\b[\s\S]*?<\/c>/gi) ?? [];
      const vals: string[] = [];
      for (const cell of cells) {
        const typeMatch = cell.match(/\bt="([^"]+)"/);
        const cellType = typeMatch?.[1] ?? '';
        let val = '';
        if (cellType === 'inlineStr') {
          val = decodeXmlEntities(cell.replace(/<[^>]+>/g, '')).trim();
        } else {
          const vMatch = cell.match(/<v>([\s\S]*?)<\/v>/i);
          const rawVal = vMatch ? decodeXmlEntities(vMatch[1]).trim() : '';
          if (cellType === 's') {
            const idx = Number.parseInt(rawVal, 10);
            val = Number.isFinite(idx) && sharedStrings[idx] !== undefined ? sharedStrings[idx] : rawVal;
          } else {
            val = rawVal;
          }
        }
        if (val) vals.push(val);
      }
      if (vals.length > 0) lines.push(`| ${vals.join(' | ')} |`);
    }
    if (lines.length > 0) sheetTexts.push(lines.join('\n'));
  }

  const combined = sheetTexts.join('\n\n').trim();
  if (!combined) {
    throw new ArchiveExtractionError('XLSX spreadsheet contained no readable cell data.', 400);
  }

  return {
    items: [
      {
        fileName,
        mimeType: 'text/plain',
        bytes: new TextEncoder().encode(combined),
        kind: 'text',
        sourceArchive,
      },
    ],
    skipped: [],
  };
}

async function convertWordToPdfViaService(params: {
  bytes: Uint8Array;
  ext: 'doc' | 'docx';
  env: Env;
}): Promise<Uint8Array | null> {
  const converterBase = (params.env.WORD_CONVERTER_URL ?? '').trim().replace(/\/+$/, '');
  if (!converterBase) return null;

  const headers: Record<string, string> = {
    'Content-Type': 'application/octet-stream',
    'X-File-Ext': params.ext,
  };
  const secret = (params.env.WORD_CONVERTER_SECRET ?? '').trim();
  if (secret) {
    headers['Authorization'] = `Bearer ${secret}`;
  }

  const bodyCopy = new Uint8Array(params.bytes.byteLength);
  bodyCopy.set(params.bytes);

  const res = await fetch(`${converterBase}/convert`, {
    method: 'POST',
    headers,
    body: bodyCopy,
    signal: AbortSignal.timeout(40_000),
  });
  if (!res.ok) return null;

  const pdfBytes = new Uint8Array(await res.arrayBuffer());
  const sig = asciiAt(pdfBytes, 0, Math.min(32, pdfBytes.byteLength));
  if (pdfBytes.byteLength < 8 || !sig.includes('%PDF-')) return null;
  return pdfBytes;
}

/**
 * Unpacks a DOCX into PDF (if LibreOffice converter exists) or into embedded images + document text.
 */
export async function unpackWordDocument(params: {
  bytes: Uint8Array;
  fileName: string;
  ext: 'doc' | 'docx';
  env: Env;
  sourceArchive?: string;
}): Promise<{ items: UnpackedExtractItem[]; skipped: SkippedArchiveEntry[] }> {
  const { bytes, fileName, ext, env, sourceArchive } = params;

  // Prefer full visual fidelity PDF conversion when LibreOffice converter is configured
  try {
    const convertedPdf = await convertWordToPdfViaService({ bytes, ext, env });
    if (convertedPdf) {
      return {
        items: [
          {
            fileName: fileName.replace(/\.(doc|docx)$/i, '.pdf'),
            mimeType: 'application/pdf',
            bytes: convertedPdf,
            kind: 'pdf',
            sourceArchive,
          },
        ],
        skipped: [],
      };
    }
  } catch {
    // Fall through to native DOCX OOXML parser if converter is unavailable
  }

  if (ext === 'doc') {
    const legacyText = extractReadableTextFromLegacyDoc(bytes);
    if (legacyText.replace(/\s+/g, '').length >= 10) {
      return {
        items: [
          {
            fileName,
            mimeType: 'text/plain',
            bytes: new TextEncoder().encode(legacyText),
            kind: 'text',
            sourceArchive,
          },
        ],
        skipped: [],
      };
    }
    throw new ArchiveExtractionError(
      'Legacy .doc file could not be read cleanly without Word-to-PDF converter. Please save as .docx or .pdf and upload again.',
      400
    );
  }

  const tracker = { totalEntries: 0, totalUncompressedBytes: 0 };
  const entries = readZipEntriesSafely({
    zipBytes: bytes,
    maxSingleEntryBytes: 25 * 1024 * 1024,
    tracker,
  });

  const mediaCandidates: UnpackedExtractItem[] = [];
  const skipped: SkippedArchiveEntry[] = [];
  const textSegments: string[] = [];
  const baseDocName = fileName.replace(/\.docx$/i, '');

  for (const entry of entries) {
    const lower = entry.name.toLowerCase();
    if (lower.startsWith('word/media/')) {
      const mediaExt = getExtensionLower(entry.name);
      const mime = detectImageMime(entry.bytes, mediaExt);
      if (mime) {
        const mediaBase = entry.name.split('/').pop() || `image.${mediaExt}`;
        mediaCandidates.push({
          fileName: `${baseDocName}/${mediaBase}`,
          mimeType: mime,
          bytes: entry.bytes,
          kind: 'image',
          sourceArchive,
        });
      } else {
        skipped.push({ fileName: entry.name, reason: 'Unsupported embedded media format in DOCX.' });
      }
      continue;
    }

    if (
      lower === 'word/document.xml' ||
      /^word\/(document\d*|header\d*|footer\d*|footnotes|endnotes)\.xml$/.test(lower)
    ) {
      const xmlText = new TextDecoder('utf-8').decode(entry.bytes);
      const extracted = extractTextFromWordXml(xmlText);
      if (extracted) textSegments.push(extracted);
    }
  }

  const combinedText = textSegments.join('\n').trim();
  const compactLen = combinedText.replace(/\s+/g, '').length;
  const items: UnpackedExtractItem[] = [];

  // When meaningful document text/table exists, keep text and ignore tiny (<8KB) decorative logo icons
  if (compactLen >= 5) {
    items.push({
      fileName,
      mimeType: 'text/plain',
      bytes: new TextEncoder().encode(combinedText),
      kind: 'text',
      sourceArchive,
    });
    for (const img of mediaCandidates) {
      if (compactLen < 20 || img.bytes.byteLength >= 8 * 1024) {
        items.push(img);
      }
    }
  } else {
    items.push(...mediaCandidates);
  }

  if (items.length === 0) {
    throw new ArchiveExtractionError('DOCX file contained no readable text or supported images.', 400);
  }

  return { items, skipped };
}

/**
 * Recursively unpacks ZIP / nested ZIP archives into validated individual extractable files.
 */
export async function unpackZipArchive(params: {
  zipBytes: Uint8Array;
  archiveName: string;
  maxPdfBytes: number;
  env: Env;
  depth?: number;
  tracker?: { totalEntries: number; totalUncompressedBytes: number };
}): Promise<{ items: UnpackedExtractItem[]; skipped: SkippedArchiveEntry[] }> {
  const {
    zipBytes,
    archiveName,
    maxPdfBytes,
    env,
    depth = 1,
    tracker = { totalEntries: 0, totalUncompressedBytes: 0 },
  } = params;

  if (depth > ZIP_SAFETY_LIMITS.maxDepth) {
    return {
      items: [],
      skipped: [
        {
          fileName: archiveName,
          reason: `Nested ZIP depth limit (${ZIP_SAFETY_LIMITS.maxDepth}) exceeded.`,
        },
      ],
    };
  }

  const skipped: SkippedArchiveEntry[] = [];
  const entries = readZipEntriesSafely({
    zipBytes,
    maxSingleEntryBytes: Math.max(maxPdfBytes, ZIP_SAFETY_LIMITS.maxSingleImageBytes),
    tracker,
    skippedOversized: skipped,
  });

  const items: UnpackedExtractItem[] = [];

  for (const entry of entries) {
    const ext = getExtensionLower(entry.name);
    if (!ext) {
      skipped.push({ fileName: entry.name, reason: 'Missing file extension.' });
      continue;
    }

    const check = validateExtractUploadHeader({
      filename: entry.name,
      sizeBytes: entry.bytes.byteLength,
      headerBytes: entry.bytes.subarray(0, Math.min(entry.bytes.byteLength, 16384)),
      maxPdfBytes,
    });

    if (!check.ok) {
      skipped.push({ fileName: entry.name, reason: check.error });
      continue;
    }

    if (check.spec.kind === 'zip') {
      const nested = await unpackZipArchive({
        zipBytes: entry.bytes,
        archiveName: `${archiveName}/${entry.name}`,
        maxPdfBytes,
        env,
        depth: depth + 1,
        tracker,
      });
      items.push(...nested.items);
      skipped.push(...nested.skipped);
      continue;
    }

    if (check.spec.kind === 'docx' || check.spec.kind === 'doc') {
      try {
        const docRes = await unpackWordDocument({
          bytes: entry.bytes,
          fileName: entry.name,
          ext: check.spec.kind,
          env,
          sourceArchive: archiveName,
        });
        items.push(...docRes.items);
        skipped.push(...docRes.skipped);
      } catch (err) {
        skipped.push({
          fileName: entry.name,
          reason: err instanceof Error ? err.message : 'Unable to unpack Word document.',
        });
      }
      continue;
    }

    if (check.spec.kind === 'xlsx') {
      try {
        const xlRes = unpackExcelSpreadsheet({
          bytes: entry.bytes,
          fileName: entry.name,
          sourceArchive: archiveName,
        });
        items.push(...xlRes.items);
        skipped.push(...xlRes.skipped);
      } catch (err) {
        skipped.push({
          fileName: entry.name,
          reason: err instanceof Error ? err.message : 'Unable to read XLSX spreadsheet.',
        });
      }
      continue;
    }

    items.push({
      fileName: entry.name,
      mimeType: check.spec.mimeType,
      bytes: entry.bytes,
      kind: check.spec.kind,
      sourceArchive: archiveName,
    });
  }

  return { items, skipped };
}
