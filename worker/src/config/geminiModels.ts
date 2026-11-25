export interface GeminiModelDefinition {
  id: string;
  label: string;
  priority: number;
  description: string;
  thinkingLevel: 'minimal' | 'low';
}

/**
 * Centralized Gemini model configuration.
 * Update model codes here when Google introduces or reroutes new Gemini releases.
 */
export const GEMINI_MODEL_CONFIG = {
  apiBaseUrl: 'https://generativelanguage.googleapis.com',
  apiVersion: 'v1beta',
  requestTimeoutMs: 45_000,
  filesUploadTimeoutMs: 60_000,
  filesPollIntervalMs: 1_000,
  filesPollMaxAttempts: 20,
  maxRetriesPerModel: 1,
  baseBackoffMs: 600,
  keyCooldownMs: 60_000,
  maxApiKeys: 20,
  temperature: 0.1,
  defaultMaxPdfMb: 50,
  defaultConcurrency: 5,
  defaultInlineThresholdMb: 4,
  defaultDailyTokenBudget: 1_000_000,
  maxBatchItems: 4,
  maxBatchInlineBytes: Math.floor(3.5 * 1024 * 1024),
  models: [
    {
      id: 'gemini-3.6-flash',
      label: 'Gemini 3.6 Flash',
      priority: 1,
      description: 'Primary fast vision extraction model',
      thinkingLevel: 'minimal',
    },
    {
      id: 'gemini-3.5-flash-lite',
      label: 'Gemini 3.5 Flash-Lite',
      priority: 2,
      description: 'High-speed lightweight fallback model',
      thinkingLevel: 'minimal',
    },
    {
      id: 'gemini-3.8-flash',
      label: 'Gemini 3.8 Flash',
      priority: 3,
      description: 'Secondary fallback (may experience high traffic)',
      thinkingLevel: 'low',
    },
  ] as readonly GeminiModelDefinition[],
} as const;

export type GeminiModelId = (typeof GEMINI_MODEL_CONFIG.models)[number]['id'];

export function isValidGeminiModelId(value: string): boolean {
  return GEMINI_MODEL_CONFIG.models.some((m) => m.id === value);
}

/**
 * Builds the ordered list of Gemini models to attempt for an extraction request.
 * In `auto` mode, follows configured priority order; in manual mode, attempts only
 * the selected model unless `allowFallback` is enabled.
 */
export function resolveModelOrder(params: {
  requestedModel?: string | null;
  allowFallback?: boolean;
  excludeModels?: string[];
}): { ok: true; models: GeminiModelDefinition[] } | { ok: false; error: string } {
  const raw = (params.requestedModel ?? 'auto').trim();
  const excluded = new Set((params.excludeModels ?? []).map((m) => m.trim()).filter(Boolean));
  const sorted = [...GEMINI_MODEL_CONFIG.models].sort((a, b) => a.priority - b.priority);

  let ordered: GeminiModelDefinition[];
  if (!raw || raw.toLowerCase() === 'auto') {
    ordered = sorted;
  } else {
    const chosen = sorted.find((m) => m.id === raw);
    if (!chosen) {
      return { ok: false, error: `Unsupported Gemini model "${raw}".` };
    }
    ordered = params.allowFallback
      ? [chosen, ...sorted.filter((m) => m.id !== chosen.id)]
      : [chosen];
  }

  const filtered = ordered.filter((m) => !excluded.has(m.id));
  if (filtered.length === 0) {
    return {
      ok: false,
      error: 'No remaining Gemini models to try for this selection.',
    };
  }
  return { ok: true, models: filtered };
}
