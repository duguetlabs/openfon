import { useEffect, useState } from "react";
import { request, callDate, type AssistantSummary } from "../cleanroom-runtime";
import type { ActionItem } from "./Inbox";
import { Button, Notice, Loading, Empty, errorText } from "./ui";
type Snapshot = {
  from: string;
  timezone: string;
  calls: { calls: number; seconds: number; average_seconds: number };
  actions: { booking_requests: number; urgent: number; messages: number };
  confirmed_bookings: number;
};
export function Dashboard({
  businessName,
  assistants,
  onNavigate,
  onAssistant,
  onAdd,
}: {
  businessName: string;
  assistants: AssistantSummary[];
  onNavigate: (screen: string, query?: Record<string, string>) => void;
  onAssistant: (id: string) => void;
  onAdd: () => void;
}) {
  const [data, setData] = useState<Snapshot | null>(null);
  const [items, setItems] = useState<ActionItem[]>([]);
  const [error, setError] = useState("");
  const [copy, setCopy] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    setError("");
    Promise.all([
      request<Snapshot>("/api/me/dashboard"),
      request<{ items: ActionItem[] }>(
        "/api/me/actions?status=open&environment=live",
      ),
    ])
      .then(([d, a]) => {
        if (active) {
          setData(d);
          setItems(a.items.slice(0, 5));
        }
      })
      .catch((e) => {
        if (active) setError(errorText(e));
      });
    return () => {
      active = false;
    };
  }, [revision]);
  return (
    <section className="of-managed-page">
      <div className="of-page-heading">
        <div>
          <h1>Your reception, at a glance.</h1>
          <p>{businessName} · What needs your attention today?</p>
        </div>
        <Button kind="line" onClick={() => setRevision((v) => v + 1)}>
          Refresh
        </Button>
      </div>
      {error && <Notice error>{error}</Notice>}
      {!data && !error ? (
        <Loading />
      ) : (
        data && (
          <>
            <section
              className="of-dashboard-stats"
              aria-label="Business statistics"
            >
              <button
                onClick={() =>
                  onNavigate("conversations", {
                    from: data.from,
                    environment: "live",
                  })
                }
              >
                <strong>{data.calls.calls}</strong>
                <span>Calls this week</span>
              </button>
              <button
                onClick={() =>
                  onNavigate("conversations", {
                    from: data.from,
                    environment: "live",
                  })
                }
              >
                <strong>{(data.calls.seconds / 60).toFixed(1)}</strong>
                <span>Minutes this week</span>
              </button>
              <button
                onClick={() =>
                  onNavigate("conversations", {
                    from: data.from,
                    environment: "live",
                  })
                }
              >
                <strong>{(data.calls.average_seconds / 60).toFixed(1)}</strong>
                <span>Minutes per call</span>
              </button>
              <button
                onClick={() =>
                  onNavigate("inbox", {
                    kind: "booking_request",
                    status: "open",
                  })
                }
              >
                <strong>{data.actions.booking_requests}</strong>
                <span>Booking requests</span>
              </button>
              <button
                onClick={() =>
                  onNavigate("inbox", { urgent: "true", status: "open" })
                }
              >
                <strong>{data.actions.urgent}</strong>
                <span>Urgent or overdue</span>
              </button>
            </section>
            <p className="of-help">
              Call statistics start Monday in {data.timezone}. Requests need
              your confirmation; OpenFon does not book appointments
              automatically.
            </p>
          </>
        )
      )}
      <div className="of-dashboard-columns">
        <section>
          <div className="of-sheet-heading">
            <h2>Recent messages & requests</h2>
            <Button kind="quiet" onClick={() => onNavigate("inbox")}>
              Open inbox
            </Button>
          </div>
          {items.length ? (
            <div className="of-dashboard-messages">
              {items.map((a) => (
                <button
                  key={a.id}
                  onClick={() =>
                    onNavigate("conversations", { call: a.call_id })
                  }
                >
                  <strong>
                    {a.caller_name || "Caller"} · {a.kind.replaceAll("_", " ")}
                  </strong>
                  <p>{a.content}</p>
                  <small>
                    {a.assistant_name || "Assistant"} ·{" "}
                    {callDate(a.created_at).toLocaleDateString()}
                  </small>
                </button>
              ))}
            </div>
          ) : data ? (
            <Empty title="A clear desk.">
              Your callers’ messages and requests will appear here.
            </Empty>
          ) : null}
        </section>
        <section>
          <div className="of-sheet-heading">
            <h2>Your assistants</h2>
            <Button kind="quiet" onClick={onAdd}>
              Add assistant
            </Button>
          </div>
          {copy && <Notice>{copy}</Notice>}
          {assistants.map((a) => (
            <article key={a.id} className="of-dashboard-assistant">
              <div>
                <h3>{a.name}</h3>
                <p>
                  {a.state === "active"
                    ? "Available"
                    : a.state === "paused"
                      ? "Paused"
                      : "Draft"}
                </p>
              </div>
              <div className="of-action-controls">
                <Button kind="line" onClick={() => onAssistant(a.id)}>
                  Test & edit
                </Button>
                <Button
                  kind="quiet"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(
                        `${location.origin}/call/${a.public_slug}`,
                      );
                      setCopy(`Link copied for ${a.name}.`);
                    } catch {
                      setCopy(
                        `Copy this link: ${location.origin}/call/${a.public_slug}`,
                      );
                    }
                  }}
                >
                  Copy link
                </Button>
              </div>
            </article>
          ))}
        </section>
      </div>
    </section>
  );
}
