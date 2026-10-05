import { useEffect, useRef, useState } from "react";
import {
  api,
  request,
  supportedLanguages,
  type Assistant,
} from "../cleanroom-runtime";
import { Field, Notice, errorText } from "./ui";
export function VoiceChoices({
  draft,
  onChange,
}: {
  draft: Assistant;
  onChange: (a: Assistant) => void;
}) {
  const [voices, setVoices] = useState<{ id: string; label: string }[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const audio = useRef<HTMLAudioElement | null>(null);
  const requestRef = useRef<AbortController | null>(null);
  const cache = useRef(new Map<string, string>());
  const revision = useRef(0);
  useEffect(() => {
    let active = true;
    request<{ voices: { id: string; label: string }[]; defaultVoice: string }>(
      "/api/me/voices",
    )
      .then((result) => {
        if (active) {
          setVoices(result.voices || []);
          setLoaded(true);
        }
      })
      .catch((e) => {
        if (active) setError(errorText(e));
      });
    return () => {
      active = false;
      requestRef.current?.abort();
      audio.current?.pause();
      for (const url of cache.current.values()) URL.revokeObjectURL(url);
      cache.current.clear();
    };
  }, []);
  useEffect(() => {
    revision.current++;
    requestRef.current?.abort();
    audio.current?.pause();
    setBusy(false);
    setPlaying(false);
  }, [draft.id, draft.voice, draft.language]);
  async function play() {
    if (playing) {
      audio.current?.pause();
      setPlaying(false);
      return;
    }
    if (busy) {
      requestRef.current?.abort();
      revision.current++;
      setBusy(false);
      return;
    }
    const gen = revision.current;
    setBusy(true);
    setError("");
    const controller = new AbortController();
    requestRef.current = controller;
    try {
      const key = `${draft.id}:${draft.voice}:${draft.language}`;
      let url = cache.current.get(key);
      if (!url) {
        const blob = await api.voicePreview(
          draft.id,
          { voice: draft.voice, language: draft.language },
          controller.signal,
        );
        if (controller.signal.aborted || gen !== revision.current) return;
        if (blob.size > 960044)
          throw new Error("Voice sample is too large. Please try again.");
        url = URL.createObjectURL(blob);
        cache.current.set(key, url);
        if (cache.current.size > 8) {
          const [oldKey, oldUrl] = cache.current.entries().next().value!;
          URL.revokeObjectURL(oldUrl);
          cache.current.delete(oldKey);
        }
      }
      if (!audio.current) audio.current = new Audio();
      audio.current.src = url;
      audio.current.onended = () => setPlaying(false);
      await audio.current.play();
      if (gen === revision.current) setPlaying(true);
    } catch (e) {
      if (!controller.signal.aborted) setError(errorText(e));
    } finally {
      if (gen === revision.current) setBusy(false);
    }
  }
  return (
    <div className="of-voice-choices">
      <div className="of-two-fields">
        <Field label="Language">
          <select
            value={draft.language}
            onChange={(e) => onChange({ ...draft, language: e.target.value })}
          >
            {!supportedLanguages.some((v) => v.id === draft.language) && (
              <option value={draft.language}>{draft.language}</option>
            )}
            {supportedLanguages.map((v) => (
              <option key={v.id} value={v.id}>
                {v.label}
              </option>
            ))}
          </select>
        </Field>
        <div className="of-voice-sample-choice">
          <Field label="Voice">
            <select
              value={draft.voice || ""}
              disabled={!loaded}
              onChange={(e) => onChange({ ...draft, voice: e.target.value })}
            >
              <option value="" disabled>
                Choose a voice
              </option>
              {draft.voice && !voices.some((v) => v.id === draft.voice) && (
                <option value={draft.voice}>
                  Saved voice — choose an available voice
                </option>
              )}
              {voices.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.label}
                </option>
              ))}
            </select>
          </Field>
          <button
            type="button"
            className="of-button line of-voice-preview-button"
            disabled={!loaded || !voices.some((v) => v.id === draft.voice)}
            aria-label={
              busy
                ? "Cancel voice sample"
                : playing
                  ? "Stop voice sample"
                  : "Play voice sample"
            }
            onClick={() => void play()}
          >
            {busy || playing ? "■" : "▶"}
          </button>
        </div>
      </div>

      {error && <Notice error>{error}</Notice>}
    </div>
  );
}
