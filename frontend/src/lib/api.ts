import type { InputTab } from './fileCheck';

export const API_BASE_URL = (
  import.meta.env.VITE_API_URL ||
  (import.meta.env.PROD
    ? 'https://captain-azhar-center.kashaf-hub.workers.dev'
    : 'http://127.0.0.1:8787')
).replace(/\/+$/, '');

export const TURNSTILE_SITE_KEY = (import.meta.env.VITE_TURNSTILE_SITE_KEY || '').trim();
const CSRF_HEADER_VALUE = 'CaptainAzharAdmin';

export interface CreatedQrRecord {
  id: string;
  type: InputTab;
  shortUrl: string;
  deleteToken: string;
  originalName?: string;
  targetUrl?: string;
  sizeBytes?: number;
  createdAt: number;
}

export interface ApiCapabilities {
  ok: boolean;
  wordToPdfEnabled: boolean;
}

export interface ConvertedWordResult {
  pdfBytes: Uint8Array;
  uploadTicket?: string;
}

const MAX_NETWORK_RETRIES = 3;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sendSingleXhrRequest(input: string, init: RequestInit): Promise<Response> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const method = (init.method || 'GET').toUpperCase();
    xhr.open(method, input, true);
    xhr.withCredentials = init.credentials === 'include';

    const headers = new Headers(init.headers);
    headers.forEach((value, key) => {
      xhr.setRequestHeader(key, value);
    });

    xhr.onload = () => {
      const contentType = xhr.getResponseHeader('Content-Type') || 'application/json';
      resolve(
        new Response(xhr.responseText, {
          status: xhr.status || 200,
          statusText: xhr.statusText,
          headers: { 'Content-Type': contentType },
        })
      );
    };
    xhr.onerror = () => {
      reject(
        new Error(
          'Unable to reach the server. Please check your connection or disable any script/ad blocker and try again.'
        )
      );
    };
    xhr.onabort = () => reject(new Error('Request was cancelled.'));
    xhr.send(typeof init.body === 'string' ? init.body : null);
  });
}

async function xhrFallbackRequest(input: string, init: RequestInit): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await sendSingleXhrRequest(input, init);
    } catch (err) {
      lastErr = err;
      if (attempt === 0) {
        await fetch(`${API_BASE_URL}/api/health`, { mode: 'cors', cache: 'no-store' }).catch(() => {});
        await sleep(350);
      }
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error('Unable to reach the server. Please check your connection and try again.');
}

async function fetchWithRetry(input: string, init: RequestInit): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_NETWORK_RETRIES; attempt++) {
    try {
      return await fetch(input, init);
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_NETWORK_RETRIES) {
        // Trigger HTTP/2 fallback if QUIC dropped on the ISP before retrying
        await fetch(`${API_BASE_URL}/api/health`, { mode: 'cors', cache: 'no-store' }).catch(() => {});
        await sleep(250 * (attempt + 1));
      }
    }
  }
  if (typeof XMLHttpRequest !== 'undefined' && (init.body === undefined || typeof init.body === 'string')) {
    return await xhrFallbackRequest(input, init);
  }
  throw lastErr instanceof Error ? lastErr : new Error('Network error. Please try again.');
}

/** Silently warms the API connection (and triggers HTTP/2 fallback if QUIC is blocked on ISP). */
export function warmupApiConnection(): void {
  fetch(`${API_BASE_URL}/api/health`, { mode: 'cors' }).catch(() => {});
}

export async function fetchApiCapabilities(): Promise<ApiCapabilities> {
  try {
    const res = await fetchWithRetry(`${API_BASE_URL}/api/health`, { mode: 'cors' });
    if (!res.ok) return { ok: false, wordToPdfEnabled: false };
    const data = (await res.json()) as { ok?: boolean; wordToPdfEnabled?: boolean };
    return {
      ok: Boolean(data.ok),
      wordToPdfEnabled: Boolean(data.wordToPdfEnabled),
    };
  } catch {
    return { ok: false, wordToPdfEnabled: false };
  }
}

