import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useSession } from '../App';
import { Button, Field, Logo } from '../ui';

export default function AuthPage() {
  const [mode, setMode] = useState<'login' | 'signup'>('signup');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const { refresh } = useSession();
  const nav = useNavigate();

  async function submit(e: FormEvent) {
    e.preventDefault();
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
    <div className="grain flex min-h-screen flex-col bg-paper md:flex-row">
      {/* brand panel */}
      <div className="relative flex flex-col justify-between overflow-hidden bg-pine-night p-8 text-paper md:w-[44%] md:p-12">
        <div className="rise">
          <Logo dark />
        </div>
        <div className="py-16 md:py-0">
          <h1 className="rise rise-1 font-display text-4xl font-semibold leading-[1.05] tracking-tight md:text-6xl">
            Your phone,
            <br />
            <em className="text-ring not-italic">answered.</em>
            <br />
            Always.
          </h1>
          <p className="rise rise-2 mt-6 max-w-sm text-sm leading-relaxed text-paper/70">
            OpenFon is an open-source AI receptionist for small businesses. It answers calls, takes
            messages, and books appointments — while you do the actual work.
          </p>
        </div>
        <p className="rise rise-3 font-mono text-xs text-paper/40">
          self-hosted · MIT licensed · no per-seat pricing
        </p>
        {/* decorative dial rings */}
        <div className="pointer-events-none absolute -right-32 -top-32 h-96 w-96 rounded-full border border-paper/10" />
        <div className="pointer-events-none absolute -right-20 -top-20 h-72 w-72 rounded-full border border-paper/10" />
        <div className="pointer-events-none absolute -bottom-40 -left-24 h-80 w-80 rounded-full border border-ring/20" />
      </div>

      {/* form panel */}
      <div className="flex flex-1 items-center justify-center p-8">
        <form onSubmit={submit} className="rise rise-2 w-full max-w-sm space-y-4">
          <div>
            <h2 className="font-display text-3xl font-semibold text-pine">
              {mode === 'signup' ? 'Set up your line' : 'Welcome back'}
            </h2>
            <p className="mt-1 text-sm text-ink-soft">
              {mode === 'signup' ? 'Free, on your own infrastructure.' : 'Sign in to your dashboard.'}
            </p>
          </div>
          <Field label="Email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@business.com" />
          <Field
            label="Password"
            type="password"
            required
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="At least 8 characters"
          />
          {error && <p className="rounded-lg bg-ring-soft px-3 py-2 text-sm text-ring">{error}</p>}
          <Button type="submit" disabled={busy} className="w-full">
            {busy ? 'One moment…' : mode === 'signup' ? 'Create account' : 'Sign in'}
          </Button>
          <p className="text-center text-sm text-ink-soft">
            {mode === 'signup' ? 'Already have an account?' : 'New here?'}{' '}
            <button type="button" className="font-semibold text-pine underline" onClick={() => setMode(mode === 'signup' ? 'login' : 'signup')}>
              {mode === 'signup' ? 'Sign in' : 'Create one'}
            </button>
          </p>
        </form>
      </div>
    </div>
  );
}
