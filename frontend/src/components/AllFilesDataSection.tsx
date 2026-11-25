import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import {
  AlertTriangle,
  Check,
  Clock,
  Copy,
  FileArchive,
  FileText,
  Loader2,
  Pencil,
  RefreshCw,
  Sparkles,
  Trash2,
  Upload,
  Users,
  X,
} from 'lucide-react';
import {
  extractApi,
  TURNSTILE_SITE_KEY,
  type ExtractConfigResponse,
  type ExtractedIdType,
  type GeminiModelOption,
  type IngestedExtractItem,
} from '../lib/api';
import {
  DEFAULT_GEMINI_MODELS,
  findDuplicateIdNumbers,
  formatColumnCopyText,
  formatElapsedTimer,
  formatRowCopyText,
  getShortModelBadge,
  ID_TYPE_LABELS,
  loadExtractModelPrefs,
  saveExtractModelPrefs,
  type ExtractTableRow,
} from '../lib/extractHelpers';
import { EXTRACT_UPLOAD_RULES, formatBytes, validateExtractFile } from '../lib/fileCheck';
import { TurnstileBox } from './TurnstileBox';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

async function renderPdfPageThumbnail(blob: Blob, pageNumber = 1): Promise<string | null> {
  try {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const task = pdfjsLib.getDocument({ data: bytes });
    const pdf = await task.promise;
    const targetPage = Math.min(Math.max(1, pageNumber), pdf.numPages);
    const page = await pdf.getPage(targetPage);
    const viewport = page.getViewport({ scale: 0.35 });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(48, Math.floor(viewport.width));
    canvas.height = Math.max(48, Math.floor(viewport.height));
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      await task.destroy().catch(() => {});
      return null;
    }
    await page.render({ canvasContext: ctx, viewport, canvas }).promise;
    const dataUrl = canvas.toDataURL('image/png');
    await task.destroy().catch(() => {});
    return dataUrl;
  } catch {
    return null;
  }
}

function getDisplayImagePreview(mimeType: string): boolean {
  return mimeType === 'image/jpeg' || mimeType === 'image/png' || mimeType === 'image/webp';
}

