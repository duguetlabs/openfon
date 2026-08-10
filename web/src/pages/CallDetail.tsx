import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, bookingRequestContact, takenMessage, type CallDetail } from '../api';
import { Card, Spinner, fmtDuration, fmtTime } from '../ui';

export default function CallDetailPage() {
  const { callId } = useParams();
  const [call, setCall] = useState<CallDetail | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (callId) void api.call(callId).then(setCall).catch((e) => setError(e.message));
  }, [callId]);

  if (error) return <p className="text-rose">{error}</p>;
  if (!call) return <Spinner />;

  const message = takenMessage(call.message_json);
  const booking = message ? null : bookingRequestContact(call);

  return (
    <div className="mx-auto max-w-2xl">
      <Link
        to="/"
        className="font-mono text-[11px] uppercase tracking-[0.14em] text-ink-faint transition-colors hover:text-iris"
      >
        ← Call log
      </Link>
      <div className="rise mt-4 mb-8">
        <p className="font-mono text-[11px] text-ink-faint">
          {fmtTime(call.started_at)} · {fmtDuration(call.duration_s)} · {call.channel}
        </p>
        <h1 className="mt-1.5 font-display text-3xl font-semibold tracking-tight text-ink">
          {call.summary ??
            (call.status === 'abandoned'
              ? call.connected_at
                ? 'Call interrupted'
                : 'Never connected'
              : 'Call transcript')}
        </h1>
        <div className="callline-accent mt-3 w-16" />
      </div>

      {message && (
        <Card className="rise rise-1 mb-8 border-rose/20 bg-wash-rose">
          <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.2em] text-rose">☎ Message taken</p>
          <p className="mt-2.5 text-sm text-ink">
            {message.caller_name && <strong>{message.caller_name}</strong>}
            {message.caller_phone && <span className="font-mono text-ink-soft"> · {message.caller_phone}</span>}
          </p>
          {message.message && <p className="mt-1 text-sm leading-relaxed text-ink">{message.message}</p>}
        </Card>
      )}

      {booking && (
        <Card className="rise rise-1 mb-8 border-iris/20 bg-wash-iris">
          <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.2em] text-iris">Booking requested</p>
          <p className="mt-2.5 text-sm text-ink">
            {booking.caller_name && <strong>{booking.caller_name}</strong>}
            {booking.caller_phone && <span className="font-mono text-ink-soft"> · {booking.caller_phone}</span>}
          </p>
        </Card>
      )}

      <div className="rise rise-2 space-y-3">
        {call.turns.map((t, i) => (
          <div key={i} className={`flex ${t.role === 'agent' ? 'justify-start' : 'justify-end'}`}>
            <div
              className={`max-w-[80%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
                t.role === 'agent'
                  ? 'rounded-tl-sm bg-midnight text-white shadow-raise'
                  : 'rounded-tr-sm border border-line bg-surface text-ink shadow-lift'
              }`}
            >
              <p
                className={`mb-1 font-mono text-[10px] uppercase tracking-[0.15em] ${
                  t.role === 'agent' ? 'text-[#B5A8F5]' : 'text-ink-faint'
                }`}
              >
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
