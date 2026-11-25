import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  FileText,
  Film,
  Image as ImageIcon,
  Info,
  Link2,
  QrCode,
  Upload,
  X,
} from 'lucide-react';
import { FeatureCards } from '../components/FeatureCards';
import { QRPreview } from '../components/QRPreview';
import { TurnstileBox } from '../components/TurnstileBox';
import {
  createShortLink,
  deleteUploadedItem,
  TURNSTILE_SITE_KEY,
  uploadFileWithProgress,
  warmupApiConnection,
  type CreatedQrRecord,
} from '../lib/api';
import {
  formatBytes,
  UPLOAD_RULES,
  validateSelectedFile,
  validateUrlInput,
  type InputTab,
} from '../lib/fileCheck';
import {
  evaluateQrContrast,
  generateVerifiedQr,
  QR_ECL_OPTIONS,
  QR_SIZE_OPTIONS,
  type GeneratedQrAssets,
  type QrErrorCorrection,
  type QrSizeOption,
} from '../lib/qrEngine';

const TABS: Array<{ id: InputTab; label: string; icon: typeof Link2 }> = [
  { id: 'link', label: 'Link', icon: Link2 },
  { id: 'image', label: 'Image', icon: ImageIcon },
  { id: 'document', label: 'Document', icon: FileText },
  { id: 'video', label: 'Video', icon: Film },
];

const RECENT_STORAGE_KEY = 'cac_recent_uploads';

function saveRecentRecord(record: CreatedQrRecord) {
  try {
    const raw = localStorage.getItem(RECENT_STORAGE_KEY);
    const list: CreatedQrRecord[] = raw ? JSON.parse(raw) : [];
    const updated = [record, ...list.filter((r) => r.id !== record.id)].slice(0, 5);
    localStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify(updated));
  } catch {
    // ignore storage errors
  }
}

