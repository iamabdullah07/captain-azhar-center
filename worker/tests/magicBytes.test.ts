import { describe, expect, it } from 'vitest';
import { validateUploadedFileHeader } from '../src/services/magicBytes';

const enc = new TextEncoder();

describe('magicBytes validator', () => {
  it('accepts valid PNG, JPEG, WEBP, and GIF headers', () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
    expect(validateUploadedFileHeader({ filename: 'photo.png', category: 'image', sizeBytes: 1024, headerBytes: png }).ok).toBe(true);

    const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
    expect(validateUploadedFileHeader({ filename: 'pic.jpg', category: 'image', sizeBytes: 1024, headerBytes: jpg }).ok).toBe(true);

    const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x20, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
    expect(validateUploadedFileHeader({ filename: 'img.webp', category: 'image', sizeBytes: 1024, headerBytes: webp }).ok).toBe(true);

    const gif = enc.encode('GIF89a\x01\x00\x01\x00');
    expect(validateUploadedFileHeader({ filename: 'anim.gif', category: 'image', sizeBytes: 1024, headerBytes: gif }).ok).toBe(true);
  });

  it('rejects SVG, HTML, and spoofed EXE disguised as PNG or PDF', () => {
    const svg = enc.encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    expect(validateUploadedFileHeader({ filename: 'vector.svg', category: 'image', sizeBytes: 500, headerBytes: svg }).ok).toBe(false);

    const exeAsPng = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]);
    expect(validateUploadedFileHeader({ filename: 'evil.png', category: 'image', sizeBytes: 500, headerBytes: exeAsPng }).ok).toBe(false);

    const htmlAsPdf = enc.encode('<html><body><script>alert(1)</script></body></html>');
    expect(validateUploadedFileHeader({ filename: 'fake.pdf', category: 'document', sizeBytes: 500, headerBytes: htmlAsPdf }).ok).toBe(false);
  });

  it('accepts PDF, OOXML (DOCX/XLSX/PPTX), OLE2 (DOC), and rejects plain ZIP disguised as DOCX', () => {
    const pdf = enc.encode('%PDF-1.7\n1 0 obj\n');
    expect(validateUploadedFileHeader({ filename: 'doc.pdf', category: 'document', sizeBytes: 4096, headerBytes: pdf }).ok).toBe(true);

    const ooxml = new Uint8Array(64);
    ooxml.set([0x50, 0x4b, 0x03, 0x04], 0);
    ooxml.set(enc.encode('[Content_Types].xml'), 30);
    expect(validateUploadedFileHeader({ filename: 'sheet.xlsx', category: 'document', sizeBytes: 4096, headerBytes: ooxml }).ok).toBe(true);
    expect(validateUploadedFileHeader({ filename: 'slides.pptx', category: 'document', sizeBytes: 4096, headerBytes: ooxml }).ok).toBe(true);
    expect(validateUploadedFileHeader({ filename: 'letter.docx', category: 'document', sizeBytes: 4096, headerBytes: ooxml }).ok).toBe(true);

    const oleDoc = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]);
    expect(validateUploadedFileHeader({ filename: 'legacy.doc', category: 'document', sizeBytes: 4096, headerBytes: oleDoc }).ok).toBe(true);

    const plainZip = new Uint8Array(64);
    plainZip.set([0x50, 0x4b, 0x03, 0x04], 0);
    plainZip.set(enc.encode('payload.exe'), 30);
    expect(validateUploadedFileHeader({ filename: 'trojan.docx', category: 'document', sizeBytes: 4096, headerBytes: plainZip }).ok).toBe(false);
  });

  it('accepts MP4, MOV, WebM and enforces category size caps', () => {
    const mp4 = new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32]);
    expect(validateUploadedFileHeader({ filename: 'clip.mp4', category: 'video', sizeBytes: 1024 * 1024, headerBytes: mp4 }).ok).toBe(true);

    const webm = new Uint8Array(32);
    webm.set([0x1a, 0x45, 0xdf, 0xa3], 0);
    webm.set(enc.encode('webm'), 16);
    expect(validateUploadedFileHeader({ filename: 'clip.webm', category: 'video', sizeBytes: 1024 * 1024, headerBytes: webm }).ok).toBe(true);

    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
    expect(
      validateUploadedFileHeader({
        filename: 'huge.png',
        category: 'image',
        sizeBytes: 11 * 1024 * 1024,
        headerBytes: png,
      }).ok
    ).toBe(false);
  });
});
