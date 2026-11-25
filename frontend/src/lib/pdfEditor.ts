import {
  degrees,
  EncryptedPDFError,
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
} from 'pdf-lib';

export const PT_PER_CM = 72 / 2.54;
export const MIN_QR_PRINT_CM = 2.5;
export const MAX_CANVAS_SIDE_PX = 4096;
export const MAX_CANVAS_AREA_PX = 16_000_000;

export type PdfRotationAngle = 0 | 90 | 180 | 270;

export interface PdfPlacement {
  id: string;
  pageIndex: number;
  /** Fraction [0..1] of displayed page width from left edge */
  x: number;
  /** Fraction [0..1] of displayed page height from top edge */
  y: number;
  /** Fraction [0..1] of displayed page width */
  w: number;
  /** Fraction [0..1] of displayed page height */
  h: number;
}

export interface PdfPageGeometry {
  pageIndex: number;
  cropX: number;
  cropY: number;
  cropWidth: number;
  cropHeight: number;
  rotation: PdfRotationAngle;
  userUnit: number;
  /** Physical displayed width in 1/72" PDF points (accounting for rotation and /UserUnit). */
  displayedWidthPt: number;
  /** Physical displayed height in 1/72" PDF points (accounting for rotation and /UserUnit). */
  displayedHeightPt: number;
}

export interface PdfInspectionResult {
  pageCount: number;
  isSigned: boolean;
  signatureDetails: string | null;
  pages: PdfPageGeometry[];
}

export interface PdfDrawPlacement {
  x: number;
  y: number;
  width: number;
  height: number;
  rotateDegrees: PdfRotationAngle;
}

export function normalizePdfRotation(angle: number): PdfRotationAngle {
  const mod = ((Math.round(angle) % 360) + 360) % 360;
  if (mod === 90 || mod === 180 || mod === 270) return mod;
  return 0;
}

function readPageUserUnit(pageNode: ReturnType<PDFDocument['getPage']>['node']): number {
  const raw = pageNode.lookup(PDFName.of('UserUnit'));
  if (raw instanceof PDFNumber) {
    const val = raw.asNumber();
    if (Number.isFinite(val) && val > 0) return val;
  }
  return 1;
}

function detectPdfSignatures(pdfDoc: PDFDocument, rawBytes: Uint8Array): {
  isSigned: boolean;
  details: string | null;
} {
  const reasons = new Set<string>();

  try {
    const acroForm = pdfDoc.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict);
    if (acroForm) {
      const sigFlags = acroForm.lookup(PDFName.of('SigFlags'));
      if (sigFlags instanceof PDFNumber && sigFlags.asNumber() > 0) {
        reasons.add('/SigFlags');
      }
      const fields = acroForm.lookupMaybe(PDFName.of('Fields'), PDFArray);
      if (fields) {
        for (let i = 0; i < fields.size(); i++) {
          const field = fields.lookupMaybe(i, PDFDict);
          const ft = field?.lookup(PDFName.of('FT'));
          if (ft === PDFName.of('Sig')) {
            reasons.add('Signature field (/FT /Sig)');
            break;
          }
        }
      }
    }

    for (const page of pdfDoc.getPages()) {
      const annots = page.node.Annots();
      if (!annots) continue;
      for (let i = 0; i < annots.size(); i++) {
        const annot = annots.lookupMaybe(i, PDFDict);
        if (!annot) continue;
        if (annot.lookup(PDFName.of('FT')) === PDFName.of('Sig')) {
          reasons.add('Signature widget annotation');
          break;
        }
      }
    }
  } catch {
    // Fall back to byte-level scan below
  }

  // Also scan PDF structure markers in latin1 (catches incremental/detached signature dictionaries)
  const text = new TextDecoder('latin1').decode(rawBytes);
  if (/\/ByteRange\s*\[/.test(text)) {
    reasons.add('/ByteRange');
  }
  if (/\/SigFlags\s+[1-9]/.test(text)) {
    reasons.add('/SigFlags');
  }
  if (/\/SubFilter\s*\/(?:adbe\.pkcs7|ETSI\.CAdES|adbe\.x509)/.test(text)) {
    reasons.add('PKCS#7/CAdES signature');
  }

  if (reasons.size === 0) {
    return { isSigned: false, details: null };
  }
  return {
    isSigned: true,
    details: `Detected digital signature markers (${Array.from(reasons).join(', ')}). Adding a QR code and saving will invalidate existing signatures.`,
  };
}

