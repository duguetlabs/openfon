import { useEffect, useRef, useState } from "react";
import { request, callDate } from "../cleanroom-runtime";
import { Button, Field, Notice, Loading, Empty, errorText } from "./ui";
export interface ActionItem {
  id: string;
  call_id: string;
  kind: string;
  content: string;
  caller_name: string;
  caller_phone: string;
  assistant_name: string;
  status: "open" | "handled";
  urgent: number;
  due_at: string | null;
  created_at: string;
  environment: string;
}
const names: Record<string, string> = {
  booking_request: "Booking request",
  message: "Message",
  callback: "Callback request",
  todo: "To-do",
};
export function Inbox({
  query = "",
  onCall,
  onQuery,
}: {
  query?: string;
  onCall: (id: string) => void;
  onQuery: (query: Record<string, string>) => void;
}) {
  const params = new URLSearchParams(query);
  const status = params.get("status") || "open";
  const kind = params.get("kind") || "";
  const urgent = params.get("urgent") || "";
  const environment = params.get("environment") || "live";
  const [items, setItems] = useState<ActionItem[]>([]);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState("");
  const generation = useRef(0);
  const lock = useRef(false);
  const loading = useRef(false);
  async function load(append = false, navigation = false) {
    if (lock.current && !navigation) return;
    loading.current = true;
    const gen = ++generation.current;
    setBusy(true);
    setError("");
    try {
      const q = new URLSearchParams({
        status,
        kind,
        urgent,
        environment,
        offset: String(append ? items.length : 0),
      });
      const result = await request<{ items: ActionItem[]; hasMore: boolean }>(
        `/api/me/actions?${q}`,
      );
      if (gen !== generation.current) return;
      setItems((old) =>
        append
          ? [
              ...old,
              ...result.items.filter((a) => !old.some((b) => a.id === b.id)),
            ]
          : result.items,
      );
      setMore(result.hasMore);
    } catch (e) {
      if (gen === generation.current) setError(errorText(e));
    } finally {
      if (gen === generation.current) {
        loading.current = false;
        setBusy(false);
      }
    }
  }
  useEffect(() => {
    void load(false, true);
    return () => {
      generation.current++;
    };
  }, [query]);
  const filter = (change: Record<string, string>) =>
    onQuery({ status, kind, urgent, environment, ...change });
  async function update(item: ActionItem, patch: object) {
    if (lock.current || loading.current) return;
    lock.current = true;
    setPending(item.id);
    setError("");
    const gen = generation.current;
    try {
      await request(
        `/api/me/actions/${encodeURIComponent(item.id)}`,
        "PATCH",
        patch,
      );
      if (gen !== generation.current) return;
      setNotice("Item updated.");
      if (urgent === "true") {
        // Membership depends on the server's clock and combined urgency/date
        // predicate. Restart paging rather than guessing that predicate locally.
        setItems([]);
        setMore(false);
        await load(false, true);
        return;
      }
      setItems((old) =>
        old
          .map((a) => (a.id === item.id ? { ...a, ...patch } : a))
          .filter((a) => status === "all" || a.status === status),
      );
    } catch (e) {
      if (gen === generation.current) setError(errorText(e));
    } finally {
      lock.current = false;
      setPending("");
    }
  }
  return (
    <section className="of-managed-page">
      <div className="of-page-heading">
        <div>
          <h1>Messages & to-dos</h1>
          <p>
            What callers need from you. Every item links to its conversation.
          </p>
        </div>
        <Button kind="line" disabled={busy || Boolean(pending)} onClick={() => void load()}>
          Refresh
        </Button>
      </div>
      <div className="of-filter-bar">
        <Field label="Status">
          <select
            disabled={busy || Boolean(pending)}
            value={status}
            onChange={(e) => filter({ status: e.target.value })}
          >
            <option value="open">Needs attention</option>
            <option value="handled">Handled</option>
            <option value="all">All</option>
          </select>
        </Field>
        <Field label="Type">
          <select
            disabled={busy || Boolean(pending)}
            value={kind}
            onChange={(e) => filter({ kind: e.target.value })}
          >
            <option value="">All types</option>
            {Object.entries(names).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Priority">
          <select
            disabled={busy || Boolean(pending)}
            value={urgent}
            onChange={(e) => filter({ urgent: e.target.value })}
          >
            <option value="">All priorities</option>
            <option value="true">Urgent or overdue</option>
          </select>
        </Field>
        <Field label="Calls">
          <select
            disabled={busy || Boolean(pending)}
            value={environment}
            onChange={(e) => filter({ environment: e.target.value })}
          >
            <option value="live">Customer calls</option>
            <option value="test">Private tests</option>
            <option value="all">All calls</option>
          </select>
        </Field>
      </div>
      {error && (
        <Notice error>
          {error} <button onClick={() => void load()}>Retry</button>
        </Notice>
      )}
      {notice && <Notice>{notice}</Notice>}
      {busy && !items.length ? (
        <Loading />
      ) : !items.length && !error ? (
        <Empty title="Nothing here yet.">
          Messages, requests and to-dos captured during calls will appear here.
          An appointment request is not a confirmed booking.
        </Empty>
      ) : (
        <div className="of-action-list">
          {items.map((item) => (
            <article key={item.id} className="of-action-row">
              <div>
                <span className="of-status">
                  {names[item.kind]} · {item.status}
                </span>
                <h2>{item.caller_name || "Caller"}</h2>
                <p>{item.content}</p>
                <small>
                  {item.assistant_name || "Assistant no longer available"} ·{" "}
                  {callDate(item.created_at).toLocaleString()}
                </small>
                {item.caller_phone && (
                  <p>
                    <a href={`tel:${item.caller_phone}`}>{item.caller_phone}</a>
                  </p>
                )}
                <div className="of-action-controls">
                  <Button kind="line" onClick={() => onCall(item.call_id)}>
                    View source call
                  </Button>
                  <Button
                    disabled={busy || Boolean(pending)}
                    onClick={() =>
                      void update(item, {
                        status: item.status === "open" ? "handled" : "open",
                      })
                    }
                  >
                    {pending === item.id
                      ? "Saving…"
                      : item.status === "open"
                        ? "Mark handled"
                        : "Reopen"}
                  </Button>
                </div>
              </div>
              <div className="of-action-due">
                <Field label="Due date">
                  <input
                    type="date"
                    value={item.due_at?.slice(0, 10) || ""}
                    disabled={busy || Boolean(pending)}
                    onChange={(e) =>
                      void update(item, {
                        due_at: e.target.value
                          ? `${e.target.value}T23:59:59.000Z`
                          : null,
                      })
                    }
                  />
                </Field>
                <label className="of-check">
                  <input
                    type="checkbox"
                    checked={Boolean(item.urgent)}
                    disabled={busy || Boolean(pending)}
                    onChange={(e) =>
                      void update(item, { urgent: e.target.checked })
                    }
                  />
                  Urgent
                </label>
              </div>
            </article>
          ))}
        </div>
      )}
      {more && (
        <Button kind="line" disabled={busy || Boolean(pending)} onClick={() => void load(true)}>
          Load more items
        </Button>
      )}
    </section>
  );
}
