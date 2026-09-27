import { useEffect, useRef, useState } from "react";
import { api } from "../cleanroom-runtime";
import type {
  Assistant,
  Collection,
  CollectionDetail,
  KnowledgeFields,
} from "../cleanroom-runtime";
import { Button, Field, Notice, errorText, useDirtyGuard } from "./ui";
import { Icon } from "./icons";
const blank: KnowledgeFields = {
  kind: "faq",
  status: "active",
  title: "",
  question: "",
  answer: "",
  content: "",
};
export function Knowledge({
  assistant,
  onChanged,
}: {
  assistant: Assistant;
  onChanged: () => void;
}) {
  const [collections, setCollections] = useState<Collection[]>([]);
  const [collection, setCollection] = useState<CollectionDetail | null>(null);
  const [draft, setDraft] = useState<KnowledgeFields>(blank);
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const generation = useRef(0);
  const attached =
    !!collection && assistant.collectionIds?.includes(collection.id);
  useDirtyGuard(adding);
  async function load(key?: string) {
    const run = ++generation.current;
    try {
      const groups = await api.collections();
      if (run !== generation.current) return;
      setCollections(groups);
      const next =
        key ||
        collection?.id ||
        groups.find((g) => assistant.collectionIds?.includes(g.id))?.id ||
        groups[0]?.id;
      const detail = next ? await api.collection(next) : null;
      if (run === generation.current) setCollection(detail);
    } catch (e) {
      if (run === generation.current) setError(errorText(e));
    }
  }
  useEffect(() => {
    void load();
    return () => {
      generation.current++;
    };
  }, [assistant.id]);
  async function save() {
    if (busy) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      let target = collection;
      if (!target) {
        const made = await api.createCollection({
          name: "Business information",
        });
        target = await api.collection(made.id);
        setCollection(target);
      }
      const saved = editing
        ? await api.saveKnowledge(editing, draft)
        : await api.createKnowledge(target.id, draft);
      // Keep the acknowledged identity if attachment or refresh fails: retry must update, not duplicate.
      setEditing(saved.id);
      setDraft(saved);
      if (!assistant.collectionIds?.includes(target.id))
        await api.attachKnowledge(assistant.id, target.id);
      setDraft(blank);
      setEditing(null);
      setAdding(false);
      setMessage(
        saved.status === "active"
          ? "Saved and connected. Eligible for your receptionist’s next conversation."
          : "Draft saved. It will not be used in conversations until you activate it.",
      );
      onChanged();
      await load(target.id);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  const cancel = () => {
    if (adding && !window.confirm("Discard this unsaved answer?")) return;
    setAdding(false);
    setEditing(null);
    setDraft(blank);
  };
  return (
    <div className="of-knowledge of-brand-knowledge">
      {error && <Notice error>{error}</Notice>}
      {message && <Notice>{message}</Notice>}
      <p className="of-help">
        Give your receptionist the answers a colleague would need: opening
        hours, services, and common questions.
      </p>
      {collections.length > 0 && (
        <div className="of-inline-controls">
          <Field label="Information collection">
            <select
              disabled={busy}
              value={collection?.id || ""}
              onChange={(e) => {
                if (
                  adding &&
                  !window.confirm(
                    "Discard this unsaved answer and change collection?",
                  )
                )
                  return;
                setAdding(false);
                setEditing(null);
                setDraft(blank);
                setMessage("");
                void load(e.target.value);
              }}
            >
              {collections.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
          {collection && (
            <Button
              kind="quiet"
              disabled={busy || adding}
              onClick={async () => {
                setBusy(true);
                setError("");
                try {
                  if (attached)
                    await api.detachKnowledge(assistant.id, collection.id);
                  else await api.attachKnowledge(assistant.id, collection.id);
                  onChanged();
                } catch (e) {
                  setError(errorText(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              {attached ? "Remove from receptionist" : "Use this collection"}
            </Button>
          )}
        </div>
      )}
      {collection && !attached && (
        <Notice>
          This collection is not connected to this receptionist. Saving an
          answer here will connect it.
        </Notice>
      )}
      {!adding ? (
        <>
          <div className="of-answer-list">
            {collection?.items.map((item) => (
              <button
                key={item.id}
                className={item.status === "draft" ? "is-draft" : "is-active"}
                onClick={() => {
                  setDraft({ ...item });
                  setEditing(item.id);
                  setAdding(true);
                  setMessage("");
                }}
              >
                <span>
                  <strong>
                    {item.question || item.title || "Business note"}
                  </strong>
                  <small>
                    {item.kind} ·{" "}
                    {item.status === "draft"
                      ? "Draft — not used in calls"
                      : attached
                        ? "Active · connected to this receptionist"
                        : "Active · collection not connected"}
                  </small>
                </span>
                <Icon name="arrow" size={18} />
              </button>
            ))}
          </div>
          {collection?.nextCursor && (
            <Button
              kind="quiet"
              disabled={busy}
              onClick={async () => {
                const run = ++generation.current;
                setBusy(true);
                try {
                  const next = await api.collection(
                    collection.id,
                    collection.nextCursor!,
                  );
                  if (run === generation.current)
                    setCollection({
                      ...next,
                      items: [...collection.items, ...next.items],
                    });
                } catch (e) {
                  if (run === generation.current) setError(errorText(e));
                } finally {
                  if (run === generation.current) setBusy(false);
                }
              }}
            >
              Load more answers
            </Button>
          )}
          <Button
            kind="line"
            icon="plus"
            onClick={() => {
              setDraft(blank);
              setEditing(null);
              setAdding(true);
              setMessage("");
            }}
          >
            Add business information
          </Button>
          {!!collection?.items.length && (
            <p className="of-help">
              Conversations use up to 32 active entries within the context
              limit. Keep answers concise; larger collections may not fit in
              full.
            </p>
          )}
        </>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
          className="of-form of-knowledge-editor"
        >
          <h3 className="of-reading-title">
            {editing ? "Edit business information" : "Add business information"}
          </h3>
          <Field label="Type of information">
            <select
              value={draft.kind}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  kind: e.target.value as KnowledgeFields["kind"],
                })
              }
            >
              <option value="faq">Question & answer</option>
              <option value="service">Service</option>
              <option value="note">Business note</option>
            </select>
          </Field>
          {draft.kind === "faq" ? (
            <>
              <Field label="What might a customer ask?">
                <input
                  required={draft.status === "active"}
                  value={draft.question}
                  onChange={(e) =>
                    setDraft({ ...draft, question: e.target.value })
                  }
                  placeholder="What time do you close on Friday?"
                />
              </Field>
              <Field label="The answer">
                <textarea
                  required={draft.status === "active"}
                  rows={4}
                  value={draft.answer}
                  onChange={(e) =>
                    setDraft({ ...draft, answer: e.target.value })
                  }
                />
              </Field>
            </>
          ) : (
            <>
              <Field label="Title">
                <input
                  required={
                    draft.status === "active" && draft.kind === "service"
                  }
                  value={draft.title}
                  onChange={(e) =>
                    setDraft({ ...draft, title: e.target.value })
                  }
                />
              </Field>
              <Field label="Details to share with callers">
                <textarea
                  required={draft.status === "active" && draft.kind === "note"}
                  rows={5}
                  value={draft.content}
                  onChange={(e) =>
                    setDraft({ ...draft, content: e.target.value })
                  }
                />
              </Field>
            </>
          )}
          <label className="of-check">
            <input
              type="checkbox"
              checked={draft.status === "active"}
              onChange={(e) =>
                setDraft({
                  ...draft,
                  status: e.target.checked ? "active" : "draft",
                })
              }
            />
            Use this answer in conversations
          </label>
          <div className="of-actions">
            <Button type="submit" disabled={busy}>
              {busy ? "Saving…" : "Save answer"}
            </Button>
            <Button kind="quiet" disabled={busy} onClick={cancel}>
              Cancel
            </Button>
            {editing && (
              <Button
                kind="danger"
                disabled={busy}
                onClick={async () => {
                  if (!confirm("Delete this business information?")) return;
                  setBusy(true);
                  try {
                    await api.removeKnowledge(editing);
                    setAdding(false);
                    setEditing(null);
                    setDraft(blank);
                    await load();
                    onChanged();
                  } catch (e) {
                    setError(errorText(e));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Delete
              </Button>
            )}
          </div>
        </form>
      )}
    </div>
  );
}
