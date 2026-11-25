import { describe, expect, it, vi } from 'vitest';
import { deflateSync, inflateSync } from 'node:zlib';
import jsQR from 'jsqr';
import { PDFDocument, PDFName, PDFNumber, PDFRawStream } from 'pdf-lib';
import type { CreatedQrRecord } from '../src/lib/api';
import {
  generateDocumentWithOriginalQr,
  prepareDocumentForEditor,
} from '../src/lib/documentQrFlow';
import {
  createDefaultPage1Placement,
  inspectPdfForEditing,
} from '../src/lib/pdfEditor';
import { buildMatrixGrid, buildQrPixelBuffer } from '../src/lib/qrEngine';

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) {
      c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

function makePngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + 4 + data.length + 4);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length, false);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  const crc = crc32(out.subarray(4, 8 + data.length));
  view.setUint32(8 + data.length, crc, false);
  return out;
}

function encodeRgbaToPngDataUrl(width: number, height: number, rgba: Uint8ClampedArray): string {
  const stride = width * 4 + 1;
  const raw = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0;
    raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * stride + 1);
  }
  const idat = new Uint8Array(deflateSync(raw));

  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, width, false);
  ihdrView.setUint32(4, height, false);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const parts = [sig, makePngChunk('IHDR', ihdr), makePngChunk('IDAT', idat), makePngChunk('IEND', new Uint8Array(0))];
  const png = new Uint8Array(parts.reduce((acc, p) => acc + p.length, 0));
  let off = 0;
  for (const part of parts) {
    png.set(part, off);
    off += part.length;
  }
  return `data:image/png;base64,${Buffer.from(png).toString('base64')}`;
}

function nodeBuildVerifiedQr(params: { shortUrl: string }) {
  const matrix = buildMatrixGrid(params.shortUrl, 'M');
  const buf = buildQrPixelBuffer({
    matrix,
    targetSizePx: 400,
    quietZoneModules: 4,
    fgColor: '#0A1832',
    bgColor: '#FFFFFF',
  });
  const decoded = jsQR(buf.data, buf.width, buf.height, { inversionAttempts: 'dontInvert' });
  return {
    pngDataUrl: encodeRgbaToPngDataUrl(buf.width, buf.height, buf.data),
    verified: Boolean(decoded && decoded.data === params.shortUrl),
  };
}

async function countPdfImages(pdfBytes: Uint8Array): Promise<number> {
  const doc = await PDFDocument.load(pdfBytes);
  let count = 0;
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (obj instanceof PDFRawStream && obj.dict.lookup(PDFName.of('Subtype')) === PDFName.of('Image')) {
      count++;
    }
  }
  return count;
}

async function decodeEmbeddedQrFromPdfBytes(pdfBytes: Uint8Array): Promise<string | null> {
  const doc = await PDFDocument.load(pdfBytes);
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue;
    if (obj.dict.lookup(PDFName.of('Subtype')) !== PDFName.of('Image')) continue;
    if (obj.dict.lookup(PDFName.of('ColorSpace')) !== PDFName.of('DeviceRGB')) continue;

    const width = (obj.dict.lookup(PDFName.of('Width')) as PDFNumber).asNumber();
    const height = (obj.dict.lookup(PDFName.of('Height')) as PDFNumber).asNumber();
    const rgb = new Uint8Array(inflateSync(obj.contents));
    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let i = 0, j = 0; i < rgb.length; i += 3, j += 4) {
      rgba[j] = rgb[i];
      rgba[j + 1] = rgb[i + 1];
      rgba[j + 2] = rgb[i + 2];
      rgba[j + 3] = 255;
    }
    const decoded = jsQR(rgba, width, height, { inversionAttempts: 'dontInvert' });
    if (decoded) return decoded.data;
  }
  return null;
}

async function makeCleanPdfBytes(label = 'Clean Document'): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595.28, 841.89]);
  page.drawText(label, { x: 50, y: 780, size: 16 });
  return new Uint8Array(await doc.save());
}

