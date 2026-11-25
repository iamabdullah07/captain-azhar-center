import { useEffect, useState } from 'react';
import { KeyRound, Loader2, Lock, Mail, ShieldAlert } from 'lucide-react';
import { adminApi, TURNSTILE_SITE_KEY } from '../lib/api';
import { TurnstileBox } from '../components/TurnstileBox';
import { AdminDashboard } from './AdminDashboard';

export function AdminAuthPage() {
  const [checking, setChecking] = useState(true);
  const [authenticatedEmail, setAuthenticatedEmail] = useState<string | null>(null);
  const [initialized, setInitialized] = useState<boolean>(true);
  const [mode, setMode] = useState<'auth' | 'forgot'>('auth');

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [turnstileToken, setTurnstileToken] = useState('');
  const [turnstileReset, setTurnstileReset] = useState(0);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const loadState = async () => {
    setChecking(true);
    try {
      const me = await adminApi.me();
      if (me.authenticated) {
        setAuthenticatedEmail(me.email);
        setChecking(false);
        return;
      }
    } catch {
      // Not logged in
    }

    try {
      const boot = await adminApi.bootstrap();
      setInitialized(boot.initialized);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to reach admin backend.');
    } finally {
      setChecking(false);
    }
  };

  useEffect(() => {
    loadState();
  }, []);

  if (checking) {
    return (
      <div className="min-h-[70vh] flex items-center justify-center">
        <Loader2 className="w-8 h-8 text-[#0A1832] animate-spin" />
      </div>
    );
  }

  if (authenticatedEmail) {
    return (
      <AdminDashboard
        ownerEmail={authenticatedEmail}
        onLoggedOut={() => {
          setAuthenticatedEmail(null);
          setPassword('');
          loadState();
        }}
      />
    );
  }

  const handleAuthSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setInfo(null);

    if (TURNSTILE_SITE_KEY && !turnstileToken) {
      setError('Please complete the Turnstile verification check.');
      return;
    }

    if (!initialized) {
      if (password.length < 14) {
        setError('Owner password must be at least 14 characters (a passphrase is recommended).');
        return;
      }
      if (password !== confirmPassword) {
        setError('Passwords do not match.');
        return;
      }
    }

    setSubmitting(true);
    try {
      if (!initialized) {
        const res = await adminApi.signup(email, password, turnstileToken);
        setAuthenticatedEmail(res.email);
      } else {
        const res = await adminApi.login(email, password, turnstileToken);
        setAuthenticatedEmail(res.email);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Authentication failed.');
      setTurnstileReset((n) => n + 1);
    } finally {
      setSubmitting(false);
    }
  };

  const handleForgotSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setInfo(null);

    if (TURNSTILE_SITE_KEY && !turnstileToken) {
      setError('Please complete the Turnstile verification check.');
      return;
    }

    setSubmitting(true);
    try {
      const res = await adminApi.forgot(email, turnstileToken);
      setInfo(res.message);
      setTurnstileReset((n) => n + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to request reset link.');
      setTurnstileReset((n) => n + 1);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="max-w-md mx-auto px-4 py-12">
      <div className="bg-white rounded-2xl border border-slate-200 shadow-[0_14px_40px_-15px_rgba(10,24,50,0.14)] p-7">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-11 h-11 rounded-xl bg-[#0A1832] text-[#D9A441] flex items-center justify-center">
            {mode === 'forgot' ? <Mail className="w-5 h-5" /> : <Lock className="w-5 h-5" />}
          </div>
          <div>
            <h1 className="text-xl font-extrabold text-[#0A1832]">
              {mode === 'forgot'
                ? 'Reset Owner Password'
                : initialized
                ? 'Owner Admin Sign In'
                : 'One-Time Owner Setup'}
            </h1>
            <p className="text-xs text-slate-500">Captain Azhar Center — Private Control Panel</p>
          </div>
        </div>

        {!initialized && mode === 'auth' && (
          <div className="mb-4 bg-amber-50 border border-amber-200 rounded-xl p-3 text-xs text-amber-900 flex items-start gap-2">
            <ShieldAlert className="w-4 h-4 text-[#D9A441] shrink-0 mt-0.5" />
            <span>
              First-time setup: enter the designated owner email and choose a strong password (minimum
              14 characters). Sign-up locks permanently after this account is created.
            </span>
          </div>
        )}

        {error && (
          <div className="mb-4 bg-rose-50 border border-rose-200 text-rose-700 rounded-xl p-3 text-xs font-medium">
            {error}
          </div>
        )}

        {info && (
          <div className="mb-4 bg-emerald-50 border border-emerald-200 text-emerald-800 rounded-xl p-3 text-xs font-medium">
            {info}
          </div>
        )}

        {mode === 'auth' ? (
          <form onSubmit={handleAuthSubmit} className="space-y-4">
            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-1.5">Owner Email</label>
              <input
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="owner@example.com"
                className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 text-sm focus:border-[#0A1832] outline-none"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-1.5">
                Password {!initialized && '(min 14 characters)'}
              </label>
              <input
                type="password"
                required
                minLength={initialized ? 1 : 14}
                autoComplete={initialized ? 'current-password' : 'new-password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 text-sm focus:border-[#0A1832] outline-none"
              />
            </div>

            {!initialized && (
              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1.5">
                  Confirm Password
                </label>
                <input
                  type="password"
                  required
                  minLength={14}
                  autoComplete="new-password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 text-sm focus:border-[#0A1832] outline-none"
                />
              </div>
            )}

            <TurnstileBox onToken={setTurnstileToken} resetTrigger={turnstileReset} />

            <button
              type="submit"
              disabled={submitting}
              className="w-full py-3 px-4 rounded-xl bg-[#0A1832] hover:bg-[#13294B] text-white font-bold text-sm transition cursor-pointer disabled:opacity-60"
            >
              {submitting
                ? 'Verifying...'
                : initialized
                ? 'Sign In to Dashboard'
                : 'Create Owner Account'}
            </button>

            {initialized && (
              <div className="text-center pt-1">
                <button
                  type="button"
                  onClick={() => {
                    setError(null);
                    setInfo(null);
                    setMode('forgot');
                    setTurnstileReset((n) => n + 1);
                  }}
                  className="text-xs font-semibold text-slate-500 hover:text-[#0A1832] cursor-pointer"
                >
                  Forgot password?
                </button>
              </div>
            )}
          </form>
        ) : (
          <form onSubmit={handleForgotSubmit} className="space-y-4">
            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-1.5">Owner Email</label>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="owner@example.com"
                className="w-full px-3.5 py-2.5 rounded-xl border border-slate-300 text-sm focus:border-[#0A1832] outline-none"
              />
            </div>

            <TurnstileBox onToken={setTurnstileToken} resetTrigger={turnstileReset} />

            <button
              type="submit"
              disabled={submitting}
              className="w-full py-3 px-4 rounded-xl bg-[#0A1832] hover:bg-[#13294B] text-white font-bold text-sm flex items-center justify-center gap-2 transition cursor-pointer disabled:opacity-60"
            >
              <KeyRound className="w-4 h-4 text-[#D9A441]" />
              {submitting ? 'Sending...' : 'Send One-Time Reset Link'}
            </button>

            <div className="text-center pt-1">
              <button
                type="button"
                onClick={() => {
                  setError(null);
                  setInfo(null);
                  setMode('auth');
                  setTurnstileReset((n) => n + 1);
                }}
                className="text-xs font-semibold text-slate-500 hover:text-[#0A1832] cursor-pointer"
              >
                Back to Sign In
              </button>
            </div>
          </form>
        )}
      </div>
    </main>
  );
}
