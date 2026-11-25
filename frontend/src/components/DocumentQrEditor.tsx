import { useEffect, useMemo, useRef, useState } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import {
  AlertCircle,
  AlertTriangle,
  Check,
  CheckCircle2,
  Copy,
  Download,
  ExternalLink,
  FilePenLine,
  FileText,
  Info,
  Loader2,
  Plus,
  QrCode,
  RefreshCw,
  ShieldAlert,
  Trash2,
  Upload,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import {
  convertWordToPdf,
  deleteUploadedItem,
  fetchApiCapabilities,
  reserveShortId,
  TURNSTILE_SITE_KEY,
  uploadFileWithProgress,
  type CreatedQrRecord,
  type ReservedShortId,
} from '../lib/api';
import {
  EDITABLE_DOC_RULES,
  formatBytes,
  validateEditableDocFile,
  type EditableDocKind,
} from '../lib/fileCheck';
import {
  copyPlacementToPage,
  createDefaultPage1Placement,
  dataUrlToUint8Array,
  embedQrIntoPdf,
  getPlacementPrintCm,
  inspectPdfForEditing,
  PT_PER_CM,
  type PdfInspectionResult,
  type PdfPlacement,
} from '../lib/pdfEditor';
import { generateVerifiedQr } from '../lib/qrEngine';
import { PdfPageCanvas } from './PdfPageCanvas';
import { TurnstileBox } from './TurnstileBox';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

const ZOOM_PRESETS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3] as const;

function buildOutputPdfName(originalName: string): string {
  const clean = originalName.replace(/\.(pdf|docx?|PDF|DOCX?)$/, '') || 'document';
  return `${clean}-with-qr.pdf`;
}

