import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useSession } from '../App';
import { authSubmissionBlocked, SIGN_OUT_PENDING_MESSAGE } from '../session-load';
import { Button, Field, Logo } from '../ui';

export default function AuthPage() {
  const [mode, setMode] = useState<'login' | 'signup'>('signup');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const { refresh, signOut, signOutPending, signOutWarning } = useSession();
  const nav = useNavigate();
  const authLocked = authSubmissionBlocked(signOutPending, Boolean(signOutWarning));

  async function submit(e: FormEvent) {
    e.preventDefault();
    // Native disabled controls stop user input, while this guard also covers a
    // programmatic submission during pending or unconfirmed server sign-out.
    if (authSubmissionBlocked(signOutPending, Boolean(signOutWarning))) return;
    setBusy(true);
    setError('');
    try {
      await (mode === 'signup' ? api.signup(email, password) : api.login(email, password));
      await refresh();
      nav('/');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen flex-col bg-base md:flex-row">
      {/* brand panel */}
      <div className="relative flex flex-col justify-between overflow-hidden bg-midnight p-8 text-white md:w-[44%] md:p-12">
        {/* atmosphere: iris + rose glow on midnight */}
        <div
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              'radial-gradient(640px 480px at 85% 0%, rgb(88 73 190 / 0.35), transparent 70%), radial-gradient(560px 420px at 0% 100%, rgb(180 58 102 / 0.22), transparent 70%)',
          }}
        />
        {/* decorative dial rings */}
        <div className="pointer-events-none absolute -right-32 -top-32 h-96 w-96 rounded-full border border-white/[0.08]" />
        <div className="pointer-events-none absolute -right-20 -top-20 h-72 w-72 rounded-full border border-white/[0.08]" />
        <div className="pointer-events-none absolute -bottom-40 -left-24 h-80 w-80 rounded-full border border-white/[0.07]" />

        <div className="rise relative">
          <span className="inline-flex items-center gap-2 text-xl">
            <svg viewBox="0 0 32 32" className="h-7 w-7" aria-hidden>
              <circle cx="16" cy="16" r="15" fill="#FFFFFF" />
              <path
                d="M10 9c4 0 13 9 13 13 0 1.5-2.5 4-4 4-.8 0-3-1.5-3-2.5 0-.8 1.5-2 1.5-2.7 0-1-4.3-5.3-5.3-5.3-.7 0-1.9 1.5-2.7 1.5C8.5 17 7 14.8 7 14c0-1.5 1.5-5 3-5z"
                fill="#1A1532"
              />
            </svg>
            <span className="font-display font-semibold tracking-tight text-white">
              open<span className="text-[#B5A8F5]">fon</span>
            </span>
          </span>
        </div>
        <div className="relative py-16 md:py-0">
          <h1 className="rise rise-1 font-display text-4xl font-semibold leading-[1.05] tracking-tight md:text-6xl">
            Your phone,
            <br />
            <em className="not-italic text-[#B5A8F5]">answered.</em>
            <br />
            Always.
          </h1>
          <p className="rise rise-2 mt-6 max-w-sm text-sm leading-relaxed text-white/65">
            OpenFon is an open-source AI receptionist for small businesses. It answers calls, takes
            messages, and books appointments — while you do the actual work.
          </p>
        </div>
        <p className="rise rise-3 relative font-mono text-xs text-white/40">
          self-hosted · MIT licensed · no per-seat pricing
        </p>
      </div>

      {/* form panel */}
      <div className="atmosphere flex flex-1 items-center justify-center p-8">
        <form onSubmit={submit} className="rise rise-2 w-full max-w-sm">
          {signOutWarning && (
            <div
              className="mb-4 rounded-[10px] border border-rose/25 bg-wash-rose px-4 py-3 text-sm text-rose"
              role="alert"
            >
              <p>{signOutWarning}</p>
              <button
                type="button"
                className="mt-2 font-semibold underline decoration-rose/30 underline-offset-2 hover:decoration-rose disabled:cursor-not-allowed disabled:opacity-60"
                disabled={signOutPending}
                onClick={() => {
                  void signOut().catch(() => {
                    // The alert remains visible and offers another retry.
                  });
                }}
              >
                {signOutPending ? 'Retrying sign-out…' : 'Retry sign-out'}
              </button>
            </div>
          )}
          {signOutPending && (
            <p
              id="sign-out-pending-status"
              className="mb-4 rounded-[10px] border border-iris/20 bg-wash-iris px-4 py-3 text-sm text-ink-soft"
              role="status"
              aria-live="polite"
            >
              {SIGN_OUT_PENDING_MESSAGE}
            </p>
          )}
          <fieldset
            disabled={authLocked}
            aria-busy={signOutPending}
            aria-describedby={signOutPending ? 'sign-out-pending-status' : undefined}
            className="m-0 min-w-0 border-0 p-0 transition-opacity disabled:cursor-wait disabled:opacity-60"
          >
            <div className="rounded-2xl border border-line bg-surface p-7 shadow-raise sm:p-8">
              <div className="mb-6">
                <h2 className="font-display text-3xl font-semibold tracking-tight text-ink">
                  {mode === 'signup' ? 'Set up your line' : 'Welcome back'}
                </h2>
                <p className="mt-1.5 text-sm text-ink-soft">
                  {mode === 'signup' ? 'Free, on your own infrastructure.' : 'Sign in to your dashboard.'}
                </p>
              </div>
              <div className="space-y-4">
                <Field
                  label="Email"
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@business.com"
                />
                <Field
                  label="Password"
                  type="password"
                  required
                  minLength={8}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="At least 8 characters"
                />
                {error && (
                  <p className="rounded-[10px] border border-rose/20 bg-wash-rose px-3 py-2 text-sm text-rose">
                    {error}
                  </p>
                )}
                <Button type="submit" disabled={busy || authLocked} className="w-full">
                  {busy ? 'One moment…' : mode === 'signup' ? 'Create account' : 'Sign in'}
                </Button>
              </div>
            </div>
          </fieldset>
          <p className="mt-5 text-center text-sm text-ink-soft">
            {mode === 'signup' ? 'Already have an account?' : 'New here?'}{' '}
            <button
              type="button"
              className="font-semibold text-iris underline decoration-iris/30 underline-offset-2 hover:decoration-iris disabled:cursor-wait disabled:opacity-60"
              disabled={authLocked}
              aria-describedby={signOutPending ? 'sign-out-pending-status' : undefined}
              onClick={() => setMode(mode === 'signup' ? 'login' : 'signup')}
            >
              {mode === 'signup' ? 'Sign in' : 'Create one'}
            </button>
          </p>
        </form>
      </div>
    </div>
  );
}
