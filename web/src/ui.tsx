import type { ReactNode, InputHTMLAttributes, TextareaHTMLAttributes, ButtonHTMLAttributes } from 'react';

export function Logo({ dark = false, size = 'md' }: { dark?: boolean; size?: 'md' | 'lg' }) {
  return (
    <span className={`inline-flex items-center gap-2 ${size === 'lg' ? 'text-3xl' : 'text-xl'}`}>
      <svg viewBox="0 0 32 32" className={size === 'lg' ? 'h-9 w-9' : 'h-7 w-7'} aria-hidden>
        <circle cx="16" cy="16" r="15" fill={dark ? '#FAF6EF' : '#1F4D3A'} />
        <path
          d="M10 9c4 0 13 9 13 13 0 1.5-2.5 4-4 4-.8 0-3-1.5-3-2.5 0-.8 1.5-2 1.5-2.7 0-1-4.3-5.3-5.3-5.3-.7 0-1.9 1.5-2.7 1.5C8.5 17 7 14.8 7 14c0-1.5 1.5-5 3-5z"
          fill={dark ? '#1F4D3A' : '#FAF6EF'}
        />
      </svg>
      <span className={`font-display font-semibold tracking-tight ${dark ? 'text-paper' : 'text-pine'}`}>
        open<span className="text-ring">fon</span>
      </span>
    </span>
  );
}

export function Button({
  variant = 'primary',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'ghost' | 'danger' }) {
  const styles = {
    primary:
      'bg-pine text-paper hover:bg-pine-deep shadow-lift disabled:opacity-50 disabled:cursor-not-allowed',
    ghost: 'bg-transparent text-pine border border-line hover:border-pine/40 hover:bg-paper-2',
    danger: 'bg-ring text-paper hover:brightness-95',
  }[variant];
  return (
    <button
      className={`rounded-full px-5 py-2.5 text-sm font-semibold transition-all active:scale-[0.98] ${styles} ${className}`}
      {...props}
    />
  );
}

export function Field({
  label,
  hint,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-bold uppercase tracking-[0.12em] text-ink-soft">{label}</span>
      <input
        className="w-full rounded-xl border border-line bg-white/70 px-4 py-2.5 text-sm text-ink outline-none transition-colors placeholder:text-ink-soft/50 focus:border-pine focus:bg-white"
        {...props}
      />
      {hint && <span className="mt-1 block text-xs text-ink-soft">{hint}</span>}
    </label>
  );
}

export function TextArea({
  label,
  hint,
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { label: string; hint?: string }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-bold uppercase tracking-[0.12em] text-ink-soft">{label}</span>
      <textarea
        className="w-full rounded-xl border border-line bg-white/70 px-4 py-2.5 text-sm text-ink outline-none transition-colors placeholder:text-ink-soft/50 focus:border-pine focus:bg-white"
        rows={3}
        {...props}
      />
      {hint && <span className="mt-1 block text-xs text-ink-soft">{hint}</span>}
    </label>
  );
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-2xl border border-line bg-white/60 p-6 shadow-lift ${className}`}>{children}</div>;
}

export function SectionTitle({ children, sub }: { children: ReactNode; sub?: string }) {
  return (
    <div className="mb-4">
      <h2 className="font-display text-2xl font-semibold text-pine">{children}</h2>
      {sub && <p className="mt-1 text-sm text-ink-soft">{sub}</p>}
    </div>
  );
}

export function Spinner() {
  return (
    <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-pine/30 border-t-pine align-middle" />
  );
}

export const LANGUAGES: [string, string][] = [
  ['en', 'English'],
  ['de', 'Deutsch'],
  ['fr', 'Français'],
  ['es', 'Español'],
  ['nl', 'Nederlands'],
  ['sv', 'Svenska'],
  ['da', 'Dansk'],
  ['it', 'Italiano'],
  ['fi', 'Suomi'],
  ['ru', 'Русский'],
];

export function fmtDuration(s: number | null): string {
  if (s == null) return '—';
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
}

export function fmtTime(iso: string): string {
  const d = new Date(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z');
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
