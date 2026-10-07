import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { api, supportedLanguages } from "../cleanroom-runtime";
import type { Workspace } from "../cleanroom-runtime";
import {
  readHourRows,
  readClosureRows,
  readFaqRows,
  serializeHourRows,
  serializeClosureRows,
  serializeFaqRows,
} from "../row-arrays";
import { readServiceRows, serializeServiceRows } from "../service-rows";
import { Button, Field, Notice, errorText, useDirtyGuard } from "./ui";
import { CountrySelect } from "./CountrySelect";
import { Icon } from "./icons";
import "./business.css";

const basics = [
  "name",
  "description",
  "address",
  "country",
  "phone",
  "website",
  "timezone",
  "contact_email",
  "default_language",
  "shared_instructions",
] as const;
const labels = {
  name: "Business name",
  description: "What you do",
  address: "Address",
  country: "Business country",
  phone: "Contact phone",
  website: "Website",
  timezone: "Time zone",
  contact_email: "Contact email",
  default_language: "Default language",
  shared_instructions: "How your assistants help — shared instructions",
};
function snapshot(workspace: Workspace) {
  return {
    workspace: { ...workspace },
    hours: readHourRows(workspace.hours_json, []),
    closures: readClosureRows(workspace.closures_json),
    services: readServiceRows(workspace.services_json),
    faqs: readFaqRows(workspace.faqs_json, []),
  };
}
function Rows({
  title,
  count,
  children,
  onAdd,
  addLabel,
}: {
  title: string;
  count: number;
  children: ReactNode;
  onAdd: () => void;
  addLabel: string;
}) {
  return (
    <details className="of-provider-section of-business-details">
      <summary>
        <span>{title}</span>
        <small>{count} entries</small>
      </summary>
      <div className="of-form">
        {children}
        <Button kind="line" onClick={onAdd}>
          {addLabel}
        </Button>
      </div>
    </details>
  );
}
export function Business({
  workspace,
  onBack,
  onSaved,
}: {
  workspace: Workspace;
  onBack: (saved?: boolean) => void;
  onSaved: (next: Workspace) => void;
}) {
  const [draft, setDraft] = useState(() => snapshot(workspace));
  const [baseline, setBaseline] = useState(draft);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [refreshPending, setRefreshPending] = useState(false);
  const acknowledged = useRef<{
    submitted: typeof draft;
    version: number;
  } | null>(null);
  const draftRef = useRef(draft);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const pending = useRef(false);
  const version = useRef(0);
  const dirty = JSON.stringify(draft) !== JSON.stringify(baseline);
  useDirtyGuard(dirty || busy || refreshPending);
  function change(next: typeof draft) {
    version.current++;
    draftRef.current = next;
    setDraft(next);
    setNotice("");
  }
  async function readAcceptedWorkspace() {
    const accepted = acknowledged.current;
    if (!accepted) return;
    const fresh = (await api.bootstrap()).workspace;
    if (!mounted.current) return;
    if (!fresh || fresh.id !== workspace.id)
      throw new Error("The saved business is unavailable. Retry the refresh.");
    const canonical = snapshot(fresh);
    const current = draftRef.current;
    const next = { ...canonical, workspace: { ...canonical.workspace } };
    for (const key of basics)
      if (current.workspace[key] !== accepted.submitted.workspace[key])
        Object.assign(next.workspace, { [key]: current.workspace[key] });
    for (const key of ["hours", "closures", "services", "faqs"] as const) {
      if (
        JSON.stringify(current[key]) !== JSON.stringify(accepted.submitted[key])
      )
        Object.assign(next, { [key]: current[key] });
    }
    draftRef.current = next;
    setDraft(next);
    setBaseline(canonical);
    onSaved(fresh);
    acknowledged.current = null;
    setRefreshPending(false);
    setNotice("Business details saved.");
    setError("");
    if (version.current === accepted.version) onBack(true);
  }
  async function retryRefresh() {
    if (pending.current || !acknowledged.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      await readAcceptedWorkspace();
    } catch (e) {
      if (mounted.current)
        setError(
          `Business details were saved, but the latest details could not load. ${errorText(e)}`,
        );
    } finally {
      if (mounted.current) {
        pending.current = false;
        setBusy(false);
      }
    }
  }
  async function save() {
    if (pending.current || acknowledged.current || !dirty) return;
    pending.current = true;
    setBusy(true);
    setError("");
    const submitted = draft;
    const submittedVersion = version.current;
    const payload: Partial<Workspace> = Object.fromEntries(
      basics
        .filter((key) => submitted.workspace[key] !== baseline.workspace[key])
        .map((key) => [key, submitted.workspace[key]]),
    );
    // Do not normalize or discard historical JSON on an unrelated contact edit.
    if (JSON.stringify(submitted.hours) !== JSON.stringify(baseline.hours))
      payload.hours_json = serializeHourRows(submitted.hours);
    if (
      JSON.stringify(submitted.closures) !== JSON.stringify(baseline.closures)
    )
      payload.closures_json = serializeClosureRows(submitted.closures);
    if (
      JSON.stringify(submitted.services) !== JSON.stringify(baseline.services)
    )
      payload.services_json = serializeServiceRows(submitted.services);
    if (JSON.stringify(submitted.faqs) !== JSON.stringify(baseline.faqs))
      payload.faqs_json = serializeFaqRows(submitted.faqs);
    try {
      await api.updateWorkspace(workspace.id, payload);
      if (!mounted.current) return;
      acknowledged.current = { submitted, version: submittedVersion };
      setBaseline(submitted);
      setRefreshPending(true);
      await readAcceptedWorkspace();
    } catch (e) {
      if (mounted.current)
        setError(
          acknowledged.current
            ? `Business details were saved, but the latest details could not load. ${errorText(e)}`
            : errorText(e),
        );
    } finally {
      if (mounted.current) {
        pending.current = false;
        setBusy(false);
      }
    }
  }
  return (
    <section>
      <button className="of-back" onClick={() => onBack()}>
        <Icon name="back" size={18} />
        Back to Home
      </button>
      <div className="of-page-heading">
        <div>
          <h1>My business</h1>
          <p>The essentials your receptionist can share with callers.</p>
        </div>
      </div>
      {error && <Notice error>{error}</Notice>}
      {notice && <Notice>{notice}</Notice>}
      {refreshPending && (
        <Button kind="line" disabled={busy} onClick={() => void retryRefresh()}>
          Retry business refresh
        </Button>
      )}
      <form
        className="of-business-form of-form"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        {basics.map((key) => (
          <Field key={key} label={labels[key]}>
            {key === "country" ? (
              <CountrySelect value={draft.workspace.country} onChange={country=>change({...draft,workspace:{...draft.workspace,country}})} />
            ) : key === "default_language" ? (
              <select
                value={draft.workspace.default_language || "en"}
                onChange={(e) =>
                  change({
                    ...draft,
                    workspace: {
                      ...draft.workspace,
                      default_language: e.target.value,
                    },
                  })
                }
              >
                {draft.workspace.default_language &&
                  !supportedLanguages.some(
                    (v) => v.id === draft.workspace.default_language,
                  ) && (
                    <option value={draft.workspace.default_language}>
                      {draft.workspace.default_language} (saved)
                    </option>
                  )}
                {supportedLanguages.map((language) => (
                  <option key={language.id} value={language.id}>
                    {language.label}
                  </option>
                ))}
              </select>
            ) : key === "description" || key === "shared_instructions" ? (
              <textarea
                rows={4}
                value={draft.workspace[key] || ""}
                onChange={(e) =>
                  change({
                    ...draft,
                    workspace: { ...draft.workspace, [key]: e.target.value },
                  })
                }
              />
            ) : (
              <input
                required={key === "name"}
                type={
                  key === "contact_email"
                    ? "email"
                    : key === "website"
                      ? "url"
                      : key === "phone"
                        ? "tel"
                        : "text"
                }
                value={draft.workspace[key] || ""}
                onChange={(e) =>
                  change({
                    ...draft,
                    workspace: { ...draft.workspace, [key]: e.target.value },
                  })
                }
              />
            )}
          </Field>
        ))}
        <Rows
          title="Opening hours"
          count={draft.hours.length}
          addLabel="Add opening hours"
          onAdd={() =>
            change({
              ...draft,
              hours: [
                ...draft.hours,
                { day: "Monday", open: "09:00", close: "17:00", closed: false },
              ],
            })
          }
        >
          {draft.hours.map((row, i) => (
            <div
              className="of-business-row"
              role="group"
              aria-label={`Opening hours ${i + 1}`}
              key={i}
            >
              <Field label={`Day ${i + 1}`}>
                <input
                  value={row.day}
                  onChange={(e) =>
                    change({
                      ...draft,
                      hours: draft.hours.map((value, index) =>
                        index === i ? { ...value, day: e.target.value } : value,
                      ),
                    })
                  }
                />
              </Field>
              <label className="of-check">
                <input
                  type="checkbox"
                  checked={!row.closed}
                  onChange={(e) =>
                    change({
                      ...draft,
                      hours: draft.hours.map((value, index) =>
                        index === i
                          ? { ...value, closed: !e.target.checked }
                          : value,
                      ),
                    })
                  }
                />
                Open on {row.day || `day ${i + 1}`}
              </label>
              {!row.closed && (
                <div className="of-business-pair">
                  <Field label={`${row.day} opening time`}>
                    <input
                      type="time"
                      value={row.open}
                      onChange={(e) =>
                        change({
                          ...draft,
                          hours: draft.hours.map((value, index) =>
                            index === i
                              ? { ...value, open: e.target.value }
                              : value,
                          ),
                        })
                      }
                    />
                  </Field>
                  <Field label={`${row.day} closing time`}>
                    <input
                      type="time"
                      value={row.close}
                      onChange={(e) =>
                        change({
                          ...draft,
                          hours: draft.hours.map((value, index) =>
                            index === i
                              ? { ...value, close: e.target.value }
                              : value,
                          ),
                        })
                      }
                    />
                  </Field>
                </div>
              )}
              <Button
                kind="quiet"
                onClick={() =>
                  change({
                    ...draft,
                    hours: draft.hours.filter((_, index) => index !== i),
                  })
                }
              >
                Remove opening hours {i + 1}
              </Button>
            </div>
          ))}
        </Rows>
        <Rows
          title="Holidays & special closures"
          count={draft.closures.length}
          addLabel="Add closure"
          onAdd={() =>
            change({
              ...draft,
              closures: [...draft.closures, { date: "", reason: "" }],
            })
          }
        >
          {draft.closures.map((row, i) => (
            <div className="of-business-row" key={i}>
              <Field label={`Closure ${i + 1} date`}>
                <input
                  type="date"
                  required
                  value={row.date}
                  onChange={(e) =>
                    change({
                      ...draft,
                      closures: draft.closures.map((value, index) =>
                        index === i
                          ? { ...value, date: e.target.value }
                          : value,
                      ),
                    })
                  }
                />
              </Field>
              <Field label={`Closure ${i + 1} reason`}>
                <input
                  value={row.reason || ""}
                  onChange={(e) =>
                    change({
                      ...draft,
                      closures: draft.closures.map((value, index) =>
                        index === i
                          ? { ...value, reason: e.target.value }
                          : value,
                      ),
                    })
                  }
                />
              </Field>
              <Button
                kind="quiet"
                onClick={() =>
                  change({
                    ...draft,
                    closures: draft.closures.filter((_, index) => index !== i),
                  })
                }
              >
                Remove closure {i + 1}
              </Button>
            </div>
          ))}
        </Rows>
        <Rows
          title="Services & prices"
          count={draft.services.length}
          addLabel="Add service"
          onAdd={() =>
            change({
              ...draft,
              services: [...draft.services, { name: "", price: "" }],
            })
          }
        >
          {draft.services.map((row, i) => (
            <div className="of-business-row" key={i}>
              <Field label={`Service ${i + 1} name`}>
                <input
                  value={row.name}
                  onChange={(e) =>
                    change({
                      ...draft,
                      services: draft.services.map((value, index) =>
                        index === i
                          ? { ...value, name: e.target.value }
                          : value,
                      ),
                    })
                  }
                />
              </Field>
              <Field label={`Service ${i + 1} price`}>
                <input
                  value={row.price || ""}
                  onChange={(e) =>
                    change({
                      ...draft,
                      services: draft.services.map((value, index) =>
                        index === i
                          ? { ...value, price: e.target.value }
                          : value,
                      ),
                    })
                  }
                />
              </Field>
              <Button
                kind="quiet"
                onClick={() =>
                  change({
                    ...draft,
                    services: draft.services.filter((_, index) => index !== i),
                  })
                }
              >
                Remove service {i + 1}
              </Button>
            </div>
          ))}
        </Rows>
        <Rows
          title="Common questions"
          count={draft.faqs.length}
          addLabel="Add question"
          onAdd={() =>
            change({ ...draft, faqs: [...draft.faqs, { q: "", a: "" }] })
          }
        >
          {draft.faqs.map((row, i) => (
            <div className="of-business-row" key={i}>
              <Field label={`FAQ ${i + 1} question`}>
                <input
                  value={row.q}
                  onChange={(e) =>
                    change({
                      ...draft,
                      faqs: draft.faqs.map((value, index) =>
                        index === i ? { ...value, q: e.target.value } : value,
                      ),
                    })
                  }
                />
              </Field>
              <Field label={`FAQ ${i + 1} answer`}>
                <textarea
                  rows={3}
                  value={row.a}
                  onChange={(e) =>
                    change({
                      ...draft,
                      faqs: draft.faqs.map((value, index) =>
                        index === i ? { ...value, a: e.target.value } : value,
                      ),
                    })
                  }
                />
              </Field>
              <Button
                kind="quiet"
                onClick={() =>
                  change({
                    ...draft,
                    faqs: draft.faqs.filter((_, index) => index !== i),
                  })
                }
              >
                Remove question {i + 1}
              </Button>
            </div>
          ))}
        </Rows>
        <Button type="submit" disabled={busy || refreshPending || !dirty}>
          {busy ? "Saving…" : "Save business details"}
        </Button>
      </form>
    </section>
  );
}
