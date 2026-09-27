import { useEffect, useRef, useState } from "react";
import { api, callbackMessage, callDate } from "../cleanroom-runtime";
import type { Call, CallDetail, Page } from "../cleanroom-runtime";
import { Button, Empty, Notice, errorText } from "./ui";
import { Icon } from "./icons";
import { CallDiagnostics } from './Diagnostics';
export function CallRows({
  calls,
  onOpen,
}: {
  calls: Call[];
  onOpen: (id: string) => void;
}) {
  return (
    <div className="of-call-list of-brand-call-list">
      {calls.map((call) => {
        const message = callbackMessage(call.message_json);
        return (
          <button key={call.id} className={message?.message ? "has-message" : undefined} onClick={() => onOpen(call.id)}>
            <div
              className={`of-message-symbol ${message?.message ? "has-message" : ""}`}
            >
              <Icon name={message?.message ? "message" : "phone"} />
            </div>
            <div className="of-call-title">
              <strong>
                {message?.caller_name ||
                  (call.environment === "test"
                    ? "Your rehearsal"
                    : call.caller_id?.startsWith("owner:")
                      ? "Browser caller"
                      : call.caller_id || "Browser caller")}
              </strong>
              <span>
                {message?.message ||
                  call.summary ||
                  (call.status === "failed"
                    ? "Conversation could not connect"
                    : "Open conversation details")}
              </span>
            </div>
            <div className="of-call-meta">
              <time>
                {callDate(call.started_at).toLocaleDateString(undefined, {
                  month: "short",
                  day: "numeric",
                })}
              </time>
              <span>
                {call.status === "failed"
                  ? call.environment === "test"
                    ? "Rehearsal failed"
                    : "Call failed"
                  : call.environment === "test"
                    ? "Rehearsal"
                    : message?.message
                      ? "Message"
                      : "Conversation"}
              </span>
            </div>
            <Icon name="arrow" size={18} />
          </button>
        );
      })}
    </div>
  );
}
export function Conversations({
  initial,
  onBack,
}: {
  initial?: string;
  onBack: () => void;
}) {
  const [page, setPage] = useState<Page<Call>>({ items: [], nextCursor: null });
  const [detail, setDetail] = useState<CallDetail | null>(null);
  const [filter, setFilter] = useState<"all" | "test" | "live">("all");
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const listGeneration = useRef(0);
  const detailGeneration = useRef(0);
  async function load(cursor?: string) {
    const run = ++listGeneration.current;
    setBusy(true);
    setError("");
    try {
      const data = await api.calls({
        environment: filter,
        search,
        cursor,
        limit: 30,
      });
      if (run === listGeneration.current)
        setPage((p) =>
          cursor ? { ...data, items: [...p.items, ...data.items] } : data,
        );
    } catch (e) {
      if (run === listGeneration.current) setError(errorText(e));
    } finally {
      if (run === listGeneration.current) setBusy(false);
    }
  }
  async function open(id: string) {
    const run = ++detailGeneration.current;
    setBusy(true);
    setError("");
    try {
      const found = await api.call(id);
      let name = found.assistant_name;
      if (!name && found.assistant_id) {
        try {
          name = (await api.assistant(found.assistant_id)).name;
        } catch {
          /* Deleted assistants retain their original call record. */
        }
      }
      if (run === detailGeneration.current)
        setDetail({ ...found, assistant_name: name });
    } catch (e) {
      if (run === detailGeneration.current) setError(errorText(e));
    } finally {
      if (run === detailGeneration.current) setBusy(false);
    }
  }
  useEffect(() => {
    if (initial) void open(initial);
    return () => {
      detailGeneration.current++;
    };
  }, [initial]);
  useEffect(() => {
    void load();
    return () => {
      listGeneration.current++;
    };
  }, [filter]);
  const message = detail ? callbackMessage(detail.message_json) : null;
  return (
    <section className="of-brand-operations of-brand-conversations">
      <button
        className="of-back"
        onClick={
          detail
            ? () => {
                detailGeneration.current++;
                setDetail(null);
                setNotice("");
              }
            : onBack
        }
      >
        <Icon name="back" size={18} />
        {detail ? "All conversations" : "Back to your desk"}
      </button>
      <div className="of-page-heading">
        <div>
          <h1>{detail ? "The conversation" : "Messages & conversations"}</h1>
          <p>
            {detail
              ? `${callDate(detail.started_at).toLocaleString()} · ${detail.environment === "test" ? "Browser rehearsal" : "Live conversation"}`
              : "The details your callers leave, ready for your follow-up."}
          </p>
        </div>
        <Button
          kind="line"
          disabled={busy}
          onClick={() => (detail ? void open(detail.id) : void load())}
        >
          {busy ? "Refreshing…" : "Refresh"}
        </Button>
      </div>
      {error && <Notice error>{error}</Notice>}
      {notice && <Notice>{notice}</Notice>}
      {detail ? (
        <div className="of-conversation-layout">
          <section className={`of-message-detail ${message?.message ? "is-message-slip" : ""}`}>
            <h2>
              {message?.message ? "A message for you" : "Conversation overview"}
            </h2>
            {message?.message ? (
              <>
                <p className="of-message-body">{message.message}</p>
                <dl>
                  <dt>Caller</dt>
                  <dd>{message.caller_name || "Name not provided"}</dd>
                  <dt>Callback number</dt>
                  <dd>
                    {message.caller_phone ? (
                      <a href={`tel:${message.caller_phone}`}>
                        {message.caller_phone}
                      </a>
                    ) : (
                      "Not provided"
                    )}
                  </dd>
                </dl>
                <div className="of-message-next-step">
                  <span>Next step</span>
                  <p>Review the request and follow up with the caller.</p>
                </div>
              </>
            ) : (
              <p>
                {detail.summary || "No summary recorded for this conversation."}
              </p>
            )}
            <dl>
              <dt>Status</dt>
              <dd>{detail.status}</dd>
              <dt>Receptionist</dt>
              <dd>
                {detail.assistant_name ||
                  (detail.assistant_id
                    ? "Receptionist no longer available"
                    : "Not recorded")}
              </dd>
              {detail.outcome && (
                <>
                  <dt>Outcome</dt>
                  <dd>{detail.outcome}</dd>
                </>
              )}
              {detail.duration_s != null && (
                <>
                  <dt>Duration</dt>
                  <dd>{detail.duration_s} seconds</dd>
                </>
              )}
            </dl>
            {detail.failure_message && (
              <Notice error>{detail.failure_message}</Notice>
            )}
          </section>
          <section className="of-transcript">
            <h2>What was said</h2>
            {detail.turns.length ? (
              detail.turns.map((turn) => (
                <article key={turn.id} className={turn.role === "caller" ? "is-caller" : "is-receptionist"}>
                  <strong>
                    {turn.role === "caller"
                      ? "Caller"
                      : detail.assistant_name || "Receptionist"}
                  </strong>
                  <p>{turn.text}</p>
                  {turn.role === "caller" && (
                    <button
                      className="of-text-button"
                      onClick={async () => {
                        try {
                          await api.knowledgeFromTurn(detail.id, turn.id);
                          setNotice(
                            "Saved as a draft question. Add its answer under “What they know” before using it in calls.",
                          );
                        } catch (e) {
                          setError(errorText(e));
                        }
                      }}
                    >
                      Save as a question to answer
                    </button>
                  )}
                </article>
              ))
            ) : (
              <p className="of-help">No transcript was recorded.</p>
            )}
          </section>
        </div>
      ) : (
        <>
          <form
            className="of-list-toolbar"
            onSubmit={(e) => {
              e.preventDefault();
              void load();
            }}
          >
            <input
              aria-label="Search conversations"
              placeholder="Search conversations…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <select
              aria-label="Conversation type"
              value={filter}
              onChange={(e) => setFilter(e.target.value as typeof filter)}
            >
              <option value="all">All conversations</option>
              <option value="live">Live conversations</option>
              <option value="test">Browser rehearsals</option>
            </select>
            <Button type="submit" kind="line">
              Search
            </Button>
          </form>
          {page.items.length ? (
            <CallRows calls={page.items} onOpen={(id) => void open(id)} />
          ) : (
            !busy && (
              <Empty title="No conversations here yet">
                Try a browser conversation from your desk. Its transcript will
                appear here.
              </Empty>
            )
          )}
          {page.nextCursor && (
            <Button
              kind="line"
              disabled={busy}
              onClick={() => void load(page.nextCursor!)}
            >
              Load more
            </Button>
          )}
        </>
      )}
      {detail?.environment === 'test' && <CallDiagnostics key={detail.id} callId={detail.id} active={detail.status === 'active'} />}
    </section>
  );
}
