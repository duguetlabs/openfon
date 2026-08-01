import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type CallRow } from '../api';
import { useSession } from '../App';
import { Card, Spinner, fmtDuration, fmtTime } from '../ui';

const INTENT_BADGE: Record<string, string> = {
  question: 'bg-wash-iris text-ink-soft shadow-[inset_0_0_0_1px_rgb(88_73_190/0.12)]',
  booking: 'bg-wash-iris text-iris shadow-[inset_0_0_0_1px_rgb(88_73_190/0.25)]',
  message: 'bg-wash-rose text-rose shadow-[inset_0_0_0_1px_rgb(180_58_102/0.25)]',
  other: 'bg-wash-iris text-ink-soft shadow-[inset_0_0_0_1px_rgb(88_73_190/0.12)]',
};

// Fallbacks for rows with no summary, one per status the schema can hold.
//
// 'failed' means the socket connected and the session broke mid-call, and
// finalize() always writes a "Call failed: …" summary — so this entry is nearly
// unreachable, and it says "Call failed" rather than "didn't connect" because a
// failed call plainly did connect. That matters now that 'abandoned' exists: it
// is the one that genuinely never reached a Durable Object.
//
// 'active' is the only status that should ever blink.
const STATUS_LABEL: Record<string, string> = {
  active: 'Call in progress…',
  abandoned: 'Never connected',
  failed: 'Call failed',
};

