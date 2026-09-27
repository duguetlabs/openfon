import { useEffect, useRef, useState } from "react";
import { api, supportedLanguages, voiceChoicesFor } from "../cleanroom-runtime";
import type {
  Assistant,
  Provider,
  ProviderCatalog,
} from "../cleanroom-runtime";
import { Button, Field, Notice, errorText } from "./ui";
export function VoiceChoices({
  draft,
  onChange,
}: {
  draft: Assistant;
  onChange: (a: Assistant) => void;
}) {
  const [provider, setProvider] = useState<Provider | null>(null);
  const [catalog, setCatalog] = useState<ProviderCatalog | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [sample, setSample] = useState("");
  const [sampleLabel, setSampleLabel] = useState("");
  const localPreview = useRef(false);
  const sampleUrl = useRef("");
  const audio = useRef<HTMLAudioElement>(null);
  const request = useRef<AbortController | null>(null);
  useEffect(() => {
    let active = true;
    Promise.all([api.provider(), api.providerCatalog()])
      .then(([p, c]) => {
        if (active) {
          setProvider(p);
          setCatalog(c);
        }
      })
      .catch((e) => {
        if (active) setError(errorText(e));
      });
    return () => {
      active = false;
      request.current?.abort();
      audio.current?.pause();
      if (sampleUrl.current) URL.revokeObjectURL(sampleUrl.current);
      if (localPreview.current) window.speechSynthesis?.cancel();
    };
  }, []);
  useEffect(() => {
    request.current?.abort();
    audio.current?.pause();
    if (localPreview.current) {
      window.speechSynthesis?.cancel();
      localPreview.current = false;
    }
    if (sampleUrl.current) {
      URL.revokeObjectURL(sampleUrl.current);
      sampleUrl.current = "";
    }
    setSample("");
    setSampleLabel("");
    setBusy(false);
    setError("");
  }, [
    draft.id,
    draft.engine,
    draft.language,
    draft.voice,
    draft.realtime_model,
    draft.realtime_voice,
    draft.greeting,
  ]);
  const realtime = draft.engine === "realtime";
  const browserVoice =
    !realtime && provider?.effective_tts_provider === "browser";
  const selected = realtime ? draft.realtime_voice : draft.voice;
  const choices =
    provider && catalog ? voiceChoicesFor(draft, provider, catalog) : [];
  async function preview() {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    audio.current?.pause();
    setError("");
    setBusy(true);
    try {
      if (browserVoice) {
        if (!("speechSynthesis" in window))
          throw new Error(
            "This browser cannot play a voice sample. Try a browser rehearsal instead.",
          );
        speechSynthesis.cancel();
        const speech = new SpeechSynthesisUtterance(
          draft.greeting || "Hello. How can I help you today?",
        );
        speech.lang = draft.language;
        const local = speechSynthesis
          .getVoices()
          .find((v) =>
            v.lang.toLowerCase().startsWith(draft.language.toLowerCase()),
          );
        if (local) speech.voice = local;
        speech.onend = () => {
          if (!controller.signal.aborted) {
            localPreview.current = false;
            setBusy(false);
          }
        };
        speech.onerror = () => {
          if (controller.signal.aborted) return;
          localPreview.current = false;
          setBusy(false);
          setError(
            "The sample could not play. Try again or use a browser rehearsal.",
          );
        };
        localPreview.current = true;
        speechSynthesis.speak(speech);
        return;
      }
      const blob = await api.voicePreview(
        draft.id,
        {
          engine: draft.engine,
          language: draft.language,
          voice: draft.voice,
          realtime_model: draft.realtime_model,
          realtime_voice: draft.realtime_voice,
        },
        controller.signal,
      );
      if (controller.signal.aborted) return;
      if (sampleUrl.current) URL.revokeObjectURL(sampleUrl.current);
      sampleUrl.current = URL.createObjectURL(blob);
      setSample(sampleUrl.current);
      setSampleLabel(
        `${draft.language} · ${selected || "Provider default"}${draft.engine === "realtime" ? ` · ${draft.realtime_model || provider?.effective_realtime_model || "Default model"}` : ""}`,
      );
    } catch (e) {
      if (!controller.signal.aborted) {
        setError(errorText(e));
        setBusy(false);
      }
    } finally {
      if (!browserVoice && !controller.signal.aborted) setBusy(false);
    }
  }
  return (
    <div className="of-voice-choices of-brand-voice">
      <div className="of-voice-heading">
        <h3 className="of-reading-title">Language & voice</h3>
        <p>Choose how your receptionist sounds, then listen to a sample.</p>
      </div>
      <div className="of-two-fields">
        <Field label="Language">
          <select
            value={draft.language}
            onChange={(e) => onChange({ ...draft, language: e.target.value })}
          >
            {!supportedLanguages.some(
              (option) => option.id === draft.language,
            ) && (
              <option value={draft.language}>
                {draft.language || "Choose a language"}
              </option>
            )}
            {supportedLanguages.map((option) => (
              <option value={option.id} key={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Voice">
          <select
            value={selected}
            onChange={(e) =>
              onChange({
                ...draft,
                [realtime ? "realtime_voice" : "voice"]: e.target.value,
              })
            }
          >
            <option value="">
              {browserVoice ? "Browser default" : "Provider default"}
            </option>
            {selected && !choices.some((v) => v.id === selected) && (
              <option value={selected}>{selected}</option>
            )}
            {choices.map((v) => (
              <option key={v.id} value={v.id}>
                {v.label}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <div className="of-voice-sample">
        <Button
          kind="line"
          icon="phone"
          disabled={busy || !provider}
          onClick={() => void preview()}
        >
          {busy
            ? browserVoice
              ? "Playing sample…"
              : "Preparing sample…"
            : "Listen to a sample"}
        </Button>
        <small>A short preview of these voice choices.</small>
      </div>
      {sample && (
        <figure className="of-sample-result">
          <figcaption>Voice sample: {sampleLabel}</figcaption>
          <audio
            ref={audio}
            controls
            src={sample}
            aria-label={`Receptionist voice sample: ${sampleLabel}`}
          />
        </figure>
      )}
      {error && <Notice error>{error}</Notice>}
    </div>
  );
}
