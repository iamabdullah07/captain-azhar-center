import type { ExtractedIdType } from './api';

export type ExtractRowStatus = 'uploading' | 'extracting' | 'done' | 'failed';

export interface ExtractTableRow {
  rowId: string;
  fileId: string | null;
  accessToken: string | null;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  kind: 'image' | 'pdf' | 'text';
  sourceArchive?: string;
  pageNumber: number | null;
  thumbnailUrl: string | null;
  status: ExtractRowStatus;
  uploadProgress: number;
  name: string | null;
  idNumber: string | null;
  idType: ExtractedIdType | null;
  nationality: string | null;
  confidence: number | null;
  modelUsed: string | null;
  triedModels: string[];
  errorMessage: string | null;
  startedAt: number | null;
  elapsedMs: number;
  manuallyEdited: boolean;
}

export const ID_TYPE_LABELS: Record<ExtractedIdType, string> = {
  passport: 'Passport',
  iqama: 'Iqama',
  national_id: 'National ID',
  visa: 'Visa',
};

export const MODEL_PREFS_STORAGE_KEY = 'cac_extract_model_prefs_v1';

export interface ExtractModelPrefs {
  selectedModel: string;
  allowFallback: boolean;
}

export const DEFAULT_GEMINI_MODELS = [
  { id: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash', priority: 1, description: 'Primary fast vision model' },
  { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash-Lite', priority: 2, description: 'Lightweight fallback' },
  { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', priority: 3, description: 'Secondary fallback' },
] as const;

export function loadExtractModelPrefs(): ExtractModelPrefs {
  try {
    const raw = localStorage.getItem(MODEL_PREFS_STORAGE_KEY);
    if (!raw) return { selectedModel: 'auto', allowFallback: false };
    const parsed = JSON.parse(raw) as Partial<ExtractModelPrefs>;
    return {
      selectedModel: typeof parsed.selectedModel === 'string' && parsed.selectedModel ? parsed.selectedModel : 'auto',
      allowFallback: Boolean(parsed.allowFallback),
    };
  } catch {
    return { selectedModel: 'auto', allowFallback: false };
  }
}

export function saveExtractModelPrefs(prefs: ExtractModelPrefs): void {
  try {
    localStorage.setItem(MODEL_PREFS_STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Ignore storage errors
  }
}

/**
 * Formats milliseconds into `M:SS` live timer style (e.g., `0:09`, `1:45`).
 */
export function formatElapsedTimer(ms: number): string {
  const safeSeconds = Math.max(0, Math.floor(ms / 1000));
  const mins = Math.floor(safeSeconds / 60);
  const secs = safeSeconds % 60;
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

/**
 * Computes vertical newline-separated values for a given table data column.
 */
export function formatColumnCopyText(
  rows: ReadonlyArray<Pick<ExtractTableRow, 'name' | 'idNumber' | 'nationality'>>,
  column: 'name' | 'idNumber' | 'nationality'
): string {
  return rows.map((row) => (row[column] && row[column]!.trim() ? row[column]!.trim() : '-')).join('\n');
}

/**
 * Formats a single row horizontally (`NAME\tID\tNATIONALITY`) for spreadsheet/Word paste.
 */
export function formatRowCopyText(
  row: Pick<ExtractTableRow, 'name' | 'idNumber' | 'nationality'>
): string {
  return [
    row.name?.trim() || '-',
    row.idNumber?.trim() || '-',
    row.nationality?.trim() || '-',
  ].join('\t');
}

/**
 * Returns the set of normalized ID numbers that appear in two or more rows.
 */
export function findDuplicateIdNumbers(
  rows: ReadonlyArray<Pick<ExtractTableRow, 'idNumber'>>
): Set<string> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const val = row.idNumber?.trim().toUpperCase();
    if (!val || val === '-') continue;
    counts.set(val, (counts.get(val) ?? 0) + 1);
  }
  const duplicates = new Set<string>();
  for (const [idVal, count] of counts.entries()) {
    if (count > 1) duplicates.add(idVal);
  }
  return duplicates;
}

export function getShortModelBadge(modelId: string | null): string {
  if (!modelId) return '';
  const map: Record<string, string> = {
    'gemini-3.6-flash': '3.6 Flash',
    'gemini-3.5-flash-lite': '3.5 Lite',
    'gemini-3.8-flash': '3.8 Flash',
  };
  return map[modelId] ?? modelId;
}

export function formatCompactTokenCount(tokens: number): string {
  const safe = Math.max(0, Math.round(tokens));
  if (safe >= 1_000_000) {
    const m = safe / 1_000_000;
    return `${Number.isInteger(m) ? m : m.toFixed(2).replace(/\.?0+$/, '')}M`;
  }
  if (safe >= 1_000) {
    const k = safe / 1_000;
    return `${k >= 100 ? Math.round(k) : Number(k.toFixed(1))}K`;
  }
  return String(safe);
}

export function getQuotaTubeTone(
  remainingPct: number,
  status: 'ready' | 'cooldown' | 'exhausted' | 'none'
): {
  tone: 'green' | 'yellow' | 'red';
  barClass: string;
  textClass: string;
  badgeClass: string;
} {
  if (status === 'cooldown' || status === 'exhausted' || status === 'none' || remainingPct <= 20) {
    return {
      tone: 'red',
      barClass: 'bg-rose-500',
      textClass: 'text-rose-700',
      badgeClass: 'bg-rose-50 border-rose-200 text-rose-700',
    };
  }
  if (remainingPct <= 50) {
    return {
      tone: 'yellow',
      barClass: 'bg-amber-400',
      textClass: 'text-amber-800',
      badgeClass: 'bg-amber-50 border-amber-200 text-amber-800',
    };
  }
  return {
    tone: 'green',
    barClass: 'bg-emerald-500',
    textClass: 'text-emerald-700',
    badgeClass: 'bg-emerald-50 border-emerald-200 text-emerald-700',
  };
}
