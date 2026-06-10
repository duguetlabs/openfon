import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, type CallDetail } from '../api';
import { Card, Spinner, fmtDuration, fmtTime } from '../ui';

export default function CallDetailPage() {
  const { callId } = useParams();
  const [call, setCall] = useState<CallDetail | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (callId) void api.call(callId).then(setCall).catch((e) => setError(e.message));
  }, [callId]);

  if (error) return <p className="text-ring">{error}</p>;
  if (!call) return <Spinner />;

  const message = call.message_json ? (JSON.parse(call.message_json) as { caller_name?: string; caller_phone?: string; message?: string }) : null;

  return (
    <div className="mx-auto max-w-2xl">
      <Link to="/" className="font-mono text-xs text-ink-soft hover:text-pine">
        ← back to call log
      </Link>
      <div className="rise mt-3 mb-6">
        <p className="font-mono text-xs text-ink-soft">
          {fmtTime(call.started_at)} · {fmtDuration(call.duration_s)} · {call.channel}
        </p>
        <h1 className="mt-1 font-display text-3xl font-semibold text-pine">{call.summary ?? 'Call transcript'}</h1>
      </div>

      {message && (
        <Card className="rise rise-1 mb-6 border-ring/40 bg-ring-soft">
          <p className="font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-ring">☎ Message taken</p>
          <p className="mt-2 text-sm text-ink">
            {message.caller_name && <strong>{message.caller_name}</strong>}
            {message.caller_phone && <span className="font-mono"> · {message.caller_phone}</span>}
          </p>
          {message.message && <p className="mt-1 text-sm text-ink">{message.message}</p>}
        </Card>
      )}

      <div className="rise rise-2 space-y-3">
        {call.turns.map((t, i) => (
          <div key={i} className={`flex ${t.role === 'agent' ? 'justify-start' : 'justify-end'}`}>
            <div
              className={`max-w-[80%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed shadow-lift ${
                t.role === 'agent' ? 'rounded-tl-sm bg-pine text-paper' : 'rounded-tr-sm border border-line bg-white/70 text-ink'
              }`}
            >
              <p className="mb-0.5 font-mono text-[10px] uppercase tracking-[0.15em] opacity-60">
                {t.role === 'agent' ? 'agent' : 'caller'}
              </p>
              {t.text}
            </div>
          </div>
        ))}
        {call.turns.length === 0 && <p className="text-sm text-ink-soft">No conversation recorded.</p>}
      </div>
    </div>
  );
}
