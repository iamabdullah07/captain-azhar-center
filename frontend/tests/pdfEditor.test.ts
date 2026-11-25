import { describe, expect, it } from 'vitest';
import { deflateSync } from 'node:zlib';
import jsQR from 'jsqr';
import { degrees, PDFDict, PDFDocument, PDFName, PDFNumber, PDFStream } from 'pdf-lib';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
  clampSquarePlacement,
  computeClampedCanvasBackingScale,
  copyPlacementToPage,
  createDefaultPage1Placement,
  embedQrIntoPdf,
  getPlacementPrintCm,
  inspectPdfForEditing,
  MAX_CANVAS_AREA_PX,
  MAX_CANVAS_SIDE_PX,
  placementToPdfDrawOptions,
  viewportRectToNormalizedPlacement,
  type PdfPlacement,
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

function encodeRgbaToPng(width: number, height: number, rgba: Uint8ClampedArray): Uint8Array {
  const stride = width * 4 + 1;
  const raw = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0; // filter type 0
    raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * stride + 1);
  }
  const idat = new Uint8Array(deflateSync(raw));

  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, width, false);
  ihdrView.setUint32(4, height, false);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const c1 = makePngChunk('IHDR', ihdr);
  const c2 = makePngChunk('IDAT', idat);
  const c3 = makePngChunk('IEND', new Uint8Array(0));

  const png = new Uint8Array(sig.length + c1.length + c2.length + c3.length);
  let off = 0;
  for (const part of [sig, c1, c2, c3]) {
    png.set(part, off);
    off += part.length;
  }
  return png;
}

function makeSampleQrPng(shortUrl = 'https://worker.test/f/TestId123'): {
  pngBytes: Uint8Array;
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
} {
  const matrix = buildMatrixGrid(shortUrl, 'M');
  const buf = buildQrPixelBuffer({
    matrix,
    targetSizePx: 400,
    quietZoneModules: 4,
    fgColor: '#0A1832',
    bgColor: '#FFFFFF',
  });
  return {
    pngBytes: encodeRgbaToPng(buf.width, buf.height, buf.data),
    width: buf.width,
    height: buf.height,
    rgba: buf.data,
  };
}

function transformDrawnImageCorner(
  drawOpts: ReturnType<typeof placementToPdfDrawOptions>,
  s: number,
  t: number
): [number, number] {
  const sx = s * drawOpts.width;
  const sy = t * drawOpts.height;
  const rad = (drawOpts.rotateDegrees * Math.PI) / 180;
  const cos = Math.round(Math.cos(rad));
  const sin = Math.round(Math.sin(rad));
  return [
    drawOpts.x + sx * cos - sy * sin,
    drawOpts.y + sx * sin + sy * cos,
  ];
}