/**
 * Inspects a PDF before opening in the editor:
 * - Rejects encrypted or permission-locked PDFs (never uses ignoreEncryption: true)
 * - Detects digital signatures so the UI can warn the user upfront
 * - Extracts CropBox, /Rotate, and /UserUnit geometry for each page
 */
export async function inspectPdfForEditing(pdfBytes: Uint8Array): Promise<PdfInspectionResult> {
  if (pdfBytes.byteLength < 8) {
    throw new Error('Selected PDF file is empty or too small.');
  }

  let pdfDoc: PDFDocument;
  try {
    pdfDoc = await PDFDocument.load(pdfBytes);
  } catch (err) {
    const isEncrypted =
      err instanceof EncryptedPDFError ||
      (err instanceof Error && /encrypt|password/i.test(err.message));
    if (isEncrypted) {
      throw new Error(
        'This PDF is encrypted or permission-locked and cannot be edited safely. Please unlock or print-to-PDF first.'
      );
    }
    throw new Error('Could not read this PDF file. It may be corrupted or unsupported.');
  }

  if (pdfDoc.isEncrypted) {
    throw new Error(
      'This PDF is encrypted or permission-locked and cannot be edited safely. Please unlock or print-to-PDF first.'
    );
  }

  const rawPages = pdfDoc.getPages();
  if (rawPages.length === 0) {
    throw new Error('This PDF contains zero pages.');
  }

  const pages: PdfPageGeometry[] = rawPages.map((page, pageIndex) => {
    const cropBox = page.getCropBox();
    const rotation = normalizePdfRotation(page.getRotation().angle);
    const userUnit = readPageUserUnit(page.node);
    const dispUserW = rotation === 90 || rotation === 270 ? cropBox.height : cropBox.width;
    const dispUserH = rotation === 90 || rotation === 270 ? cropBox.width : cropBox.height;

    return {
      pageIndex,
      cropX: cropBox.x,
      cropY: cropBox.y,
      cropWidth: cropBox.width,
      cropHeight: cropBox.height,
      rotation,
      userUnit,
      displayedWidthPt: dispUserW * userUnit,
      displayedHeightPt: dispUserH * userUnit,
    };
  });

  const sig = detectPdfSignatures(pdfDoc, pdfBytes);
  return {
    pageCount: pages.length,
    isSigned: sig.isSigned,
    signatureDetails: sig.details,
    pages,
  };
}

export function getMinQrPrintPt(pageGeom: PdfPageGeometry): number {
  const minPageSide = Math.min(pageGeom.displayedWidthPt, pageGeom.displayedHeightPt);
  return Math.min(MIN_QR_PRINT_CM * PT_PER_CM, minPageSide * 0.85);
}

export function getMaxQrPrintPt(pageGeom: PdfPageGeometry): number {
  return Math.min(pageGeom.displayedWidthPt, pageGeom.displayedHeightPt);
}

/**
 * Ensures a QR placement stays strictly square in physical/displayed space,
 * respects minimum print size (~2.5 cm), and stays strictly inside page bounds.
 */
export function clampSquarePlacement(
  raw: Pick<PdfPlacement, 'x' | 'y' | 'w' | 'h'>,
  pageGeom: PdfPageGeometry
): Pick<PdfPlacement, 'x' | 'y' | 'w' | 'h'> {
  const minPt = getMinQrPrintPt(pageGeom);
  const maxPt = getMaxQrPrintPt(pageGeom);

  const requestedW = raw.w * pageGeom.displayedWidthPt;
  const requestedH = raw.h * pageGeom.displayedHeightPt;
  const candidatePt = Number.isFinite(requestedW) && requestedW > 0 ? requestedW : requestedH;
  const sidePt = Math.min(maxPt, Math.max(minPt, candidatePt || minPt));

  const w = Math.min(1, sidePt / pageGeom.displayedWidthPt);
  const h = Math.min(1, sidePt / pageGeom.displayedHeightPt);
  const x = Math.min(Math.max(0, raw.x), Math.max(0, 1 - w));
  const y = Math.min(Math.max(0, raw.y), Math.max(0, 1 - h));

  return { x, y, w, h };
}

