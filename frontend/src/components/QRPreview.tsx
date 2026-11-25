import { useEffect, useState, type CSSProperties } from 'react';
import {
  AlertCircle,
  Check,
  CheckCircle2,
  Copy,
  Download,
  ExternalLink,
  Loader2,
  QrCode,
  Trash2,
} from 'lucide-react';
import { downloadQrAsPdf, type GeneratedQrAssets } from '../lib/qrEngine';
import type { CreatedQrRecord } from '../lib/api';

interface QRPreviewProps {
  loading: boolean;
  progress: number;
  error: string | null;
  assets: GeneratedQrAssets | null;
  record: CreatedQrRecord | null;
  onDeleteCurrent: () => Promise<void>;
  deleting: boolean;
  deletedMessage: string | null;
}

const CHECKERBOARD_STYLE: CSSProperties = {
  backgroundImage:
    'linear-gradient(45deg, #e2e8f0 25%, transparent 25%), linear-gradient(-45deg, #e2e8f0 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #e2e8f0 75%), linear-gradient(-45deg, transparent 75%, #e2e8f0 75%)',
  backgroundSize: '16px 16px',
  backgroundPosition: '0 0, 0 8px, 8px -8px, -8px 0',
  backgroundColor: '#ffffff',
};

function triggerDownload(url: string, filename: string) {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export function QRPreview({
  loading,
  progress,
  error,
  assets,
  record,
  onDeleteCurrent,
  deleting,
  deletedMessage,
}: QRPreviewProps) {
  const [copiedLink, setCopiedLink] = useState(false);
  const [copiedToken, setCopiedToken] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [previewMode, setPreviewMode] = useState<'normal' | 'transparent'>('normal');

  useEffect(() => {
    setPreviewMode('normal');
    setConfirmDelete(false);
    setCopiedLink(false);
    setCopiedToken(false);
  }, [record?.id]);

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
      // Clipboard fallback ignored
    }
  };

  const handleDownloadSvg = () => {
    if (!assets || !record) return;
    const blob = new Blob([assets.svgString], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    triggerDownload(url, `captain-azhar-qr-${record.id}-${assets.sizePx}px.svg`);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const isTransparentPreview = Boolean(assets && previewMode === 'transparent');

  return (
    <div className="bg-white rounded-2xl border border-slate-200/80 shadow-[0_12px_35px_-12px_rgba(10,24,50,0.08)] p-6">
      <div className="flex items-center justify-between gap-2 mb-4">
        <div className="flex items-center gap-2.5">
          <span className="w-7 h-7 rounded-full bg-[#0A1832] text-white text-xs font-bold flex items-center justify-center">
            3
          </span>
          <h2 className="text-lg font-bold text-[#0A1832]">Your QR Code</h2>
        </div>

        {assets?.verified && (
          <span className="inline-flex items-center gap-1 text-[11px] font-semibold px-2.5 py-1 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200">
            <CheckCircle2 className="w-3.5 h-3.5" />
            Scan-Verified
          </span>
        )}
      </div>

      {/* Preview mode toggle when QR is generated */}
      {assets && !loading && !error && (
        <div className="grid grid-cols-2 gap-1 bg-slate-100 p-1 rounded-xl mb-3 text-xs font-bold">
          <button
            type="button"
            onClick={() => setPreviewMode('normal')}
            className={`py-1.5 rounded-lg transition cursor-pointer ${
              previewMode === 'normal'
                ? 'bg-white text-[#0A1832] shadow-xs'
                : 'text-slate-500 hover:text-[#0A1832]'
            }`}
          >
            Standard Preview
          </button>
          <button
            type="button"
            onClick={() => setPreviewMode('transparent')}
            className={`py-1.5 rounded-lg transition cursor-pointer ${
              previewMode === 'transparent'
                ? 'bg-white text-[#0A1832] shadow-xs'
                : 'text-slate-500 hover:text-[#0A1832]'
            }`}
          >
            Transparent Preview
          </button>
        </div>
      )}

      {/* Warm gold-framed preview box matching reference screenshot */}
      <div className="bg-amber-50/40 border-2 border-amber-100 rounded-2xl p-4">
        <div
          style={isTransparentPreview ? CHECKERBOARD_STYLE : undefined}
          className={`${
            isTransparentPreview ? '' : 'bg-white'
          } rounded-xl border border-slate-100 aspect-square w-full flex flex-col items-center justify-center p-4 overflow-hidden`}
        >
          {loading ? (
            <div className="flex flex-col items-center text-center gap-3">
              <Loader2 className="w-9 h-9 text-[#D9A441] animate-spin" />
              <div className="text-sm font-semibold text-[#0A1832]">
                {progress > 0 && progress < 100
                  ? `Uploading... ${progress}%`
                  : 'Generating & verifying QR...'}
              </div>
              <p className="text-xs text-slate-400">Checking scan readability with jsQR</p>
            </div>
          ) : error ? (
            <div className="flex flex-col items-center text-center gap-2 px-3">
              <AlertCircle className="w-9 h-9 text-rose-500" />
              <p className="text-sm font-semibold text-rose-700">Could not generate QR</p>
              <p className="text-xs text-rose-600 leading-relaxed">{error}</p>
            </div>
          ) : assets ? (
            <img
              key={`${record?.id ?? 'qr'}-${previewMode}`}
              src={isTransparentPreview ? assets.transparentPngDataUrl : assets.pngDataUrl}
              alt={isTransparentPreview ? 'Transparent QR Code Preview' : 'Generated QR Code'}
              className="w-full h-full object-contain"
              style={{ imageRendering: 'pixelated' }}
            />
          ) : (
            <div className="flex flex-col items-center text-center gap-2.5 px-4">
              <QrCode className="w-11 h-11 text-slate-300" />
              <p className="text-xs sm:text-sm text-slate-400">
                Choose a file or enter a link, then click Generate.
              </p>
            </div>
          )}
        </div>
      </div>

      {assets && record && (
        <div className="mt-4 space-y-3.5">
          {assets.autoAdjusted && (
            <div className="text-xs bg-amber-50 border border-amber-200 text-amber-800 rounded-xl px-3 py-2">
              Scan self-check upgraded settings to Error Correction <strong>{assets.effectiveEcl}</strong>
              {assets.effectiveMargin ? ' with Safe Margin' : ''} for reliable camera scanning.
            </div>
          )}

          {/* Short URL + Copy */}
          <div className="text-[11px] font-medium text-slate-600 bg-amber-50/60 border border-amber-200/80 rounded-xl px-3 py-2 truncate">
            Active QR target:{' '}
            <strong className="text-[#0A1832]">
              {record.originalName || record.targetUrl || record.id}
            </strong>{' '}
            <span className="font-mono text-slate-500">({record.id})</span>
          </div>

          <div className="bg-slate-50 border border-slate-200 rounded-xl p-2.5 flex items-center gap-2">
            <input
              type="text"
              readOnly
              value={record.shortUrl}
              aria-label="Generated short link"
              className="flex-1 bg-transparent text-xs font-mono text-[#0A1832] focus:outline-none truncate px-1"
            />
            <button
              type="button"
              onClick={() => handleCopy(record.shortUrl, 'link')}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-white border border-slate-200 hover:border-[#0A1832] text-xs font-semibold text-[#0A1832] transition cursor-pointer shrink-0"
            >
              {copiedLink ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
              {copiedLink ? 'Copied' : 'Copy'}
            </button>
            <a
              href={record.shortUrl}
              target="_blank"
              rel="noopener noreferrer"
              title="Open short link"
              className="p-1.5 rounded-lg bg-white border border-slate-200 hover:border-[#0A1832] text-slate-600 hover:text-[#0A1832] transition shrink-0"
            >
              <ExternalLink className="w-3.5 h-3.5" />
            </a>
          </div>

          {/* 4 equal-size format buttons in a single row */}
          <div className="space-y-2.5">
            <div className="grid grid-cols-4 gap-2">
              <button
                type="button"
                onClick={() =>
                  triggerDownload(
                    assets.pngDataUrl,
                    `captain-azhar-qr-${record.id}-${assets.sizePx}px.png`
                  )
                }
                title={`Download PNG (${assets.sizePx} × ${assets.sizePx} px)`}
                className="py-2.5 px-2 rounded-xl bg-[#0A1832] hover:bg-[#13294B] border border-[#0A1832] text-white text-xs font-bold flex items-center justify-center gap-1 transition cursor-pointer shadow-xs"
              >
                <Download className="w-3.5 h-3.5 text-[#D9A441] shrink-0" />
                <span>PNG</span>
              </button>
              <button
                type="button"
                onClick={handleDownloadSvg}
                title="Download Vector SVG"
                className="py-2.5 px-2 rounded-xl border border-slate-200 hover:border-[#0A1832] bg-white text-xs font-bold text-[#0A1832] flex items-center justify-center gap-1 transition cursor-pointer"
              >
                <Download className="w-3.5 h-3.5 text-slate-500 shrink-0" />
                <span>SVG</span>
              </button>
              <button
                type="button"
                onClick={() =>
                  triggerDownload(
                    assets.jpgDataUrl,
                    `captain-azhar-qr-${record.id}-${assets.sizePx}px.jpg`
                  )
                }
                title={`Download JPG (${assets.sizePx} × ${assets.sizePx} px)`}
                className="py-2.5 px-2 rounded-xl border border-slate-200 hover:border-[#0A1832] bg-white text-xs font-bold text-[#0A1832] flex items-center justify-center gap-1 transition cursor-pointer"
              >
                <Download className="w-3.5 h-3.5 text-slate-500 shrink-0" />
                <span>JPG</span>
              </button>
              <button
                type="button"
                onClick={() => downloadQrAsPdf(assets, `captain-azhar-qr-${record.id}`)}
                title="Download Print PDF"
                className="py-2.5 px-2 rounded-xl border border-slate-200 hover:border-[#0A1832] bg-white text-xs font-bold text-[#0A1832] flex items-center justify-center gap-1 transition cursor-pointer"
              >
                <Download className="w-3.5 h-3.5 text-slate-500 shrink-0" />
                <span>PDF</span>
              </button>
            </div>

            {/* Separate Transparent PNG card with checkerboard thumbnail & light-bg note */}
            <div className="border border-slate-200 rounded-xl p-3 bg-slate-50/70 space-y-2">
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => setPreviewMode('transparent')}
                  title="Preview Transparent QR on checkerboard"
                  style={CHECKERBOARD_STYLE}
                  className="w-11 h-11 rounded-lg border border-slate-300 p-1 shrink-0 overflow-hidden cursor-pointer hover:border-[#0A1832] transition"
                >
                  <img
                    key={`thumb-${record.id}`}
                    src={assets.transparentPngDataUrl}
                    alt="Transparent QR checkerboard thumbnail"
                    className="w-full h-full object-contain"
                    style={{ imageRendering: 'pixelated' }}
                  />
                </button>
                <button
                  type="button"
                  onClick={() =>
                    triggerDownload(
                      assets.transparentPngDataUrl,
                      `captain-azhar-qr-transparent-${record.id}-${assets.sizePx}px.png`
                    )
                  }
                  className="flex-1 py-2.5 px-3 rounded-xl border border-[#0A1832]/30 hover:border-[#0A1832] bg-white text-xs font-bold text-[#0A1832] flex items-center justify-center gap-1.5 transition cursor-pointer"
                >
                  <Download className="w-3.5 h-3.5 text-[#D9A441]" />
                  <span>Transparent PNG</span>
                </button>
              </div>
              <p className="text-[11px] text-slate-500 leading-snug">
                No background or white margin — place directly on designs. Scans reliably on{' '}
                <strong className="text-[#0A1832]">light backgrounds only</strong>.
              </p>
            </div>
          </div>

          {/* Uploader Self-Delete Token & Action */}
          {deletedMessage ? (
            <div className="text-xs bg-emerald-50 border border-emerald-200 text-emerald-800 rounded-xl p-3">
              {deletedMessage}
            </div>
          ) : (
            <div className="border border-slate-200 rounded-xl p-3 bg-slate-50/70 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] font-semibold text-slate-600">
                  Save Delete Token (to remove later):
                </span>
                <button
                  type="button"
                  onClick={() => handleCopy(record.deleteToken, 'token')}
                  className="text-[11px] font-semibold text-[#0A1832] hover:text-[#D9A441] inline-flex items-center gap-1 cursor-pointer"
                >
                  {copiedToken ? <Check className="w-3 h-3 text-emerald-600" /> : <Copy className="w-3 h-3" />}
                  {copiedToken ? 'Token Copied' : 'Copy Token'}
                </button>
              </div>
              <div className="text-[11px] font-mono text-slate-500 truncate bg-white px-2 py-1 rounded border border-slate-200">
                {record.deleteToken}
              </div>

              {!confirmDelete ? (
                <button
                  type="button"
                  onClick={() => setConfirmDelete(true)}
                  className="w-full py-1.5 px-3 rounded-lg border border-rose-200 text-rose-700 hover:bg-rose-50 text-xs font-semibold flex items-center justify-center gap-1.5 transition cursor-pointer"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  Delete This Uploaded Item
                </button>
              ) : (
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={deleting}
                    onClick={async () => {
                      await onDeleteCurrent();
                      setConfirmDelete(false);
                    }}
                    className="flex-1 py-1.5 px-3 rounded-lg bg-rose-600 hover:bg-rose-700 text-white text-xs font-bold transition cursor-pointer disabled:opacity-60"
                  >
                    {deleting ? 'Deleting...' : 'Confirm Delete'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmDelete(false)}
                    className="py-1.5 px-3 rounded-lg border border-slate-200 bg-white text-xs font-semibold text-slate-600 cursor-pointer"
                  >
                    Cancel
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Bottom notice matching reference screenshot */}
      <div className="mt-4 bg-slate-50 border border-slate-200/80 rounded-xl p-3.5 text-xs text-slate-600 leading-relaxed">
        <strong className="text-[#92400E]">Before printing:</strong> scan the code once with your phone
        to confirm it opens properly before printing.
      </div>
    </div>
  );
}