export async function createShortLink(url: string, turnstileToken: string): Promise<CreatedQrRecord> {
  const res = await fetchWithRetry(`${API_BASE_URL}/api/link`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, turnstileToken }),
  });
  const data = (await res.json()) as CreatedQrRecord & { error?: string };
  if (!res.ok) {
    throw new Error(data.error || 'Could not create short link.');
  }
  return data;
}

function sendSingleUploadXhr(params: {
  file: File;
  category: Exclude<InputTab, 'link'>;
  turnstileToken: string;
  convertedUploadTicket?: string;
  onProgress: (pct: number) => void;
}): Promise<CreatedQrRecord> {
  const { file, category, turnstileToken, convertedUploadTicket, onProgress } = params;

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${API_BASE_URL}/api/upload`, true);

    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name));
    xhr.setRequestHeader('X-File-Category', category);
    xhr.setRequestHeader('X-Turnstile-Token', turnstileToken);
    if (convertedUploadTicket) {
      xhr.setRequestHeader('X-Converted-Upload-Ticket', convertedUploadTicket);
    }

    xhr.upload.onprogress = (ev) => {
      if (ev.lengthComputable && ev.total > 0) {
        onProgress(Math.min(99, Math.round((ev.loaded / ev.total) * 100)));
      }
    };

    xhr.onload = () => {
      try {
        const parsed = JSON.parse(xhr.responseText || '{}') as CreatedQrRecord & { error?: string };
        if (xhr.status >= 200 && xhr.status < 300) {
          onProgress(100);
          resolve(parsed);
        } else {
          reject(new Error(parsed.error || `Upload failed (${xhr.status})`));
        }
      } catch {
        reject(new Error(`Upload failed (${xhr.status})`));
      }
    };

    xhr.onerror = () => {
      const err = new Error('Network error while uploading file.');
      (err as Error & { isTransientNetwork?: boolean }).isTransientNetwork = true;
      reject(err);
    };
    xhr.onabort = () => reject(new Error('Upload was cancelled.'));

    xhr.send(file);
  });
}

export async function uploadFileWithProgress(params: {
  file: File;
  category: Exclude<InputTab, 'link'>;
  turnstileToken: string;
  convertedUploadTicket?: string;
  onProgress: (pct: number) => void;
}): Promise<CreatedQrRecord> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_NETWORK_RETRIES; attempt++) {
    try {
      return await sendSingleUploadXhr(params);
    } catch (err) {
      lastErr = err;
      const isTransient = Boolean((err as Error & { isTransientNetwork?: boolean })?.isTransientNetwork);
      if (!isTransient || attempt >= MAX_NETWORK_RETRIES) {
        throw err;
      }
      params.onProgress(0);
      await fetch(`${API_BASE_URL}/api/health`, { mode: 'cors', cache: 'no-store' }).catch(() => {});
      await sleep(300 * (attempt + 1));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('Network error while uploading file.');
}

export async function convertWordToPdf(params: {
  file: File;
  turnstileToken?: string;
  onProgress?: (pct: number) => void;
}): Promise<ConvertedWordResult> {
  const { file, turnstileToken = '', onProgress } = params;

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${API_BASE_URL}/api/convert-word`, true);
    xhr.responseType = 'arraybuffer';

    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name));
    xhr.setRequestHeader('X-Turnstile-Token', turnstileToken);

    xhr.upload.onprogress = (ev) => {
      if (onProgress && ev.lengthComputable && ev.total > 0) {
        onProgress(Math.min(95, Math.round((ev.loaded / ev.total) * 100)));
      }
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300 && xhr.response instanceof ArrayBuffer) {
        onProgress?.(100);
        const uploadTicket = xhr.getResponseHeader('X-Converted-Upload-Ticket')?.trim() || undefined;
        resolve({
          pdfBytes: new Uint8Array(xhr.response),
          uploadTicket,
        });
        return;
      }
      let message = `Word conversion failed (${xhr.status})`;
      if (xhr.response instanceof ArrayBuffer) {
        try {
          const text = new TextDecoder().decode(xhr.response);
          const parsed = JSON.parse(text) as { error?: string };
          if (parsed.error) message = parsed.error;
        } catch {
          // ignore parse error
        }
      }
      reject(new Error(message));
    };

    xhr.onerror = () => reject(new Error('Network error while converting Word file.'));
    xhr.onabort = () => reject(new Error('Word conversion was cancelled.'));
    xhr.send(file);
  });
}

