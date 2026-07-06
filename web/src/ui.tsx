import type { ReactNode, InputHTMLAttributes, TextareaHTMLAttributes, ButtonHTMLAttributes } from 'react';

export function Logo({ dark = false, size = 'md' }: { dark?: boolean; size?: 'md' | 'lg' }) {
  return (
    <span className={`inline-flex items-center gap-2 ${size === 'lg' ? 'text-3xl' : 'text-xl'}`}>
      <svg viewBox="0 0 32 32" className={size === 'lg' ? 'h-9 w-9' : 'h-7 w-7'} aria-hidden>
        <circle cx="16" cy="16" r="15" fill={dark ? '#FAF6EF' : '#5849BE'} />
        <path
          d="M10 9c4 0 13 9 13 13 0 1.5-2.5 4-4 4-.8 0-3-1.5-3-2.5 0-.8 1.5-2 1.5-2.7 0-1-4.3-5.3-5.3-5.3-.7 0-1.9 1.5-2.7 1.5C8.5 17 7 14.8 7 14c0-1.5 1.5-5 3-5z"
          fill={dark ? '#1F4D3A' : '#FFFFFF'}
        />
      </svg>
      <span className={`font-display font-semibold tracking-tight ${dark ? 'text-paper' : 'text-ink'}`}>
        open<span className={dark ? 'text-ring' : 'text-iris'}>fon</span>
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
      'border border-iris-deep/80 bg-iris text-white shadow-lift hover:bg-iris-deep disabled:opacity-50 disabled:cursor-not-allowed',
    ghost:
      'border border-line-strong bg-surface text-ink shadow-lift hover:border-iris/40 hover:text-iris disabled:opacity-50 disabled:cursor-not-allowed',
    danger: 'border border-rose/80 bg-rose text-white shadow-lift hover:brightness-95',
  }[variant];
  return (
    <button
      className={`rounded-[10px] px-4 py-2 text-sm font-semibold transition-all active:scale-[0.98] ${styles} ${className}`}
      {...props}
    />
  );
}

export function FieldLabel({ children }: { children: ReactNode }) {
  return (
    <span className="mb-1.5 block font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-soft">
      {children}
    </span>
  );
}

export const inputClass =
  'w-full rounded-[10px] border border-line-strong bg-surface px-3.5 py-2.5 text-sm text-ink shadow-[inset_0_1px_2px_rgb(35_33_54/0.03)] outline-none transition-[border-color,box-shadow] placeholder:text-ink-faint focus:border-iris focus:ring-[3px] focus:ring-iris/15';

export const selectClass = `${'w-full rounded-[10px] border border-line-strong bg-surface py-2.5 pl-3.5 pr-10 text-sm text-ink shadow-[inset_0_1px_2px_rgb(35_33_54/0.03)] outline-none transition-[border-color,box-shadow] focus:border-iris focus:ring-[3px] focus:ring-iris/15'} select-chrome`;

export const inputClassSm =
  'rounded-lg border border-line-strong bg-surface px-3 py-1.5 text-sm text-ink outline-none transition-[border-color,box-shadow] placeholder:text-ink-faint focus:border-iris focus:ring-[3px] focus:ring-iris/15';

export function Field({
  label,
  hint,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string }) {
  return (
    <label className="block">
      <FieldLabel>{label}</FieldLabel>
      <input className={inputClass} {...props} />
      {hint && <span className="mt-1.5 block text-xs leading-relaxed text-ink-soft">{hint}</span>}
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
      <FieldLabel>{label}</FieldLabel>
      <textarea className={inputClass} rows={3} {...props} />
      {hint && <span className="mt-1.5 block text-xs leading-relaxed text-ink-soft">{hint}</span>}
    </label>
  );
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-2xl border border-line bg-surface p-6 shadow-lift ${className}`}>{children}</div>
  );
}

export function SectionTitle({ children, sub }: { children: ReactNode; sub?: string }) {
  return (
    <div className="mb-4">
      <h2 className="font-display text-[22px] font-semibold tracking-tight text-ink">{children}</h2>
      {sub && <p className="mt-1 max-w-xl text-sm leading-relaxed text-ink-soft">{sub}</p>}
    </div>
  );
}

export function Spinner() {
  return (
    <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-iris/25 border-t-iris align-middle" />
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