describe('Edit QR in File Flow (QR targets original uploaded file)', () => {
  it('encodes originalId short link in downloaded PDF, keeps stored original bytes clean, and makes zero uploads on Generate', async () => {
    const cleanPdfBytes = await makeCleanPdfBytes('Original Report');
    const cleanPdfFile = new File([cleanPdfBytes.slice()], 'report.pdf', { type: 'application/pdf' });

    const storedFiles = new Map<string, Uint8Array>();
    const uploadSpy = vi.fn(async ({ file }: { file: File }) => {
      const id = 'A7k2Orig';
      storedFiles.set(id, new Uint8Array(await file.arrayBuffer()));
      const record: CreatedQrRecord = {
        id,
        type: 'document',
        shortUrl: `https://captain-azhar-center.kashaf-hub.workers.dev/f/${id}`,
        deleteToken: 'del-token-orig',
        originalName: file.name,
        sizeBytes: file.size,
        createdAt: Date.now(),
      };
      return record;
    });
    const convertSpy = vi.fn();

    const prepared = await prepareDocumentForEditor({
      file: cleanPdfFile,
      kind: 'pdf',
      turnstileToken: 'turnstile-tok-1',
      deps: {
        uploadFile: uploadSpy,
        convertWord: convertSpy,
        inspectPdf: inspectPdfForEditing,
      },
    });

    expect(uploadSpy).toHaveBeenCalledTimes(1);
    expect(convertSpy).not.toHaveBeenCalled();

    const p1 = createDefaultPage1Placement(prepared.inspection.pages[0], 'qr-1');
    const generated = await generateDocumentWithOriginalQr({
      workingPdfBytes: prepared.pdfBytes,
      originalRecord: prepared.originalRecord,
      originalFilename: cleanPdfFile.name,
      placements: [p1],
      deps: { buildQr: nodeBuildVerifiedQr },
    });

    // Generate must NOT upload the finished PDF
    expect(uploadSpy).toHaveBeenCalledTimes(1);

    // The QR inside the downloaded PDF must decode with jsQR to the originalId short link
    const decodedInPdf = await decodeEmbeddedQrFromPdfBytes(generated.outputPdfBytes);
    expect(decodedInPdf).toBe('https://captain-azhar-center.kashaf-hub.workers.dev/f/A7k2Orig');
    expect(generated.shortUrl).toBe('https://captain-azhar-center.kashaf-hub.workers.dev/f/A7k2Orig');
    expect(generated.outputFilename).toBe('report-with-qr.pdf');

    // The file stored at the original short link must have exact same bytes as uploaded file (0 QR images)
    const storedBytes = storedFiles.get('A7k2Orig');
    expect(storedBytes).toEqual(cleanPdfBytes);
    expect(await countPdfImages(storedBytes!)).toBe(0);
    // Downloaded PDF is the only copy containing the embedded QR
    expect(await countPdfImages(generated.outputPdfBytes)).toBe(1);
  });

  it('Word flow converts to PDF first, stores converted PDF as clean original, and points QR to that converted PDF', async () => {
    const wordBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]);
    const wordFile = new File([wordBytes], 'letter.docx', {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
    const convertedCleanPdfBytes = await makeCleanPdfBytes('Converted From Word');

    const callOrder: string[] = [];
    const storedFiles = new Map<string, { file: File; bytes: Uint8Array; ticket?: string }>();

    const convertSpy = vi.fn(async ({ file }: { file: File }) => {
      callOrder.push(`convert:${file.name}`);
      return {
        pdfBytes: convertedCleanPdfBytes,
        uploadTicket: 'signed-conv-ticket-1',
      };
    });

    const uploadSpy = vi.fn(
      async ({
        file,
        convertedUploadTicket,
      }: {
        file: File;
        convertedUploadTicket?: string;
      }) => {
        callOrder.push(`upload:${file.name}`);
        const id = 'ConvPdf9';
        storedFiles.set(id, {
          file,
          bytes: new Uint8Array(await file.arrayBuffer()),
          ticket: convertedUploadTicket,
        });
        const record: CreatedQrRecord = {
          id,
          type: 'document',
          shortUrl: `https://captain-azhar-center.kashaf-hub.workers.dev/f/${id}`,
          deleteToken: 'del-token-conv',
          originalName: file.name,
          sizeBytes: file.size,
          createdAt: Date.now(),
        };
        return record;
      }
    );

    const prepared = await prepareDocumentForEditor({
      file: wordFile,
      kind: 'word',
      turnstileToken: 'turnstile-tok-word',
      deps: {
        convertWord: convertSpy,
        uploadFile: uploadSpy,
        inspectPdf: inspectPdfForEditing,
      },
    });

    // Must convert first, then upload converted PDF (never store .docx or QR-stamped PDF)
    expect(callOrder).toEqual(['convert:letter.docx', 'upload:letter.pdf']);
    expect(convertSpy).toHaveBeenCalledTimes(1);
    expect(uploadSpy).toHaveBeenCalledTimes(1);

    const stored = storedFiles.get('ConvPdf9');
    expect(stored).toBeDefined();
    expect(stored!.file.name).toBe('letter.pdf');
    expect(stored!.file.type).toBe('application/pdf');
    expect(stored!.ticket).toBe('signed-conv-ticket-1');
    expect(stored!.bytes).toEqual(convertedCleanPdfBytes);
    expect(await countPdfImages(stored!.bytes)).toBe(0);

    const p1 = createDefaultPage1Placement(prepared.inspection.pages[0], 'qr-word-1');
    const generated = await generateDocumentWithOriginalQr({
      workingPdfBytes: prepared.pdfBytes,
      originalRecord: prepared.originalRecord,
      originalFilename: wordFile.name,
      placements: [p1],
      deps: { buildQr: nodeBuildVerifiedQr },
    });

    // Generate makes no upload request
    expect(uploadSpy).toHaveBeenCalledTimes(1);
    expect(generated.outputFilename).toBe('letter-with-qr.pdf');

    // Embedded QR points directly to the stored converted PDF short link
    const decodedInPdf = await decodeEmbeddedQrFromPdfBytes(generated.outputPdfBytes);
    expect(decodedInPdf).toBe('https://captain-azhar-center.kashaf-hub.workers.dev/f/ConvPdf9');
    expect(await countPdfImages(generated.outputPdfBytes)).toBe(1);
  });
});