export function HomePage() {
  const [activeTab, setActiveTab] = useState<InputTab>('link');
  const [urlInput, setUrlInput] = useState('');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [dragActive, setDragActive] = useState(false);

  const [sizePx, setSizePx] = useState<QrSizeOption>(300);
  const [ecl, setEcl] = useState<QrErrorCorrection>('M');
  const [fgColor, setFgColor] = useState('#0A1832');
  const [bgColor, setBgColor] = useState('#FFFFFF');
  const [safeMargin, setSafeMargin] = useState(true);

  const [turnstileToken, setTurnstileToken] = useState('');
  const [turnstileResetKey, setTurnstileResetKey] = useState(0);

  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [assets, setAssets] = useState<GeneratedQrAssets | null>(null);
  const [record, setRecord] = useState<CreatedQrRecord | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deletedMessage, setDeletedMessage] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const contrast = useMemo(() => evaluateQrContrast(fgColor, bgColor), [fgColor, bgColor]);

  // Warm API connection on mount so HTTP/2 fallback settles before user uploads
  useEffect(() => {
    warmupApiConnection();
  }, []);

  // Live re-render of QR preview & download presets when customization changes for an active generated record
  useEffect(() => {
    if (!record || deletedMessage || contrast.isBlocked) return;
    try {
      const updated = generateVerifiedQr({
        shortUrl: record.shortUrl,
        sizePx,
        errorCorrection: ecl,
        fgColor,
        bgColor,
        safeMargin,
      });
      setAssets(updated);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to update QR preview.');
    }
  }, [record, deletedMessage, contrast.isBlocked, sizePx, ecl, fgColor, bgColor, safeMargin]);

  const handleTabChange = (tab: InputTab) => {
    setActiveTab(tab);
    setSelectedFile(null);
    setRecord(null);
    setAssets(null);
    setDeletedMessage(null);
    setError(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handleFilePicked = (file: File | undefined) => {
    if (!file || activeTab === 'link') return;
    setRecord(null);
    setAssets(null);
    setDeletedMessage(null);
    const check = validateSelectedFile(file, activeTab);
    if (!check.ok) {
      setSelectedFile(null);
      setError(check.error);
      return;
    }
    setError(null);
    setSelectedFile(file);
  };

  const canSubmit = useMemo(() => {
    if (loading || contrast.isBlocked) return false;
    if (TURNSTILE_SITE_KEY && !turnstileToken) return false;
    if (activeTab === 'link') return urlInput.trim().length > 0;
    return selectedFile !== null;
  }, [loading, contrast.isBlocked, turnstileToken, activeTab, urlInput, selectedFile]);

  const handleGenerate = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setDeletedMessage(null);

    if (contrast.isBlocked) {
      setError(contrast.message);
      return;
    }

    if (TURNSTILE_SITE_KEY && !turnstileToken) {
      setError('Please complete the security verification check.');
      return;
    }

    let validUrl = '';
    if (activeTab === 'link') {
      const check = validateUrlInput(urlInput);
      if (!check.ok) {
        setError(check.error);
        return;
      }
      validUrl = check.url;
    } else if (!selectedFile) {
      setError(`Please select a ${UPLOAD_RULES[activeTab].label.toLowerCase()} file first.`);
      return;
    } else {
      const check = validateSelectedFile(selectedFile, activeTab);
      if (!check.ok) {
        setError(check.error);
        return;
      }
    }

    setRecord(null);
    setAssets(null);
    setLoading(true);
    setProgress(0);

    try {
      const created =
        activeTab === 'link'
          ? await createShortLink(validUrl, turnstileToken)
          : await uploadFileWithProgress({
              file: selectedFile!,
              category: activeTab,
              turnstileToken,
              onProgress: setProgress,
            });

      const qr = generateVerifiedQr({
        shortUrl: created.shortUrl,
        sizePx,
        errorCorrection: ecl,
        fgColor,
        bgColor,
        safeMargin,
      });

      setRecord(created);
      setAssets(qr);
      saveRecentRecord(created);
      setTurnstileResetKey((k) => k + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong while generating your QR.');
      setTurnstileResetKey((k) => k + 1);
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteCurrent = async () => {
    if (!record) return;
    setDeleting(true);
    try {
      await deleteUploadedItem(record.id, record.deleteToken);
      setDeletedMessage('Item deleted permanently. Scanning this QR will no longer open the content.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed.');
    } finally {
      setDeleting(false);
    }
  };

  const step1Heading =
    activeTab === 'link'
      ? 'Paste Your Link'
      : `Upload Your ${UPLOAD_RULES[activeTab].label}`;

  return (
    <main className="pb-6">
      {/* Hero section matching reference screenshot */}
      <section className="max-w-4xl mx-auto px-4 sm:px-6 pt-10 pb-8 text-center">
        <p className="text-[11px] sm:text-xs font-extrabold tracking-[0.18em] uppercase text-[#D9A441] mb-3">
          PROFESSIONAL QR SOLUTION
        </p>
        <h1 className="text-3xl sm:text-5xl font-extrabold tracking-tight text-[#0A1832] leading-[1.15]">
          Turn any file or link into a{' '}
          <span className="text-[#D9A441]">scannable QR code</span>
        </h1>
        <p className="mt-4 text-sm sm:text-base text-slate-600 max-w-2xl mx-auto leading-relaxed">
          Upload an image, document, or video — or paste any link — and download a print-ready QR code
          with no sign-up required.
        </p>

        {/* Four subtle trust bullets */}
        <div className="mt-6 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-xs font-medium text-slate-600">
          <span className="inline-flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-[#D9A441]" />
            Instant QR Generation
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-[#D9A441]" />
            Fast Short Links
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-[#D9A441]" />
            Print-Ready Quality
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-[#D9A441]" />
            Works on Every Phone
          </span>
        </div>
      </section>

      {/* Main 2-column workspace */}
      <section className="max-w-5xl mx-auto px-4 sm:px-6">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          {/* Left column: Upload & Customize */}
          <form
            onSubmit={handleGenerate}
            className="lg:col-span-7 bg-white rounded-2xl border border-slate-200/80 shadow-[0_12px_35px_-12px_rgba(10,24,50,0.08)] p-6 space-y-6"
          >
            {/* 4 Input Tabs */}
            <div className="grid grid-cols-4 gap-1.5 bg-slate-100 p-1 rounded-xl">
              {TABS.map(({ id, label, icon: Icon }) => {
                const active = activeTab === id;
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => handleTabChange(id)}
                    className={`flex items-center justify-center gap-1.5 py-2 px-2 rounded-lg text-xs sm:text-sm font-bold transition cursor-pointer ${
                      active
                        ? 'bg-[#0A1832] text-[#D9A441] shadow-sm'
                        : 'text-slate-600 hover:text-[#0A1832]'
                    }`}
                  >
                    <Icon className="w-4 h-4 shrink-0" />
                    <span className="truncate">{label}</span>
                  </button>
                );
              })}
            </div>

            {/* Step 1: Upload / URL Input */}
            <div>
              <div className="flex items-center gap-2.5 mb-3">
                <span className="w-7 h-7 rounded-full bg-[#0A1832] text-white text-xs font-bold flex items-center justify-center">
                  1
                </span>
                <h2 className="text-lg font-bold text-[#0A1832]">{step1Heading}</h2>
              </div>

              {activeTab === 'link' ? (
                <div className="space-y-2">
                  <input
                    type="url"
                    value={urlInput}
                    onChange={(e) => {
                      setUrlInput(e.target.value);
                      if (record) {
                        setRecord(null);
                        setAssets(null);
                        setDeletedMessage(null);
                      }
                    }}
                    placeholder="https://example.com/your-page"
                    className="w-full px-4 py-3 rounded-xl border border-slate-300 focus:border-[#0A1832] focus:ring-2 focus:ring-[#D9A441]/30 outline-none text-sm text-[#0A1832]"
                  />
                  <p className="text-xs text-slate-500">
                    Accepts <code className="text-slate-700">https://</code> or{' '}
                    <code className="text-slate-700">http://</code> URLs. No upload required.
                  </p>
                </div>
              ) : (
                <div>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept={UPLOAD_RULES[activeTab].accept}
                    onChange={(e) => {
                      const picked = e.target.files?.[0];
                      e.target.value = '';
                      handleFilePicked(picked);
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
                      handleFilePicked(e.dataTransfer.files?.[0]);
                    }}
                    className={`border-2 border-dashed rounded-xl p-6 text-center transition cursor-pointer ${
                      dragActive
                        ? 'border-[#D9A441] bg-amber-50/40'
                        : 'border-slate-300 hover:border-[#D9A441] bg-slate-50/40'
                    }`}
                  >
                    {selectedFile ? (
                      <div className="flex items-center justify-between gap-3 bg-white border border-slate-200 rounded-xl px-4 py-3 text-left">
                        <div className="min-w-0">
                          <div className="text-sm font-bold text-[#0A1832] truncate">
                            {selectedFile.name}
                          </div>
                          <div className="text-xs text-slate-500">
                            {formatBytes(selectedFile.size)} &middot; Ready to upload
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelectedFile(null);
                            setRecord(null);
                            setAssets(null);
                            setDeletedMessage(null);
                            if (fileInputRef.current) fileInputRef.current.value = '';
                          }}
                          aria-label="Remove selected file"
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
                          Click to choose a {UPLOAD_RULES[activeTab].label.toLowerCase()}
                        </div>
                        <div className="text-xs text-slate-500">
                          or drag &amp; drop here &middot; up to {UPLOAD_RULES[activeTab].maxLabel}
                        </div>
                        <div className="text-[11px] text-slate-400">
                          Allowed:{' '}
                          {UPLOAD_RULES[activeTab].extensions.map((ext) => ext.toUpperCase()).join(', ')}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Honest Storage & Privacy Notice (Part B2) */}
              <div className="mt-3 flex items-start gap-2.5 bg-slate-50 border border-slate-200/80 rounded-xl p-3 text-xs text-slate-600 leading-relaxed">
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
            </div>

            {/* Step 2: Customize */}
            <div>
              <div className="flex items-center gap-2.5 mb-3">
                <span className="w-7 h-7 rounded-full bg-[#0A1832] text-white text-xs font-bold flex items-center justify-center">
                  2
                </span>
                <h2 className="text-lg font-bold text-[#0A1832]">
                  Customize <span className="text-sm font-normal text-slate-400">(optional)</span>
                </h2>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1.5">
                    QR Code Size
                  </label>
                  <select
                    value={sizePx}
                    onChange={(e) => setSizePx(Number(e.target.value) as QrSizeOption)}
                    className="w-full px-3 py-2.5 rounded-xl border border-slate-300 bg-white text-sm text-[#0A1832] focus:border-[#0A1832] outline-none"
                  >
                    {QR_SIZE_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1.5">
                    Error Correction
                  </label>
                  <select
                    value={ecl}
                    onChange={(e) => setEcl(e.target.value as QrErrorCorrection)}
                    className="w-full px-3 py-2.5 rounded-xl border border-slate-300 bg-white text-sm text-[#0A1832] focus:border-[#0A1832] outline-none"
                  >
                    {QR_ECL_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1.5">
                    Foreground Color
                  </label>
                  <div className="flex items-center gap-2 border border-slate-300 rounded-xl px-2.5 py-1.5 bg-white">
                    <input
                      type="color"
                      value={/^#[0-9a-fA-F]{6}$/.test(fgColor) ? fgColor : '#0A1832'}
                      onChange={(e) => setFgColor(e.target.value.toUpperCase())}
                      aria-label="Foreground color picker"
                      className="w-8 h-8 rounded border-0 cursor-pointer bg-transparent"
                    />
                    <input
                      type="text"
                      value={fgColor}
                      onChange={(e) => setFgColor(e.target.value.toUpperCase())}
                      maxLength={7}
                      className="flex-1 text-sm font-mono text-[#0A1832] outline-none"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-1.5">
                    Background Color
                  </label>
                  <div className="flex items-center gap-2 border border-slate-300 rounded-xl px-2.5 py-1.5 bg-white">
                    <input
                      type="color"
                      value={/^#[0-9a-fA-F]{6}$/.test(bgColor) ? bgColor : '#FFFFFF'}
                      onChange={(e) => setBgColor(e.target.value.toUpperCase())}
                      aria-label="Background color picker"
                      className="w-8 h-8 rounded border-0 cursor-pointer bg-transparent"
                    />
                    <input
                      type="text"
                      value={bgColor}
                      onChange={(e) => setBgColor(e.target.value.toUpperCase())}
                      maxLength={7}
                      className="flex-1 text-sm font-mono text-[#0A1832] outline-none"
                    />
                  </div>
                </div>
              </div>

              {/* Contrast Status */}
              <div
                className={`mt-3 text-xs rounded-xl px-3 py-2 border ${
                  contrast.isBlocked
                    ? 'bg-rose-50 border-rose-200 text-rose-700'
                    : contrast.isWarning
                    ? 'bg-amber-50 border-amber-200 text-amber-800'
                    : 'bg-emerald-50/70 border-emerald-200 text-emerald-800'
                }`}
              >
                {contrast.message}
              </div>

              {/* Safe White Margin checkbox */}
              <label className="mt-3.5 flex items-center gap-2.5 text-xs sm:text-sm text-slate-600 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={safeMargin}
                  onChange={(e) => setSafeMargin(e.target.checked)}
                  className="w-4 h-4 accent-[#D9A441] rounded"
                />
                <span>Add a safe white margin (recommended for printing &amp; scanning)</span>
              </label>

              {!safeMargin && (
                <div className="mt-2 flex items-center gap-2 text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2">
                  <AlertTriangle className="w-4 h-4 shrink-0 text-[#D9A441]" />
                  <span>
                    Disabling the quiet zone can make some phone cameras struggle to detect the QR code.
                  </span>
                </div>
              )}
            </div>

            {/* Turnstile Captcha */}
            <TurnstileBox onToken={setTurnstileToken} resetTrigger={turnstileResetKey} />

            {/* Upload Progress Bar */}
            {loading && activeTab !== 'link' && (
              <div className="space-y-1.5">
                <div className="flex justify-between text-xs font-semibold text-[#0A1832]">
                  <span>Uploading file...</span>
                  <span>{progress}%</span>
                </div>
                <div className="h-2.5 w-full bg-slate-100 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-[#D9A441] transition-all duration-150"
                    style={{ width: `${progress}%` }}
                  />
                </div>
              </div>
            )}

            {/* Generate CTA */}
            <button
              type="submit"
              disabled={!canSubmit}
              className={`w-full py-3.5 px-5 rounded-xl font-bold text-sm flex items-center justify-center gap-2 transition ${
                canSubmit
                  ? 'bg-[#0A1832] hover:bg-[#13294B] text-white cursor-pointer shadow-sm'
                  : 'bg-slate-400 text-white cursor-not-allowed opacity-85'
              }`}
            >
              <QrCode className="w-4 h-4 text-[#D9A441]" />
              {loading ? 'Generating QR Code...' : 'Generate QR Code'}
            </button>
          </form>

          {/* Right column: QR Preview */}
          <div className="lg:col-span-5">
            <QRPreview
              loading={loading}
              progress={progress}
              error={error}
              assets={assets}
              record={record}
              onDeleteCurrent={handleDeleteCurrent}
              deleting={deleting}
              deletedMessage={deletedMessage}
            />
          </div>
        </div>
      </section>

      <FeatureCards />
    </main>
  );
}
