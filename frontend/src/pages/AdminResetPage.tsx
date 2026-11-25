import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { CheckCircle2, KeyRound } from 'lucide-react';
import { adminApi } from '../lib/api';

export function AdminResetPage() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') ?? '';

  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [doneMessage, setDoneMessage] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!token) {
      setError('Missing password reset token.');
      return;
    }
    if (newPassword.length < 14) {
      setError('New password must be at least 14 characters.');
      return;
    }
    if (newPassword !== confirm) {
      setError('Passwords do not match.');
      return;
    }

    setSubmitting(true);
    try {
      const res = await adminApi.reset(token, newPassword);
      setDoneMessage(res.message);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Reset failed.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="max-w-md mx-auto px-4 py-12">
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-7">
        <div className="flex items-center gap-3 mb-5">
          <div className="w-10 h-10 rounded-xl bg-[#0A1832] text-[#D9A441] flex items-center justify-center">
            <KeyRound className="w-5 h-5" />
          </div>
          <div>
            <h1 className="text-lg font-extrabold text-[#0A1832]">Set New Owner Password</h1>
            <p className="text-xs text-slate-500">One-time password reset</p>
          </div>
        </div>

        {doneMessage ? (
          <div className="space-y-4">
            <div className="flex items-center gap-2 bg-emerald-50 border border-emerald-200 text-emerald-800 rounded-xl p-3 text-sm">
              <CheckCircle2 className="w-4 h-4 shrink-0" />
              <span>{doneMessage}</span>
            </div>
            <Link
              to="/admin"
              className="block w-full text-center py-2.5 px-4 rounded-xl bg-[#0A1832] text-white font-bold text-sm"
            >
              Go to Admin Sign In
            </Link>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            {error && (
              <div className="bg-rose-50 border border-rose-200 text-rose-700 rounded-xl p-3 text-xs">
                {error}
              </div>
            )}

            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-1.5">
                New Password (minimum 14 characters)
              </label>
              <input
                type="password"
                required
                minLength={14}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 text-sm focus:border-[#0A1832] outline-none"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-1.5">
                Confirm New Password
              </label>
              <input
                type="password"
                required
                minLength={14}
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 text-sm focus:border-[#0A1832] outline-none"
              />
            </div>

            <button
              type="submit"
              disabled={submitting}
              className="w-full py-3 px-4 rounded-xl bg-[#0A1832] hover:bg-[#13294B] text-white font-bold text-sm transition cursor-pointer disabled:opacity-60"
            >
              {submitting ? 'Updating...' : 'Save New Password'}
            </button>
          </form>
        )}
      </div>
    </main>
  );
}
