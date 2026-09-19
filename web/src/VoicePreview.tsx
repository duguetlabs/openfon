import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type Assistant } from './api';
import { Button } from './ui';
import { PREVIEW_TEXT } from '../../src/voice-preview-text';

export function VoicePreview({ assistant, browserSpeech, disabled }: {
  assistant: Assistant; browserSpeech: boolean; disabled: boolean;
}) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [url, setUrl] = useState('');
  const audio = useRef<HTMLAudioElement | null>(null), currentUrl = useRef('');
  const request = useRef<AbortController | null>(null);
  const utterance = useRef<SpeechSynthesisUtterance | null>(null);
  const mounted = useRef(true);
  const audioRef = useCallback((element: HTMLAudioElement | null) => {
    if (!element && audio.current) audio.current.pause();
    audio.current = element;
  }, []);
  const stop = () => {
    request.current?.abort(); request.current = null;
    if (audio.current) { audio.current.pause(); audio.current.currentTime = 0; }
    if (utterance.current) {
      utterance.current.onend = null; utterance.current.onerror = null;
      window.speechSynthesis.cancel(); utterance.current = null;
    }
  };
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; stop(); URL.revokeObjectURL(currentUrl.current); };
  }, []);
  const preview = async () => {
    if (request.current || utterance.current) return;
    stop(); setError(''); setBusy(true); setUrl('');
    URL.revokeObjectURL(currentUrl.current); currentUrl.current = '';
    if (browserSpeech) {
      if (!('speechSynthesis' in window) || window.speechSynthesis.speaking || window.speechSynthesis.pending) {
        setBusy(false); setError('Browser speech is unavailable or already in use. Finish other speech and try again.'); return;
      }
      const item = new SpeechSynthesisUtterance(PREVIEW_TEXT[assistant.language] || PREVIEW_TEXT.en);
      item.lang = assistant.language;
      const done = () => { if (mounted.current && utterance.current === item) { utterance.current = null; setBusy(false); } };
      item.onend = done; item.onerror = () => { done(); if (mounted.current) setError('The browser could not play this voice.'); };
      utterance.current = item; window.speechSynthesis.speak(item); return;
    }
    const controller = new AbortController(); request.current = controller;
    try {
      const blob = await api.voicePreview(assistant, controller.signal);
      if (!mounted.current || request.current !== controller) return;
      currentUrl.current = URL.createObjectURL(blob); setUrl(currentUrl.current);
    } catch (e) {
      if (mounted.current && request.current === controller) setError(e instanceof Error ? e.message : 'Voice preview failed.');
    } finally {
      if (mounted.current && request.current === controller) { request.current = null; setBusy(false); }
    }
  };
  return <div className="space-y-2">
    <div className="flex flex-wrap gap-2">
      <Button type="button" disabled={disabled || busy} onClick={() => void preview()}>{busy ? browserSpeech ? 'Playing voice…' : 'Preparing voice…' : 'Preview voice'}</Button>
      {(busy || url) && <Button type="button" variant="ghost" onClick={() => { stop(); setBusy(false); }}>Stop preview</Button>}
    </div>
    {url && <audio ref={audioRef} className="max-w-full" controls autoPlay src={url} aria-label="Selected voice sample" onError={() => setError('Audio playback failed. Try generating another sample.')} />}
    {error && <p role="alert">{error}</p>}
    <p className="studio-muted">Listen to an AI-generated sample in the selected language before saving. {browserSpeech ? 'Uses this device’s browser voice.' : 'Uses your saved provider settings; provider usage charges may apply.'} No microphone or call recording.</p>
  </div>;
}