describe('PDF Editor Geometry, Coordinates, Security & Deduplication', () => {
  it('maps placements accurately on A4 portrait corners and center via pdf.js viewport', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([595.28, 841.89]);
    const pdfBytes = new Uint8Array(await doc.save());
    const { pngBytes } = makeSampleQrPng();

    const inspection = await inspectPdfForEditing(pdfBytes);
    const page0 = inspection.pages[0];

    const targets: Array<{ label: string; x: number; y: number }> = [
      { label: 'top-left', x: 0, y: 0 },
      { label: 'top-right', x: 1 - 0.15, y: 0 },
      { label: 'bottom-left', x: 0, y: 1 - (0.15 * 595.28) / 841.89 },
      { label: 'bottom-right', x: 1 - 0.15, y: 1 - (0.15 * 595.28) / 841.89 },
      { label: 'center', x: 0.425, y: 0.45 },
    ];

    const pdfJsDoc = await pdfjsLib.getDocument({ data: pdfBytes.slice() }).promise;
    const jsPage = await pdfJsDoc.getPage(1);
    const viewport = jsPage.getViewport({ scale: 1 });

    for (const target of targets) {
      const clamped = clampSquarePlacement(
        { x: target.x, y: target.y, w: 0.15, h: (0.15 * 595.28) / 841.89 },
        page0
      );
      const placement: PdfPlacement = { id: target.label, pageIndex: 0, ...clamped };
      const drawOpts = placementToPdfDrawOptions(placement, page0);

      // Verify all 4 image corners map to the exact displayed CSS viewport fractions
      const tlPdf = transformDrawnImageCorner(drawOpts, 0, 1);
      const trPdf = transformDrawnImageCorner(drawOpts, 1, 1);
      const blPdf = transformDrawnImageCorner(drawOpts, 0, 0);
      const brPdf = transformDrawnImageCorner(drawOpts, 1, 0);

      const tlView = viewport.convertToViewportPoint(tlPdf[0], tlPdf[1]);
      const trView = viewport.convertToViewportPoint(trPdf[0], trPdf[1]);
      const blView = viewport.convertToViewportPoint(blPdf[0], blPdf[1]);
      const brView = viewport.convertToViewportPoint(brPdf[0], brPdf[1]);

      expect(tlView[0]).toBeCloseTo(clamped.x * viewport.width, 2);
      expect(tlView[1]).toBeCloseTo(clamped.y * viewport.height, 2);
      expect(trView[0]).toBeCloseTo((clamped.x + clamped.w) * viewport.width, 2);
      expect(trView[1]).toBeCloseTo(clamped.y * viewport.height, 2);
      expect(blView[0]).toBeCloseTo(clamped.x * viewport.width, 2);
      expect(blView[1]).toBeCloseTo((clamped.y + clamped.h) * viewport.height, 2);
      expect(brView[0]).toBeCloseTo((clamped.x + clamped.w) * viewport.width, 2);
      expect(brView[1]).toBeCloseTo((clamped.y + clamped.h) * viewport.height, 2);

      // Confirm physical squareness
      expect(Math.abs((trView[0] - tlView[0]) - (blView[1] - tlView[1]))).toBeLessThan(0.05);

      const out = await embedQrIntoPdf({ pdfBytes, qrPngBytes: pngBytes, placements: [placement] });
      expect(out.byteLength).toBeGreaterThan(pdfBytes.byteLength);
    }

    jsPage.cleanup();
    await pdfJsDoc.loadingTask.destroy();
  });

  it('keeps QR upright and aligned across /Rotate 0, 90, 180, 270 with non-zero CropBox and /UserUnit', async () => {
    const rotations = [0, 90, 180, 270] as const;
    const { pngBytes } = makeSampleQrPng();

    for (const rot of rotations) {
      const doc = await PDFDocument.create();
      const page = doc.addPage([600, 800]);
      page.setCropBox(50, 75, 450, 620); // non-zero CropBox origin!
      page.setRotation(degrees(rot));
      page.node.set(PDFName.of('UserUnit'), PDFNumber.of(2)); // /UserUnit = 2!

      const pdfBytes = new Uint8Array(await doc.save());
      const inspection = await inspectPdfForEditing(pdfBytes);
      const geom = inspection.pages[0];

      expect(geom.rotation).toBe(rot);
      expect(geom.cropX).toBe(50);
      expect(geom.cropY).toBe(75);
      expect(geom.userUnit).toBe(2);

      // Simulate user placing a 160x160 CSS px QR at (40, 60) on a zoomed 2x pdf.js viewport
      const pdfJsDoc = await pdfjsLib.getDocument({ data: pdfBytes.slice() }).promise;
      const jsPage = await pdfJsDoc.getPage(1);
      const viewport = jsPage.getViewport({ scale: 1 });

      const placement = viewportRectToNormalizedPlacement({
        rectCss: { x: 40, y: 60, width: 160, height: 160 },
        pageCssSize: { width: viewport.width, height: viewport.height },
        userUnit: geom.userUnit,
        pageGeom: geom,
        id: `rot-${rot}`,
      });

      const drawOpts = placementToPdfDrawOptions(placement, geom);
      const tlPdf = transformDrawnImageCorner(drawOpts, 0, 1);
      const trPdf = transformDrawnImageCorner(drawOpts, 1, 1);
      const blPdf = transformDrawnImageCorner(drawOpts, 0, 0);
      const brPdf = transformDrawnImageCorner(drawOpts, 1, 0);

      const tlView = viewport.convertToViewportPoint(tlPdf[0], tlPdf[1]);
      const trView = viewport.convertToViewportPoint(trPdf[0], trPdf[1]);
      const blView = viewport.convertToViewportPoint(blPdf[0], blPdf[1]);
      const brView = viewport.convertToViewportPoint(brPdf[0], brPdf[1]);

      // Verify upright orientation in pdf.js viewport:
      // top-left is left & above bottom-right, top-right is to the right of top-left!
      expect(tlView[0]).toBeCloseTo(placement.x * viewport.width, 2);
      expect(tlView[1]).toBeCloseTo(placement.y * viewport.height, 2);
      expect(trView[0]).toBeCloseTo((placement.x + placement.w) * viewport.width, 2);
      expect(trView[1]).toBeCloseTo(placement.y * viewport.height, 2);
      expect(blView[0]).toBeCloseTo(placement.x * viewport.width, 2);
      expect(blView[1]).toBeCloseTo((placement.y + placement.h) * viewport.height, 2);
      expect(brView[0]).toBeCloseTo((placement.x + placement.w) * viewport.width, 2);
      expect(brView[1]).toBeCloseTo((placement.y + placement.h) * viewport.height, 2);

      // Export & verify saved PDF loads cleanly
      const saved = await embedQrIntoPdf({ pdfBytes, qrPngBytes: pngBytes, placements: [placement] });
      const reloaded = await PDFDocument.load(saved);
      expect(reloaded.getPageCount()).toBe(1);

      jsPage.cleanup();
      await pdfJsDoc.loadingTask.destroy();
    }
  });

  it('produces identical PDF coordinates across 50%, 100%, and 300% zoom levels', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([595.28, 841.89]);
    const pdfBytes = new Uint8Array(await doc.save());
    const geom = (await inspectPdfForEditing(pdfBytes)).pages[0];

    const coordsByZoom = [0.5, 1, 3].map((zoom) => {
      const pageW = geom.displayedWidthPt * (96 / 72) * zoom;
      const pageH = geom.displayedHeightPt * (96 / 72) * zoom;
      const placed = viewportRectToNormalizedPlacement({
        rectCss: { x: 0.2 * pageW, y: 0.3 * pageH, width: 0.25 * pageW, height: 0.25 * pageW },
        pageCssSize: { width: pageW, height: pageH },
        userUnit: geom.userUnit,
        pageGeom: geom,
        id: `zoom-${zoom}`,
      });
      return placementToPdfDrawOptions(placed, geom);
    });

    expect(coordsByZoom[0].x).toBeCloseTo(coordsByZoom[1].x, 4);
    expect(coordsByZoom[0].y).toBeCloseTo(coordsByZoom[1].y, 4);
    expect(coordsByZoom[0].width).toBeCloseTo(coordsByZoom[1].width, 4);
    expect(coordsByZoom[2].x).toBeCloseTo(coordsByZoom[1].x, 4);
    expect(coordsByZoom[2].y).toBeCloseTo(coordsByZoom[1].y, 4);
    expect(coordsByZoom[2].width).toBeCloseTo(coordsByZoom[1].width, 4);
  });

  it('embeds the QR image ONCE when copied to multiple pages without multiplying file size', async () => {
    const doc = await PDFDocument.create();
    for (let i = 0; i < 4; i++) doc.addPage([595.28, 841.89]);
    const pdfBytes = new Uint8Array(await doc.save());
    const { pngBytes } = makeSampleQrPng();
    const inspection = await inspectPdfForEditing(pdfBytes);

    const p1 = createDefaultPage1Placement(inspection.pages[0], 'p1');
    const p2 = copyPlacementToPage(p1, inspection.pages[0], inspection.pages[1], 'p2');
    const p3 = copyPlacementToPage(p1, inspection.pages[0], inspection.pages[2], 'p3');
    const p4 = copyPlacementToPage(p1, inspection.pages[0], inspection.pages[3], 'p4');

    const onePagePdf = await embedQrIntoPdf({ pdfBytes, qrPngBytes: pngBytes, placements: [p1] });
    const fourPagePdf = await embedQrIntoPdf({
      pdfBytes,
      qrPngBytes: pngBytes,
      placements: [p1, p2, p3, p4],
    });

    // Extra 3 pages only add tiny content stream commands, NOT 3 copies of the PNG!
    expect(fourPagePdf.byteLength - onePagePdf.byteLength).toBeLessThan(1500);

    const reloaded = await PDFDocument.load(fourPagePdf);
    let imageXObjects = 0;
    for (const [, obj] of reloaded.context.enumerateIndirectObjects()) {
      if (obj instanceof PDFStream && obj.dict.lookup(PDFName.of('Subtype')) === PDFName.of('Image')) {
        imageXObjects++;
      }
    }
    expect(imageXObjects).toBe(1);
  });

  it('rejects encrypted/locked PDFs cleanly and warns on digitally signed PDFs', async () => {
    // 1. Encrypted PDF (with /Encrypt dictionary in trailer)
    const encryptedStub = new TextEncoder().encode(
      '%PDF-1.7\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Count 1/Kids[3 0 R]>>endobj\n3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R>>endobj\n4 0 obj<</Filter/Standard/V 2/R 3/Length 128/P -4>>endobj\nxref\n0 5\n0000000000 65535 f \ntrailer<</Size 5/Root 1 0 R/Encrypt 4 0 R>>\nstartxref\n0\n%%EOF'
    );
    await expect(inspectPdfForEditing(encryptedStub)).rejects.toThrow(/encrypted|permission-locked/i);

    // 2. Digitally signed PDF (/AcroForm /SigFlags 3 + /ByteRange)
    const doc = await PDFDocument.create();
    doc.addPage([595, 842]);
    const sigDict = doc.context.obj({
      Type: PDFName.of('Sig'),
      Filter: PDFName.of('Adobe.PPKLite'),
      SubFilter: PDFName.of('adbe.pkcs7.detached'),
      ByteRange: [0, 100, 200, 300],
    });
    const sigField = doc.context.obj({
      FT: PDFName.of('Sig'),
      T: 'Signature1',
      V: doc.context.register(sigDict),
    });
    const acroForm = doc.context.obj({
      SigFlags: PDFNumber.of(3),
      Fields: [doc.context.register(sigField)],
    });
    doc.catalog.set(PDFName.of('AcroForm'), doc.context.register(acroForm));
    const signedBytes = new Uint8Array(await doc.save());

    const inspected = await inspectPdfForEditing(signedBytes);
    expect(inspected.isSigned).toBe(true);
    expect(inspected.signatureDetails).toMatch(/SigFlags|ByteRange|Signature/i);
  });

  it('handles 120-page PDFs, enforces print minimum size, and clamps CAD sheet canvas scale', async () => {
    const doc = await PDFDocument.create();
    for (let i = 0; i < 120; i++) {
      doc.addPage([595.28, 841.89]);
    }
    const bigBytes = new Uint8Array(await doc.save());
    const inspection = await inspectPdfForEditing(bigBytes);
    expect(inspection.pageCount).toBe(120);

    const p1 = createDefaultPage1Placement(inspection.pages[0], 'p1');
    const tinyAttempt = clampSquarePlacement({ x: 0.9, y: 0.9, w: 0.01, h: 0.01 }, inspection.pages[0]);
    const printCm = getPlacementPrintCm({ id: 'tiny', pageIndex: 0, ...tinyAttempt }, inspection.pages[0]);
    expect(printCm.widthCm).toBeGreaterThanOrEqual(2.4);
    expect(tinyAttempt.x + tinyAttempt.w).toBeLessThanOrEqual(1.0001);
    expect(tinyAttempt.y + tinyAttempt.h).toBeLessThanOrEqual(1.0001);

    const { pngBytes } = makeSampleQrPng();
    const out120 = await embedQrIntoPdf({ pdfBytes: bigBytes, qrPngBytes: pngBytes, placements: [p1] });
    expect(out120.byteLength).toBeGreaterThan(bigBytes.byteLength);

    // Huge CAD sheet (14400 x 14400 pt) at 300% zoom and 3x DPR
    const cssW = 14400 * (96 / 72) * 3;
    const cssH = 14400 * (96 / 72) * 3;
    const scale = computeClampedCanvasBackingScale({ cssWidth: cssW, cssHeight: cssH, desiredDpr: 3 });
    expect(cssW * scale).toBeLessThanOrEqual(MAX_CANVAS_SIDE_PX + 1);
    expect(cssH * scale).toBeLessThanOrEqual(MAX_CANVAS_SIDE_PX + 1);
    expect(cssW * scale * (cssH * scale)).toBeLessThanOrEqual(MAX_CANVAS_AREA_PX + 100);
  });

  it('verifies generated QR PNG embedded into PDF decodes back to the reserved short URL', async () => {
    const reservedShortUrl = 'https://captain-azhar-center.kashaf-hub.workers.dev/f/Reserve99';
    const qr = makeSampleQrPng(reservedShortUrl);
    const decoded = jsQR(qr.rgba, qr.width, qr.height, { inversionAttempts: 'dontInvert' });
    expect(decoded?.data).toBe(reservedShortUrl);

    const doc = await PDFDocument.create();
    doc.addPage([595.28, 841.89]);
    const pdfBytes = new Uint8Array(await doc.save());
    const inspection = await inspectPdfForEditing(pdfBytes);
    const p1 = createDefaultPage1Placement(inspection.pages[0], 'p1');

    const finalBytes = await embedQrIntoPdf({ pdfBytes, qrPngBytes: qr.pngBytes, placements: [p1] });
    const reloaded = await PDFDocument.load(finalBytes);
    let embeddedStream: PDFDict | null = null;
    for (const [, obj] of reloaded.context.enumerateIndirectObjects()) {
      if (obj instanceof PDFStream && obj.dict.lookup(PDFName.of('Subtype')) === PDFName.of('Image')) {
        embeddedStream = obj.dict;
      }
    }
    expect(embeddedStream).not.toBeNull();
  });
});
