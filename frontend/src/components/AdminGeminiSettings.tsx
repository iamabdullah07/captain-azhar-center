import { useCallback, useEffect, useState } from 'react';
import {
  Eye,
  EyeOff,
  KeyRound,
  Plus,
  RefreshCw,
  ShieldAlert,
  Sliders,
  Trash2,
} from 'lucide-react';
import { adminApi, type AdminGeminiKeySummary } from '../lib/api';

interface AdminGeminiSettingsProps {
  onNotice: (msg: string | null) => void;
  onError: (msg: string | null) => void;
}

export function AdminGeminiSettings({ onNotice, onError }: AdminGeminiSettingsProps) {
  const [loading, setLoading] = useState(true);
  const [keys, setKeys] = useState<AdminGeminiKeySummary[]>([]);
  const [maxKeysLimit, setMaxKeysLimit] = useState(20);
  const [totalActive, setTotalActive] = useState(0);

  const [newApiKey, setNewApiKey] = useState('');
  const [newLabel, setNewLabel] = useState('');
  const [showKeyInput, setShowKeyInput] = useState(false);
  const [addingKey, setAddingKey] = useState(false);

  const [maxPdfMb, setMaxPdfMb] = useState(50);
  const [concurrency, setConcurrency] = useState(5);
  const [inlineThresholdMb, setInlineThresholdMb] = useState(4);
  const [savingSettings, setSavingSettings] = useState(false);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await adminApi.getExtractSettings();
      setKeys(res.keys);
      setMaxKeysLimit(res.maxKeysLimit);
      setTotalActive(res.totalConfiguredCount);
      setMaxPdfMb(res.maxPdfMb);
      setConcurrency(res.concurrency);
      setInlineThresholdMb(res.inlineThresholdMb);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Failed to load Gemini settings.');
    } finally {
      setLoading(false);
    }
  }, [onError]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const handleAddKey = async (e: React.FormEvent) => {
    e.preventDefault();
    onError(null);
    onNotice(null);
    if (!newApiKey.trim()) return;

    setAddingKey(true);
    try {
      const res = await adminApi.addGeminiKey(newApiKey.trim(), newLabel.trim() || undefined);
      setNewApiKey('');
      setNewLabel('');
      setShowKeyInput(false);
      onNotice(`Added Gemini API key (${res.key.maskedKey}).`);
      await loadData();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Could not add API key.');
    } finally {
      setAddingKey(false);
    }
  };

  const handleToggleEnabled = async (key: AdminGeminiKeySummary) => {
    onError(null);
    onNotice(null);
    try {
      await adminApi.updateGeminiKey(key.id, { enabled: !key.enabled });
      onNotice(`${key.label} ${key.enabled ? 'disabled' : 'enabled'}.`);
      await loadData();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Could not update key.');
    }
  };

  const handleClearCooldown = async (key: AdminGeminiKeySummary) => {
    onError(null);
    onNotice(null);
    try {
      await adminApi.updateGeminiKey(key.id, { clearCooldown: true });
      onNotice(`Cleared cooldown for ${key.label}.`);
      await loadData();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Could not clear cooldown.');
    }
  };

  const handleDeleteKey = async (key: AdminGeminiKeySummary) => {
    onError(null);
    onNotice(null);
    try {
      await adminApi.deleteGeminiKey(key.id);
      onNotice(`Removed ${key.label} (${key.maskedKey}).`);
      await loadData();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Could not delete key.');
    }
  };

  const handleSaveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    onError(null);
    onNotice(null);
    setSavingSettings(true);
    try {
      await adminApi.updateExtractSettings({ maxPdfMb, concurrency, inlineThresholdMb });
      onNotice('AI Extraction limits & concurrency saved.');
      await loadData();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Could not save extraction settings.');
    } finally {
      setSavingSettings(false);
    }
  };

  const now = Date.now();

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
      {/* Left: 1-20 Gemini API Keys Management */}
      <div className="lg:col-span-7 bg-white rounded-2xl border border-slate-200 p-5 space-y-5 shadow-xs">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <KeyRound className="w-4 h-4 text-[#D9A441]" />
            <h3 className="font-bold text-[#0A1832] text-sm sm:text-base">
              Gemini API Keys Rotation Pool
            </h3>
          </div>
          <div className="flex items-center gap-2">
            <span className="px-2.5 py-1 rounded-full bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs font-bold">
              {totalActive} Active &middot; {keys.length}/{maxKeysLimit} Total
            </span>
            <button
              type="button"
              onClick={() => void loadData()}
              disabled={loading}
              title="Refresh keys"
              className="p-1.5 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50 cursor-pointer"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </div>

        <p className="text-xs text-slate-500 leading-relaxed">
          Keys are encrypted at rest with AES-GCM, rotated round-robin across extractions, and
          automatically placed on cooldown on HTTP 429 quota errors. Raw keys are never sent back to
          the browser or printed in logs.
        </p>

        {/* Add Key Form */}
        <form onSubmit={handleAddKey} className="bg-slate-50 border border-slate-200 rounded-xl p-4 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-12 gap-2.5">
            <div className="sm:col-span-7 relative">
              <input
                type={showKeyInput ? 'text' : 'password'}
                value={newApiKey}
                onChange={(e) => setNewApiKey(e.target.value)}
                placeholder="Paste Gemini API key (AIza...)"
                autoComplete="off"
                className="w-full pl-3 pr-9 py-2 rounded-xl border border-slate-300 bg-white text-xs sm:text-sm font-mono text-[#0A1832] outline-none focus:border-[#0A1832]"
              />
              <button
                type="button"
                onClick={() => setShowKeyInput((v) => !v)}
                aria-label={showKeyInput ? 'Hide API key' : 'Show API key'}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700 cursor-pointer"
              >
                {showKeyInput ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
            <div className="sm:col-span-3">
              <input
                type="text"
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
                placeholder="Label (optional)"
                maxLength={40}
                className="w-full px-3 py-2 rounded-xl border border-slate-300 bg-white text-xs sm:text-sm text-[#0A1832] outline-none focus:border-[#0A1832]"
              />
            </div>
            <div className="sm:col-span-2">
              <button
                type="submit"
                disabled={addingKey || !newApiKey.trim() || keys.length >= maxKeysLimit}
                className="w-full py-2 px-3 rounded-xl bg-[#0A1832] hover:bg-[#13294B] text-white text-xs font-bold inline-flex items-center justify-center gap-1 cursor-pointer disabled:opacity-45"
              >
                <Plus className="w-3.5 h-3.5 text-[#D9A441]" />
                <span>Add</span>
              </button>
            </div>
          </div>
        </form>

        {/* Keys List */}
        <div className="space-y-2.5">
          {keys.length === 0 && !loading && (
            <div className="border border-dashed border-slate-200 rounded-xl p-6 text-center text-xs text-slate-400">
              No Gemini API keys configured yet. Add 1 to 20 keys above or configure{' '}
              <code>GEMINI_API_KEYS</code> in Worker secrets.
            </div>
          )}

          {keys.map((k) => {
            const inCooldown = k.cooldownUntil > now;
            const cooldownSec = inCooldown ? Math.ceil((k.cooldownUntil - now) / 1000) : 0;
            return (
              <div
                key={k.id}
                className="border border-slate-200 rounded-xl p-3.5 flex flex-wrap items-center justify-between gap-3"
              >
                <div className="space-y-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs font-bold text-[#0A1832]">{k.label}</span>
                    <span className="font-mono text-xs px-2 py-0.5 rounded bg-slate-100 text-slate-700">
                      {k.maskedKey}
                    </span>
                    <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-slate-100 text-slate-500">
                      {k.source === 'env' ? 'Env Secret' : 'Managed'}
                    </span>
                    {!k.enabled ? (
                      <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-slate-100 text-slate-500">
                        Disabled
                      </span>
                    ) : inCooldown ? (
                      <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-100 text-amber-800">
                        Cooldown ({cooldownSec}s)
                      </span>
                    ) : (
                      <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700">
                        Ready
                      </span>
                    )}
                  </div>
                  <div className="text-[11px] text-slate-400 flex items-center gap-3 flex-wrap">
                    <span>Success: {k.successCount}</span>
                    <span>Errors: {k.errorCount}</span>
                    {k.lastError && (
                      <span className="text-rose-500 inline-flex items-center gap-1 truncate max-w-xs">
                        <ShieldAlert className="w-3 h-3 shrink-0" />
                        {k.lastError}
                      </span>
                    )}
                  </div>
                </div>

                {k.source === 'db' && (
                  <div className="flex items-center gap-1.5">
                    {inCooldown && (
                      <button
                        type="button"
                        onClick={() => void handleClearCooldown(k)}
                        className="px-2.5 py-1 rounded-lg border border-amber-200 bg-amber-50 text-amber-800 text-xs font-semibold hover:bg-amber-100 cursor-pointer"
                      >
                        Reset Cooldown
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => void handleToggleEnabled(k)}
                      className="px-2.5 py-1 rounded-lg border border-slate-200 text-xs font-semibold text-slate-700 hover:bg-slate-50 cursor-pointer"
                    >
                      {k.enabled ? 'Disable' : 'Enable'}
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleDeleteKey(k)}
                      aria-label={`Remove ${k.label}`}
                      className="p-1.5 rounded-lg border border-rose-200 text-rose-600 hover:bg-rose-50 cursor-pointer"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Right: Configurable Limits & Concurrency */}
      <form
        onSubmit={handleSaveSettings}
        className="lg:col-span-5 bg-white rounded-2xl border border-slate-200 p-5 space-y-4 shadow-xs self-start"
      >
        <div className="flex items-center gap-2 font-bold text-[#0A1832] text-sm sm:text-base">
          <Sliders className="w-4 h-4 text-[#D9A441]" />
          <span>Extraction Limits &amp; Concurrency</span>
        </div>

        <div className="space-y-3">
          <div>
            <label className="block text-xs font-semibold text-slate-600 mb-1">
              Max PDF / ZIP Size (MB)
            </label>
            <input
              type="number"
              min={5}
              max={50}
              value={maxPdfMb}
              onChange={(e) => setMaxPdfMb(Number(e.target.value))}
              className="w-full px-3 py-2 rounded-xl border border-slate-300 text-sm text-[#0A1832]"
            />
            <p className="mt-1 text-[11px] text-slate-400">Default 50 MB (allowed range: 5–50 MB).</p>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-600 mb-1">
              Parallel File Concurrency
            </label>
            <input
              type="number"
              min={1}
              max={20}
              value={concurrency}
              onChange={(e) => setConcurrency(Number(e.target.value))}
              className="w-full px-3 py-2 rounded-xl border border-slate-300 text-sm text-[#0A1832]"
            />
            <p className="mt-1 text-[11px] text-slate-400">
              Default 5. Runtime concurrency is automatically capped by the number of active keys.
            </p>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-600 mb-1">
              Inline Base64 Threshold (MB)
            </label>
            <input
              type="number"
              min={1}
              max={15}
              value={inlineThresholdMb}
              onChange={(e) => setInlineThresholdMb(Number(e.target.value))}
              className="w-full px-3 py-2 rounded-xl border border-slate-300 text-sm text-[#0A1832]"
            />
            <p className="mt-1 text-[11px] text-slate-400">
              Files up to this size are sent inline (base64); larger files automatically stream via
              Gemini Files API.
            </p>
          </div>
        </div>

        <button
          type="submit"
          disabled={savingSettings}
          className="w-full py-2.5 px-4 rounded-xl bg-[#0A1832] hover:bg-[#13294B] text-white font-bold text-sm cursor-pointer disabled:opacity-50"
        >
          {savingSettings ? 'Saving...' : 'Save Extraction Settings'}
        </button>
      </form>
    </div>
  );
}