export async function deleteUploadedItem(id: string, deleteToken: string): Promise<void> {
  const res = await fetchWithRetry(`${API_BASE_URL}/api/f/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: {
      'Content-Type': 'application/json',
      'X-Delete-Token': deleteToken,
    },
    body: JSON.stringify({ deleteToken }),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) {
    throw new Error(data.error || 'Could not delete item.');
  }
}

export async function submitAbuseReport(idOrUrl: string, reason: string): Promise<string> {
  const res = await fetchWithRetry(`${API_BASE_URL}/api/report`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idOrUrl, reason }),
  });
  const data = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
  if (!res.ok) {
    throw new Error(data.error || 'Failed to submit report.');
  }
  return data.message || 'Report submitted.';
}

// ---- Admin API Client ----

async function adminFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const method = (options.method ?? 'GET').toUpperCase();
  const headers = new Headers(options.headers);
  if (!headers.has('Content-Type') && options.body) {
    headers.set('Content-Type', 'application/json');
  }
  if (method !== 'GET' && method !== 'HEAD') {
    headers.set('X-Requested-With', CSRF_HEADER_VALUE);
  }

  const res = await fetchWithRetry(`${API_BASE_URL}/api/admin${path}`, {
    ...options,
    credentials: 'include',
    headers,
  });

  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) {
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return data;
}

export const adminApi = {
  bootstrap: () => adminFetch<{ initialized: boolean }>('/bootstrap'),
  signup: (email: string, password: string, turnstileToken: string) =>
    adminFetch<{ ok: boolean; email: string }>('/signup', {
      method: 'POST',
      body: JSON.stringify({ email, password, turnstileToken }),
    }),
  login: (email: string, password: string, turnstileToken: string) =>
    adminFetch<{ ok: boolean; email: string }>('/login', {
      method: 'POST',
      body: JSON.stringify({ email, password, turnstileToken }),
    }),
  logout: () => adminFetch<{ ok: boolean }>('/logout', { method: 'POST', body: '{}' }),
  forgot: (email: string, turnstileToken: string) =>
    adminFetch<{ ok: boolean; message: string }>('/forgot', {
      method: 'POST',
      body: JSON.stringify({ email, turnstileToken }),
    }),
  reset: (token: string, newPassword: string) =>
    adminFetch<{ ok: boolean; message: string }>('/reset', {
      method: 'POST',
      body: JSON.stringify({ token, newPassword }),
    }),
  me: () => adminFetch<{ authenticated: boolean; email: string }>('/me'),
  stats: () =>
    adminFetch<{
      totalBytes: number;
      limitBytes: number;
      percentUsed: number;
      triggerPct: number;
      targetPct: number;
      expireLinksMonths: number | null;
      countsByType: Record<string, number>;
      oldestActiveFileDate: number | null;
      unresolvedReportsCount: number;
      cleanupLogs: Array<{
        id: number;
        run_time: number;
        files_deleted: number;
        bytes_freed: number;
        total_after: number;
        trigger: string;
      }>;
      loginAttempts: Array<{
        id: number;
        time: number;
        ip: string;
        success: number;
      }>;
    }>('/stats'),
  files: (params: { q?: string; type?: string; status?: string; page?: number }) => {
    const qs = new URLSearchParams();
    if (params.q) qs.set('q', params.q);
    if (params.type) qs.set('type', params.type);
    if (params.status) qs.set('status', params.status);
    if (params.page) qs.set('page', String(params.page));
    return adminFetch<{
      items: Array<{
        id: string;
        type: string;
        original_name: string | null;
        mime_type: string | null;
        size_bytes: number;
        target_url: string | null;
        created_at: number;
        status: string;
        removed_reason: string | null;
      }>;
      total: number;
      page: number;
      pageSize: number;
    }>(`/files?${qs.toString()}`);
  },
  deleteFile: (id: string) => adminFetch<{ ok: boolean }>(`/f/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  blockItem: (id: string, action: 'block' | 'unblock') =>
    adminFetch<{ ok: boolean; status: string }>(`/block/${encodeURIComponent(id)}`, {
      method: 'POST',
      body: JSON.stringify({ action }),
    }),
  runCleanup: () =>
    adminFetch<{
      ok: boolean;
      ran: boolean;
      filesDeleted: number;
      bytesFreed: number;
      totalAfter: number;
    }>('/cleanup', { method: 'POST', body: '{}' }),
  reports: () =>
    adminFetch<{
      reports: Array<{
        id: number;
        file_id: string;
        reason: string;
        time: number;
        resolved: number;
        type?: string;
        original_name?: string;
        target_url?: string;
        item_status?: string;
      }>;
    }>('/reports'),
  resolveReport: (id: number) =>
    adminFetch<{ ok: boolean }>(`/reports/${id}/resolve`, { method: 'POST', body: '{}' }),
  updateSettings: (payload: {
    triggerPct?: number;
    targetPct?: number;
    expireLinksMonths?: number | null;
  }) =>
    adminFetch<{
      ok: boolean;
      triggerPct: number;
      targetPct: number;
      expireLinksMonths: number | null;
    }>('/settings', {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),
  getExtractSettings: () =>
    adminFetch<{
      maxPdfMb: number;
      concurrency: number;
      inlineThresholdMb: number;
      dailyTokenBudget: number;
      maxKeysLimit: number;
      envKeysCount: number;
      totalConfiguredCount: number;
      keys: AdminGeminiKeySummary[];
    }>('/extract-settings'),
  updateExtractSettings: (payload: {
    maxPdfMb?: number;
    concurrency?: number;
    inlineThresholdMb?: number;
    dailyTokenBudget?: number;
  }) =>
    adminFetch<{
      ok: boolean;
      maxPdfMb: number;
      concurrency: number;
      inlineThresholdMb: number;
      dailyTokenBudget: number;
    }>('/extract-settings', {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),
  addGeminiKey: (apiKey: string, label?: string) =>
    adminFetch<{ ok: boolean; key: AdminGeminiKeySummary }>('/gemini-keys', {
      method: 'POST',
      body: JSON.stringify({ apiKey, label }),
    }),
  updateGeminiKey: (
    id: string,
    payload: { enabled?: boolean; label?: string; clearCooldown?: boolean }
  ) =>
    adminFetch<{ ok: boolean; id: string; enabled: boolean; label: string }>(
      `/gemini-keys/${encodeURIComponent(id)}`,
      {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }
    ),
  deleteGeminiKey: (id: string) =>
    adminFetch<{ ok: boolean; id: string }>(`/gemini-keys/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
};

// ---- All Files Data (AI Extraction) API Client ----

export type ExtractedIdType = 'passport' | 'iqama' | 'national_id' | 'visa';

export interface GeminiModelOption {
  id: string;
  label: string;
  priority: number;
  description: string;
}

export interface PublicKeyQuotaSnapshot {
  totalKeys: number;
  keysUsedToday: number;
  exhaustedKeysCount: number;
  activeKeyNumber: number;
  activeKeyStatus: 'ready' | 'cooldown' | 'exhausted' | 'none';
  dailyTokenBudget: number;
  tokensUsedToday: number;
  tokensRemaining: number;
  remainingPct: number;
  requestsToday: number;
  cooledDownModels?: string[];
}

export interface ExtractConfigResponse {
  ok: boolean;
  maxPdfMb: number;
  concurrency: number;
  effectiveConcurrency: number;
  inlineThresholdMb: number;
  activeKeyCount: number;
  wordToPdfEnabled: boolean;
  models: GeminiModelOption[];
  quota?: PublicKeyQuotaSnapshot;
}

export interface IngestedExtractItem {
  fileId: string;
  accessToken: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  kind: 'image' | 'pdf' | 'text';
  sourceArchive?: string;
}

export interface IngestExtractResponse {
  ok: boolean;
  items: IngestedExtractItem[];
  skipped: Array<{ fileName: string; reason: string }>;
  error?: string;
}

export interface ExtractedDocumentRecord {
  pageNumber: number | null;
  name: string | null;
  idNumber: string | null;
  idType: ExtractedIdType | null;
  nationality: string | null;
  confidence: number | null;
}

export interface RunExtractResponse {
  ok: boolean;
  fileId: string;
  modelUsed: string;
  durationMs: number;
  tokenUsage?: { promptTokens: number; outputTokens: number; totalTokens: number };
  quota?: PublicKeyQuotaSnapshot;
  documents: ExtractedDocumentRecord[];
  attempts: Array<{ model: string; status: 'ok' | 'retry' | 'failed'; reason?: string }>;
  error?: string;
}

export interface RunBatchExtractResponse {
  ok: boolean;
  modelUsed: string;
  durationMs: number;
  tokenUsage?: { promptTokens: number; outputTokens: number; totalTokens: number };
  quota?: PublicKeyQuotaSnapshot;
  results: Array<{ fileId: string; documents: ExtractedDocumentRecord[] }>;
  attempts: Array<{ model: string; status: 'ok' | 'retry' | 'failed'; reason?: string }>;
  error?: string;
}

function buildExtractError(message: string, quota?: PublicKeyQuotaSnapshot): Error {
  const err = new Error(message) as Error & { quota?: PublicKeyQuotaSnapshot };
  if (quota) err.quota = quota;
  return err;
}

export interface AdminGeminiKeySummary {
  id: string;
  source: 'db' | 'env';
  label: string;
  maskedKey: string;
  enabled: boolean;
  cooldownUntil: number;
  lastUsedAt: number;
  successCount: number;
  errorCount: number;
  lastError: string | null;
  createdAt: number;
  tokensUsedToday?: number;
  requestsToday?: number;
}

export const extractApi = {
  getConfig: async (): Promise<ExtractConfigResponse> => {
    const res = await fetchWithRetry(`${API_BASE_URL}/api/extract/config`, { mode: 'cors' });
    const data = (await res.json().catch(() => ({}))) as ExtractConfigResponse & { error?: string };
    if (!res.ok) {
      throw new Error(data.error || 'Could not load extraction configuration.');
    }
    return data;
  },

  createSession: async (turnstileToken: string): Promise<string> => {
    const res = await fetchWithRetry(`${API_BASE_URL}/api/extract/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ turnstileToken }),
    });
    const data = (await res.json().catch(() => ({}))) as { batchTicket?: string; error?: string };
    if (!res.ok || !data.batchTicket) {
      throw new Error(data.error || 'Security verification failed.');
    }
    return data.batchTicket;
  },

  ingestFileWithProgress: (params: {
    file: File;
    turnstileToken?: string;
    batchTicket?: string;
    onProgress: (pct: number) => void;
  }): Promise<IngestExtractResponse> => {
    const { file, turnstileToken = '', batchTicket = '', onProgress } = params;
    const attemptUpload = (canRetry: boolean): Promise<IngestExtractResponse> =>
      new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', `${API_BASE_URL}/api/extract/ingest`, true);
        xhr.setRequestHeader('Content-Type', 'application/octet-stream');
        xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name));
        if (batchTicket) {
          xhr.setRequestHeader('X-Extract-Batch-Token', batchTicket);
        } else if (turnstileToken) {
          xhr.setRequestHeader('X-Turnstile-Token', turnstileToken);
        }

        xhr.upload.onprogress = (ev) => {
          if (ev.lengthComputable && ev.total > 0) {
            onProgress(Math.min(99, Math.round((ev.loaded / ev.total) * 100)));
          }
        };

        xhr.onload = () => {
          try {
            const parsed = JSON.parse(xhr.responseText || '{}') as IngestExtractResponse;
            if (xhr.status >= 200 && xhr.status < 300) {
              onProgress(100);
              resolve(parsed);
            } else if (canRetry && xhr.status >= 502 && xhr.status <= 504) {
              setTimeout(() => void attemptUpload(false).then(resolve, reject), 450);
            } else {
              reject(new Error(parsed.error || `Upload failed (${xhr.status})`));
            }
          } catch {
            if (canRetry && xhr.status >= 502 && xhr.status <= 504) {
              setTimeout(() => void attemptUpload(false).then(resolve, reject), 450);
            } else {
              reject(new Error(`Upload failed (${xhr.status})`));
            }
          }
        };

        xhr.onerror = () => {
          if (canRetry) {
            setTimeout(() => void attemptUpload(false).then(resolve, reject), 450);
          } else {
            reject(new Error('Network error while uploading file.'));
          }
        };
        xhr.onabort = () => reject(new Error('Upload was cancelled.'));
        xhr.send(file);
      });

    return attemptUpload(true);
  },

  runExtraction: async (params: {
    fileId: string;
    accessToken: string;
    model: string;
    allowFallback: boolean;
    excludeModels?: string[];
  }): Promise<RunExtractResponse> => {
    const res = await fetchWithRetry(`${API_BASE_URL}/api/extract/run`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Extract-Token': params.accessToken,
      },
      body: JSON.stringify({
        fileId: params.fileId,
        model: params.model,
        allowFallback: params.allowFallback,
        excludeModels: params.excludeModels ?? [],
      }),
    });
    const data = (await res.json().catch(() => ({}))) as RunExtractResponse;
    if (!res.ok) {
      throw buildExtractError(data.error || `Extraction failed (${res.status})`, data.quota);
    }
    return data;
  },

  runBatchExtraction: async (params: {
    items: Array<{ fileId: string; accessToken: string }>;
    model: string;
    allowFallback: boolean;
    excludeModels?: string[];
  }): Promise<RunBatchExtractResponse> => {
    const res = await fetchWithRetry(`${API_BASE_URL}/api/extract/run-batch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        items: params.items,
        model: params.model,
        allowFallback: params.allowFallback,
        excludeModels: params.excludeModels ?? [],
      }),
    });
    const data = (await res.json().catch(() => ({}))) as RunBatchExtractResponse;
    if (!res.ok) {
      throw buildExtractError(data.error || `Batch extraction failed (${res.status})`, data.quota);
    }
    return data;
  },

  fetchFileBlob: async (fileId: string, accessToken: string): Promise<Blob> => {
    const res = await fetchWithRetry(`${API_BASE_URL}/api/extract/file/${encodeURIComponent(fileId)}`, {
      method: 'GET',
      headers: {
        'X-Extract-Token': accessToken,
      },
    });
    if (!res.ok) {
      throw new Error(`Preview failed (${res.status})`);
    }
    return await res.blob();
  },

  deleteFile: async (fileId: string, accessToken: string): Promise<void> => {
    const res = await fetchWithRetry(`${API_BASE_URL}/api/extract/file/${encodeURIComponent(fileId)}`, {
      method: 'DELETE',
      headers: {
        'X-Extract-Token': accessToken,
      },
    });
    if (!res.ok && res.status !== 404 && res.status !== 410) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(data.error || 'Could not delete file.');
    }
  },
};
