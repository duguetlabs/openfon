import { useRef, useState } from "react";
import type { ReactNode } from "react";
import { api } from "../cleanroom-runtime";
import type { Workspace } from "../cleanroom-runtime";
import { readHourRows, readClosureRows, readFaqRows, serializeHourRows, serializeClosureRows, serializeFaqRows } from "../row-arrays";
import { readServiceRows, serializeServiceRows } from "../service-rows";
import { Button, Field, Notice, errorText, useDirtyGuard } from "./ui";
import { Icon } from "./icons";
import "./business.css";

const basics = ["name", "description", "address", "phone", "website", "timezone"] as const;
const labels = { name: "Business name", description: "What you do", address: "Address", phone: "Contact phone", website: "Website", timezone: "Time zone" };
function snapshot(workspace: Workspace) {
  return { workspace: { ...workspace }, hours: readHourRows(workspace.hours_json, []),
    closures: readClosureRows(workspace.closures_json), services: readServiceRows(workspace.services_json), faqs: readFaqRows(workspace.faqs_json, []) };
}
function Rows({ title, count, children, onAdd, addLabel }: { title: string; count: number; children: ReactNode; onAdd: () => void; addLabel: string }) {
  return <details className="of-provider-section of-business-details">
    <summary><span>{title}</span><small>{count} entries</small></summary>
    <div className="of-form">{children}<Button kind="line" onClick={onAdd}>{addLabel}</Button></div>
  </details>;
}
export function Business({ workspace, onBack, onSaved }: { workspace: Workspace; onBack: (saved?: boolean) => void; onSaved: (next: Workspace) => void }) {
  const [draft, setDraft] = useState(() => snapshot(workspace));
  const [baseline, setBaseline] = useState(draft);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const pending = useRef(false);
  const version = useRef(0);
  const dirty = JSON.stringify(draft) !== JSON.stringify(baseline);
  useDirtyGuard(dirty || busy);
  function change(next: typeof draft) { version.current++; setDraft(next); setNotice(""); }
  async function save() {
    if (pending.current || !dirty) return;
    pending.current = true; setBusy(true); setError("");
    const submitted = draft;
    const submittedVersion = version.current;
    const payload: Partial<Workspace> = Object.fromEntries(basics.map(key => [key, submitted.workspace[key]]));
    // Do not normalize or discard historical JSON on an unrelated contact edit.
    if (JSON.stringify(submitted.hours) !== JSON.stringify(baseline.hours)) payload.hours_json = serializeHourRows(submitted.hours);
    if (JSON.stringify(submitted.closures) !== JSON.stringify(baseline.closures)) payload.closures_json = serializeClosureRows(submitted.closures);
    if (JSON.stringify(submitted.services) !== JSON.stringify(baseline.services)) payload.services_json = serializeServiceRows(submitted.services);
    if (JSON.stringify(submitted.faqs) !== JSON.stringify(baseline.faqs)) payload.faqs_json = serializeFaqRows(submitted.faqs);
    try {
      await api.updateWorkspace(workspace.id, payload);
      const accepted = { ...workspace, ...payload };
      setBaseline(submitted);
      onSaved(accepted);
      setNotice("Business details saved.");
      if (version.current === submittedVersion) onBack(true);
    } catch (e) { setError(errorText(e)); }
    finally { pending.current = false; setBusy(false); }
  }
  return <section>
    <button className="of-back" onClick={() => onBack()}><Icon name="back" size={18} />Back to your desk</button>
    <div className="of-page-heading"><div><h1>Your business</h1><p>The essentials your receptionist can share with callers.</p></div></div>
    {error && <Notice error>{error}</Notice>}{notice && <Notice>{notice}</Notice>}
    <form className="of-business-form of-form" onSubmit={e => { e.preventDefault(); void save(); }}>
      {basics.map(key => <Field key={key} label={labels[key]}>
        {key === "description" ? <textarea rows={4} value={draft.workspace[key] || ""} onChange={e => change({ ...draft, workspace: { ...draft.workspace, [key]: e.target.value } })} />
          : <input required={key === "name"} type={key === "website" ? "url" : key === "phone" ? "tel" : "text"} value={draft.workspace[key] || ""} onChange={e => change({ ...draft, workspace: { ...draft.workspace, [key]: e.target.value } })} />}
      </Field>)}
      <Rows title="Opening hours" count={draft.hours.length} addLabel="Add opening hours" onAdd={() => change({ ...draft, hours: [...draft.hours, { day: "Monday", open: "09:00", close: "17:00", closed: false }] })}>
        {draft.hours.map((row, i) => <div className="of-business-row" role="group" aria-label={`Opening hours ${i + 1}`} key={i}>
          <Field label={`Day ${i + 1}`}><input value={row.day} onChange={e => change({ ...draft, hours: draft.hours.map((value, index) => index === i ? { ...value, day: e.target.value } : value) })} /></Field>
          <label className="of-check"><input type="checkbox" checked={!row.closed} onChange={e => change({ ...draft, hours: draft.hours.map((value, index) => index === i ? { ...value, closed: !e.target.checked } : value) })} />Open on {row.day || `day ${i + 1}`}</label>
          {!row.closed && <div className="of-business-pair">
            <Field label={`${row.day} opening time`}><input type="time" value={row.open} onChange={e => change({ ...draft, hours: draft.hours.map((value, index) => index === i ? { ...value, open: e.target.value } : value) })} /></Field>
            <Field label={`${row.day} closing time`}><input type="time" value={row.close} onChange={e => change({ ...draft, hours: draft.hours.map((value, index) => index === i ? { ...value, close: e.target.value } : value) })} /></Field>
          </div>}
          <Button kind="quiet" onClick={() => change({ ...draft, hours: draft.hours.filter((_, index) => index !== i) })}>Remove opening hours {i + 1}</Button>
        </div>)}
      </Rows>
      <Rows title="Holidays & special closures" count={draft.closures.length} addLabel="Add closure" onAdd={() => change({ ...draft, closures: [...draft.closures, { date: "", reason: "" }] })}>
        {draft.closures.map((row, i) => <div className="of-business-row" key={i}>
          <Field label={`Closure ${i + 1} date`}><input type="date" required value={row.date} onChange={e => change({ ...draft, closures: draft.closures.map((value, index) => index === i ? { ...value, date: e.target.value } : value) })} /></Field>
          <Field label={`Closure ${i + 1} reason`}><input value={row.reason || ""} onChange={e => change({ ...draft, closures: draft.closures.map((value, index) => index === i ? { ...value, reason: e.target.value } : value) })} /></Field>
          <Button kind="quiet" onClick={() => change({ ...draft, closures: draft.closures.filter((_, index) => index !== i) })}>Remove closure {i + 1}</Button>
        </div>)}
      </Rows>
      <Rows title="Services & prices" count={draft.services.length} addLabel="Add service" onAdd={() => change({ ...draft, services: [...draft.services, { name: "", price: "" }] })}>
        {draft.services.map((row, i) => <div className="of-business-row" key={i}>
          <Field label={`Service ${i + 1} name`}><input value={row.name} onChange={e => change({ ...draft, services: draft.services.map((value, index) => index === i ? { ...value, name: e.target.value } : value) })} /></Field>
          <Field label={`Service ${i + 1} price`}><input value={row.price || ""} onChange={e => change({ ...draft, services: draft.services.map((value, index) => index === i ? { ...value, price: e.target.value } : value) })} /></Field>
          <Button kind="quiet" onClick={() => change({ ...draft, services: draft.services.filter((_, index) => index !== i) })}>Remove service {i + 1}</Button>
        </div>)}
      </Rows>
      <Rows title="Common questions" count={draft.faqs.length} addLabel="Add question" onAdd={() => change({ ...draft, faqs: [...draft.faqs, { q: "", a: "" }] })}>
        {draft.faqs.map((row, i) => <div className="of-business-row" key={i}>
          <Field label={`FAQ ${i + 1} question`}><input value={row.q} onChange={e => change({ ...draft, faqs: draft.faqs.map((value, index) => index === i ? { ...value, q: e.target.value } : value) })} /></Field>
          <Field label={`FAQ ${i + 1} answer`}><textarea rows={3} value={row.a} onChange={e => change({ ...draft, faqs: draft.faqs.map((value, index) => index === i ? { ...value, a: e.target.value } : value) })} /></Field>
          <Button kind="quiet" onClick={() => change({ ...draft, faqs: draft.faqs.filter((_, index) => index !== i) })}>Remove question {i + 1}</Button>
        </div>)}
      </Rows>
      <Button type="submit" disabled={busy || !dirty}>{busy ? "Saving…" : "Save business details"}</Button>
    </form>
  </section>;
}
