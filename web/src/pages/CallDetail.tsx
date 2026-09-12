import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError, bookingRequestContact, takenMessage, type CallDetail, type KnowledgeCollection } from '../api';
import { Button, Card, Spinner, fmtDuration, fmtTime } from '../ui';

export default function CallDetailPage() {
  const { callId } = useParams();
  const [call, setCall] = useState<CallDetail | null>(null);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const [collections, setCollections] = useState<KnowledgeCollection[]>([]);
  const [collectionId, setCollectionId] = useState('');
  const [drafting, setDrafting] = useState<number | null>(null);
  const [saved, setSaved] = useState('');
  useEffect(() => { void api.knowledgeCollections().then(c => { setCollections(c); setCollectionId(c[0]?.id || ''); }).catch(() => {}); }, []);

  useEffect(() => {
    let active = true;
    setCall(null); setError(''); setSaved('');
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    async function refreshCall() {
      if (!callId) return;
      try {
        const next = await api.call(callId);
        if (!active) return;
        failures = 0; setCall(next); setError('');
        if (next.status === 'active') timer = setTimeout(refreshCall, 1500);
      } catch (e) {
        if (active) {
          setError(e instanceof Error ? e.message : 'Could not refresh call.');
          failures++;
          const transient = !(e instanceof ApiError) || e.status === 429 || e.status >= 500;
          if (transient && failures < 3) timer = setTimeout(refreshCall, 3000);
        }
      }
    }
    void refreshCall();
    return () => { active = false; clearTimeout(timer); };
  }, [callId, reload]);

  const retry = <Button variant="ghost" onClick={() => setReload(n => n + 1)}>Retry call</Button>;
  if (error && !call) return <div><p role="alert" className="text-rose">{error}</p>{retry}</div>;
  if (!call) return <Spinner />;

  const message = takenMessage(call.message_json);
  const booking = message ? null : bookingRequestContact(call);

  return (
    <div className="mx-auto max-w-2xl">
      <Link
        to="/calls"
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

      {call.status === 'active' && <p role="status">Waiting for the conversation to finish saving…</p>}
      {error && <div><p role="alert" className="text-rose">{error}</p>{retry}</div>}
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

      {call.failure_message && <Card className="mb-5"><p>Call issue: {call.failure_message}</p></Card>}
      <div className="mb-6"><p className="text-sm text-ink-soft">Save a caller’s question as a knowledge draft, then write and approve the answer in Knowledge.</p>{collections.length > 0 && <label className="mt-3 block text-sm">Save drafts to <select className="ml-3 rounded border border-line p-2" value={collectionId} onChange={e=>setCollectionId(e.target.value)}>{collections.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></label>}{error && <p role="alert" className="mt-3 text-rose">{error}</p>}{saved && <p role="status" className="mt-3 text-sm">{saved} <Link to="/knowledge" className="text-iris underline">Review knowledge →</Link></p>}</div>
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
              <p className="whitespace-pre-wrap">{t.text}</p>
              {t.role === 'caller' && <button disabled={drafting !== null} className="mt-3 block text-xs text-iris underline disabled:opacity-50" onClick={async()=>{setDrafting(t.id);setError('');setSaved('');try{await api.draftKnowledgeFromTurn({callId:call.id,turnId:t.id,...(collectionId?{collectionId}:{})});setSaved('Question saved as a draft.');}catch(e){setError(e instanceof Error?e.message:'Could not save draft.');}finally{setDrafting(null);}}}>{drafting===t.id?'Saving…':'Save question to knowledge'}</button>}
            </div>
          </div>
        ))}
        {call.turns.length === 0 && <p className="text-sm text-ink-soft">No conversation recorded.</p>}
      </div>
    </div>
  );
}
