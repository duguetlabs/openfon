import { useEffect, useRef, useState } from "react";
import { api, ApiError, callbackMessage, callDate } from "../cleanroom-runtime";
import type { AssistantSummary, Call, CallDetail, Page } from "../cleanroom-runtime";
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
  onSelect,
  query,
  onQuery,
  assistants,
  moreAssistants,
  assistantListBusy,
  onMoreAssistants,
}: {
  initial?: string;
  onSelect: (id?: string) => void;
  query: string;
  onQuery: (query: Record<string, string>) => void;
  assistants: AssistantSummary[];
  moreAssistants: boolean;
  assistantListBusy: boolean;
  onMoreAssistants: () => void;
  onBack: () => void;
}) {
  const params = new URLSearchParams(query);
  const [page, setPage] = useState<Page<Call>>({ items: [], nextCursor: null });
  const [detail, setDetail] = useState<CallDetail | null>(null);
  const [selectedId, setSelectedId] = useState<string | undefined>(initial);
  const selected = useRef(initial);
  const [filter, setFilter] = useState<"all" | "test" | "live">(params.get("environment") === "test" ? "test" : params.get("environment") === "live" ? "live" : "all");
  const [search, setSearch] = useState(params.get("search") || "");
  const [listError, setListError] = useState("");
  const [detailError, setDetailError] = useState("");
  const [actionError, setActionError] = useState("");
  const [listBusy, setListBusy] = useState(false);
  const [detailBusy, setDetailBusy] = useState(false);
  const [savingQuestion, setSavingQuestion] = useState(false);
  const questionPending = useRef(false);
  const [notice, setNotice] = useState("");
  const listGeneration = useRef(0);
  const detailGeneration = useRef(0);
  const poll = useRef<ReturnType<typeof setTimeout> | null>(null);
  const polls = useRef(0);
  const busy = selectedId ? detailBusy : listBusy;
  function clearPoll() { if (poll.current) clearTimeout(poll.current); poll.current = null; }
  async function load(cursor?: string) {
    const run = ++listGeneration.current;
    setListBusy(true); setListError("");
    if (!cursor) setPage({ items: [], nextCursor: null });
    try {
      const committed = new URLSearchParams(query);
      const environment = committed.get("environment") === "test" ? "test" : committed.get("environment") === "live" ? "live" : "all";
      const data = await api.calls({ environment, search: committed.get("search") || "", assistantId: committed.get("assistantId") || undefined,
        status: committed.get("status") || undefined, intent: committed.get("intent") || undefined,
        direction: committed.get("direction") === "outbound" ? "outbound" : committed.get("direction") === "inbound" ? "inbound" : undefined,
        from: committed.get("from") || undefined, to: committed.get("to") || undefined, cursor, limit: 30 });
      if (run === listGeneration.current) setPage(current => cursor ? { ...data, items: [...current.items, ...data.items] } : data);
    } catch (e) { if (run === listGeneration.current) setListError(errorText(e)); }
    finally { if (run === listGeneration.current) setListBusy(false); }
  }
  async function open(id: string, automatic = false, failures = 0) {
    clearPoll();
    if (!automatic) {
      polls.current = 0;
      if (selected.current !== id) { setActionError(""); setNotice(""); setDetail(null); }
      selected.current = id; setSelectedId(id);
    }
    const run = ++detailGeneration.current;
    setDetailBusy(true);
    if (!automatic) setDetailError("");
    try {
      const found = await api.call(id);
      let name = found.assistant_name;
      if (!name && found.assistant_id) {
        try { name = (await api.assistant(found.assistant_id)).name; }
        catch { /* A deleted receptionist does not remove the conversation. */ }
      }
      if (run !== detailGeneration.current || selected.current !== id) return;
      setDetail({ ...found, assistant_name: name }); setDetailError("");
      if (["active", "pending", "ringing", "connecting"].includes(found.status) && polls.current++ < 60) {
        poll.current = setTimeout(() => { if (selected.current === id) void open(id, true); }, 3000);
      }
    } catch (e) {
      if (run !== detailGeneration.current || selected.current !== id) return;
      setDetailError(errorText(e));
      const retryable = !(e instanceof ApiError) || e.status >= 500 || e.status === 408 || e.status === 429;
      if (retryable && failures < 2) poll.current = setTimeout(() => {
        if (selected.current === id) void open(id, true, failures + 1);
      }, 3000);
    } finally { if (run === detailGeneration.current) setDetailBusy(false); }
  }
  useEffect(() => {
    let active = true;
    const route = new URLSearchParams(query);
    const routeFilter = route.get("environment") === "test" ? "test" : route.get("environment") === "live" ? "live" : "all";
    const routeSearch = route.get("search") || "";
    setFilter(routeFilter); setSearch(routeSearch);
    Promise.resolve().then(() => {
      if (!active) return;
      if (initial) void open(initial);
      else {
        selected.current = undefined; setSelectedId(undefined); setDetail(null); setDetailError(""); setActionError("");
        void load();
      }
    });
    return () => { active = false; detailGeneration.current++; listGeneration.current++; clearPoll(); };
  }, [initial, query]);
  const message = detail ? callbackMessage(detail.message_json) : null;
  return (
    <section className="of-brand-operations of-brand-conversations">
      <button
        className="of-back"
        onClick={
          selectedId
            ? () => {
                detailGeneration.current++; clearPoll();
                selected.current = undefined; setSelectedId(undefined); setDetail(null);
                setNotice(""); setActionError(""); setDetailError(""); onSelect();
              }
            : onBack
        }
      >
        <Icon name="back" size={18} />
        {selectedId ? "All conversations" : "Back to your desk"}
      </button>
      <div className="of-page-heading">
        <div>
          <h1>{selectedId ? "The conversation" : "Messages & conversations"}</h1>
          <p>
            {detail
              ? `${callDate(detail.started_at).toLocaleString()} · ${detail.environment === "test" ? "Browser rehearsal" : "Live conversation"}`
              : "The details your callers leave, ready for your follow-up."}
          </p>
        </div>
        <Button
          kind="line"
          disabled={busy}
          onClick={() => (selectedId ? void open(selectedId) : void load())}
        >
          {busy ? "Refreshing…" : selectedId && detailError ? "Retry call" : "Refresh"}
        </Button>
      </div>
      {(selectedId ? detailError : listError) && <Notice error>{selectedId ? detailError : listError}</Notice>}
      {actionError && <Notice error>{actionError}</Notice>}
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
                      disabled={savingQuestion}
                      onClick={async () => {
                        if (questionPending.current) return;
                        questionPending.current = true; setSavingQuestion(true); setActionError("");
                        const callId = detail.id;
                        try {
                          await api.knowledgeFromTurn(detail.id, turn.id);
                          if (selected.current !== callId) return;
                          setNotice(
                            "Saved as a draft question. Add its answer under “What they know” before using it in calls.",
                          );
                        } catch (e) {
                          if (selected.current === callId) setActionError(errorText(e));
                        } finally { questionPending.current = false; setSavingQuestion(false); }
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
      ) : selectedId ? (
        <p className="of-help">{busy ? "Opening conversation…" : "Conversation details are unavailable. Retry the request or return to all conversations."}</p>
      ) : (
        <>
          <form
            className="of-list-toolbar"
            onSubmit={(e) => {
              e.preventDefault();
              if (search === (params.get("search") || "") && filter === (params.get("environment") || "all")) void load();
              else onQuery({ search, environment: filter });
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
              onChange={(e) => onQuery({ search, environment: e.target.value })}
            >
              <option value="all">All conversations</option>
              <option value="live">Live conversations</option>
              <option value="test">Browser rehearsals</option>
            </select>
            <select aria-label="Receptionist filter" value={params.get("assistantId") || ""} onChange={e => onQuery({ search, assistantId: e.target.value })}>
              <option value="">All receptionists</option>
              {params.get("assistantId") && !assistants.some(item => item.id === params.get("assistantId")) && <option value={params.get("assistantId")!}>Selected receptionist</option>}
              {assistants.map(item => <option key={item.id} value={item.id}>{item.name || "Unnamed receptionist"}</option>)}
            </select>
            <select aria-label="Call status" value={params.get("status") || ""} onChange={e => onQuery({ search, status: e.target.value })}>
              <option value="">All statuses</option>
              {["active", "completed", "failed", "abandoned"].map(status => <option key={status} value={status}>{status}</option>)}
            </select>
            <Button type="submit" kind="line">Search</Button>
            {moreAssistants && <Button type="button" kind="quiet" disabled={assistantListBusy} onClick={onMoreAssistants}>{assistantListBusy ? "Loading receptionists…" : "Find more receptionists"}</Button>}
          </form>
          {page.items.length ? (
            <CallRows calls={page.items} onOpen={onSelect} />
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