function triggerBlobDownload(blobUrl: string, filename: string) {
  const a = document.createElement('a');
  a.href = blobUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export function DocumentQrEditor() {
  const [wordToPdfEnabled, setWordToPdfEnabled] = useState<boolean | null>(null);

  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [selectedKind, setSelectedKind] = useState<EditableDocKind | null>(null);
  const [dragActive, setDragActive] = useState(false);

  const [turnstileToken, setTurnstileToken] = useState('');
  const [turnstileResetKey, setTurnstileResetKey] = useState(0);

  const [preparing, setPreparing] = useState(false);
  const [prepareStage, setPrepareStage] = useState('');
  const [uploadProgress, setUploadProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  // Loaded editor session state
  const [originalRecord, setOriginalRecord] = useState<CreatedQrRecord | null>(null);
  const [pendingReservation, setPendingReservation] = useState<ReservedShortId | null>(null);
  const [sourceKind, setSourceKind] = useState<EditableDocKind | null>(null);
  const [workingPdfBytes, setWorkingPdfBytes] = useState<Uint8Array | null>(null);
  const [pdfDocument, setPdfDocument] = useState<PDFDocumentProxy | null>(null);
  const [inspection, setInspection] = useState<PdfInspectionResult | null>(null);

  const [zoom, setZoom] = useState<number>(1);
  const [jumpPageInput, setJumpPageInput] = useState('1');
  const [copyPageInput, setCopyPageInput] = useState('2');

  const [placements, setPlacements] = useState<PdfPlacement[]>([]);
  const [selectedPlacementId, setSelectedPlacementId] = useState<string | null>(null);
  const [liveCmOverride, setLiveCmOverride] = useState<{ id: string; cm: number } | null>(null);

  // Final generated state
  const [generating, setGenerating] = useState(false);
  const [saveProgress, setSaveProgress] = useState(0);
  const [generatedQrDataUrl, setGeneratedQrDataUrl] = useState<string | null>(null);
  const [finalRecord, setFinalRecord] = useState<CreatedQrRecord | null>(null);
  const [finalPdfUrl, setFinalPdfUrl] = useState<string | null>(null);
  const [finalPdfFilename, setFinalPdfFilename] = useState('document-with-qr.pdf');
  const [copiedLink, setCopiedLink] = useState(false);
  const [copiedToken, setCopiedToken] = useState(false);
  const [deletingFinal, setDeletingFinal] = useState(false);
  const [deletedMessage, setDeletedMessage] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const [scrollRootEl, setScrollRootEl] = useState<HTMLElement | null>(null);

  useEffect(() => {
    let mounted = true;
    fetchApiCapabilities().then((caps) => {
      if (mounted) setWordToPdfEnabled(caps.wordToPdfEnabled);
    });
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    return () => {
      if (pdfDocument) {
        pdfDocument.loadingTask.destroy().catch(() => {});
      }
    };
  }, [pdfDocument]);

  useEffect(() => {
    return () => {
      if (finalPdfUrl) {
        URL.revokeObjectURL(finalPdfUrl);
      }
    };
  }, [finalPdfUrl]);

  const resetEditorSession = () => {
    if (pdfDocument) {
      pdfDocument.loadingTask.destroy().catch(() => {});
    }
    if (finalPdfUrl) {
      URL.revokeObjectURL(finalPdfUrl);
    }
    setOriginalRecord(null);
    setPendingReservation(null);
    setSourceKind(null);
    setWorkingPdfBytes(null);
    setPdfDocument(null);
    setInspection(null);
    setPlacements([]);
    setSelectedPlacementId(null);
    setLiveCmOverride(null);
    setGeneratedQrDataUrl(null);
    setFinalRecord(null);
    setFinalPdfUrl(null);
    setDeletedMessage(null);
    setError(null);
    setUploadProgress(0);
    setSaveProgress(0);
  };

  const handleFilePicked = async (file: File | undefined) => {
    if (!file) return;
    resetEditorSession();
    const check = validateEditableDocFile(file);
    if (!check.ok) {
      setSelectedFile(null);
      setSelectedKind(null);
      setError(check.error);
      return;
    }

    if (check.kind === 'pdf') {
      try {
        const previewBytes = new Uint8Array(await file.arrayBuffer());
        await inspectPdfForEditing(previewBytes);
      } catch (err) {
        setSelectedFile(null);
        setSelectedKind(null);
        setError(err instanceof Error ? err.message : 'Unable to open PDF.');
        return;
      }
    }

    setError(null);
    setSelectedFile(file);
    setSelectedKind(check.kind);
  };

  const handleOpenDocument = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedFile || !selectedKind) return;
    setError(null);

    if (selectedKind === 'word' && wordToPdfEnabled === false) {
      setError(
        'Word-to-PDF conversion is coming soon on this server. Please export your Word document as a PDF first and upload the PDF here.'
      );
      return;
    }

    if (TURNSTILE_SITE_KEY && !turnstileToken) {
      setError('Please complete the security verification check.');
      return;
    }

    setPreparing(true);
    setUploadProgress(0);

    try {
      let pdfBytes: Uint8Array;
      let preCheckedInspection: PdfInspectionResult | null = null;

      if (selectedKind === 'pdf') {
        setPrepareStage('Inspecting PDF permissions and signatures...');
        pdfBytes = new Uint8Array(await selectedFile.arrayBuffer());
        preCheckedInspection = await inspectPdfForEditing(pdfBytes);

        setPrepareStage('Uploading original PDF...');
        const uploaded = await uploadFileWithProgress({
          file: selectedFile,
          category: 'document',
          turnstileToken,
          reserveNext: true,
          onProgress: setUploadProgress,
        });
        setOriginalRecord(uploaded);
        setPendingReservation(uploaded.nextReservation ?? null);
      } else {
        setPrepareStage('Uploading Word document...');
        const uploadedWord = await uploadFileWithProgress({
          file: selectedFile,
          category: 'document',
          turnstileToken,
          reserveNext: true,
          onProgress: setUploadProgress,
        });
        setOriginalRecord(uploadedWord);
        setPendingReservation(uploadedWord.nextReservation ?? null);

        setPrepareStage('Converting Word document to PDF...');
        setUploadProgress(0);
        pdfBytes = await convertWordToPdf({
          file: selectedFile,
          sourceId: uploadedWord.id,
          deleteToken: uploadedWord.deleteToken,
          onProgress: setUploadProgress,
        });

        setPrepareStage('Verifying converted PDF...');
        preCheckedInspection = await inspectPdfForEditing(pdfBytes);
      }

      setPrepareStage('Loading PDF pages...');
      // Pass a copy (.slice()) because pdf.js transfers the ArrayBuffer to its worker thread
      const loadingTask = pdfjsLib.getDocument({ data: pdfBytes.slice() });
      const loadedPdf = await loadingTask.promise;

      if (!preCheckedInspection || preCheckedInspection.pageCount !== loadedPdf.numPages) {
        await loadingTask.destroy().catch(() => {});
        throw new Error('Converted PDF page count did not match.');
      }

      const page1 = preCheckedInspection.pages[0];
      const defaultPlacement = createDefaultPage1Placement(page1, `qr-${crypto.randomUUID()}`);

      // Pick comfortable initial zoom (roughly fits ~640px viewer width without exceeding 100%)
      const page1CssAt100 = page1.displayedWidthPt * (96 / 72);
      const fitZoom = page1CssAt100 > 680 ? Number(Math.max(0.5, Math.min(1, 640 / page1CssAt100)).toFixed(2)) : 1;

      setWorkingPdfBytes(pdfBytes);
      setPdfDocument(loadedPdf);
      setInspection(preCheckedInspection);
      setSourceKind(selectedKind);
      setZoom(fitZoom);
      setJumpPageInput('1');
      setCopyPageInput(preCheckedInspection.pageCount > 1 ? '2' : '1');
      setPlacements([defaultPlacement]);
      setSelectedPlacementId(defaultPlacement.id);
      setTurnstileResetKey((k) => k + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to open document in PDF editor.');
      setTurnstileResetKey((k) => k + 1);
    } finally {
      setPreparing(false);
      setPrepareStage('');
    }
  };

  const activePlacement = useMemo(
    () => placements.find((p) => p.id === selectedPlacementId) ?? placements[0] ?? null,
    [placements, selectedPlacementId]
  );

  const activePageGeom = useMemo(() => {
    if (!inspection || !activePlacement) return null;
    return inspection.pages[activePlacement.pageIndex] ?? null;
  }, [inspection, activePlacement]);

  const activeSizeDisplay = useMemo(() => {
    if (!activePlacement || !activePageGeom) return null;
    if (liveCmOverride && liveCmOverride.id === activePlacement.id) {
      return { widthCm: liveCmOverride.cm, heightCm: liveCmOverride.cm };
    }
    return getPlacementPrintCm(activePlacement, activePageGeom);
  }, [activePlacement, activePageGeom, liveCmOverride]);

  const scrollToPage = (pageIndex: number) => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const target = container.querySelector(`[data-page-index="${pageIndex}"]`);
    if (target instanceof HTMLElement) {
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  const handleUpdatePlacement = (id: string, next: Pick<PdfPlacement, 'x' | 'y' | 'w' | 'h'>) => {
    setLiveCmOverride(null);
    setPlacements((prev) =>
      prev.map((item) => (item.id === id ? { ...item, ...next } : item))
    );
  };

  const handleLiveSizeChange = (id: string, liveWidthPx: number, pageCssWidth: number) => {
    if (!inspection || pageCssWidth <= 0) return;
    const target = placements.find((p) => p.id === id);
    const pageGeom = target ? inspection.pages[target.pageIndex] : null;
    if (!pageGeom) return;
    const cm = Number((((liveWidthPx / pageCssWidth) * pageGeom.displayedWidthPt) / PT_PER_CM).toFixed(1));
    setLiveCmOverride({ id, cm });
  };

  const handleCopyToPage = () => {
    if (!inspection || !activePlacement || !activePageGeom) return;
    const pageNum = Number.parseInt(copyPageInput, 10);
    if (!Number.isInteger(pageNum) || pageNum < 1 || pageNum > inspection.pageCount) {
      setError(`Enter a page number between 1 and ${inspection.pageCount}.`);
      return;
    }
    const targetIdx = pageNum - 1;
    const targetPage = inspection.pages[targetIdx];
    const copied = copyPlacementToPage(
      activePlacement,
      activePageGeom,
      targetPage,
      `qr-${crypto.randomUUID()}`
    );
    setError(null);
    setPlacements((prev) => [...prev, copied]);
    setSelectedPlacementId(copied.id);
    setJumpPageInput(String(pageNum));
    setTimeout(() => scrollToPage(targetIdx), 50);
  };

  const handleCopyToAllPages = () => {
    if (!inspection || !activePlacement || !activePageGeom) return;
    const existingPages = new Set(placements.map((p) => p.pageIndex));
    const additions: PdfPlacement[] = [];
    for (const page of inspection.pages) {
      if (existingPages.has(page.pageIndex)) continue;
      additions.push(
        copyPlacementToPage(
          activePlacement,
          activePageGeom,
          page,
          `qr-${crypto.randomUUID()}`
        )
      );
    }
    if (additions.length === 0) return;
    setError(null);
    setPlacements((prev) => [...prev, ...additions]);
  };

  const handleRemovePlacement = (id: string) => {
    if (placements.length <= 1) return;
    const remaining = placements.filter((p) => p.id !== id);
    setPlacements(remaining);
    if (selectedPlacementId === id) {
      setSelectedPlacementId(remaining[0]?.id ?? null);
    }
  };

  const handleAddOnPage1 = () => {
    if (!inspection) return;
    const next = createDefaultPage1Placement(inspection.pages[0], `qr-${crypto.randomUUID()}`);
    setPlacements((prev) => [...prev, next]);
    setSelectedPlacementId(next.id);
    setTimeout(() => scrollToPage(0), 50);
  };

  const handleGenerateAndSave = async () => {
    if (!workingPdfBytes || !originalRecord || !selectedFile || placements.length === 0) return;

    setError(null);
    setDeletedMessage(null);
    setGenerating(true);
    setSaveProgress(0);

    try {
      // 1. Use pre-reserved short ID from upload (or allocate a fresh one on re-generate)
      const hasValidPreReserved =
        pendingReservation && pendingReservation.expiresAt > Date.now() + 30_000;
      const reserved = hasValidPreReserved
        ? pendingReservation
        : await reserveShortId({
            sourceId: originalRecord.id,
            deleteToken: originalRecord.deleteToken,
            turnstileToken,
          });
      if (hasValidPreReserved) {
        setPendingReservation(null);
      }

      // 2. Build & jsQR-verify high-res QR code with 4-module white panel
      const verifiedQr = generateVerifiedQr({
        shortUrl: reserved.shortUrl,
        sizePx: 1000,
        errorCorrection: 'M',
        fgColor: '#0A1832',
        bgColor: '#FFFFFF',
        safeMargin: true,
      });

      if (!verifiedQr.verified) {
        throw new Error('QR scan self-check failed. Please try again.');
      }

      // 3. Embed QR once into PDF using exact rotation/CropBox/UserUnit transform
      const qrPngBytes = dataUrlToUint8Array(verifiedQr.pngDataUrl);
      const outputPdfBytes = await embedQrIntoPdf({
        pdfBytes: workingPdfBytes,
        qrPngBytes,
        placements,
      });

      const outFilename = buildOutputPdfName(selectedFile.name);
      const outBuffer = new ArrayBuffer(outputPdfBytes.byteLength);
      new Uint8Array(outBuffer).set(outputPdfBytes);
      const outFile = new File([outBuffer], outFilename, { type: 'application/pdf' });

      if (outFile.size > EDITABLE_DOC_RULES.maxBytes) {
        throw new Error(`Finished PDF exceeds the ${EDITABLE_DOC_RULES.maxLabel} upload limit.`);
      }

      // 4. Upload finished PDF under the reserved short ID (original uploaded file stays intact)
      const saved = await uploadFileWithProgress({
        file: outFile,
        category: 'document',
        turnstileToken: '',
        reserved: { id: reserved.id, reserveToken: reserved.reserveToken },
        onProgress: setSaveProgress,
      });

      const blobUrl = URL.createObjectURL(new Blob([outBuffer], { type: 'application/pdf' }));
      if (finalPdfUrl) URL.revokeObjectURL(finalPdfUrl);

      setGeneratedQrDataUrl(verifiedQr.pngDataUrl);
      setFinalPdfUrl(blobUrl);
      setFinalPdfFilename(outFilename);
      setFinalRecord(saved);
      triggerBlobDownload(blobUrl, outFilename);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to embed QR code into PDF.');
    } finally {
      setGenerating(false);
    }
  };

  const handleCopy = async (text: string, which: 'link' | 'token') => {
    try {
      await navigator.clipboard.writeText(text);
      if (which === 'link') {
        setCopiedLink(true);
        setTimeout(() => setCopiedLink(false), 2000);
      } else {
        setCopiedToken(true);
        setTimeout(() => setCopiedToken(false), 2000);
      }
    } catch {
      // ignore clipboard errors
    }
  };

  const handleDeleteFinal = async () => {
    if (!finalRecord) return;
    setDeletingFinal(true);
    try {
      await deleteUploadedItem(finalRecord.id, finalRecord.deleteToken);
      setDeletedMessage('Final PDF removed from server. Scanning its QR code will no longer open it.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete file.');
    } finally {
      setDeletingFinal(false);
    }
  };

  const isEditorOpen = Boolean(pdfDocument && inspection && workingPdfBytes && originalRecord);
  const wordBlockedByServer = selectedKind === 'word' && wordToPdfEnabled === false;

  if (!isEditorOpen) {
    return (
      <section className="max-w-3xl mx-auto px-4 sm:px-6">
        <form
          onSubmit={handleOpenDocument}
          className="bg-white rounded-2xl border border-slate-200/80 shadow-[0_12px_35px_-12px_rgba(10,24,50,0.08)] p-6 sm:p-8 space-y-6"
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <span className="w-8 h-8 rounded-full bg-[#0A1832] text-[#D9A441] flex items-center justify-center">
                <FilePenLine className="w-4 h-4" />
              </span>
              <div>
                <h2 className="text-lg font-bold text-[#0A1832]">Add QR to Document</h2>
                <p className="text-xs text-slate-500">
                  Place a scannable QR code on page 1 (or any page) and download the finished PDF.
                </p>
              </div>
            </div>

            {wordToPdfEnabled !== null && (
              <span
                className={`text-[11px] font-bold px-2.5 py-1 rounded-full border ${
                  wordToPdfEnabled
                    ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                    : 'bg-amber-50 text-amber-800 border-amber-200'
                }`}
              >
                {wordToPdfEnabled ? 'PDF & Word Ready' : 'PDF Ready · Word Coming Soon'}
              </span>
            )}
          </div>

          <input
            ref={fileInputRef}
            type="file"
            accept={EDITABLE_DOC_RULES.accept}
            onChange={(e) => {
              const picked = e.target.files?.[0];
              e.target.value = '';
              void handleFilePicked(picked);
            }}
            className="hidden"
          />

          <div
            role="button"
            tabIndex={0}
            onClick={() => fileInputRef.current?.click()}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                fileInputRef.current?.click();
              }
            }}
            onDragOver={(e) => {
              e.preventDefault();
              setDragActive(true);
            }}
            onDragLeave={() => setDragActive(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragActive(false);
              void handleFilePicked(e.dataTransfer.files?.[0]);
            }}
            className={`border-2 border-dashed rounded-xl p-7 text-center transition cursor-pointer ${
              dragActive
                ? 'border-[#D9A441] bg-amber-50/40'
                : 'border-slate-300 hover:border-[#D9A441] bg-slate-50/40'
            }`}
          >
            {selectedFile ? (
              <div className="flex items-center justify-between gap-3 bg-white border border-slate-200 rounded-xl px-4 py-3 text-left">
                <div className="flex items-center gap-3 min-w-0">
                  <FileText className="w-5 h-5 text-[#D9A441] shrink-0" />
                  <div className="min-w-0">
                    <div className="text-sm font-bold text-[#0A1832] truncate">{selectedFile.name}</div>
                    <div className="text-xs text-slate-500">
                      {formatBytes(selectedFile.size)} &middot;{' '}
                      {selectedKind === 'word' ? 'Word Document' : 'PDF Document'}
                    </div>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setSelectedFile(null);
                    setSelectedKind(null);
                    setError(null);
                  }}
                  aria-label="Remove selected document"
                  className="p-1.5 rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50 transition"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            ) : (
              <div className="space-y-2 py-2">
                <div className="w-11 h-11 rounded-xl bg-white border border-slate-200 shadow-xs flex items-center justify-center mx-auto text-[#0A1832]">
                  <Upload className="w-5 h-5" />
                </div>
                <div className="text-sm font-bold text-[#0A1832]">
                  Click to choose a PDF or Word document
                </div>
                <div className="text-xs text-slate-500">
                  or drag &amp; drop here &middot; up to {EDITABLE_DOC_RULES.maxLabel}
                </div>
                <div className="text-[11px] text-slate-400">
                  Allowed: PDF, DOC, DOCX (PDF opens directly; Word converts to PDF)
                </div>
              </div>
            )}
          </div>

          {selectedKind === 'word' && wordToPdfEnabled === false && (
            <div className="flex items-start gap-2.5 bg-amber-50 border border-amber-200 rounded-xl p-3.5 text-xs text-amber-900 leading-relaxed">
              <AlertTriangle className="w-4 h-4 text-[#D9A441] shrink-0 mt-0.5" />
              <div>
                <strong>Word conversion coming soon:</strong> The live server does not have the
                Word-to-PDF converter enabled yet. Please export or save your Word file as a{' '}
                <strong>PDF</strong> first and upload the PDF here.
              </div>
            </div>
          )}

          {selectedKind === 'word' && wordToPdfEnabled !== false && (
            <div className="flex items-start gap-2.5 bg-amber-50 border border-amber-200 rounded-xl p-3.5 text-xs text-amber-900 leading-relaxed">
              <AlertTriangle className="w-4 h-4 text-[#D9A441] shrink-0 mt-0.5" />
              <div>
                Your Word file will be converted to PDF. Fonts, tables or spacing may shift slightly,
                and you will download a PDF.
              </div>
            </div>
          )}

          <div className="flex items-start gap-2.5 bg-slate-50 border border-slate-200/80 rounded-xl p-3 text-xs text-slate-600 leading-relaxed">
            <Info className="w-4 h-4 text-[#D9A441] shrink-0 mt-0.5" />
            <div>
              <p>
                Files are kept as long as storage is available; the oldest files may be removed when
                the storage limit is reached.
              </p>
              <p className="mt-1 text-slate-500">
                Anyone who has the short link can open the file. Do not upload private or illegal
                material.
              </p>
            </div>
          </div>

          <TurnstileBox onToken={setTurnstileToken} resetTrigger={turnstileResetKey} />

          {preparing && (
            <div className="space-y-1.5">
              <div className="flex justify-between text-xs font-semibold text-[#0A1832]">
                <span>{prepareStage || 'Preparing document...'}</span>
                <span>{uploadProgress}%</span>
              </div>
              <div className="h-2.5 w-full bg-slate-100 rounded-full overflow-hidden">
                <div
                  className="h-full bg-[#D9A441] transition-all duration-150"
                  style={{ width: `${uploadProgress}%` }}
                />
              </div>
            </div>
          )}

          {error && (
            <div className="flex items-start gap-2.5 bg-rose-50 border border-rose-200 rounded-xl p-3 text-xs text-rose-700">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          <button
            type="submit"
            disabled={
              preparing ||
              !selectedFile ||
              wordBlockedByServer ||
              (Boolean(TURNSTILE_SITE_KEY) && !turnstileToken)
            }
            className={`w-full py-3.5 px-5 rounded-xl font-bold text-sm flex items-center justify-center gap-2 transition ${
              !preparing &&
              selectedFile &&
              !wordBlockedByServer &&
              (!TURNSTILE_SITE_KEY || turnstileToken)
                ? 'bg-[#0A1832] hover:bg-[#13294B] text-white cursor-pointer shadow-sm'
                : 'bg-slate-400 text-white cursor-not-allowed opacity-85'
            }`}
          >
            {preparing ? (
              <>
                <Loader2 className="w-4 h-4 text-[#D9A441] animate-spin" />
                <span>{prepareStage || 'Opening Editor...'}</span>
              </>
            ) : selectedKind === 'word' ? (
              <>
                <FilePenLine className="w-4 h-4 text-[#D9A441]" />
                <span>Upload &amp; Convert to PDF</span>
              </>
            ) : (
              <>
                <FilePenLine className="w-4 h-4 text-[#D9A441]" />
                <span>Open PDF in Editor</span>
              </>
            )}
          </button>
        </form>
      </section>
    );
  }

  return (
    <section className="max-w-6xl mx-auto px-4 sm:px-6 space-y-4">
      {/* Top Editor Toolbar */}
      <div className="bg-white rounded-2xl border border-slate-200/80 shadow-xs p-3.5 sm:px-5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <FileText className="w-5 h-5 text-[#D9A441] shrink-0" />
          <div className="min-w-0">
            <div className="text-sm font-bold text-[#0A1832] truncate max-w-[240px] sm:max-w-xs">
              {selectedFile?.name || 'Document'}
            </div>
            <div className="text-[11px] text-slate-500">
              {inspection!.pageCount} {inspection!.pageCount === 1 ? 'page' : 'pages'}
              {sourceKind === 'word' ? ' · Converted from Word' : ''}
            </div>
          </div>
        </div>

        {/* Zoom & Page Controls */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex items-center bg-slate-100 rounded-xl p-1 gap-1">
            <button
              type="button"
              onClick={() => setZoom((z) => Math.max(0.5, Number((z - 0.25).toFixed(2))))}
              title="Zoom out"
              className="p-1.5 rounded-lg text-slate-600 hover:bg-white hover:text-[#0A1832] transition cursor-pointer"
            >
              <ZoomOut className="w-4 h-4" />
            </button>
            <select
              aria-label="Zoom level"
              value={ZOOM_PRESETS.includes(zoom as (typeof ZOOM_PRESETS)[number]) ? zoom : ''}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (v > 0) setZoom(v);
              }}
              className="bg-transparent text-xs font-bold text-[#0A1832] px-1 outline-none cursor-pointer"
            >
              {!ZOOM_PRESETS.includes(zoom as (typeof ZOOM_PRESETS)[number]) && (
                <option value="">{Math.round(zoom * 100)}%</option>
              )}
              {ZOOM_PRESETS.map((z) => (
                <option key={z} value={z}>
                  {Math.round(z * 100)}%
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => setZoom((z) => Math.min(3, Number((z + 0.25).toFixed(2))))}
              title="Zoom in"
              className="p-1.5 rounded-lg text-slate-600 hover:bg-white hover:text-[#0A1832] transition cursor-pointer"
            >
              <ZoomIn className="w-4 h-4" />
            </button>
          </div>

          {inspection!.pageCount > 1 && (
            <div className="inline-flex items-center gap-1.5 bg-slate-100 rounded-xl px-2.5 py-1 text-xs">
              <span className="text-slate-500 font-semibold">Page</span>
              <input
                type="number"
                min={1}
                max={inspection!.pageCount}
                value={jumpPageInput}
                onChange={(e) => setJumpPageInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    const p = Number.parseInt(jumpPageInput, 10);
                    if (p >= 1 && p <= inspection!.pageCount) scrollToPage(p - 1);
                  }
                }}
                aria-label="Jump to page number"
                className="w-12 bg-white border border-slate-200 rounded-md px-1.5 py-0.5 text-center font-bold text-[#0A1832]"
              />
              <button
                type="button"
                onClick={() => {
                  const p = Number.parseInt(jumpPageInput, 10);
                  if (p >= 1 && p <= inspection!.pageCount) scrollToPage(p - 1);
                }}
                className="font-bold text-[#0A1832] hover:text-[#D9A441] cursor-pointer"
              >
                Go
              </button>
            </div>
          )}

          <button
            type="button"
            onClick={() => {
              resetEditorSession();
              setSelectedFile(null);
              setSelectedKind(null);
            }}
            className="px-3 py-1.5 rounded-xl border border-slate-200 hover:border-[#0A1832] text-xs font-bold text-slate-600 hover:text-[#0A1832] transition cursor-pointer"
          >
            Change File
          </button>
        </div>
      </div>

      {/* Digital Signature Warning */}
      {inspection!.isSigned && (
        <div className="flex items-start gap-2.5 bg-amber-50 border border-amber-300 rounded-xl p-3.5 text-xs text-amber-900">
          <ShieldAlert className="w-4 h-4 text-amber-700 shrink-0 mt-0.5" />
          <div>
            <strong>Digitally Signed PDF Warning:</strong> {inspection!.signatureDetails}
          </div>
        </div>
      )}

      {/* Word Conversion Notice */}
      {sourceKind === 'word' && (
        <div className="flex items-start gap-2.5 bg-slate-50 border border-slate-200 rounded-xl p-3 text-xs text-slate-600">
          <Info className="w-4 h-4 text-[#D9A441] shrink-0 mt-0.5" />
          <span>
            Converted from Word to PDF — please review page layout before pressing Generate. Output
            downloads as a PDF.
          </span>
        </div>
      )}

      {/* Main Editor Grid: PDF Canvas + Controls Sidebar */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
        <div
          ref={(el) => {
            scrollContainerRef.current = el;
            setScrollRootEl(el);
          }}
          className="lg:col-span-8 bg-slate-200/75 border border-slate-300/80 rounded-2xl p-4 sm:p-6 max-h-[75vh] overflow-auto space-y-6"
        >
          {inspection!.pages.map((pageGeom) => (
            <PdfPageCanvas
              key={pageGeom.pageIndex}
              pdfDocument={pdfDocument!}
              pageGeom={pageGeom}
              zoom={zoom}
              scrollRoot={scrollRootEl}
              placements={placements.filter((p) => p.pageIndex === pageGeom.pageIndex)}
              selectedPlacementId={selectedPlacementId}
              generatedQrDataUrl={generatedQrDataUrl}
              disabled={Boolean(finalRecord)}
              onSelectPlacement={setSelectedPlacementId}
              onUpdatePlacement={handleUpdatePlacement}
              onLiveSizeChange={handleLiveSizeChange}
            />
          ))}
        </div>

        {/* Right Sidebar: Inspector, Copy to Page N, Generate & Download */}
        <aside className="lg:col-span-4 bg-white rounded-2xl border border-slate-200/80 shadow-[0_12px_35px_-12px_rgba(10,24,50,0.08)] p-5 space-y-5">
          <div>
            <h3 className="text-base font-bold text-[#0A1832] flex items-center gap-2">
              <QrCode className="w-4 h-4 text-[#D9A441]" />
              <span>QR Placement</span>
            </h3>
            <p className="text-xs text-slate-500 mt-1">
              {finalRecord
                ? 'Real QR code embedded in the PDF below.'
                : 'Drag the preview box and resize from any corner (square-locked, min 2.5 cm).'}
            </p>
          </div>

          {activePlacement && activeSizeDisplay && (
            <div className="bg-slate-50 border border-slate-200/80 rounded-xl p-3.5 space-y-2 text-xs">
              <div className="flex justify-between">
                <span className="text-slate-500">Selected Page</span>
                <strong className="text-[#0A1832]">
                  Page {activePlacement.pageIndex + 1} of {inspection!.pageCount}
                </strong>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">Print Size</span>
                <strong className="text-[#0A1832]">
                  {activeSizeDisplay.widthCm} &times; {activeSizeDisplay.heightCm} cm
                </strong>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">Total QR Boxes</span>
                <strong className="text-[#0A1832]">{placements.length}</strong>
              </div>
            </div>
          )}

          {/* Copy to Page N & Placed List */}
          {!finalRecord && (
            <div className="space-y-3 border-t border-slate-100 pt-4">
              {inspection!.pageCount > 1 && (
                <div className="space-y-2">
                  <label className="block text-xs font-semibold text-slate-600">
                    Copy QR to another page
                  </label>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      min={1}
                      max={inspection!.pageCount}
                      value={copyPageInput}
                      onChange={(e) => setCopyPageInput(e.target.value)}
                      aria-label="Copy to page number"
                      className="w-20 px-2.5 py-2 rounded-xl border border-slate-300 text-sm font-bold text-[#0A1832] text-center"
                    />
                    <button
                      type="button"
                      onClick={handleCopyToPage}
                      disabled={!activePlacement}
                      className="flex-1 py-2 px-3 rounded-xl border border-[#0A1832] text-[#0A1832] hover:bg-[#0A1832] hover:text-white text-xs font-bold flex items-center justify-center gap-1 transition cursor-pointer"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      <span>Copy to Page {copyPageInput}</span>
                    </button>
                  </div>
                  <button
                    type="button"
                    onClick={handleCopyToAllPages}
                    disabled={!activePlacement}
                    className="w-full py-2 px-3 rounded-xl border border-slate-200 hover:border-[#0A1832] text-xs font-semibold text-slate-600 hover:text-[#0A1832] transition cursor-pointer"
                  >
                    Copy to All Remaining Pages
                  </button>
                </div>
              )}

              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-xs font-semibold text-slate-600">
                  <span>Active Placements</span>
                  <button
                    type="button"
                    onClick={handleAddOnPage1}
                    className="text-[11px] font-bold text-[#0A1832] hover:text-[#D9A441] cursor-pointer"
                  >
                    + Add on Page 1
                  </button>
                </div>
                <div className="max-h-36 overflow-y-auto space-y-1.5 pr-1">
                  {placements.map((p, idx) => {
                    const geom = inspection!.pages[p.pageIndex];
                    const cm = geom ? getPlacementPrintCm(p, geom) : null;
                    const isSelected = p.id === activePlacement?.id;
                    return (
                      <div
                        key={p.id}
                        className={`flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg border text-xs ${
                          isSelected
                            ? 'bg-amber-50/70 border-[#D9A441] text-[#0A1832]'
                            : 'bg-white border-slate-200 text-slate-600'
                        }`}
                      >
                        <button
                          type="button"
                          onClick={() => {
                            setSelectedPlacementId(p.id);
                            scrollToPage(p.pageIndex);
                          }}
                          className="flex-1 text-left font-semibold truncate cursor-pointer"
                        >
                          #{idx + 1} · Page {p.pageIndex + 1}
                          {cm ? ` (${cm.widthCm} cm)` : ''}
                        </button>
                        {placements.length > 1 && (
                          <button
                            type="button"
                            onClick={() => handleRemovePlacement(p.id)}
                            aria-label={`Remove QR placement ${idx + 1}`}
                            className="p-1 text-slate-400 hover:text-rose-600 cursor-pointer"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}

          {error && (
            <div className="flex items-start gap-2 bg-rose-50 border border-rose-200 rounded-xl p-3 text-xs text-rose-700">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          {generating && (
            <div className="space-y-1.5">
              <div className="flex justify-between text-xs font-semibold text-[#0A1832]">
                <span>Saving final PDF...</span>
                <span>{saveProgress}%</span>
              </div>
              <div className="h-2 w-full bg-slate-100 rounded-full overflow-hidden">
                <div
                  className="h-full bg-[#D9A441] transition-all duration-150"
                  style={{ width: `${saveProgress}%` }}
                />
              </div>
            </div>
          )}

          {!finalRecord ? (
            <button
              type="button"
              disabled={generating || placements.length === 0}
              onClick={handleGenerateAndSave}
              className={`w-full py-3.5 px-5 rounded-xl font-bold text-sm flex items-center justify-center gap-2 transition ${
                !generating && placements.length > 0
                  ? 'bg-[#0A1832] hover:bg-[#13294B] text-white cursor-pointer shadow-sm'
                  : 'bg-slate-400 text-white cursor-not-allowed'
              }`}
            >
              {generating ? (
                <>
                  <Loader2 className="w-4 h-4 text-[#D9A441] animate-spin" />
                  <span>Generating &amp; Saving PDF...</span>
                </>
              ) : (
                <>
                  <QrCode className="w-4 h-4 text-[#D9A441]" />
                  <span>Generate &amp; Save PDF</span>
                </>
              )}
            </button>
          ) : (
            <div className="space-y-3 border-t border-slate-100 pt-4">
              <div className="flex items-center gap-2 text-xs font-bold text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-xl px-3 py-2">
                <CheckCircle2 className="w-4 h-4 shrink-0" />
                <span>QR embedded &amp; verified! Ready to download.</span>
              </div>

              {finalPdfUrl && (
                <button
                  type="button"
                  onClick={() => triggerBlobDownload(finalPdfUrl, finalPdfFilename)}
                  className="w-full py-3 px-4 rounded-xl bg-[#0A1832] hover:bg-[#13294B] text-white text-sm font-bold flex items-center justify-center gap-2 transition cursor-pointer shadow-xs"
                >
                  <Download className="w-4 h-4 text-[#D9A441]" />
                  <span>Download Final PDF</span>
                </button>
              )}

              <div className="bg-slate-50 border border-slate-200 rounded-xl p-2.5 flex items-center gap-2">
                <input
                  type="text"
                  readOnly
                  value={finalRecord.shortUrl}
                  aria-label="Final PDF short link"
                  className="flex-1 bg-transparent text-xs font-mono text-[#0A1832] focus:outline-none truncate px-1"
                />
                <button
                  type="button"
                  onClick={() => handleCopy(finalRecord.shortUrl, 'link')}
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-white border border-slate-200 hover:border-[#0A1832] text-xs font-semibold text-[#0A1832] cursor-pointer shrink-0"
                >
                  {copiedLink ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                  {copiedLink ? 'Copied' : 'Copy'}
                </button>
                <a
                  href={finalRecord.shortUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  title="Open final PDF short link"
                  className="p-1.5 rounded-lg bg-white border border-slate-200 hover:border-[#0A1832] text-slate-600 hover:text-[#0A1832] shrink-0"
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                </a>
              </div>

              <div className="text-[11px] text-slate-500">
                QR inside this PDF opens <strong className="text-[#0A1832]">{finalRecord.shortUrl}</strong>.
                Original file preserved at <span className="font-mono">{originalRecord!.id}</span>.
              </div>

              {deletedMessage ? (
                <div className="text-xs bg-emerald-50 border border-emerald-200 text-emerald-800 rounded-xl p-3">
                  {deletedMessage}
                </div>
              ) : (
                <div className="border border-slate-200 rounded-xl p-3 bg-slate-50/70 space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[11px] font-semibold text-slate-600">
                      Final PDF Delete Token:
                    </span>
                    <button
                      type="button"
                      onClick={() => handleCopy(finalRecord.deleteToken, 'token')}
                      className="text-[11px] font-semibold text-[#0A1832] hover:text-[#D9A441] inline-flex items-center gap-1 cursor-pointer"
                    >
                      {copiedToken ? <Check className="w-3 h-3 text-emerald-600" /> : <Copy className="w-3 h-3" />}
                      {copiedToken ? 'Token Copied' : 'Copy Token'}
                    </button>
                  </div>
                  <div className="text-[11px] font-mono text-slate-500 truncate bg-white px-2 py-1 rounded border border-slate-200">
                    {finalRecord.deleteToken}
                  </div>
                  <button
                    type="button"
                    disabled={deletingFinal}
                    onClick={handleDeleteFinal}
                    className="w-full py-1.5 px-3 rounded-lg border border-rose-200 text-rose-700 hover:bg-rose-50 text-xs font-semibold flex items-center justify-center gap-1.5 transition cursor-pointer disabled:opacity-60"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    {deletingFinal ? 'Deleting...' : 'Delete Final PDF from Server'}
                  </button>
                </div>
              )}

              <button
                type="button"
                onClick={() => {
                  if (finalPdfUrl) URL.revokeObjectURL(finalPdfUrl);
                  setFinalPdfUrl(null);
                  setFinalRecord(null);
                  setGeneratedQrDataUrl(null);
                  setDeletedMessage(null);
                }}
                className="w-full py-2 px-3 rounded-xl border border-slate-200 hover:border-[#0A1832] text-xs font-bold text-slate-600 hover:text-[#0A1832] flex items-center justify-center gap-1.5 transition cursor-pointer"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                <span>Adjust Placement &amp; Generate New Version</span>
              </button>
            </div>
          )}
        </aside>
      </div>
    </section>
  );
}
