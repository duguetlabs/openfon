import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { api, type Assistant } from './api';
import { PREVIEW_TEXT } from '../../src/voice-preview-text';

// Scoped to one mounted editor, never shared across accounts or persisted.
export type VoiceSampleCache = Map<string, { blob: Blob; until: number }>;
export function VoicePreview({ assistant, browserSpeech, disabled, cache, cacheKey }: {
  assistant: Assistant; browserSpeech: boolean; disabled: boolean;
  cache: VoiceSampleCache; cacheKey: string;
}) {
  const [loading, setLoading] = useState(false), [playing, setPlaying] = useState(false), [error, setError] = useState('');
  const root = useRef<HTMLSpanElement>(null), audio = useRef<HTMLAudioElement | null>(null);
  const objectUrl = useRef(''), request = useRef<AbortController | null>(null);
  const attempted = useRef(false);
  const pending = useRef<Promise<boolean> | null>(null), wanted = useRef(false), mounted = useRef(true);
  const utterance = useRef<SpeechSynthesisUtterance | null>(null), errorId = useId();
  const audioRef = useCallback((element: HTMLAudioElement | null) => {
    if (!element) audio.current?.pause();
    audio.current = element;
  }, []);
  const stop = () => {
    wanted.current = false;
    if (audio.current) { audio.current.pause(); audio.current.currentTime = 0; }
    if (utterance.current) {
      utterance.current.onend = null; utterance.current.onerror = null;
      window.speechSynthesis.cancel(); utterance.current = null;
    }
    if (mounted.current) setPlaying(false);
  };
  const install = (blob: Blob) => {
    URL.revokeObjectURL(objectUrl.current); objectUrl.current = URL.createObjectURL(blob);
    if (audio.current) { audio.current.src = objectUrl.current; audio.current.load(); }
  };
  const load = (): Promise<boolean> => {
    if (objectUrl.current) return Promise.resolve(true);
    if (pending.current) return pending.current;
    const cached = cache.get(cacheKey);
    if (cached && cached.until > Date.now()) { install(cached.blob); return Promise.resolve(true); }
    cache.delete(cacheKey);
    attempted.current = true;
    const controller = new AbortController(); request.current = controller; setLoading(true);
    pending.current = api.voicePreview(assistant, controller.signal).then(blob => {
      if (!mounted.current || request.current !== controller) return false;
      // Each server sample is <= 960,044 bytes. Bound retained memory as well.
      if (blob.size > 960044) throw new Error('Voice sample is too large.');
      cache.delete(cacheKey);
      while (cache.size >= 8) cache.delete(cache.keys().next().value!);
      cache.set(cacheKey, { blob, until: Date.now() + 10 * 60_000 }); install(blob); return true;
    }).catch(e => {
      if (mounted.current && request.current === controller && wanted.current) {
        setError(e instanceof Error ? e.message : 'Voice sample could not load.');
      }
      return false;
    }).finally(() => {
      if (mounted.current && request.current === controller) { request.current = null; pending.current = null; setLoading(false); }
    });
    return pending.current;
  };
  useEffect(() => {
    mounted.current = true;
    // Wait until visible and the choice has settled. Never preload the catalog
    // or start speech; clicking play reuses this same in-flight request.
    let timer: ReturnType<typeof setTimeout> | undefined, visible = false;
    const schedule = () => {
      clearTimeout(timer);
      if (visible && !disabled && !browserSpeech && document.visibilityState === 'visible') {
        timer = setTimeout(() => { if (!attempted.current) void load(); }, 600);
      }
    };
    const observer = new IntersectionObserver(entries => { visible = entries.some(e => e.isIntersecting); schedule(); });
    document.addEventListener('visibilitychange', schedule);
    if (root.current) observer.observe(root.current);
    return () => {
      mounted.current = false; clearTimeout(timer); observer.disconnect(); document.removeEventListener('visibilitychange', schedule);
      stop(); request.current?.abort(); request.current = null; pending.current = null;
      URL.revokeObjectURL(objectUrl.current); objectUrl.current = '';
    };
  }, [disabled]);
  const playAudio = () => {
    void audio.current?.play().catch(() => {
      if (mounted.current && wanted.current) { stop(); setError('Playback could not start. Press play to try again.'); }
    });
  };
  const play = async () => {
    if (wanted.current) { stop(); return; }
    setError(''); wanted.current = true; setPlaying(true);
    if (browserSpeech) {
      if (!('speechSynthesis' in window) || window.speechSynthesis.speaking || window.speechSynthesis.pending) {
        stop(); setError('Browser speech is unavailable or already in use.'); return;
      }
      const item = new SpeechSynthesisUtterance(PREVIEW_TEXT[assistant.language] || PREVIEW_TEXT.en);
      item.lang = assistant.language;
      const done = () => { if (mounted.current && utterance.current === item) { utterance.current = null; wanted.current = false; setPlaying(false); } };
      item.onend = done; item.onerror = () => { done(); if (mounted.current) setError('The browser could not play this voice.'); };
      utterance.current = item; window.speechSynthesis.speak(item); return;
    }
    // Keep cached playback inside the click's browser activation window.
    if (objectUrl.current) { playAudio(); return; }
    const ready = await load();
    if (!mounted.current || !wanted.current) return;
    if (ready) playAudio(); else stop();
  };
  const label = playing ? 'Stop voice sample' : 'Play voice sample';
  return <span ref={root} className="relative inline-flex shrink-0">
    <button type="button" disabled={disabled} onClick={() => void play()} aria-label={label} title={label}
      aria-busy={loading} aria-describedby={error ? errorId : undefined}
      className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-slate-300 text-slate-700 hover:bg-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-40">
      <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
        {playing ? <rect x="6" y="6" width="12" height="12" rx="2" /> : <path d="M8 4.5v15l12-7.5z" />}
      </svg>
      {loading && <span aria-hidden="true" className="absolute inset-0 animate-spin rounded-full border-2 border-transparent border-t-slate-500" />}
    </button>
    <audio hidden ref={audioRef} preload="auto"
      onEnded={() => { wanted.current = false; setPlaying(false); }}
      onError={() => { if (wanted.current) { stop(); setError('Audio playback failed. Try another voice.'); } }} />
    {error && <span id={errorId} role="alert" className="absolute right-0 top-full z-10 mt-2 w-64 rounded-lg border bg-white p-3 text-sm text-slate-800 shadow-lg">{error}</span>}
  </span>;
}
