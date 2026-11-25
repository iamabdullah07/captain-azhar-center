import { GEMINI_MODEL_CONFIG } from '../config/geminiModels';
import type {
  Env,
  ExtractSettingsRow,
  GeminiApiKeyRow,
  GeminiKeyDailyUsageRow,
  GeminiKeyRuntimeRow,
} from '../types';
import { bytesToHex, hexToBytes, sha256Hex } from './cryptoUtils';

export interface TokenUsageCounts {
  promptTokens: number;
  outputTokens: number;
  totalTokens: number;
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
}

export interface PooledGeminiKey {
  id: string | null;
  source: 'db' | 'env';
  label: string;
  keyHash: string;
  maskedKey: string;
  apiKey: string;
  cooldownUntil: number;
  lastUsedAt: number;
}

export interface MaskedKeySummary {
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
  tokensUsedToday: number;
  requestsToday: number;
}

const KEY_DERIVE_PREFIX = 'gemini-api-key-aes-v1:';

async function deriveAesKey(secret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${KEY_DERIVE_PREFIX}${secret}`)
  );
  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export function maskGeminiApiKey(rawKey: string): string {
  const trimmed = rawKey.trim();
  if (trimmed.length <= 8) {
    return `${trimmed.slice(0, 2)}••••${trimmed.slice(-2)}`;
  }
  const head = trimmed.slice(0, Math.min(6, trimmed.length - 4));
  const tail = trimmed.slice(-4);
  return `${head}••••••${tail}`;
}

export function validateGeminiApiKeyFormat(rawKey: string): { ok: true; cleaned: string } | { ok: false; error: string } {
  const cleaned = rawKey.trim();
  if (!cleaned) {
    return { ok: false, error: 'API key is required.' };
  }
  if (cleaned.length < 20 || cleaned.length > 256 || /\s/.test(cleaned)) {
    return { ok: false, error: 'Invalid Gemini API key format.' };
  }
  return { ok: true, cleaned };
}

export async function encryptGeminiApiKey(plainKey: string, secret: string): Promise<string> {
  const aesKey = await deriveAesKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    aesKey,
    new TextEncoder().encode(plainKey)
  );
  return `${bytesToHex(iv)}:${bytesToHex(new Uint8Array(encrypted))}`;
}

export async function decryptGeminiApiKey(stored: string, secret: string): Promise<string> {
  const sep = stored.indexOf(':');
  if (sep <= 0) throw new Error('Invalid encrypted key payload');
  const iv = hexToBytes(stored.slice(0, sep));
  const cipher = hexToBytes(stored.slice(sep + 1));
  const aesKey = await deriveAesKey(secret);
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    aesKey,
    cipher as BufferSource
  );
  return new TextDecoder().decode(decrypted);
}

export function parseEnvGeminiKeys(env: Pick<Env, 'GEMINI_API_KEY' | 'GEMINI_API_KEYS'>): string[] {
  const combined = [env.GEMINI_API_KEYS ?? '', env.GEMINI_API_KEY ?? ''].join('\n');
  const rawList = combined
    .split(/[\r\n,;]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 20);
  return Array.from(new Set(rawList)).slice(0, GEMINI_MODEL_CONFIG.maxApiKeys);
}

export function getTodayUtcDateStr(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

export async function getExtractSettings(env: Env): Promise<ExtractSettingsRow> {
  const row = await env.DB
    .prepare('SELECT * FROM extract_settings WHERE id = 1')
    .first<ExtractSettingsRow>();

  const envMaxPdf = Number.parseInt(env.EXTRACT_MAX_PDF_MB ?? '', 10);
  const envConc = Number.parseInt(env.EXTRACT_CONCURRENCY ?? '', 10);

  if (row) {
    return {
      ...row,
      max_pdf_mb: Number.isFinite(envMaxPdf) && envMaxPdf > 0 ? envMaxPdf : row.max_pdf_mb,
      concurrency: Number.isFinite(envConc) && envConc > 0 ? envConc : row.concurrency,
      daily_token_budget:
        Number.isFinite(row.daily_token_budget) && row.daily_token_budget > 0
          ? row.daily_token_budget
          : GEMINI_MODEL_CONFIG.defaultDailyTokenBudget,
    };
  }

  await env.DB
    .prepare(
      `INSERT OR IGNORE INTO extract_settings
       (id, max_pdf_mb, concurrency, inline_threshold_mb, key_rr_cursor, daily_token_budget)
       VALUES (1, ?, ?, ?, 0, ?)`
    )
    .bind(
      GEMINI_MODEL_CONFIG.defaultMaxPdfMb,
      GEMINI_MODEL_CONFIG.defaultConcurrency,
      GEMINI_MODEL_CONFIG.defaultInlineThresholdMb,
      GEMINI_MODEL_CONFIG.defaultDailyTokenBudget
    )
    .run();

  return {
    id: 1,
    max_pdf_mb: Number.isFinite(envMaxPdf) && envMaxPdf > 0 ? envMaxPdf : GEMINI_MODEL_CONFIG.defaultMaxPdfMb,
    concurrency: Number.isFinite(envConc) && envConc > 0 ? envConc : GEMINI_MODEL_CONFIG.defaultConcurrency,
    inline_threshold_mb: GEMINI_MODEL_CONFIG.defaultInlineThresholdMb,
    key_rr_cursor: 0,
    daily_token_budget: GEMINI_MODEL_CONFIG.defaultDailyTokenBudget,
  };
}

/**
 * Loads all active Gemini API keys (encrypted D1 keys + Worker secret/env keys),
 * deduplicated and capped at 20 keys. Never returns or logs plaintext outside this pool.
 */
export async function loadActiveGeminiKeyPool(env: Env): Promise<PooledGeminiKey[]> {
  const pool: PooledGeminiKey[] = [];
  const seenHashes = new Set<string>();
  const secret = (env.SESSION_SECRET ?? '').trim();

  if (secret) {
    const dbRows = await env.DB
      .prepare('SELECT * FROM gemini_api_keys WHERE enabled = 1 ORDER BY created_at ASC')
      .all<GeminiApiKeyRow>();

    for (const row of dbRows.results ?? []) {
      if (pool.length >= GEMINI_MODEL_CONFIG.maxApiKeys) break;
      if (seenHashes.has(row.key_hash)) continue;
      try {
        const plain = await decryptGeminiApiKey(row.encrypted_key, secret);
        seenHashes.add(row.key_hash);
        pool.push({
          id: row.id,
          source: 'db',
          label: row.label || 'Managed Key',
          keyHash: row.key_hash,
          maskedKey: row.masked_key,
          apiKey: plain,
          cooldownUntil: row.cooldown_until,
          lastUsedAt: row.last_used_at,
        });
      } catch {
        // Skip unreadable key if SESSION_SECRET rotated without exposing secret
      }
    }
  }

  const envKeys = parseEnvGeminiKeys(env);
  if (envKeys.length > 0) {
    const runtimeRows = await env.DB
      .prepare('SELECT * FROM gemini_key_runtime')
      .all<GeminiKeyRuntimeRow>();
    const runtimeMap = new Map<string, GeminiKeyRuntimeRow>();
    for (const r of runtimeRows.results ?? []) {
      runtimeMap.set(r.key_hash, r);
    }

    let envIdx = 0;
    for (const rawKey of envKeys) {
      if (pool.length >= GEMINI_MODEL_CONFIG.maxApiKeys) break;
      envIdx += 1;
      const keyHash = await sha256Hex(rawKey);
      if (seenHashes.has(keyHash)) continue;
      seenHashes.add(keyHash);
      const rt = runtimeMap.get(keyHash);
      pool.push({
        id: null,
        source: 'env',
        label: `Env Key ${envIdx}`,
        keyHash,
        maskedKey: maskGeminiApiKey(rawKey),
        apiKey: rawKey,
        cooldownUntil: rt?.cooldown_until ?? 0,
        lastUsedAt: rt?.last_used_at ?? 0,
      });
    }
  }

  return pool;
}

/**
 * Selects the next healthy Gemini API key in round-robin order and advances the persisted cursor.
 */
export async function pickRoundRobinKey(params: {
  pool: PooledGeminiKey[];
  db: D1Database;
  excludedKeyHashes?: Set<string>;
  now?: number;
}): Promise<
  | { ok: true; key: PooledGeminiKey }
  | { ok: false; reason: 'none_configured' | 'all_cooldown'; retryAfterSeconds: number }
> {
  const { pool, db, excludedKeyHashes } = params;
  const now = params.now ?? Date.now();

  if (pool.length === 0) {
    return { ok: false, reason: 'none_configured', retryAfterSeconds: 0 };
  }

  const settings = await db
    .prepare('SELECT key_rr_cursor FROM extract_settings WHERE id = 1')
    .first<{ key_rr_cursor: number }>();
  const cursor = Math.max(0, settings?.key_rr_cursor ?? 0);

  let earliestCooldownUntil = Number.POSITIVE_INFINITY;

  for (let offset = 0; offset < pool.length; offset++) {
    const idx = (cursor + offset) % pool.length;
    const candidate = pool[idx];
    if (excludedKeyHashes?.has(candidate.keyHash)) continue;

    if (candidate.cooldownUntil <= now) {
      const nextCursor = (idx + 1) % pool.length;
      await db
        .prepare('UPDATE extract_settings SET key_rr_cursor = ? WHERE id = 1')
        .bind(nextCursor)
        .run();
      return { ok: true, key: candidate };
    }

    if (candidate.cooldownUntil < earliestCooldownUntil) {
      earliestCooldownUntil = candidate.cooldownUntil;
    }
  }

  const retryAfterSeconds = Number.isFinite(earliestCooldownUntil)
    ? Math.max(1, Math.ceil((earliestCooldownUntil - now) / 1000))
    : 30;
  return { ok: false, reason: 'all_cooldown', retryAfterSeconds };
}

export async function recordGeminiKeySuccess(
  db: D1Database,
  key: PooledGeminiKey,
  now = Date.now(),
  tokenUsage?: TokenUsageCounts
): Promise<void> {
  const usageDate = getTodayUtcDateStr(now);
  const promptTokens = Math.max(0, Math.floor(tokenUsage?.promptTokens ?? 0));
  const outputTokens = Math.max(0, Math.floor(tokenUsage?.outputTokens ?? 0));
  const totalTokens = Math.max(0, Math.floor(tokenUsage?.totalTokens ?? promptTokens + outputTokens));

  const usageStmt = db
    .prepare(
      `INSERT INTO gemini_key_daily_usage
       (key_hash, usage_date, prompt_tokens, output_tokens, total_tokens, requests_count, last_used_at)
       VALUES (?, ?, ?, ?, ?, 1, ?)
       ON CONFLICT(key_hash, usage_date) DO UPDATE SET
         prompt_tokens = gemini_key_daily_usage.prompt_tokens + excluded.prompt_tokens,
         output_tokens = gemini_key_daily_usage.output_tokens + excluded.output_tokens,
         total_tokens = gemini_key_daily_usage.total_tokens + excluded.total_tokens,
         requests_count = gemini_key_daily_usage.requests_count + 1,
         last_used_at = excluded.last_used_at`
    )
    .bind(key.keyHash, usageDate, promptTokens, outputTokens, totalTokens, now);

  if (key.source === 'db' && key.id) {
    await db.batch([
      db
        .prepare(
          `UPDATE gemini_api_keys
           SET last_used_at = ?, success_count = success_count + 1, cooldown_until = 0, last_error = NULL
           WHERE id = ?`
        )
        .bind(now, key.id),
      usageStmt,
    ]);
    return;
  }

  await db.batch([
    db
      .prepare(
        `INSERT INTO gemini_key_runtime (key_hash, cooldown_until, last_used_at, success_count, error_count, last_error)
         VALUES (?, 0, ?, 1, 0, NULL)
         ON CONFLICT(key_hash) DO UPDATE SET
           cooldown_until = 0,
           last_used_at = excluded.last_used_at,
           success_count = gemini_key_runtime.success_count + 1,
           last_error = NULL`
      )
      .bind(key.keyHash, now),
    usageStmt,
  ]);
}

export async function recordGeminiKeyCooldown(params: {
  db: D1Database;
  key: PooledGeminiKey;
  cooldownMs: number;
  errorMessage: string;
  now?: number;
}): Promise<void> {
  const { db, key, cooldownMs, errorMessage } = params;
  const now = params.now ?? Date.now();
  const cooldownUntil = cooldownMs > 0 ? now + cooldownMs : 0;
  const safeErr = errorMessage.slice(0, 180);

  key.cooldownUntil = cooldownUntil;

  if (key.source === 'db' && key.id) {
    await db
      .prepare(
        `UPDATE gemini_api_keys
         SET cooldown_until = ?, last_used_at = ?, error_count = error_count + 1, last_error = ?
         WHERE id = ?`
      )
      .bind(cooldownUntil, now, safeErr, key.id)
      .run();
    return;
  }

  await db
    .prepare(
      `INSERT INTO gemini_key_runtime (key_hash, cooldown_until, last_used_at, success_count, error_count, last_error)
       VALUES (?, ?, ?, 0, 1, ?)
       ON CONFLICT(key_hash) DO UPDATE SET
         cooldown_until = excluded.cooldown_until,
         last_used_at = excluded.last_used_at,
         error_count = gemini_key_runtime.error_count + 1,
         last_error = excluded.last_error`
    )
    .bind(key.keyHash, cooldownUntil, now, safeErr)
    .run();
}

export async function getPublicQuotaSnapshot(params: {
  env: Env;
  preferredKeyHash?: string | null;
  now?: number;
}): Promise<PublicKeyQuotaSnapshot> {
  const { env, preferredKeyHash } = params;
  const now = params.now ?? Date.now();
  const today = getTodayUtcDateStr(now);

  const [settings, pool, dailyRes] = await Promise.all([
    getExtractSettings(env),
    loadActiveGeminiKeyPool(env),
    env.DB
      .prepare('SELECT * FROM gemini_key_daily_usage WHERE usage_date = ?')
      .bind(today)
      .all<GeminiKeyDailyUsageRow>(),
  ]);

  const budget = settings.daily_token_budget || GEMINI_MODEL_CONFIG.defaultDailyTokenBudget;
  if (pool.length === 0) {
    return {
      totalKeys: 0,
      keysUsedToday: 0,
      exhaustedKeysCount: 0,
      activeKeyNumber: 0,
      activeKeyStatus: 'none',
      dailyTokenBudget: budget,
      tokensUsedToday: 0,
      tokensRemaining: 0,
      remainingPct: 0,
      requestsToday: 0,
    };
  }

  const usageByHash = new Map<string, GeminiKeyDailyUsageRow>();
  for (const row of dailyRes.results ?? []) {
    usageByHash.set(row.key_hash, row);
  }

  let keysUsedToday = 0;
  let exhaustedKeysCount = 0;

  for (const k of pool) {
    const u = usageByHash.get(k.keyHash);
    const usedTokens = u?.total_tokens ?? 0;
    const reqs = u?.requests_count ?? 0;
    const inCooldown = k.cooldownUntil > now;
    if (reqs > 0 || inCooldown) {
      keysUsedToday += 1;
    }
    if (inCooldown || usedTokens >= budget) {
      exhaustedKeysCount += 1;
    }
  }

  // Pick which single key to report right now:
  // 1) If preferredKeyHash (just executed) exists, report that key.
  // 2) Otherwise report the next ready key at cursor (or most recently used if all in cooldown).
  let selectedIdx = -1;
  if (preferredKeyHash) {
    selectedIdx = pool.findIndex((k) => k.keyHash === preferredKeyHash);
  }
  if (selectedIdx === -1) {
    const cursor = Math.max(0, settings.key_rr_cursor ?? 0);
    for (let offset = 0; offset < pool.length; offset++) {
      const idx = (cursor + offset) % pool.length;
      if (pool[idx].cooldownUntil <= now) {
        selectedIdx = idx;
        break;
      }
    }
    if (selectedIdx === -1) {
      selectedIdx = cursor % pool.length;
    }
  }

  const activeKey = pool[selectedIdx];
  const activeUsage = usageByHash.get(activeKey.keyHash);
  const tokensUsedToday = activeUsage?.total_tokens ?? 0;
  const requestsToday = activeUsage?.requests_count ?? 0;
  const inCooldown = activeKey.cooldownUntil > now;
  const tokensRemaining = inCooldown ? 0 : Math.max(0, budget - tokensUsedToday);
  const remainingPct = inCooldown
    ? 0
    : Math.max(0, Math.min(100, Math.round((tokensRemaining / budget) * 100)));

  const activeKeyStatus: PublicKeyQuotaSnapshot['activeKeyStatus'] = inCooldown
    ? 'cooldown'
    : tokensRemaining <= 0
    ? 'exhausted'
    : 'ready';

  return {
    totalKeys: pool.length,
    keysUsedToday,
    exhaustedKeysCount,
    activeKeyNumber: selectedIdx + 1,
    activeKeyStatus,
    dailyTokenBudget: budget,
    tokensUsedToday,
    tokensRemaining,
    remainingPct,
    requestsToday,
  };
}

/**
 * Returns masked key metadata ONLY (never exposes raw API keys).
 */
export async function listMaskedKeysForAdmin(env: Env): Promise<{
  keys: MaskedKeySummary[];
  envKeysCount: number;
  totalConfiguredCount: number;
}> {
  const today = getTodayUtcDateStr();
  const [dbRows, dailyRows] = await Promise.all([
    env.DB
      .prepare(
        `SELECT id, label, masked_key, key_hash, enabled, cooldown_until, last_used_at,
                success_count, error_count, last_error, created_at
         FROM gemini_api_keys
         ORDER BY created_at DESC`
      )
      .all<Omit<GeminiApiKeyRow, 'encrypted_key'>>(),
    env.DB
      .prepare('SELECT * FROM gemini_key_daily_usage WHERE usage_date = ?')
      .bind(today)
      .all<GeminiKeyDailyUsageRow>(),
  ]);

  const dailyMap = new Map<string, GeminiKeyDailyUsageRow>();
  for (const u of dailyRows.results ?? []) {
    dailyMap.set(u.key_hash, u);
  }

  const seenHashes = new Set<string>();
  const result: MaskedKeySummary[] = [];

  for (const r of dbRows.results ?? []) {
    seenHashes.add(r.key_hash);
    const usage = dailyMap.get(r.key_hash);
    result.push({
      id: r.id,
      source: 'db',
      label: r.label || 'Managed Key',
      maskedKey: r.masked_key,
      enabled: r.enabled === 1,
      cooldownUntil: r.cooldown_until,
      lastUsedAt: r.last_used_at,
      successCount: r.success_count,
      errorCount: r.error_count,
      lastError: r.last_error,
      createdAt: r.created_at,
      tokensUsedToday: usage?.total_tokens ?? 0,
      requestsToday: usage?.requests_count ?? 0,
    });
  }

  const envKeys = parseEnvGeminiKeys(env);
  let envCount = 0;
  if (envKeys.length > 0) {
    const rtRows = await env.DB.prepare('SELECT * FROM gemini_key_runtime').all<GeminiKeyRuntimeRow>();
    const rtMap = new Map<string, GeminiKeyRuntimeRow>();
    for (const r of rtRows.results ?? []) rtMap.set(r.key_hash, r);

    for (let i = 0; i < envKeys.length; i++) {
      const kHash = await sha256Hex(envKeys[i]);
      if (seenHashes.has(kHash)) continue;
      seenHashes.add(kHash);
      envCount += 1;
      const rt = rtMap.get(kHash);
      const usage = dailyMap.get(kHash);
      result.push({
        id: `env-${i + 1}`,
        source: 'env',
        label: `Environment Secret #${envCount}`,
        maskedKey: maskGeminiApiKey(envKeys[i]),
        enabled: true,
        cooldownUntil: rt?.cooldown_until ?? 0,
        lastUsedAt: rt?.last_used_at ?? 0,
        successCount: rt?.success_count ?? 0,
        errorCount: rt?.error_count ?? 0,
        lastError: rt?.last_error ?? null,
        createdAt: 0,
        tokensUsedToday: usage?.total_tokens ?? 0,
        requestsToday: usage?.requests_count ?? 0,
      });
    }
  }

  return {
    keys: result,
    envKeysCount: envCount,
    totalConfiguredCount: result.filter((k) => k.enabled).length,
  };
}