export function createDefaultPage1Placement(
  pageGeom: PdfPageGeometry,
  id = 'qr-page-1'
): PdfPlacement {
  const minPt = getMinQrPrintPt(pageGeom);
  const maxPt = getMaxQrPrintPt(pageGeom);
  const targetPt = Math.min(maxPt * 0.45, Math.max(minPt, 3.4 * PT_PER_CM));
  const marginPt = Math.min(20, maxPt * 0.06);

  const w = targetPt / pageGeom.displayedWidthPt;
  const h = targetPt / pageGeom.displayedHeightPt;
  const mx = marginPt / pageGeom.displayedWidthPt;
  const my = marginPt / pageGeom.displayedHeightPt;

  const clamped = clampSquarePlacement(
    {
      x: Math.max(0, 1 - w - mx),
      y: Math.max(0, 1 - h - my),
      w,
      h,
    },
    pageGeom
  );

  return {
    id,
    pageIndex: pageGeom.pageIndex,
    ...clamped,
  };
}

export function copyPlacementToPage(
  source: PdfPlacement,
  sourcePage: PdfPageGeometry,
  targetPage: PdfPageGeometry,
  newId: string
): PdfPlacement {
  const physicalSidePt = source.w * sourcePage.displayedWidthPt;
  const clamped = clampSquarePlacement(
    {
      x: source.x,
      y: source.y,
      w: physicalSidePt / targetPage.displayedWidthPt,
      h: physicalSidePt / targetPage.displayedHeightPt,
    },
    targetPage
  );

  return {
    id: newId,
    pageIndex: targetPage.pageIndex,
    ...clamped,
  };
}

export function getPlacementPrintCm(
  placement: PdfPlacement,
  pageGeom: PdfPageGeometry
): { widthCm: number; heightCm: number } {
  const widthCm = (placement.w * pageGeom.displayedWidthPt) / PT_PER_CM;
  const heightCm = (placement.h * pageGeom.displayedHeightPt) / PT_PER_CM;
  return {
    widthCm: Number(widthCm.toFixed(1)),
    heightCm: Number(heightCm.toFixed(1)),
  };
}

/**
 * Clamps canvas backing pixel ratio for huge pages (e.g. CAD sheets) and mobile Safari limits,
 * while keeping CSS page dimensions exact for DOM overlay positioning.
 */
export function computeClampedCanvasBackingScale(params: {
  cssWidth: number;
  cssHeight: number;
  desiredDpr?: number;
  maxDpr?: number;
}): number {
  const { cssWidth, cssHeight, desiredDpr = 1, maxDpr = 3 } = params;
  if (cssWidth <= 0 || cssHeight <= 0) return 1;

  let dpr = Math.min(Math.max(1, desiredDpr), maxDpr);
  const maxSideScale = Math.min(
    MAX_CANVAS_SIDE_PX / cssWidth,
    MAX_CANVAS_SIDE_PX / cssHeight
  );
  const maxAreaScale = Math.sqrt(MAX_CANVAS_AREA_PX / (cssWidth * cssHeight));
  dpr = Math.min(dpr, maxSideScale, maxAreaScale);
  return Math.max(0.005, dpr);
}

/**
 * Converts a normalized displayed-page placement (top-left origin, [0..1] fractions)
 * back into raw pdf-lib user space coordinates, handling:
 * - Y-axis flip and image height subtraction
 * - All four /Rotate angles (0, 90, 180, 270)
 * - Non-zero CropBox origin (cropX, cropY)
 * - /UserUnit cancellation (viewportWidth / userUnit recovers raw displayed user-space size)
 */
