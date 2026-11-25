import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, CheckCircle2, Flag } from 'lucide-react';
import { submitAbuseReport } from '../lib/api';

export function ReportPage() {
  const [idOrUrl, setIdOrUrl] = useState('');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    setSubmitting(true);
    try {
      const msg = await submitAbuseReport(idOrUrl, reason);
      setSuccess(msg);
      setIdOrUrl('');
      setReason('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to send report.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="max-w-xl mx-auto px-4 sm:px-6 py-10">
      <Link
        to="/"
        className="inline-flex items-center gap-1.5 text-sm font-semibold text-slate-600 hover:text-[#0A1832] mb-6"
      >
        <ArrowLeft className="w-4 h-4" />
        Back to QR Generator
      </Link>

      <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm p-6 sm:p-8">
        <div className="flex items-center gap-3 mb-5">
          <div className="w-10 h-10 rounded-xl bg-amber-50 border border-amber-200 flex items-center justify-center text-[#D9A441]">
            <Flag className="w-5 h-5" />
          </div>
          <div>
            <h1 className="text-xl font-extrabold text-[#0A1832]">Report Abuse or Unsafe Link</h1>
            <p className="text-xs text-slate-500">
              Help keep Captain Azhar Center safe by flagging suspicious QR links.
            </p>
          </div>
        </div>

        {success && (
          <div className="mb-4 flex items-center gap-2 bg-emerald-50 border border-emerald-200 text-emerald-800 rounded-xl p-3 text-sm">
            <CheckCircle2 className="w-4 h-4 shrink-0" />
            <span>{success}</span>
          </div>
        )}

        {error && (
          <div className="mb-4 bg-rose-50 border border-rose-200 text-rose-700 rounded-xl p-3 text-sm">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-semibold text-slate-600 mb-1.5">
              Short QR Link or ID
            </label>
            <input
              type="text"
              required
              value={idOrUrl}
              onChange={(e) => setIdOrUrl(e.target.value)}
              placeholder="https://.../f/AbC123xY or AbC123xY"
              className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 text-sm focus:border-[#0A1832] outline-none"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-600 mb-1.5">
              Reason for Reporting
            </label>
            <textarea
              required
              minLength={5}
              maxLength={500}
              rows={4}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Describe the issue (e.g., phishing link, malware, unauthorized content)..."
              className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 text-sm focus:border-[#0A1832] outline-none"
            />
          </div>

          <button
            type="submit"
            disabled={submitting}
            className="w-full py-3 px-4 rounded-xl bg-[#0A1832] hover:bg-[#13294B] text-white font-bold text-sm transition cursor-pointer disabled:opacity-60"
          >
            {submitting ? 'Submitting Report...' : 'Submit Report'}
          </button>
        </form>
      </div>
    </main>
  );
}
