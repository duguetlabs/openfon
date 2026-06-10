import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { VoiceCall, type VoiceEvent } from '../voice';
import { Logo } from '../ui';

type Phase = 'idle' | 'connecting' | 'live' | 'ended' | 'error';

interface CaptionLine {
  who: 'caller' | 'agent';
  text: string;
}

export default function Widget() {
  const { slug } = useParams();
  const [agentName, setAgentName] = useState('');
  const [businessName, setBusinessName] = useState('');
  const [notFound, setNotFound] = useState(false);
  const [phase, setPhase] = useState<Phase>('idle');
  const [errorMsg, setErrorMsg] = useState('');
  const [lines, setLines] = useState<CaptionLine[]>([]);
  const [speaking, setSpeaking] = useState<'caller' | 'agent' | 'none'>('none');
  const [thinking, setThinking] = useState(false);
  const [level, setLevel] = useState(0);
  const [textInput, setTextInput] = useState('');
  const [hasMic, setHasMic] = useState(true);
  const callRef = useRef<VoiceCall | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!slug) return;
    fetch(`/api/public/agent/${slug}`)
      .then(async (r) => {
        if (!r.ok) throw new Error();
        const d = (await r.json()) as { businessName: string; agentName: string };
        setBusinessName(d.businessName);
        setAgentName(d.agentName);
      })
      .catch(() => setNotFound(true));
    return () => callRef.current?.hangup();
  }, [slug]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [lines, thinking]);

  function onEvent(ev: VoiceEvent) {
    switch (ev.type) {
      case 'status':
        if (ev.status === 'live') setPhase('live');
        else if (ev.status === 'ended') setPhase((p) => (p === 'error' ? p : 'ended'));
        else if (ev.status === 'error') {
          setPhase('error');
          setErrorMsg(ev.detail ?? 'Something went wrong');
        }
        break;
      case 'transcript':
        setThinking(true);
        setLines((l) => [...l, { who: 'caller', text: ev.text }]);
        break;
      case 'agent_text':
        setThinking(false);
        setLines((l) => [...l, { who: 'agent', text: ev.text }]);
        break;
      case 'thinking':
        setThinking(true);
        break;
      case 'speaking':
        setSpeaking(ev.who);
        break;
      case 'level':
        setLevel(ev.value);
        break;
    }
  }

  async function startCall() {
    if (!slug) return;
    setPhase('connecting');
    setLines([]);
    const call = new VoiceCall();
    callRef.current = call;
    call.on(onEvent);
    try {
      await call.start(slug);
      setHasMic(call.hasMic);
    } catch (err) {
      setPhase('error');
      setErrorMsg(err instanceof Error ? err.message : 'Could not start the call');
    }
  }

  function hangup() {
    callRef.current?.hangup();
    setPhase('ended');
  }

  function sendText() {
    if (!textInput.trim()) return;
    callRef.current?.sendText(textInput.trim());
    setTextInput('');
  }

  if (notFound) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-pine-night text-paper">
        <Logo dark />
        <p className="font-display text-2xl">This line doesn't exist.</p>
      </div>
    );
  }

  const live = phase === 'live';

  return (
    <div className="grain relative flex min-h-screen flex-col overflow-hidden bg-pine-night text-paper">
      {/* ambient dial rings */}
      <div className="pointer-events-none absolute left-1/2 top-1/2 h-[120vmin] w-[120vmin] -translate-x-1/2 -translate-y-1/2 rounded-full border border-paper/5" />
      <div className="pointer-events-none absolute left-1/2 top-1/2 h-[90vmin] w-[90vmin] -translate-x-1/2 -translate-y-1/2 rounded-full border border-paper/5" />
      <div className="pointer-events-none absolute left-1/2 top-1/2 h-[60vmin] w-[60vmin] -translate-x-1/2 -translate-y-1/2 rounded-full border border-paper/[0.07]" />

      <header className="relative z-10 flex items-center justify-between px-6 py-5">
        <Logo dark />
        <span className="font-mono text-xs text-paper/40">{live ? <span className="text-ring">● LIVE</span> : 'web call'}</span>
      </header>

      <main className="relative z-10 flex flex-1 flex-col items-center justify-center px-6 pb-10">
        {phase === 'idle' && (
          <div className="rise text-center">
            <p className="font-mono text-xs uppercase tracking-[0.3em] text-paper/40">You're calling</p>
            <h1 className="mt-2 font-display text-5xl font-semibold tracking-tight">{businessName || '…'}</h1>
            {agentName && <p className="mt-3 text-paper/60">{agentName} will pick up. Speak naturally — headphones help.</p>}
          </div>
        )}

        {(phase === 'connecting' || live) && (
          <div ref={scrollRef} className="w-full max-w-lg flex-1 space-y-3 overflow-y-auto py-6 [mask-image:linear-gradient(to_bottom,transparent,black_12%)]">
            {lines.map((l, i) => (
              <div key={i} className={`flex ${l.who === 'agent' ? 'justify-start' : 'justify-end'}`}>
                <p
                  className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-[15px] leading-relaxed ${
                    l.who === 'agent' ? 'rounded-tl-sm bg-paper/10 text-paper' : 'rounded-tr-sm bg-ring text-paper'
                  }`}
                >
                  {l.text}
                </p>
              </div>
            ))}
            {thinking && (
              <p className="flex gap-1.5 px-4 py-2">
                <span className="blink h-2 w-2 rounded-full bg-paper/40" />
                <span className="blink h-2 w-2 rounded-full bg-paper/40 [animation-delay:0.2s]" />
                <span className="blink h-2 w-2 rounded-full bg-paper/40 [animation-delay:0.4s]" />
              </p>
            )}
          </div>
        )}

        {phase === 'ended' && (
          <div className="rise text-center">
            <h1 className="font-display text-4xl font-semibold">Call ended.</h1>
            <p className="mt-3 text-paper/60">Thanks for calling {businessName}.</p>
          </div>
        )}
        {phase === 'error' && (
          <div className="rise text-center">
            <h1 className="font-display text-3xl font-semibold text-ring">Line trouble.</h1>
            <p className="mt-3 max-w-sm text-paper/60">{errorMsg}</p>
          </div>
        )}

        {/* dial */}
        <div className="mt-8 flex flex-col items-center gap-5">
          <div className="relative">
            {phase === 'connecting' && (
              <>
                <span className="ringpulse absolute inset-0 rounded-full border-2 border-ring" />
                <span className="ringpulse2 absolute inset-0 rounded-full border-2 border-ring" />
              </>
            )}
            {live && speaking === 'agent' && (
              <span className="absolute -inset-2 rounded-full border-2 border-paper/30 transition-transform" />
            )}
            {live && (
              <span
                className="absolute -inset-1 rounded-full border-2 border-ring/60 transition-transform duration-75"
                style={{ transform: `scale(${1 + level * 0.25})`, opacity: speaking === 'caller' ? 1 : 0.15 }}
              />
            )}
            {phase === 'idle' || phase === 'ended' || phase === 'error' ? (
              <button
                onClick={() => void startCall()}
                className="group flex h-28 w-28 items-center justify-center rounded-full bg-ring text-paper shadow-deep transition-transform hover:scale-105 active:scale-95"
                aria-label="Start call"
              >
                <PhoneIcon className="wobble h-10 w-10 [animation-play-state:paused] group-hover:[animation-play-state:running]" />
              </button>
            ) : (
              <button
                onClick={hangup}
                className="flex h-28 w-28 items-center justify-center rounded-full bg-paper/10 text-paper backdrop-blur transition-colors hover:bg-ring"
                aria-label="Hang up"
              >
                <PhoneIcon className="h-10 w-10 rotate-[135deg]" />
              </button>
            )}
          </div>
          <p className="font-mono text-xs uppercase tracking-[0.25em] text-paper/40">
            {phase === 'idle' && 'tap to call'}
            {phase === 'connecting' && 'ringing…'}
            {live && (speaking === 'agent' ? `${agentName} is speaking` : speaking === 'caller' ? 'listening to you' : hasMic ? 'your turn — just talk' : 'type below')}
            {phase === 'ended' && 'call again'}
            {phase === 'error' && 'try again'}
          </p>

          {live && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                sendText();
              }}
              className="flex w-full max-w-md gap-2"
            >
              <input
                value={textInput}
                onChange={(e) => setTextInput(e.target.value)}
                placeholder={hasMic ? 'Or type instead of speaking…' : 'Type your message…'}
                className="flex-1 rounded-full border border-paper/15 bg-paper/5 px-5 py-2.5 text-sm text-paper outline-none placeholder:text-paper/30 focus:border-paper/40"
              />
              <button type="submit" className="rounded-full bg-paper px-5 text-sm font-bold text-pine transition-transform hover:scale-105">
                Send
              </button>
            </form>
          )}
        </div>
      </main>

      <footer className="relative z-10 pb-5 text-center font-mono text-[10px] text-paper/25">
        powered by openfon — open-source AI phone agent
      </footer>
    </div>
  );
}

function PhoneIcon({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
      <path d="M6.6 2.8c1.2 0 4.2 2.4 4.2 3.5 0 .9-1.3 1.9-1.3 2.6 0 1.2 4.4 5.6 5.6 5.6.7 0 1.7-1.3 2.6-1.3 1.1 0 3.5 3 3.5 4.2 0 1.6-2.6 3.8-4.2 3.8C12.3 21.2 2.8 11.7 2.8 7c0-1.6 2.2-4.2 3.8-4.2z" />
    </svg>
  );
}
