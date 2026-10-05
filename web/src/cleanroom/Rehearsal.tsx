import {updateTranscript,type TranscriptRevision} from '../transcript-state';
import { useEffect, useRef, useState } from "react";
import { RehearsalController } from "../cleanroom-runtime";
import type { Assistant } from "../cleanroom-runtime";
import { Icon } from "./icons";
import { RecordingDisclosure } from './Diagnostics';
import "./brand-operate.css";
export function Rehearsal({
  assistant,
  dirty = false,
  blockedReason,
  onConnections,
  onEnded,
  slug,
}: {
  assistant: Pick<Assistant, "id" | "name" | "greeting" | "state">;
  dirty?: boolean;
  blockedReason?: string;
  onConnections?: () => void;
  onEnded?: () => void;
  slug?: string;
}) {
  const call = useRef<RehearsalController | null>(null);
  const [status, setStatus] = useState("idle");
  const [detail, setDetail] = useState("");
  const [audioBlocked, setAudioBlocked] = useState(false);
  const [hasMic, setHasMic] = useState(true);
  const [turns, setTurns] = useState<({ role: string; text: string } & TranscriptRevision)[]>([]);
  const [text, setText] = useState("");
  const [speaker, setSpeaker] = useState("none");
  const [level, setLevel] = useState(0);
  const [debugRecording, setDebugRecording] = useState<boolean | null>(null);
  const active = status === "connecting" || status === "live";
  useEffect(() => {
    setStatus("idle");
    setDetail("");
    setTurns([]);
    return () => {
      call.current?.dispose();
      call.current = null;
    };
  }, [assistant.id, slug]);
  function start() {
    if (dirty || blockedReason || active) return;
    call.current?.dispose();
    setDetail("");
    setTurns([]);
    setAudioBlocked(false);
    setHasMic(true);
    setSpeaker("none");
    setLevel(0);
    setDebugRecording(null);
    const controller = new RehearsalController((event) => {
      if (event.type === 'debug') setDebugRecording(event.recording);
      if (event.type === "status") {
        setStatus(event.status);
        if(event.status!=="live"){setSpeaker("none");setLevel(0);}
        if (event.status === "error")
          setDetail(event.detail || "Connection failed.");
        if (event.status === "live") setHasMic(controller.hasMic);
      }
      if (event.type === "audio") setAudioBlocked(event.blocked);
      if (event.type === "speaking") setSpeaker(event.who);
      if (event.type === "level") setLevel(event.value);
      if (event.type === "transcript" || event.type === "agent_text")
        setTurns((v) => updateTranscript(v, {
            role: event.type === "transcript" ? "You" : assistant.name,
            text: event.text,eventId:event.eventId,revision:event.revision,final:event.final,
          }));
    }, onEnded);
    call.current = controller;
    void controller.start(assistant.id, { dirty, slug }).catch((error) => {
      setStatus("error");
      setDetail(error instanceof Error ? error.message : "Could not connect.");
    });
  }
  function stop() {
    call.current?.stop();
  }
  return (
    <section
      className={`of-station of-brand-rehearsal ${active ? "is-live" : ""}`}
      aria-label={slug ? "Call receptionist" : "Browser rehearsal"}
    >
      <div className="of-station-top">
        <span className="of-kicker">
          {slug ? "Say hello" : "Browser rehearsal"}
        </span>
        <span className="of-station-state" role="status">
          <i />
          {status === "live"
            ? "Connected"
            : status === "connecting"
              ? "Connecting"
              : status === "ended"
                ? "Finished"
                : status === "error"
                  ? "Connection failed"
                  : slug
                    ? "Ready for a conversation"
                    : "Test your saved brief"}
        </span>
      </div>
      <div className="of-call-action">
        {!slug && <RecordingDisclosure recording={debugRecording} />}
        <button
          className={`of-call-button ${active ? "end" : ""}`}
          onClick={active ? stop : () => void start()}
          disabled={(dirty || !!blockedReason) && !active}
          aria-label={active ? "End conversation" : "Start browser conversation"}
        >
          <Icon name={active ? "close" : "phone"} size={22} />
          <span>
            {active
              ? "End conversation"
              : status === "ended"
                ? "Try another conversation"
                : "Try a conversation"}
          </span>
        </button>
        <p className="of-call-guidance">
          {dirty
            ? "Save your changes first"
            : blockedReason
              ? blockedReason
              : active
                ? hasMic
                  ? "Microphone and text"
                  : "Text-only mode"
                : "Uses your microphone · or type instead"}
        </p>
      </div>
      <div className="of-greeting">
        {active ? (
          <>
            <h2 className="of-reading-title">
              {status === "connecting"
                ? "One moment…"
                : speaker === "agent"
                  ? `${assistant.name} is speaking`
                  : "You’re through."}
            </h2>
            <p>
              {status === "connecting"
                ? "Opening your conversation."
                : hasMic
                  ? "Speak naturally. Your receptionist is listening."
                  : "Microphone unavailable · text-only conversation."}
            </p>
            <div className="of-audio-meter" aria-hidden="true">
              {[0.4, 0.7, 1, 0.65, 0.35, 0.8, 1, 0.55, 0.3].map((n, i) => (
                <i
                  key={i}
                  style={{ transform: `scaleY(${(8 + n * level * 56) / 64})` }}
                />
              ))}
            </div>
          </>
        ) : (
          <>
            <h2>{slug ? "A warm welcome." : "Try your first hello."}</h2>
            <blockquote className="of-saved-welcome">
              <span>{slug ? "Ready when you are" : assistant.greeting ? "Your saved welcome" : "A place to begin"}</span>
              <p>
                “{assistant.greeting ||
                  (slug
                    ? "Start a conversation when you’re ready."
                    : "Your first hello starts here.")}”
              </p>
            </blockquote>
            <p>
              {slug
                ? `Speak with ${assistant.name}.`
                : "Hear how your receptionist welcomes a customer. No phone number needed."}
            </p>
          </>
        )}
      </div>
      {assistant && <p className="of-help">Private test calls count towards usage.</p>}
      {detail && (
        <div className="of-station-error" role="alert">
          {detail}
          {onConnections && (
            <button className="of-white-link" onClick={onConnections}>
              Review settings <Icon name="arrow" size={16} />
            </button>
          )}
        </div>
      )}
      {audioBlocked && active && (
        <button
          className="of-white-link"
          onClick={() => call.current?.prepareAudio()}
        >
          Enable speaker audio
        </button>
      )}
      {(active || turns.length > 0) && (
        <div className="of-live-transcript" aria-live="polite">
          {turns.map((t, i) => (
            <p key={i} className={t.role === "You" ? "is-caller" : "is-receptionist"}>
              <strong>{t.role}</strong>
              {t.text}
            </p>
          ))}
        </div>
      )}
      {status === "live" && (
        <form
          className="of-chat-input"
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim()) {
              call.current?.sendText(text.trim());
              setText("");
            }
          }}
        >
          <input
            aria-label="Type your message"
            placeholder="Or type a message…"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <button aria-label="Send message" disabled={!text.trim()}>
            <Icon name="arrow" />
          </button>
        </form>
      )}
    </section>
  );
}
