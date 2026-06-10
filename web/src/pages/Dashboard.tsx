import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type CallRow } from '../api';
import { useSession } from '../App';
import { Card, Spinner, fmtDuration, fmtTime } from '../ui';

const INTENT_BADGE: Record<string, string> = {
  question: 'bg-paper-2 text-ink-soft',
  booking: 'bg-pine text-paper',
  message: 'bg-ring text-paper',
  other: 'bg-paper-2 text-ink-soft',
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
      <div className="rise mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="font-mono text-xs uppercase tracking-[0.2em] text-ink-soft">Switchboard</p>
          <h1 className="font-display text-4xl font-semibold tracking-tight text-pine">{business.name}</h1>
        </div>
        <div className="flex gap-3">
          <Stat label="calls" value={String(completed.length)} />
          <Stat label="messages" value={String(messages.length)} accent />
          <Stat label="talk time" value={fmtDuration(totalSec)} />
        </div>
      </div>

      <ShareCard slug={business.slug} />

      <div className="rise rise-2 mt-8">
        <h2 className="mb-3 font-display text-2xl font-semibold text-pine">Call log</h2>
        {calls === null ? (
          <Spinner />
        ) : calls.length === 0 ? (
          <Card className="py-12 text-center">
            <p className="font-display text-xl text-ink-soft">No calls yet.</p>
            <p className="mt-2 text-sm text-ink-soft">
              Click <strong>Test call</strong> in the top bar to ring your own agent.
            </p>
          </Card>
        ) : (
          <div className="overflow-hidden rounded-2xl border border-line bg-white/60 shadow-lift">
            {calls.map((c, i) => (
              <Link
                key={c.id}
                to={`/calls/${c.id}`}
                className={`flex items-center gap-4 px-5 py-4 transition-colors hover:bg-paper-2 ${i > 0 ? 'border-t border-line' : ''}`}
              >
                <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${c.status === 'active' ? 'blink bg-ring' : 'bg-ok'}`} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-ink">
                    {c.summary ?? (c.status === 'active' ? 'Call in progress…' : 'Call')}
                  </p>
                  <p className="mt-0.5 font-mono text-xs text-ink-soft">
                    {fmtTime(c.started_at)} · {fmtDuration(c.duration_s)} · {c.channel}
                  </p>
                </div>
                {c.intent && (
                  <span className={`shrink-0 rounded-full px-3 py-1 text-xs font-bold ${INTENT_BADGE[c.intent] ?? INTENT_BADGE.other}`}>
                    {c.intent}
                  </span>
                )}
                <span className="text-ink-soft">→</span>
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
    <div className={`rounded-2xl border px-5 py-3 text-center shadow-lift ${accent ? 'border-ring/40 bg-ring-soft' : 'border-line bg-white/60'}`}>
      <p className={`font-display text-2xl font-semibold ${accent ? 'text-ring' : 'text-pine'}`}>{value}</p>
      <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-soft">{label}</p>
    </div>
  );
}

function ShareCard({ slug }: { slug: string }) {
  const [copied, setCopied] = useState(false);
  const url = `${location.origin}/call/${slug}`;
  return (
    <Card className="rise rise-1 flex flex-wrap items-center justify-between gap-4 border-pine/20 bg-pine-night text-paper">
      <div>
        <p className="font-display text-lg font-semibold">Your agent is on the line</p>
        <p className="mt-0.5 text-sm text-paper/60">Share this link, or embed it on your website — callers talk to your agent in the browser.</p>
      </div>
      <button
        onClick={() => {
          void navigator.clipboard.writeText(url);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
        className="rounded-full bg-paper px-4 py-2 font-mono text-xs font-semibold text-pine transition-transform hover:scale-[1.02]"
      >
        {copied ? '✓ Copied' : url.replace(/^https?:\/\//, '')}
      </button>
    </Card>
  );
}
