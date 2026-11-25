import {
  convertWordToPdf,
  uploadFileWithProgress,
  type ConvertedWordResult,
  type CreatedQrRecord,
} from './api';
import { EDITABLE_DOC_RULES, type EditableDocKind } from './fileCheck';
import {
  dataUrlToUint8Array,
  embedQrIntoPdf,
  inspectPdfForEditing,
  type PdfInspectionResult,
  type PdfPlacement,
} from './pdfEditor';
import { generateVerifiedQr } from './qrEngine';

export function buildConvertedPdfName(originalName: string): string {
  const clean = originalName.replace(/\.(pdf|docx?|PDF|DOCX?)$/, '') || 'document';
  return `${clean}.pdf`;
}

export function buildOutputPdfName(originalName: string): string {
  const clean = originalName.replace(/\.(pdf|docx?|PDF|DOCX?)$/, '') || 'document';
  return `${clean}-with-qr.pdf`;
}

export interface DocumentFlowDeps {
  uploadFile: (params: {
    file: File;
    category: 'document';
    turnstileToken: string;
    convertedUploadTicket?: string;
    onProgress: (pct: number) => void;
  }) => Promise<CreatedQrRecord>;
  convertWord: (params: {
    file: File;
    turnstileToken?: string;
    onProgress?: (pct: number) => void;
  }) => Promise<ConvertedWordResult>;
  inspectPdf: (pdfBytes: Uint8Array) => Promise<PdfInspectionResult>;
}

const DEFAULT_FLOW_DEPS: DocumentFlowDeps = {
  uploadFile: uploadFileWithProgress,
  convertWord: convertWordToPdf,
  inspectPdf: inspectPdfForEditing,
};

export interface PreparedDocumentSession {
  originalRecord: CreatedQrRecord;
  pdfBytes: Uint8Array;
  inspection: PdfInspectionResult;
}

/**
 * Prepares a PDF or Word document for QR placement:
 * - PDF: inspects permissions/signatures first, then uploads the clean original PDF.
 * - Word: converts Word -> PDF first, inspects the converted PDF, then uploads that clean converted PDF.
 * Never embeds a QR into the uploaded server file.
 */
export async function prepareDocumentForEditor(params: {
  file: File;
  kind: EditableDocKind;
  turnstileToken: string;
  onStage?: (stage: string) => void;
  onProgress?: (pct: number) => void;
  deps?: Partial<DocumentFlowDeps>;
}): Promise<PreparedDocumentSession> {
  const { file, kind, turnstileToken, onStage, onProgress, deps } = params;
  const resolvedDeps: DocumentFlowDeps = {
    ...DEFAULT_FLOW_DEPS,
    ...deps,
  };
  const reportProgress = onProgress ?? (() => {});

  if (kind === 'pdf') {
    onStage?.('Inspecting PDF permissions and signatures...');
    const pdfBytes = new Uint8Array(await file.arrayBuffer());
    const inspection = await resolvedDeps.inspectPdf(pdfBytes);

    onStage?.('Uploading original PDF...');
    const originalRecord = await resolvedDeps.uploadFile({
      file,
      category: 'document',
      turnstileToken,
      onProgress: reportProgress,
    });

    return { originalRecord, pdfBytes, inspection };
  }

  onStage?.('Converting Word document to PDF...');
  reportProgress(0);
  const converted = await resolvedDeps.convertWord({
    file,
    turnstileToken,
    onProgress: reportProgress,
  });

  onStage?.('Verifying converted PDF...');
  const inspection = await resolvedDeps.inspectPdf(converted.pdfBytes);

  const convertedName = buildConvertedPdfName(file.name);
  const convertedBuffer = new ArrayBuffer(converted.pdfBytes.byteLength);
  new Uint8Array(convertedBuffer).set(converted.pdfBytes);
  const convertedFile = new File([convertedBuffer], convertedName, { type: 'application/pdf' });

  if (convertedFile.size > EDITABLE_DOC_RULES.maxBytes) {
    throw new Error(`Converted PDF exceeds the ${EDITABLE_DOC_RULES.maxLabel} upload limit.`);
  }

  onStage?.('Uploading converted PDF...');
  reportProgress(0);
  const originalRecord = await resolvedDeps.uploadFile({
    file: convertedFile,
    category: 'document',
    turnstileToken: converted.uploadTicket ? '' : turnstileToken,
    convertedUploadTicket: converted.uploadTicket,
    onProgress: reportProgress,
  });

  return {
    originalRecord,
    pdfBytes: converted.pdfBytes,
    inspection,
  };
}

export interface GenerateDocumentQrDeps {
  buildQr: (params: {
    shortUrl: string;
    sizePx: 1000;
    errorCorrection: 'M';
    fgColor: '#0A1832';
    bgColor: '#FFFFFF';
    safeMargin: true;
  }) => { pngDataUrl: string; verified: boolean };
  embedQr: typeof embedQrIntoPdf;
}

const DEFAULT_GENERATE_DEPS: GenerateDocumentQrDeps = {
  buildQr: generateVerifiedQr,
  embedQr: embedQrIntoPdf,
};

export interface GeneratedDocumentPdf {
  outputPdfBytes: Uint8Array;
  outputFilename: string;
  qrPngDataUrl: string;
  shortUrl: string;
}

/**
 * Generates a verified QR encoding the ORIGINAL uploaded file's short link (`originalRecord.shortUrl`)
 * and stamps it into a local copy of the PDF without performing any upload or short-ID reservation.
 */
export async function generateDocumentWithOriginalQr(params: {
  workingPdfBytes: Uint8Array;
  originalRecord: CreatedQrRecord;
  originalFilename: string;
  placements: PdfPlacement[];
  deps?: Partial<GenerateDocumentQrDeps>;
}): Promise<GeneratedDocumentPdf> {
  const { workingPdfBytes, originalRecord, originalFilename, placements, deps } = params;
  const resolvedDeps: GenerateDocumentQrDeps = {
    ...DEFAULT_GENERATE_DEPS,
    ...deps,
  };

  const verifiedQr = resolvedDeps.buildQr({
    shortUrl: originalRecord.shortUrl,
    sizePx: 1000,
    errorCorrection: 'M',
    fgColor: '#0A1832',
    bgColor: '#FFFFFF',
    safeMargin: true,
  });

  if (!verifiedQr.verified) {
    throw new Error('QR scan self-check failed. Please try again.');
  }

  const qrPngBytes = dataUrlToUint8Array(verifiedQr.pngDataUrl);
  const outputPdfBytes = await resolvedDeps.embedQr({
    pdfBytes: workingPdfBytes,
    qrPngBytes,
    placements,
  });

  return {
    outputPdfBytes,
    outputFilename: buildOutputPdfName(originalFilename),
    qrPngDataUrl: verifiedQr.pngDataUrl,
    shortUrl: originalRecord.shortUrl,
  };
}
