import type { ItemType } from '../types';

export const FILE_SIZE_LIMITS: Record<Exclude<ItemType, 'link'>, number> = {
  image: 10 * 1024 * 1024,    // 10 MB
  document: 25 * 1024 * 1024, // 25 MB
  video: 50 * 1024 * 1024,    // 50 MB
};

export interface ValidatedFileMeta {
  category: Exclude<ItemType, 'link'>;
  extension: string;
  mimeType: string;
}

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif']);
const DOC_EXTENSIONS = new Set(['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx']);
const VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'mov']);

const OOXML_MARKERS = ['[Content_Types].xml', '_rels/', 'docProps/', 'word/', 'xl/', 'ppt/'];
const DANGEROUS_ASCII_PREFIXES = ['<!doctype', '<html', '<svg', '<script', '<?php'];

function extractExtension(filename: string): string {
  const clean = filename.trim().toLowerCase();
  const lastDot = clean.lastIndexOf('.');
  if (lastDot < 0 || lastDot === clean.length - 1) return '';
  return clean.slice(lastDot + 1);
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
  let s = '';
  for (let i = 0; i < length; i++) {
    s += String.fromCharCode(buf[offset + i]);
  }
  return s;
}

function containsDangerousHeader(header: Uint8Array): boolean {
  // Reject PE executables (MZ), ELF binaries, shebang scripts, or HTML/SVG/XML scripts
  if (startsWithBytes(header, [0x4d, 0x5a])) return true; // MZ
  if (startsWithBytes(header, [0x7f, 0x45, 0x4c, 0x46])) return true; // ELF
  if (startsWithBytes(header, [0x23, 0x21])) return true; // #!

  const sampleText = new TextDecoder('utf-8')
    .decode(header.subarray(0, Math.min(header.length, 512)))
    .trimStart()
    .toLowerCase();

  for (const prefix of DANGEROUS_ASCII_PREFIXES) {
    if (sampleText.startsWith(prefix)) return true;
  }
  return false;
}

function isLikelyOOXMLZip(header: Uint8Array): boolean {
  // Standard ZIP local file header signature: PK\x03\x04
  if (!startsWithBytes(header, [0x50, 0x4b, 0x03, 0x04])) return false;

  // Check the initial local file headers inside the first 16 KB for OOXML markers
  const decoded = new TextDecoder('latin1').decode(header.subarray(0, Math.min(header.length, 16384)));
  for (const marker of OOXML_MARKERS) {
    if (decoded.includes(marker)) {
      return true;
    }
  }
  return false;
}

