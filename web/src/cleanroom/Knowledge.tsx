import { useEffect, useRef, useState } from "react";
import { api } from "../cleanroom-runtime";
import type {
  Assistant,
  Collection,
  CollectionDetail,
  KnowledgeFields,
  KnowledgeItem,
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
  onChanged: () => void | Promise<void>;
}) {
  const [collections, setCollections] = useState<Collection[]>([]);
  const [collection, setCollection] = useState<CollectionDetail | null>(null);
  const [draft, rawSetDraft] = useState<KnowledgeFields>(blank);
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [refreshPending, setRefreshPending] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [newName, setNewName] = useState("");
  const [details, setDetails] = useState({ name: "", description: "" });
  const detailsSaved = useRef(details);
  const [attachmentPending, setAttachmentPending] = useState<string | null>(null);
  const [attachedLocal, setAttachedLocal] = useState<Record<string, boolean>>({});
  const generation = useRef(0);
  const selected = useRef<string | undefined>();
  const pending = useRef(false);
  const draftVersion = useRef(0);
  const nameVersion = useRef(0);
  const attached = !!collection && (attachedLocal[collection.id] ?? !!assistant.collectionIds?.includes(collection.id));
  const detailsDirty = JSON.stringify(details) !== JSON.stringify(detailsSaved.current);
  const blocked = busy || refreshPending || !loaded;
  useDirtyGuard(adding || detailsDirty || !!newName.trim() || busy);
  function setDraft(value: KnowledgeFields) { draftVersion.current++; rawSetDraft(value); }
  function begin(recovery = false) {
    if (pending.current || (!recovery && (refreshPending || !loaded))) return false;
    pending.current = true; setBusy(true); generation.current++;
    setError(""); setMessage(""); return true;
  }
  function finish() { pending.current = false; setBusy(false); }
  async function load(key = selected.current) {
    const run = ++generation.current;
    const groups = await api.collections();
    if (run !== generation.current) return false;
    const next = key || groups.find(group => assistant.collectionIds?.includes(group.id))?.id || groups[0]?.id;
    if (key && !groups.some(group => group.id === key)) throw new Error("The selected collection is no longer available. Choose another collection to continue; your draft is retained.");
    const detail = next ? await api.collection(next) : null;
    if (run !== generation.current) return false;
    const previous = detailsSaved.current;
    const nextDetails = { name: detail?.name || "", description: detail?.description || "" };
    const same = selected.current === next;
    setDetails(current => same && JSON.stringify(current) !== JSON.stringify(previous) ? current : nextDetails);
    detailsSaved.current = nextDetails;
    selected.current = next;
    setCollections(groups); setCollection(detail); setLoaded(true);
    return true;
  }
  useEffect(() => {
    let active = true;
    void load().then(accepted => { if (active && accepted) setError(""); }).catch(e => {
      if (active) { setError(errorText(e)); setRefreshPending(true); }
    });
    return () => { active = false; generation.current++; };
  }, [assistant.id]);
  async function refreshKnowledge(key = selected.current) {
    try {
      await onChanged();
      if (!await load(key)) throw new Error("A newer knowledge read started. Retry the refresh.");
      setRefreshPending(false); setError("");
    } catch (e) {
      setRefreshPending(true);
      setError(`Your changes were saved, but knowledge could not be refreshed. ${errorText(e)}`);
    }
  }
  function acceptCollection(row: Collection) {
    selected.current = row.id;
    const value = { name: row.name, description: row.description };
    detailsSaved.current = value; setDetails(value);
    setCollections(rows => [...rows.filter(old => old.id !== row.id), row]);
    setCollection({ ...row, items: [], nextCursor: null, assistants: [] });
  }
  function acceptItem(item: KnowledgeItem) {
    setCollection(current => current && current.id === item.collection_id ? {
      ...current, items: [...current.items.filter(old => old.id !== item.id), item],
      item_count: (current.item_count ?? current.items.length) + (current.items.some(old => old.id === item.id) ? 0 : 1),
    } : current);
  }
  async function save() {
    if (!begin()) return;
    const version = draftVersion.current;
    let targetId = collection?.id;
    try {
      if (!targetId) {
        const made = await api.createCollection({ name: "Business information" });
        acceptCollection(made); targetId = made.id;
      }
      const saved = editing ? await api.saveKnowledge(editing, draft) : await api.createKnowledge(targetId, draft);
      acceptItem(saved);
      setEditing(saved.id);
      if (draftVersion.current === version) { rawSetDraft(blank); setEditing(null); setAdding(false); }
      setMessage(saved.status === "active" ? "Saved and connected. Eligible for your receptionist’s next conversation." : "Draft saved. It will not be used in conversations until you activate it.");
      if (!(attachedLocal[targetId] ?? assistant.collectionIds?.includes(targetId))) {
        try {
          await api.attachKnowledge(assistant.id, targetId);
          setAttachedLocal(current => ({ ...current, [targetId!]: true }));
        } catch (e) {
          setAttachmentPending(targetId);
          setMessage("Answer saved.");
          setError(`Your answer was saved, but connecting it failed. ${errorText(e)}`);
          return;
        }
      }
      await refreshKnowledge(targetId);
    } catch (e) { setError(errorText(e)); }
    finally { finish(); }
  }
  async function createCollection() {
    if (!newName.trim() || !begin()) return;
    const version = nameVersion.current;
    try {
      const made = await api.createCollection({ name: newName.trim() });
      acceptCollection(made);
      if (version === nameVersion.current) setNewName("");
      setMessage("Collection created.");
      await refreshKnowledge(made.id);
    } catch (e) { setError(errorText(e)); }
    finally { finish(); }
  }
  async function saveDetails() {
    if (!collection || !details.name.trim() || !detailsDirty || !begin()) return;
    const submitted = { ...details, name: details.name.trim() };
    try {
      await api.saveCollection(collection.id, submitted);
      const previous = details;
      setDetails(current => JSON.stringify(current) === JSON.stringify(previous) ? submitted : current);
      detailsSaved.current = submitted;
      setCollection(current => current && { ...current, ...submitted });
      setCollections(rows => rows.map(row => row.id === collection.id ? { ...row, ...submitted } : row));
      setMessage("Collection details saved.");
      await refreshKnowledge();
    } catch (e) { setError(errorText(e)); }
    finally { finish(); }
  }
  async function deleteCollection() {
    if (!collection || collection.is_default || !confirm("Delete this collection and its business information?")) return;
    if (!begin()) return;
    try {
      await api.deleteCollection(collection.id);
      setCollections(rows => rows.filter(row => row.id !== collection.id));
      selected.current = undefined; setCollection(null); setAdding(false); setEditing(null); rawSetDraft(blank);
      detailsSaved.current = { name: "", description: "" }; setDetails(detailsSaved.current);
      setMessage("Collection deleted.");
      await refreshKnowledge();
    } catch (e) { setError(errorText(e)); }
    finally { finish(); }
  }
  async function attachment() {
    if (!collection || !begin()) return;
    try {
      if (attached) await api.detachKnowledge(assistant.id, collection.id);
      else await api.attachKnowledge(assistant.id, collection.id);
      setAttachedLocal(current => ({ ...current, [collection.id]: !attached }));
      setMessage(attached ? "Collection disconnected." : "Collection connected.");
      await refreshKnowledge();
    } catch (e) { setError(errorText(e)); }
    finally { finish(); }
  }
  const cancel = () => {
    if (adding && !window.confirm("Discard this unsaved answer?")) return;
    setAdding(false); setEditing(null); setDraft(blank);
  };
  return (
    <div className="of-knowledge of-brand-knowledge">
      {error && <Notice error>{error}</Notice>}
      {message && <Notice>{message}</Notice>}
      {refreshPending && <Button kind="line" disabled={busy} onClick={async () => {
        if (!begin(true)) return;
        try { await refreshKnowledge(); } finally { finish(); }
      }}>Retry knowledge refresh</Button>}
      {attachmentPending && <Button kind="line" disabled={busy} onClick={async () => {
        if (!begin(true)) return;
        try {
          await api.attachKnowledge(assistant.id, attachmentPending);
          setAttachedLocal(current => ({ ...current, [attachmentPending]: true }));
          setAttachmentPending(null); await refreshKnowledge();
        } catch (e) { setError(errorText(e)); } finally { finish(); }
      }}>Retry connecting collection</Button>}
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
              onChange={async (e) => {
                if ((adding || detailsDirty) && !window.confirm("Discard unsaved knowledge edits and change collection?")) return;
                if (!begin(true)) return;
                setAdding(false); setEditing(null); setDraft(blank); setMessage("");
                detailsSaved.current = details;
                try { if (await load(e.target.value)) { setRefreshPending(false); setError(""); } }
                catch (e) { setError(errorText(e)); setRefreshPending(true); }
                finally { finish(); }
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
              disabled={blocked || adding}
              onClick={() => void attachment()}
            >
              {attached ? "Remove from receptionist" : "Use this collection"}
            </Button>
          )}
        </div>
      )}
      <details className="of-provider-section">
        <summary><span>Manage collections</span><small>Shared information</small></summary>
        <div className="of-form">
          {collection && <>
            <Field label="Collection name"><input value={details.name} onChange={e => setDetails(current => ({ ...current, name: e.target.value }))} /></Field>
            <Field label="Collection description"><textarea rows={2} value={details.description} onChange={e => setDetails(current => ({ ...current, description: e.target.value }))} /></Field>
            <div className="of-actions"><Button kind="line" disabled={blocked || !detailsDirty || !details.name.trim()} onClick={() => void saveDetails()}>Save collection details</Button>
            {!collection.is_default && <Button kind="danger" disabled={blocked || adding} onClick={() => void deleteCollection()}>Delete collection</Button>}</div>
          </>}
          <Field label="New collection"><input value={newName} onChange={e => { nameVersion.current++; setNewName(e.target.value); }} /></Field>
          <Button kind="line" disabled={blocked || adding || detailsDirty || !newName.trim()} onClick={() => void createCollection()}>Create collection</Button>
        </div>
      </details>
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
                disabled={busy}
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
                if (!begin()) return;
                const run = generation.current;
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
                  finish();
                }
              }}
            >
              Load more answers
            </Button>
          )}
          <Button
            kind="line"
            icon="plus"
            disabled={busy || !loaded}
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
            <Button type="submit" disabled={blocked || !!attachmentPending}>
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
                  if (!confirm("Delete this business information?") || !begin()) return;
                  const id = editing;
                  try {
                    await api.removeKnowledge(id);
                    setCollection(current => current && { ...current, items: current.items.filter(item => item.id !== id), item_count: Math.max(0, (current.item_count ?? current.items.length) - 1) });
                    setAdding(false); setEditing(null); setDraft(blank); setMessage("Business information deleted.");
                    await refreshKnowledge();
                  } catch (e) { setError(errorText(e)); }
                  finally { finish(); }
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