export default function Dashboard() {
  const { business } = useSession();
  const [calls, setCalls] = useState<CallRow[] | null>(null);

  useEffect(() => {
    if (business) void api.calls(business.id).then(setCalls).catch(() => setCalls([]));
  }, [business]);

  if (!business) return null;
  const completed = calls?.filter((c) => c.status === 'completed') ?? [];
  const messages = completed.filter((c) => c.message_json);
  const totalSec = completed.reduce((a, c) => a + (c.duration_s ?? 0), 0);

  return (
    <div>
      <div className="rise mb-8 flex flex-wrap items-end justify-between gap-x-8 gap-y-5">
        <div>
          <p className="font-mono text-[11px] uppercase tracking-[0.22em] text-ink-faint">Switchboard</p>
          <h1 className="mt-1 font-display text-4xl font-semibold tracking-tight text-ink">{business.name}</h1>
          <div className="callline-accent mt-3 w-16" />
        </div>
        <div className="flex w-full divide-x divide-line overflow-hidden rounded-xl border border-line bg-surface shadow-lift sm:w-auto">
          <Stat label="calls" value={String(completed.length)} />
          <Stat label="messages" value={String(messages.length)} accent />
          <Stat label="talk time" value={fmtDuration(totalSec)} />
        </div>
      </div>

      <ShareCard slug={business.slug} />

      <div className="rise rise-2 mt-10">
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="font-display text-[22px] font-semibold tracking-tight text-ink">Call log</h2>
          {calls !== null && calls.length > 0 && (
            <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-ink-faint">
              {calls.length} conversation{calls.length === 1 ? '' : 's'}
            </p>
          )}
        </div>
        {calls === null ? (
          <Spinner />
        ) : calls.length === 0 ? (
          <Card className="bg-gradient-to-b from-surface to-wash-iris/50 py-14 text-center">
            <CallGlyph />
            <p className="mt-4 font-display text-xl text-ink">No calls yet.</p>
            <p className="mx-auto mt-2 max-w-xs text-sm leading-relaxed text-ink-soft">
              Click <strong className="font-semibold text-ink">Test call</strong> in the top bar to ring your own
              agent — every conversation lands here.
            </p>
          </Card>
        ) : (
          <div className="overflow-hidden rounded-2xl border border-line bg-surface shadow-lift">
            {calls.map((c, i) => (
              <Link
                key={c.id}
                to={`/calls/${c.id}`}
                className={`group flex items-center gap-3 px-4 py-4 transition-colors hover:bg-wash-iris/60 sm:gap-4 sm:px-5 ${
                  i > 0 ? 'border-t border-line' : ''
                }`}
              >
                <span
                  className={`h-2 w-2 shrink-0 rounded-full ${
                    c.status === 'active'
                      ? 'blink bg-rose'
                      : c.status === 'failed'
                        ? 'bg-rose/70'
                        : c.status === 'abandoned'
                          ? 'bg-ink-faint/40'
                          : 'bg-ok/70'
                  }`}
                />
                <div className="min-w-0 flex-1">
                  <p
                    className={`truncate text-sm font-semibold ${
                      c.status === 'abandoned' && !c.summary ? 'text-ink-faint' : 'text-ink'
                    }`}
                  >
                    {c.summary ?? STATUS_LABEL[c.status] ?? 'Call'}
                  </p>
                  <p className="mt-1 font-mono text-[11px] text-ink-faint">
                    {fmtTime(c.started_at)} · {fmtDuration(c.duration_s)} · {c.channel}
                  </p>
                </div>
                {c.intent && (
                  <span
                    className={`shrink-0 rounded-full px-2.5 py-0.5 font-mono text-[11px] font-semibold ${
                      INTENT_BADGE[c.intent] ?? INTENT_BADGE.other
                    }`}
                  >
                    {c.intent}
                  </span>
                )}
                <span className="hidden text-ink-faint transition-all group-hover:translate-x-0.5 group-hover:text-iris sm:inline">
                  →
                </span>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, accent = false }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="min-w-[6.5rem] flex-1 px-5 py-3 text-center sm:flex-none">
      <p
        className={`whitespace-nowrap font-display text-xl font-semibold tracking-tight sm:text-2xl ${
          accent ? 'text-rose' : 'text-ink'
        }`}
      >
        {value}
      </p>
      <p className="mt-0.5 font-mono text-[10px] uppercase tracking-[0.18em] text-ink-faint">{label}</p>
    </div>
  );
}

function ShareCard({ slug }: { slug: string }) {
  const [copied, setCopied] = useState(false);
  const url = `${location.origin}/call/${slug}`;
  return (
    <div className="rise rise-1 relative overflow-hidden rounded-2xl bg-midnight p-6 text-white shadow-raise">
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'radial-gradient(480px 260px at 90% -20%, rgb(88 73 190 / 0.4), transparent 70%), radial-gradient(420px 240px at 8% 130%, rgb(180 58 102 / 0.25), transparent 70%)',
        }}
      />
      <div className="relative flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="flex items-center gap-2 font-display text-lg font-semibold">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#9D8FF0] opacity-60" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-[#B5A8F5]" />
            </span>
            Your agent is on the line
          </p>
          <p className="mt-1 max-w-md text-sm leading-relaxed text-white/60">
            Share this link, or embed it on your website — callers talk to your agent in the browser.
          </p>
        </div>
        <button
          onClick={() => {
            void navigator.clipboard.writeText(url);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
          className="rounded-[10px] border border-white/15 bg-white/10 px-4 py-2 font-mono text-xs font-semibold text-white backdrop-blur transition-colors hover:border-white/30 hover:bg-white/15"
        >
          {copied ? '✓ Copied' : `${url.replace(/^https?:\/\//, '')}  ⧉`}
        </button>
      </div>
    </div>
  );
}

function CallGlyph() {
  return (
    <svg viewBox="0 0 48 48" className="mx-auto h-12 w-12" aria-hidden>
      <circle cx="24" cy="24" r="23" fill="none" stroke="#D8D4E8" strokeWidth="1.5" strokeDasharray="1 6" strokeLinecap="round" />
      <path
        d="M18 14c3 0 9.5 6.5 9.5 9.5 0 1.1-1.9 3-3 3-.6 0-2.2-1.1-2.2-1.9 0-.6 1.1-1.5 1.1-2 0-.8-3.2-4-4-4-.5 0-1.4 1.1-2 1.1-1.1 0-2.2-1.6-2.2-2.2 0-1.1 1.1-3.5 2.8-3.5z"
        fill="#5849BE"
        opacity="0.45"
        transform="translate(5 5) scale(1.1)"
      />
    </svg>
  );
}