function detectImageMime(header: Uint8Array, ext: string): string | null {
  if (!IMAGE_EXTENSIONS.has(ext)) return null;

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (ext === 'png' && startsWithBytes(header, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return 'image/png';
  }
  // JPEG: FF D8 FF
  if ((ext === 'jpg' || ext === 'jpeg') && startsWithBytes(header, [0xff, 0xd8, 0xff])) {
    return 'image/jpeg';
  }
  // WEBP: RIFF....WEBP
  if (
    ext === 'webp' &&
    startsWithBytes(header, [0x52, 0x49, 0x46, 0x46]) &&
    asciiAt(header, 8, 4) === 'WEBP'
  ) {
    return 'image/webp';
  }
  // GIF: GIF87a or GIF89a
  if (ext === 'gif') {
    const sig = asciiAt(header, 0, 6);
    if (sig === 'GIF87a' || sig === 'GIF89a') {
      return 'image/gif';
    }
  }
  return null;
}

function detectDocumentMime(header: Uint8Array, ext: string): string | null {
  if (!DOC_EXTENSIONS.has(ext)) return null;

  // PDF: %PDF- (allow up to 16 bytes leading whitespace/BOM)
  if (ext === 'pdf') {
    const probe = asciiAt(header, 0, Math.min(header.length, 32));
    if (probe.includes('%PDF-')) {
      return 'application/pdf';
    }
    return null;
  }

  // OOXML (DOCX, XLSX, PPTX)
  if (ext === 'docx' && isLikelyOOXMLZip(header)) {
    return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  }
  if (ext === 'xlsx' && isLikelyOOXMLZip(header)) {
    return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  }
  if (ext === 'pptx' && isLikelyOOXMLZip(header)) {
    return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
  }

  // Legacy OLE2 Compound Binary Office documents (DOC, XLS, PPT): D0 CF 11 E0 A1 B1 1A E1
  if (startsWithBytes(header, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) {
    if (ext === 'doc') return 'application/msword';
    if (ext === 'xls') return 'application/vnd.ms-excel';
    if (ext === 'ppt') return 'application/vnd.ms-powerpoint';
  }

  return null;
}

function detectVideoMime(header: Uint8Array, ext: string): string | null {
  if (!VIDEO_EXTENSIONS.has(ext)) return null;

  // MP4 / MOV ISO Base Media File Format: bytes 4..7 == 'ftyp'
  if ((ext === 'mp4' || ext === 'mov') && asciiAt(header, 4, 4) === 'ftyp') {
    const brand = asciiAt(header, 8, 4).toLowerCase();
    if (ext === 'mov' && brand.startsWith('qt')) {
      return 'video/quicktime';
    }
    if (ext === 'mov') {
      return 'video/quicktime';
    }
    // Common MP4 / M4V / ISO brands
    if (/^[a-z0-9 ]{4}$/.test(brand)) {
      return 'video/mp4';
    }
  }

  // WebM: EBML header 1A 45 DF A3 + 'webm' DocType in first 128 bytes
  if (ext === 'webm' && startsWithBytes(header, [0x1a, 0x45, 0xdf, 0xa3])) {
    const probe = new TextDecoder('latin1').decode(header.subarray(0, Math.min(header.length, 128)));
    if (probe.includes('webm')) {
      return 'video/webm';
    }
  }

  return null;
}

/**
 * Inspects file extension, claimed category, size limit, and real magic bytes.
 * Rejects mismatched types, SVGs, HTML, executables, and unsupported formats.
 */
export function validateUploadedFileHeader(params: {
  filename: string;
  category: Exclude<ItemType, 'link'>;
  sizeBytes: number;
  headerBytes: Uint8Array;
}): { ok: true; meta: ValidatedFileMeta } | { ok: false; error: string } {
  const { filename, category, sizeBytes, headerBytes } = params;

  const limit = FILE_SIZE_LIMITS[category];
  if (!limit) {
    return { ok: false, error: 'Unsupported upload category.' };
  }

  if (sizeBytes <= 0) {
    return { ok: false, error: 'File appears to be empty.' };
  }

  if (sizeBytes > limit) {
    const mb = Math.round(limit / (1024 * 1024));
    return { ok: false, error: `File exceeds the ${mb} MB limit for ${category} uploads.` };
  }

  const ext = extractExtension(filename);
  if (!ext) {
    return { ok: false, error: 'File must have a valid file extension.' };
  }

  if (ext === 'svg' || ext === 'html' || ext === 'htm' || ext === 'js' || ext === 'exe') {
    return { ok: false, error: `Files of type .${ext} are not allowed for security reasons.` };
  }

  if (headerBytes.length < 8) {
    return { ok: false, error: 'File is too small or corrupted to verify.' };
  }

  if (containsDangerousHeader(headerBytes)) {
    return { ok: false, error: 'File content rejected by security check.' };
  }

  let mimeType: string | null = null;
  if (category === 'image') mimeType = detectImageMime(headerBytes, ext);
  else if (category === 'document') mimeType = detectDocumentMime(headerBytes, ext);
  else if (category === 'video') mimeType = detectVideoMime(headerBytes, ext);

  if (!mimeType) {
    return {
      ok: false,
      error: `Invalid or mismatched ${category} file. Content does not match .${ext} format.`,
    };
  }

  return {
    ok: true,
    meta: {
      category,
      extension: ext,
      mimeType,
    },
  };
}