export function AllFilesDataSection() {
  const [config, setConfig] = useState<ExtractConfigResponse>({
    ok: true,
    maxPdfMb: 50,
    concurrency: 5,
    effectiveConcurrency: 5,
    inlineThresholdMb: 4,
    activeKeyCount: 0,
    wordToPdfEnabled: false,
    models: [...DEFAULT_GEMINI_MODELS],
  });
  const [configLoaded, setConfigLoaded] = useState(false);

  const initialPrefs = useMemo(() => loadExtractModelPrefs(), []);
  const [selectedModel, setSelectedModel] = useState<string>(initialPrefs.selectedModel);
  const [allowFallback, setAllowFallback] = useState<boolean>(initialPrefs.allowFallback);

  const [rows, setRows] = useState<ExtractTableRow[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const [bannerError, setBannerError] = useState<string | null>(null);
  const [skippedNotices, setSkippedNotices] = useState<string[]>([]);

  const [turnstileToken, setTurnstileToken] = useState('');
  const [turnstileResetKey, setTurnstileResetKey] = useState(0);

  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [tickNow, setTickNow] = useState<number>(() => Date.now());
  const [batchStartedAt, setBatchStartedAt] = useState<number | null>(null);
  const [batchFinishedAt, setBatchFinishedAt] = useState<number | null>(null);

  // Modals / confirmations
  const [editingRow, setEditingRow] = useState<ExtractTableRow | null>(null);
  const [editName, setEditName] = useState('');
  const [editIdNumber, setEditIdNumber] = useState('');
  const [editIdType, setEditIdType] = useState<ExtractedIdType | ''>('');
  const [editNationality, setEditNationality] = useState('');

  const [deleteConfirmRow, setDeleteConfirmRow] = useState<ExtractTableRow | null>(null);
  const [reextractConfirm, setReextractConfirm] = useState<{
    row: ExtractTableRow;
    tryNextModel: boolean;
  } | null>(null);
  const [previewModal, setPreviewModal] = useState<{
    title: string;
    url: string | null;
    kind: 'image' | 'pdf' | 'text';
  } | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const rowsRef = useRef<ExtractTableRow[]>([]);
  rowsRef.current = rows;
  const createdObjectUrlsRef = useRef<Set<string>>(new Set());
  const pendingJobsRef = useRef<Array<{ rowId: string; item: IngestedExtractItem }>>([]);
  const activeExtractionsRef = useRef<number>(0);

  const modelPrefsRef = useRef({ selectedModel, allowFallback });
  modelPrefsRef.current = { selectedModel, allowFallback };
  const effectiveConcurrencyRef = useRef<number>(config.effectiveConcurrency || 1);
  effectiveConcurrencyRef.current = Math.max(1, config.effectiveConcurrency || 1);

  useEffect(() => {
    saveExtractModelPrefs({ selectedModel, allowFallback });
  }, [selectedModel, allowFallback]);

  useEffect(() => {
    let mounted = true;
    extractApi
      .getConfig()
      .then((cfg) => {
        if (!mounted) return;
        setConfig(cfg);
        setConfigLoaded(true);
      })
      .catch(() => {
        if (mounted) setConfigLoaded(true);
      });
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    return () => {
      for (const u of createdObjectUrlsRef.current) {
        URL.revokeObjectURL(u);
      }
      createdObjectUrlsRef.current.clear();
    };
  }, []);

  const hasActiveWork = useMemo(
    () => rows.some((r) => r.status === 'uploading' || r.status === 'extracting'),
    [rows]
  );

  // Live 250ms UI timer tick while any row is uploading or extracting
  useEffect(() => {
    if (!hasActiveWork) {
      if (batchStartedAt !== null && rows.length > 0 && batchFinishedAt === null) {
        setBatchFinishedAt(Date.now());
      }
      return;
    }
    setBatchFinishedAt(null);
    const id = window.setInterval(() => {
      setTickNow(Date.now());
    }, 250);
    return () => window.clearInterval(id);
  }, [hasActiveWork, batchStartedAt, batchFinishedAt, rows.length]);

  const duplicateIds = useMemo(() => findDuplicateIdNumbers(rows), [rows]);

  const modelsList: readonly GeminiModelOption[] = useMemo(
    () => (config.models?.length ? config.models : DEFAULT_GEMINI_MODELS),
    [config.models]
  );

  const markCopied = useCallback((key: string) => {
    setCopiedKey(key);
    window.setTimeout(() => {
      setCopiedKey((prev) => (prev === key ? null : prev));
    }, 1500);
  }, []);

  const loadThumbnailForItem = useCallback(
    async (rowId: string, item: IngestedExtractItem, pageNumber = 1, localFile?: File) => {
      try {
        if (localFile && getDisplayImagePreview(localFile.type)) {
          const objUrl = URL.createObjectURL(localFile);
          createdObjectUrlsRef.current.add(objUrl);
          setRows((prev) => prev.map((r) => (r.rowId === rowId ? { ...r, thumbnailUrl: objUrl } : r)));
          return;
        }
        if (item.kind === 'image' && getDisplayImagePreview(item.mimeType)) {
          const blob = await extractApi.fetchFileBlob(item.fileId, item.accessToken);
          const objUrl = URL.createObjectURL(blob);
          createdObjectUrlsRef.current.add(objUrl);
          setRows((prev) => prev.map((r) => (r.rowId === rowId ? { ...r, thumbnailUrl: objUrl } : r)));
          return;
        }
        if (item.kind === 'pdf') {
          const blob = localFile ?? (await extractApi.fetchFileBlob(item.fileId, item.accessToken));
          const dataUrl = await renderPdfPageThumbnail(blob, pageNumber);
          if (dataUrl) {
            setRows((prev) => prev.map((r) => (r.rowId === rowId ? { ...r, thumbnailUrl: dataUrl } : r)));
          }
        }
      } catch {
        // Fallback to clean icon badge
      }
    },
    []
  );

  const runSingleRowExtraction = useCallback(
    async (params: {
      rowId: string;
      fileId: string;
      accessToken: string;
      fileName: string;
      mimeType: string;
      sizeBytes: number;
      kind: 'image' | 'pdf' | 'text';
      sourceArchive?: string;
      thumbnailUrl: string | null;
      excludeModels?: string[];
      forceNextModel?: boolean;
      replaceExistingRowOnly?: boolean;
    }) => {
      const startTs = Date.now();
      const { selectedModel: modelChoice, allowFallback: fallbackEnabled } = modelPrefsRef.current;
      const effectiveModel = params.forceNextModel ? 'auto' : modelChoice;
      const effectiveFallback = params.forceNextModel ? true : fallbackEnabled;

      setRows((prev) =>
        prev.map((r) =>
          r.rowId === params.rowId
            ? {
                ...r,
                status: 'extracting',
                errorMessage: null,
                startedAt: startTs,
                elapsedMs: 0,
              }
            : r
        )
      );

      try {
        const res = await extractApi.runExtraction({
          fileId: params.fileId,
          accessToken: params.accessToken,
          model: effectiveModel,
          allowFallback: effectiveFallback,
          excludeModels: params.excludeModels,
        });

        const elapsed = Math.max(1, Date.now() - startTs);
        const docs = res.documents.length > 0 ? res.documents : [
          { pageNumber: null, name: null, idNumber: null, idType: null, nationality: null, confidence: null },
        ];

        setRows((prev) => {
          const idx = prev.findIndex((r) => r.rowId === params.rowId);
          if (idx === -1) return prev;
          const existing = prev[idx];
          const nextTried = Array.from(new Set([...existing.triedModels, res.modelUsed]));

          // On single-row Re-extract, update that row with the matching (or first) extracted doc
          if (params.replaceExistingRowOnly || docs.length === 1) {
            const matchedDoc =
              existing.pageNumber !== null
                ? docs.find((d) => d.pageNumber === existing.pageNumber) ?? docs[0]
                : docs[0];
            const updated: ExtractTableRow = {
              ...existing,
              status: 'done',
              name: matchedDoc.name,
              idNumber: matchedDoc.idNumber,
              idType: matchedDoc.idType,
              nationality: matchedDoc.nationality,
              confidence: matchedDoc.confidence,
              pageNumber: matchedDoc.pageNumber ?? existing.pageNumber,
              modelUsed: res.modelUsed,
              triedModels: nextTried,
              errorMessage: null,
              startedAt: null,
              elapsedMs: elapsed,
              manuallyEdited: false,
            };
            const copy = [...prev];
            copy[idx] = updated;
            return copy;
          }

          // Multi-document PDF: expand into separate rows in-place
          const expandedRows: ExtractTableRow[] = docs.map((doc, docIdx) => {
            const newId = docIdx === 0 ? existing.rowId : `row-${crypto.randomUUID()}`;
            if (docIdx > 0 && params.kind === 'pdf' && doc.pageNumber) {
              void loadThumbnailForItem(
                newId,
                {
                  fileId: params.fileId,
                  accessToken: params.accessToken,
                  fileName: params.fileName,
                  mimeType: params.mimeType,
                  sizeBytes: params.sizeBytes,
                  kind: params.kind,
                  sourceArchive: params.sourceArchive,
                },
                doc.pageNumber
              );
            }
            return {
              rowId: newId,
              fileId: params.fileId,
              accessToken: params.accessToken,
              fileName: params.fileName,
              mimeType: params.mimeType,
              sizeBytes: params.sizeBytes,
              kind: params.kind,
              sourceArchive: params.sourceArchive,
              pageNumber: doc.pageNumber,
              thumbnailUrl: docIdx === 0 ? existing.thumbnailUrl : existing.thumbnailUrl,
              status: 'done',
              uploadProgress: 100,
              name: doc.name,
              idNumber: doc.idNumber,
              idType: doc.idType,
              nationality: doc.nationality,
              confidence: doc.confidence,
              modelUsed: res.modelUsed,
              triedModels: nextTried,
              errorMessage: null,
              startedAt: null,
              elapsedMs: elapsed,
              manuallyEdited: false,
            };
          });

          return [...prev.slice(0, idx), ...expandedRows, ...prev.slice(idx + 1)];
        });
      } catch (err) {
        const elapsed = Math.max(1, Date.now() - startTs);
        const message = err instanceof Error ? err.message : 'Extraction failed.';
        setRows((prev) =>
          prev.map((r) =>
            r.rowId === params.rowId
              ? {
                  ...r,
                  status: 'failed',
                  errorMessage: message,
                  startedAt: null,
                  elapsedMs: elapsed,
                }
              : r
          )
        );
      }
    },
    [loadThumbnailForItem]
  );

  const handleFilesSelected = async (fileList: FileList | File[]) => {
    const picked = Array.from(fileList);
    if (picked.length === 0) return;

    setBannerError(null);
    setSkippedNotices([]);

    const validFiles: File[] = [];
    const validationErrors: string[] = [];
    for (const f of picked) {
      const check = validateExtractFile(f, config.maxPdfMb);
      if (!check.ok) {
        validationErrors.push(check.error);
      } else {
        validFiles.push(f);
      }
    }
    if (validationErrors.length > 0) {
      setBannerError(validationErrors[0]);
    }
    if (validFiles.length === 0) return;

    if (TURNSTILE_SITE_KEY && !turnstileToken) {
      setBannerError('Please complete the security verification check before uploading.');
      return;
    }

    if (configLoaded && config.activeKeyCount === 0) {
      setBannerError(
        'No Gemini API keys are configured on the server yet. Please add at least one key in the Admin Dashboard.'
      );
      return;
    }

    let batchTicket = '';
    try {
      if (TURNSTILE_SITE_KEY) {
        batchTicket = await extractApi.createSession(turnstileToken);
        setTurnstileResetKey((k) => k + 1);
      }
    } catch (err) {
      setBannerError(err instanceof Error ? err.message : 'Security verification failed.');
      setTurnstileResetKey((k) => k + 1);
      return;
    }

    const now = Date.now();
    setBatchStartedAt((prev) => prev ?? now);
    setBatchFinishedAt(null);

    // Create initial uploading placeholder rows
    const placeholders = validFiles.map((file) => {
      const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
      const kind: 'image' | 'pdf' | 'text' =
        ext === 'pdf' ? 'pdf' : ext === 'doc' || ext === 'docx' ? 'text' : 'image';
      const rowId = `row-${crypto.randomUUID()}`;
      let localThumb: string | null = null;
      if (kind === 'image' && getDisplayImagePreview(file.type)) {
        localThumb = URL.createObjectURL(file);
        createdObjectUrlsRef.current.add(localThumb);
      }
      const row: ExtractTableRow = {
        rowId,
        fileId: null,
        accessToken: null,
        fileName: file.name,
        mimeType: file.type || 'application/octet-stream',
        sizeBytes: file.size,
        kind,
        pageNumber: null,
        thumbnailUrl: localThumb,
        status: 'uploading',
        uploadProgress: 0,
        name: null,
        idNumber: null,
        idType: null,
        nationality: null,
        confidence: null,
        modelUsed: null,
        triedModels: [],
        errorMessage: null,
        startedAt: now,
        elapsedMs: 0,
        manuallyEdited: false,
      };
      return { file, row };
    });

    setRows((prev) => [...prev, ...placeholders.map((p) => p.row)]);

    const drainExtractionQueue = () => {
      const limit = effectiveConcurrencyRef.current;
      while (activeExtractionsRef.current < limit && pendingJobsRef.current.length > 0) {
        const nextJob = pendingJobsRef.current.shift()!;
        activeExtractionsRef.current += 1;
        void runSingleRowExtraction({
          rowId: nextJob.rowId,
          fileId: nextJob.item.fileId,
          accessToken: nextJob.item.accessToken,
          fileName: nextJob.item.fileName,
          mimeType: nextJob.item.mimeType,
          sizeBytes: nextJob.item.sizeBytes,
          kind: nextJob.item.kind,
          sourceArchive: nextJob.item.sourceArchive,
          thumbnailUrl: null,
        }).finally(() => {
          activeExtractionsRef.current = Math.max(0, activeExtractionsRef.current - 1);
          drainExtractionQueue();
        });
      }
    };

    // Upload files in bounded concurrency (3) and dispatch extracted items immediately to the AI worker pool
    const uploadQueue = [...placeholders];
    const uploadWorkerCount = Math.min(3, uploadQueue.length);

    const runUploadWorker = async () => {
      while (uploadQueue.length > 0) {
        const current = uploadQueue.shift();
        if (!current) break;
        const { file, row } = current;
        try {
          const ingestRes = await extractApi.ingestFileWithProgress({
            file,
            turnstileToken: batchTicket ? '' : turnstileToken,
            batchTicket,
            onProgress: (pct) => {
              setRows((prev) =>
                prev.map((r) => (r.rowId === row.rowId ? { ...r, uploadProgress: pct } : r))
              );
            },
          });

          if (ingestRes.skipped?.length) {
            setSkippedNotices((prev) => [
              ...prev,
              ...ingestRes.skipped.map((s) => `${s.fileName}: ${s.reason}`),
            ]);
          }

          const items = ingestRes.items ?? [];
          if (items.length === 0) {
            setRows((prev) =>
              prev.map((r) =>
                r.rowId === row.rowId
                  ? {
                      ...r,
                      status: 'failed',
                      errorMessage: 'No supported files found.',
                      startedAt: null,
                      elapsedMs: Date.now() - (r.startedAt ?? now),
                    }
                  : r
              )
            );
            continue;
          }

          const itemRows: Array<{ item: IngestedExtractItem; newRow: ExtractTableRow }> = items.map(
            (item, idx) => {
              const id = idx === 0 ? row.rowId : `row-${crypto.randomUUID()}`;
              return {
                item,
                newRow: {
                  rowId: id,
                  fileId: item.fileId,
                  accessToken: item.accessToken,
                  fileName: item.fileName,
                  mimeType: item.mimeType,
                  sizeBytes: item.sizeBytes,
                  kind: item.kind,
                  sourceArchive: item.sourceArchive,
                  pageNumber: null,
                  thumbnailUrl: idx === 0 && items.length === 1 ? row.thumbnailUrl : null,
                  status: 'extracting',
                  uploadProgress: 100,
                  name: null,
                  idNumber: null,
                  idType: null,
                  nationality: null,
                  confidence: null,
                  modelUsed: null,
                  triedModels: [],
                  errorMessage: null,
                  startedAt: Date.now(),
                  elapsedMs: 0,
                  manuallyEdited: false,
                },
              };
            }
          );

          setRows((prev) => {
            const idx = prev.findIndex((r) => r.rowId === row.rowId);
            if (idx === -1) return prev;
            return [...prev.slice(0, idx), ...itemRows.map((x) => x.newRow), ...prev.slice(idx + 1)];
          });

          for (const { item, newRow } of itemRows) {
            void loadThumbnailForItem(
              newRow.rowId,
              item,
              1,
              items.length === 1 && item.kind === 'pdf' ? file : undefined
            );
            pendingJobsRef.current.push({ rowId: newRow.rowId, item });
          }
          drainExtractionQueue();
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Upload failed.';
          setRows((prev) =>
            prev.map((r) =>
              r.rowId === row.rowId
                ? {
                    ...r,
                    status: 'failed',
                    errorMessage: message,
                    startedAt: null,
                    elapsedMs: Date.now() - (r.startedAt ?? now),
                  }
                : r
            )
          );
        }
      }
    };

    await Promise.all(Array.from({ length: uploadWorkerCount }, () => runUploadWorker()));
  };

  const triggerReextract = async (row: ExtractTableRow, tryNextModel: boolean) => {
    if (!row.fileId || !row.accessToken) return;
    const excludeModels = tryNextModel ? row.triedModels : [];
    await runSingleRowExtraction({
      rowId: row.rowId,
      fileId: row.fileId,
      accessToken: row.accessToken,
      fileName: row.fileName,
      mimeType: row.mimeType,
      sizeBytes: row.sizeBytes,
      kind: row.kind,
      sourceArchive: row.sourceArchive,
      thumbnailUrl: row.thumbnailUrl,
      excludeModels,
      forceNextModel: tryNextModel,
      replaceExistingRowOnly: true,
    });
  };

  const handleRequestReextract = (row: ExtractTableRow, tryNextModel = false) => {
    if (row.manuallyEdited) {
      setReextractConfirm({ row, tryNextModel });
      return;
    }
    void triggerReextract(row, tryNextModel);
  };

  const openEditModal = (row: ExtractTableRow) => {
    setEditingRow(row);
    setEditName(row.name ?? '');
    setEditIdNumber(row.idNumber ?? '');
    setEditIdType(row.idType ?? '');
    setEditNationality(row.nationality ?? '');
  };

  const handleSaveEdit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingRow) return;
    const cleanName = editName.trim().toUpperCase() || null;
    const cleanId = editIdNumber.replace(/[\s\-_]+/g, '').toUpperCase() || null;
    const cleanNat = editNationality.trim().toUpperCase() || null;
    const cleanType = cleanId ? (editIdType || editingRow.idType || 'national_id') : null;

    setRows((prev) =>
      prev.map((r) =>
        r.rowId === editingRow.rowId
          ? {
              ...r,
              name: cleanName,
              idNumber: cleanId,
              idType: cleanType,
              nationality: cleanNat,
              manuallyEdited: true,
            }
          : r
      )
    );
    setEditingRow(null);
  };

  const handleConfirmDeleteRow = async () => {
    if (!deleteConfirmRow) return;
    const target = deleteConfirmRow;
    setDeleteConfirmRow(null);

    const remainingWithSameFile = rowsRef.current.filter(
      (r) => r.rowId !== target.rowId && r.fileId && r.fileId === target.fileId
    );

    setRows((prev) => prev.filter((r) => r.rowId !== target.rowId));

    // Delete backend file only if no sibling row (from the same multi-page PDF) still uses it
    if (target.fileId && target.accessToken && remainingWithSameFile.length === 0) {
      await extractApi.deleteFile(target.fileId, target.accessToken).catch(() => {});
    }
  };

  const handleClearAll = async () => {
    const current = rowsRef.current;
    pendingJobsRef.current = [];
    if (current.length === 0) return;
    const uniqueFiles = new Map<string, string>();
    for (const r of current) {
      if (r.fileId && r.accessToken) uniqueFiles.set(r.fileId, r.accessToken);
    }
    setRows([]);
    setBatchStartedAt(null);
    setBatchFinishedAt(null);
    setSkippedNotices([]);
    setBannerError(null);
    await Promise.all(
      Array.from(uniqueFiles.entries()).map(([fId, tok]) =>
        extractApi.deleteFile(fId, tok).catch(() => {})
      )
    );
  };

  const handleCopyColumn = async (col: 'name' | 'idNumber' | 'nationality') => {
    const text = formatColumnCopyText(rows, col);
    if (!text) return;
    if (await copyTextToClipboard(text)) {
      markCopied(`col:${col}`);
    }
  };

  const handleCopyRow = async (row: ExtractTableRow) => {
    const text = formatRowCopyText(row);
    if (await copyTextToClipboard(text)) {
      markCopied(`row:${row.rowId}`);
    }
  };

  const handleCopySingleValue = async (key: string, value: string | null) => {
    if (!value || value === '-') return;
    if (await copyTextToClipboard(value)) {
      markCopied(key);
    }
  };

  const handleCopyAllRows = async () => {
    if (rows.length === 0) return;
    const text = rows.map((r) => formatRowCopyText(r)).join('\n');
    if (await copyTextToClipboard(text)) {
      markCopied('all-rows');
    }
  };

  // Batch timing calculations
  const totalBatchMs = useMemo(() => {
    if (batchStartedAt === null || rows.length === 0) return 0;
    const end = hasActiveWork ? tickNow : batchFinishedAt ?? tickNow;
    return Math.max(0, end - batchStartedAt);
  }, [batchStartedAt, batchFinishedAt, hasActiveWork, rows.length, tickNow]);

  const averagePerFileMs = useMemo(() => {
    const finished = rows.filter((r) => r.status === 'done' || r.status === 'failed');
    if (finished.length === 0) return 0;
    const sum = finished.reduce((acc, r) => acc + r.elapsedMs, 0);
    return Math.round(sum / finished.length);
  }, [rows]);

  const canTryAnotherModel = (row: ExtractTableRow) => {
    return row.triedModels.length < modelsList.length;
  };

  return (
    <section className="max-w-5xl mx-auto px-4 sm:px-6 space-y-5">
      {/* Top Bar: Model Selector + Batch Info */}
      <div className="bg-white rounded-2xl border border-slate-200/90 shadow-xs p-4 flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <div>
            <label
              htmlFor="extract-model-select"
              className="block text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-1"
            >
              AI Vision Model
            </label>
            <select
              id="extract-model-select"
              value={selectedModel}
              onChange={(e) => setSelectedModel(e.target.value)}
              className="px-3 py-2 rounded-xl border border-slate-300 bg-white text-xs sm:text-sm font-semibold text-[#0A1832] focus:border-[#0A1832] outline-none cursor-pointer"
            >
              <option value="auto">Auto (recommended)</option>
              {modelsList.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </div>

          {selectedModel !== 'auto' && (
            <label className="mt-4 inline-flex items-center gap-2 text-xs font-semibold text-slate-700 bg-slate-50 border border-slate-200 px-3 py-2 rounded-xl cursor-pointer select-none">
              <input
                type="checkbox"
                checked={allowFallback}
                onChange={(e) => setAllowFallback(e.target.checked)}
                className="w-3.5 h-3.5 accent-[#D9A441] rounded"
              />
              <span>Allow fallback</span>
            </label>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-slate-100 text-slate-700 font-semibold">
            <Sparkles className="w-3.5 h-3.5 text-[#D9A441]" />
            Source: AI Vision Extraction
          </span>
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-emerald-50 border border-emerald-200 text-emerald-800 font-bold">
            {rows.length} {rows.length === 1 ? 'File' : 'Files'}
          </span>
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-amber-50 border border-amber-200 text-amber-800 font-bold tabular-nums">
            <Clock className="w-3.5 h-3.5 text-[#D9A441]" />
            {formatElapsedTimer(totalBatchMs)}
            {averagePerFileMs > 0 && (
              <span className="font-medium text-amber-700">
                &middot; Avg {formatElapsedTimer(averagePerFileMs)}/file
              </span>
            )}
          </span>
        </div>
      </div>

      {/* Upload Dropzone Card */}
      <div className="bg-white rounded-2xl border border-slate-200/80 shadow-[0_12px_35px_-12px_rgba(10,24,50,0.08)] p-5 space-y-4">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept={EXTRACT_UPLOAD_RULES.accept}
          onChange={(e) => {
            if (e.target.files) {
              void handleFilesSelected(e.target.files);
            }
            e.target.value = '';
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
            if (e.dataTransfer.files?.length) {
              void handleFilesSelected(e.dataTransfer.files);
            }
          }}
          className={`border-2 border-dashed rounded-xl p-6 text-center transition cursor-pointer ${
            dragActive
              ? 'border-[#D9A441] bg-amber-50/40'
              : 'border-slate-300 hover:border-[#D9A441] bg-slate-50/40'
          }`}
        >
          <div className="space-y-2">
            <div className="w-11 h-11 rounded-xl bg-white border border-slate-200 shadow-xs flex items-center justify-center mx-auto text-[#0A1832]">
              <Upload className="w-5 h-5" />
            </div>
            <div className="text-sm font-bold text-[#0A1832]">
              Drop images, PDFs, ZIP archives, or Word documents here
            </div>
            <div className="text-xs text-slate-500">
              or click to select multiple files &middot; up to {config.maxPdfMb} MB per PDF/ZIP
            </div>
            <div className="text-[11px] text-slate-400">
              Accepted: JPG, JPEG, PNG, WEBP, HEIC, PDF (multi-page), ZIP (nested supported), DOCX
              {config.effectiveConcurrency > 1
                ? ` · Parallel concurrency: ${config.effectiveConcurrency}`
                : ''}
            </div>
          </div>
        </div>

        <TurnstileBox onToken={setTurnstileToken} resetTrigger={turnstileResetKey} />

        {bannerError && (
          <div className="flex items-start gap-2.5 bg-rose-50 border border-rose-200 text-rose-800 rounded-xl px-4 py-3 text-xs sm:text-sm">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-rose-600" />
            <span className="flex-1">{bannerError}</span>
            <button
              type="button"
              onClick={() => setBannerError(null)}
              aria-label="Dismiss error"
              className="text-rose-500 hover:text-rose-700 cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        {skippedNotices.length > 0 && (
          <div className="bg-amber-50 border border-amber-200 text-amber-900 rounded-xl px-4 py-3 text-xs space-y-1">
            <div className="font-bold">Some archive items were skipped:</div>
            <ul className="list-disc list-inside space-y-0.5">
              {skippedNotices.slice(0, 6).map((msg, i) => (
                <li key={i}>{msg}</li>
              ))}
              {skippedNotices.length > 6 && (
                <li>...and {skippedNotices.length - 6} more skipped file(s).</li>
              )}
            </ul>
          </div>
        )}
      </div>

      {/* ALL FILES DATA Card (matches Screenshot 1 table styling) */}
      <div className="bg-white rounded-2xl border-2 border-emerald-200/80 shadow-xs p-4 sm:p-5 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Users className="w-4 h-4 text-emerald-600" />
            <h2 className="text-sm font-extrabold tracking-wide uppercase text-[#0A1832]">
              ALL FILES DATA
            </h2>
          </div>

          {rows.length > 0 && (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleCopyAllRows}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-xs font-bold text-[#0A1832] transition cursor-pointer"
              >
                {copiedKey === 'all-rows' ? (
                  <>
                    <Check className="w-3.5 h-3.5 text-emerald-600" />
                    <span>Copied All</span>
                  </>
                ) : (
                  <>
                    <Copy className="w-3.5 h-3.5 text-slate-500" />
                    <span>Copy All Rows</span>
                  </>
                )}
              </button>
              <button
                type="button"
                onClick={handleClearAll}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-bold text-slate-500 hover:text-rose-600 hover:bg-rose-50 transition cursor-pointer"
              >
                <X className="w-3.5 h-3.5" />
                <span>CLEAR</span>
              </button>
            </div>
          )}
        </div>

        <div className="border border-slate-200 rounded-xl overflow-x-auto bg-white">
          <table className="w-full text-left border-collapse min-w-[760px]">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50/60 text-[11px] font-bold uppercase tracking-wider text-slate-500">
                <th className="py-3 px-4 w-[180px]">IMAGE / FILE</th>
                <th className="py-3 px-4">
                  <div className="inline-flex items-center gap-1.5">
                    <span>NAME</span>
                    <button
                      type="button"
                      onClick={() => handleCopyColumn('name')}
                      title="Copy all names (vertical)"
                      aria-label="Copy all names"
                      className="p-1 rounded hover:bg-slate-200/70 text-slate-500 hover:text-[#0A1832] transition cursor-pointer"
                    >
                      {copiedKey === 'col:name' ? (
                        <Check className="w-3.5 h-3.5 text-emerald-600" />
                      ) : (
                        <Copy className="w-3.5 h-3.5" />
                      )}
                    </button>
                  </div>
                </th>
                <th className="py-3 px-4">
                  <div className="inline-flex items-center gap-1.5">
                    <span>PASSPORT / IQAMA / NATIONAL ID</span>
                    <button
                      type="button"
                      onClick={() => handleCopyColumn('idNumber')}
                      title="Copy all ID numbers (vertical)"
                      aria-label="Copy all ID numbers"
                      className="p-1 rounded hover:bg-slate-200/70 text-slate-500 hover:text-[#0A1832] transition cursor-pointer"
                    >
                      {copiedKey === 'col:idNumber' ? (
                        <Check className="w-3.5 h-3.5 text-emerald-600" />
                      ) : (
                        <Copy className="w-3.5 h-3.5" />
                      )}
                    </button>
                  </div>
                </th>
                <th className="py-3 px-4">
                  <div className="inline-flex items-center gap-1.5">
                    <span>NATIONALITY</span>
                    <button
                      type="button"
                      onClick={() => handleCopyColumn('nationality')}
                      title="Copy all nationalities (vertical)"
                      aria-label="Copy all nationalities"
                      className="p-1 rounded hover:bg-slate-200/70 text-slate-500 hover:text-[#0A1832] transition cursor-pointer"
                    >
                      {copiedKey === 'col:nationality' ? (
                        <Check className="w-3.5 h-3.5 text-emerald-600" />
                      ) : (
                        <Copy className="w-3.5 h-3.5" />
                      )}
                    </button>
                  </div>
                </th>
                <th className="py-3 px-4 text-right">ACTIONS</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 text-xs sm:text-sm">
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-10 px-4 text-center text-xs sm:text-sm text-slate-400">
                    Upload images, PDFs, ZIPs, or DOCX files above to extract Name, ID Number, and
                    Nationality automatically.
                  </td>
                </tr>
              ) : (
                rows.map((row) => {
                  const isBusy = row.status === 'uploading' || row.status === 'extracting';
                  const liveMs = isBusy && row.startedAt ? Math.max(0, tickNow - row.startedAt) : row.elapsedMs;
                  const isDuplicateId = Boolean(
                    row.idNumber && duplicateIds.has(row.idNumber.trim().toUpperCase())
                  );

                  return (
                    <tr
                      key={row.rowId}
                      className={`group transition ${
                        row.status === 'failed' ? 'bg-rose-50/30' : 'hover:bg-slate-50/70'
                      }`}
                    >
                      {/* Col 1: IMAGE / FILE */}
                      <td className="py-3 px-4">
                        <div className="flex items-center gap-2.5">
                          <button
                            type="button"
                            onClick={() =>
                              setPreviewModal({
                                title: row.fileName,
                                url: row.thumbnailUrl,
                                kind: row.kind,
                              })
                            }
                            title="Preview file"
                            className="w-10 h-10 rounded-lg border border-slate-200 bg-slate-50 overflow-hidden flex items-center justify-center shrink-0 cursor-pointer hover:border-[#D9A441]"
                          >
                            {row.thumbnailUrl ? (
                              <img
                                src={row.thumbnailUrl}
                                alt={row.fileName}
                                className="w-full h-full object-cover"
                              />
                            ) : row.kind === 'pdf' ? (
                              <FileText className="w-5 h-5 text-rose-500" />
                            ) : row.sourceArchive ? (
                              <FileArchive className="w-5 h-5 text-amber-600" />
                            ) : (
                              <FileText className="w-5 h-5 text-slate-500" />
                            )}
                          </button>
                          <div className="min-w-0 max-w-[125px]">
                            <div
                              className="text-xs font-semibold text-[#0A1832] truncate"
                              title={row.fileName}
                            >
                              {row.fileName}
                            </div>
                            <div className="text-[10px] text-slate-400 flex items-center gap-1 flex-wrap">
                              <span>{formatBytes(row.sizeBytes)}</span>
                              {row.pageNumber !== null && (
                                <span className="px-1 rounded bg-slate-100 text-slate-600 font-semibold">
                                  p.{row.pageNumber}
                                </span>
                              )}
                            </div>
                            {row.status === 'uploading' && (
                              <div className="mt-1 w-full h-1.5 bg-slate-100 rounded-full overflow-hidden">
                                <div
                                  className="h-full bg-[#D9A441] transition-all duration-150"
                                  style={{ width: `${row.uploadProgress}%` }}
                                />
                              </div>
                            )}
                          </div>
                        </div>
                      </td>

                      {/* Col 2: NAME */}
                      <td className="py-3 px-4">
                        <div className="flex items-center gap-1.5">
                          <span className="font-semibold text-[#0A1832]">
                            {row.status === 'uploading'
                              ? `Uploading ${row.uploadProgress}%`
                              : row.status === 'extracting'
                              ? 'Extracting...'
                              : row.name || '-'}
                          </span>
                          {row.name && (
                            <button
                              type="button"
                              onClick={() => handleCopySingleValue(`cell:name:${row.rowId}`, row.name)}
                              title="Copy name"
                              aria-label="Copy name"
                              className="p-1 rounded hover:bg-slate-100 text-slate-400 hover:text-[#0A1832] transition cursor-pointer shrink-0"
                            >
                              {copiedKey === `cell:name:${row.rowId}` ? (
                                <Check className="w-3.5 h-3.5 text-emerald-600" />
                              ) : (
                                <Copy className="w-3.5 h-3.5" />
                              )}
                            </button>
                          )}
                        </div>
                      </td>

                      {/* Col 3: PASSPORT / IQAMA / NATIONAL ID */}
                      <td className="py-3 px-4">
                        <div className="space-y-1">
                          <div className="inline-flex items-center gap-1.5">
                            <span className="inline-flex items-center px-2.5 py-1 rounded-md bg-emerald-50 border border-emerald-100 text-emerald-900 font-mono text-xs font-semibold">
                              {row.idNumber || '-'}
                            </span>
                            {row.idNumber && (
                              <button
                                type="button"
                                onClick={() => handleCopySingleValue(`cell:id:${row.rowId}`, row.idNumber)}
                                title="Copy ID number"
                                aria-label="Copy ID number"
                                className="p-1 rounded hover:bg-slate-100 text-slate-400 hover:text-[#0A1832] transition cursor-pointer"
                              >
                                {copiedKey === `cell:id:${row.rowId}` ? (
                                  <Check className="w-3.5 h-3.5 text-emerald-600" />
                                ) : (
                                  <Copy className="w-3.5 h-3.5" />
                                )}
                              </button>
                            )}
                          </div>

                          {(row.idType || isDuplicateId) && (
                            <div className="flex items-center gap-1 flex-wrap">
                              {row.idType && (
                                <span className="text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded bg-slate-100 text-slate-600">
                                  {ID_TYPE_LABELS[row.idType]}
                                </span>
                              )}
                              {isDuplicateId && (
                                <span className="inline-flex items-center gap-0.5 text-[10px] font-bold px-1.5 py-0.5 rounded bg-amber-100 text-amber-800">
                                  <AlertTriangle className="w-2.5 h-2.5" />
                                  Duplicate ID
                                </span>
                              )}
                            </div>
                          )}
                        </div>
                      </td>

                      {/* Col 4: NATIONALITY */}
                      <td className="py-3 px-4">
                        <div className="flex items-center gap-1.5">
                          <span className="font-medium text-slate-700">
                            {row.nationality || '-'}
                          </span>
                          {row.nationality && (
                            <button
                              type="button"
                              onClick={() =>
                                handleCopySingleValue(`cell:nat:${row.rowId}`, row.nationality)
                              }
                              title="Copy nationality"
                              aria-label="Copy nationality"
                              className="p-1 rounded hover:bg-slate-100 text-slate-400 hover:text-[#0A1832] transition cursor-pointer shrink-0"
                            >
                              {copiedKey === `cell:nat:${row.rowId}` ? (
                                <Check className="w-3.5 h-3.5 text-emerald-600" />
                              ) : (
                                <Copy className="w-3.5 h-3.5" />
                              )}
                            </button>
                          )}
                        </div>
                      </td>

                      {/* Col 5: ACTIONS */}
                      <td className="py-3 px-4 text-right">
                        <div className="flex flex-col items-end gap-1.5">
                          <div className="inline-flex items-center gap-1.5">
                            {/* Live timer & status */}
                            <span
                              className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold tabular-nums ${
                                row.status === 'failed'
                                  ? 'bg-rose-100 text-rose-700'
                                  : isBusy
                                  ? 'bg-amber-50 text-amber-800'
                                  : 'bg-slate-100 text-slate-600'
                              }`}
                              title={row.errorMessage ?? undefined}
                            >
                              {isBusy && <Loader2 className="w-3 h-3 animate-spin" />}
                              {row.status === 'failed'
                                ? `Failed (${formatElapsedTimer(liveMs)})`
                                : formatElapsedTimer(liveMs)}
                            </span>

                            {/* Copy row horizontal */}
                            <button
                              type="button"
                              onClick={() => handleCopyRow(row)}
                              disabled={isBusy}
                              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-xs font-bold text-[#0A1832] shadow-2xs transition cursor-pointer disabled:opacity-40"
                            >
                              {copiedKey === `row:${row.rowId}` ? (
                                <>
                                  <Check className="w-3.5 h-3.5 text-emerald-600" />
                                  <span>Copied</span>
                                </>
                              ) : (
                                <>
                                  <Copy className="w-3.5 h-3.5 text-slate-500" />
                                  <span>Copy</span>
                                </>
                              )}
                            </button>

                            {/* Re-extract */}
                            <button
                              type="button"
                              onClick={() => handleRequestReextract(row, false)}
                              disabled={isBusy || !row.fileId}
                              title="Re-extract this file"
                              aria-label="Re-extract file"
                              className={`p-1.5 rounded-lg border transition cursor-pointer disabled:opacity-40 ${
                                row.status === 'failed'
                                  ? 'border-rose-300 bg-rose-50 text-rose-700 hover:bg-rose-100 ring-2 ring-rose-200'
                                  : 'border-transparent text-slate-600 hover:text-[#0A1832] hover:bg-slate-100'
                              }`}
                            >
                              <RefreshCw className={`w-4 h-4 ${isBusy ? 'animate-spin' : ''}`} />
                            </button>

                            {/* Edit */}
                            <button
                              type="button"
                              onClick={() => openEditModal(row)}
                              disabled={isBusy}
                              title="Edit extracted fields"
                              aria-label="Edit row"
                              className="p-1.5 rounded-lg text-slate-600 hover:text-[#0A1832] hover:bg-slate-100 transition cursor-pointer disabled:opacity-40"
                            >
                              <Pencil className="w-4 h-4" />
                            </button>

                            {/* Delete */}
                            <button
                              type="button"
                              onClick={() => setDeleteConfirmRow(row)}
                              title="Delete row and file"
                              aria-label="Delete row"
                              className="p-1.5 rounded-lg text-rose-500 hover:text-rose-700 hover:bg-rose-50 transition cursor-pointer"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </div>

                          {/* Model used + Try next model / error hint */}
                          <div className="flex items-center gap-2 text-[10px] text-slate-400">
                            {row.modelUsed && <span>{getShortModelBadge(row.modelUsed)}</span>}
                            {row.manuallyEdited && (
                              <span className="px-1.5 py-0.2 rounded bg-blue-50 text-blue-700 font-semibold">
                                Edited
                              </span>
                            )}
                            {row.status === 'failed' && row.errorMessage && (
                              <span className="text-rose-600 max-w-[180px] truncate" title={row.errorMessage}>
                                {row.errorMessage}
                              </span>
                            )}
                            {(row.status === 'failed' || row.status === 'done') &&
                              row.fileId &&
                              canTryAnotherModel(row) && (
                                <button
                                  type="button"
                                  onClick={() => handleRequestReextract(row, true)}
                                  className={`underline font-semibold cursor-pointer ${
                                    row.status === 'failed' || !row.name || !row.idNumber
                                      ? 'text-rose-700 hover:text-rose-900'
                                      : 'text-slate-500 hover:text-[#0A1832]'
                                  }`}
                                >
                                  Try next model
                                </button>
                              )}
                          </div>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Inline Edit Modal */}
      {editingRow && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-4">
          <form
            onSubmit={handleSaveEdit}
            className="bg-white rounded-2xl border border-slate-200 shadow-xl w-full max-w-md p-5 space-y-4"
          >
            <div className="flex items-center justify-between">
              <h3 className="text-base font-extrabold text-[#0A1832]">Edit Extracted Data</h3>
              <button
                type="button"
                onClick={() => setEditingRow(null)}
                className="p-1 rounded-lg text-slate-400 hover:text-slate-600 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-3">
              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1">
                  Full Name (Latin Uppercase)
                </label>
                <input
                  type="text"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  placeholder="e.g. MUHAMMAD ALI KHAN"
                  className="w-full px-3 py-2 rounded-xl border border-slate-300 text-sm text-[#0A1832] outline-none focus:border-[#0A1832]"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1">
                    ID Number
                  </label>
                  <input
                    type="text"
                    value={editIdNumber}
                    onChange={(e) => setEditIdNumber(e.target.value)}
                    placeholder="e.g. AB1234567"
                    className="w-full px-3 py-2 rounded-xl border border-slate-300 font-mono text-sm text-[#0A1832] outline-none focus:border-[#0A1832]"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1">
                    ID Type
                  </label>
                  <select
                    value={editIdType}
                    onChange={(e) => setEditIdType(e.target.value as ExtractedIdType | '')}
                    className="w-full px-3 py-2 rounded-xl border border-slate-300 text-sm bg-white text-[#0A1832] outline-none focus:border-[#0A1832]"
                  >
                    <option value="">Auto / None</option>
                    <option value="passport">Passport</option>
                    <option value="iqama">Iqama</option>
                    <option value="national_id">National ID</option>
                    <option value="visa">Visa</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1">
                  Nationality
                </label>
                <input
                  type="text"
                  value={editNationality}
                  onChange={(e) => setEditNationality(e.target.value)}
                  placeholder="e.g. PAKISTANI"
                  className="w-full px-3 py-2 rounded-xl border border-slate-300 text-sm text-[#0A1832] outline-none focus:border-[#0A1832]"
                />
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setEditingRow(null)}
                className="px-4 py-2 rounded-xl border border-slate-200 text-xs font-bold text-slate-600 hover:bg-slate-50 cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-4 py-2 rounded-xl bg-[#0A1832] hover:bg-[#13294B] text-white text-xs font-bold cursor-pointer"
              >
                Save Changes
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {deleteConfirmRow && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl border border-slate-200 shadow-xl w-full max-w-sm p-5 space-y-4">
            <h3 className="text-base font-extrabold text-[#0A1832]">Delete File &amp; Row?</h3>
            <p className="text-xs text-slate-600 leading-relaxed">
              This will remove <strong>{deleteConfirmRow.fileName}</strong> from the table and delete
              its temporary uploaded file.
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setDeleteConfirmRow(null)}
                className="px-4 py-2 rounded-xl border border-slate-200 text-xs font-bold text-slate-600 hover:bg-slate-50 cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmDeleteRow}
                className="px-4 py-2 rounded-xl bg-rose-600 hover:bg-rose-700 text-white text-xs font-bold cursor-pointer"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Manual Edit Overwrite Confirmation on Re-extract */}
      {reextractConfirm && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl border border-slate-200 shadow-xl w-full max-w-sm p-5 space-y-4">
            <h3 className="text-base font-extrabold text-[#0A1832]">Overwrite Manual Edits?</h3>
            <p className="text-xs text-slate-600 leading-relaxed">
              You manually edited <strong>{reextractConfirm.row.fileName}</strong>. Re-extracting
              with AI will replace your manual changes. Continue?
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setReextractConfirm(null)}
                className="px-4 py-2 rounded-xl border border-slate-200 text-xs font-bold text-slate-600 hover:bg-slate-50 cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  const target = reextractConfirm;
                  setReextractConfirm(null);
                  void triggerReextract(target.row, target.tryNextModel);
                }}
                className="px-4 py-2 rounded-xl bg-[#0A1832] hover:bg-[#13294B] text-white text-xs font-bold cursor-pointer"
              >
                Re-extract
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Quick Thumbnail Preview Modal */}
      {previewModal && (
        <div
          className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4"
          onClick={() => setPreviewModal(null)}
        >
          <div
            className="bg-white rounded-2xl border border-slate-200 shadow-xl max-w-xl w-full p-4 space-y-3"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-bold text-[#0A1832] truncate">{previewModal.title}</span>
              <button
                type="button"
                onClick={() => setPreviewModal(null)}
                className="p-1 rounded-lg text-slate-400 hover:text-slate-600 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 flex items-center justify-center min-h-[220px]">
              {previewModal.url ? (
                <img
                  src={previewModal.url}
                  alt={previewModal.title}
                  className="max-h-[70vh] w-auto object-contain rounded-lg"
                />
              ) : (
                <div className="text-xs text-slate-500 text-center space-y-2">
                  <FileText className="w-8 h-8 mx-auto text-slate-400" />
                  <div>Preview thumbnail unavailable for this document format.</div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