export function placementToPdfDrawOptions(
  placement: PdfPlacement,
  pageGeom: PdfPageGeometry
): PdfDrawPlacement {
  const { cropX, cropY, cropWidth, cropHeight, rotation } = pageGeom;
  const dispUserW = rotation === 90 || rotation === 270 ? cropHeight : cropWidth;
  const dispUserH = rotation === 90 || rotation === 270 ? cropWidth : cropHeight;

  const boxW = placement.w * dispUserW;
  const boxH = placement.h * dispUserH;
  const fx = placement.x;
  const fy = placement.y;
  const fh = placement.h;

  switch (rotation) {
    case 90:
      return {
        x: cropX + (fy + fh) * cropWidth,
        y: cropY + fx * cropHeight,
        width: boxW,
        height: boxH,
        rotateDegrees: 90,
      };
    case 180:
      return {
        x: cropX + (1 - fx) * cropWidth,
        y: cropY + (fy + fh) * cropHeight,
        width: boxW,
        height: boxH,
        rotateDegrees: 180,
      };
    case 270:
      return {
        x: cropX + (1 - fy - fh) * cropWidth,
        y: cropY + (1 - fx) * cropHeight,
        width: boxW,
        height: boxH,
        rotateDegrees: 270,
      };
    case 0:
    default:
      return {
        x: cropX + fx * cropWidth,
        y: cropY + (1 - fy - fh) * cropHeight,
        width: boxW,
        height: boxH,
        rotateDegrees: 0,
      };
  }
}

/**
 * Helper showing explicit /UserUnit normalization when starting from a pdf.js viewport box.
 * Divides viewport width/height by page userUnit before computing normalized fractions.
 */
export function viewportRectToNormalizedPlacement(params: {
  rectCss: { x: number; y: number; width: number; height: number };
  pageCssSize: { width: number; height: number };
  userUnit: number;
  pageGeom: PdfPageGeometry;
  id: string;
}): PdfPlacement {
  const { rectCss, pageCssSize, userUnit, pageGeom, id } = params;
  const safeUnit = userUnit > 0 ? userUnit : 1;
  // Recover unscaled CSS units proportional to raw PDF user space before normalizing
  const unscaledPageW = pageCssSize.width / safeUnit;
  const unscaledPageH = pageCssSize.height / safeUnit;
  const raw = {
    x: (rectCss.x / safeUnit) / unscaledPageW,
    y: (rectCss.y / safeUnit) / unscaledPageH,
    w: (rectCss.width / safeUnit) / unscaledPageW,
    h: (rectCss.height / safeUnit) / unscaledPageH,
  };
  const clamped = clampSquarePlacement(raw, pageGeom);
  return {
    id,
    pageIndex: pageGeom.pageIndex,
    ...clamped,
  };
}

export function dataUrlToUint8Array(dataUrl: string): Uint8Array {
  const comma = dataUrl.indexOf(',');
  if (comma < 0) throw new Error('Invalid image data URL.');
  const base64 = dataUrl.slice(comma + 1);
  const bin = atob(base64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

/**
 * Embeds the verified QR PNG ONCE in the PDF and stamps it at every placed coordinate.
 * Never passes ignoreEncryption: true.
 */
export async function embedQrIntoPdf(params: {
  pdfBytes: Uint8Array;
  qrPngBytes: Uint8Array;
  placements: PdfPlacement[];
}): Promise<Uint8Array> {
  const { pdfBytes, qrPngBytes, placements } = params;
  if (placements.length === 0) {
    throw new Error('Place at least one QR code on the document before generating.');
  }

  const inspection = await inspectPdfForEditing(pdfBytes);
  const pdfDoc = await PDFDocument.load(pdfBytes);
  const pages = pdfDoc.getPages();

  // Embed once and reuse across all placements/pages so PDF size stays small
  const embeddedQr = await pdfDoc.embedPng(qrPngBytes);

  for (const placement of placements) {
    const page = pages[placement.pageIndex];
    const pageGeom = inspection.pages[placement.pageIndex];
    if (!page || !pageGeom) {
      throw new Error(`Invalid target page index: ${placement.pageIndex + 1}`);
    }

    const clamped = clampSquarePlacement(placement, pageGeom);
    const drawOpts = placementToPdfDrawOptions(
      { ...placement, ...clamped },
      pageGeom
    );

    page.drawImage(embeddedQr, {
      x: drawOpts.x,
      y: drawOpts.y,
      width: drawOpts.width,
      height: drawOpts.height,
      rotate: degrees(drawOpts.rotateDegrees),
    });
  }

  return new Uint8Array(await pdfDoc.save());
}
