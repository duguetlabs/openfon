import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { confirmDiscardUnsaved, useUnsavedEdits } from '../unsaved-edits';
import { api } from '../api';
import { useSession } from '../App';
import {
  readFaqRows,
  readHourRows,
  serializeFaqRows,
  serializeHourRows,
  type FaqRow,
  type HourRow,
} from '../row-arrays';
import { readServiceRows, serializeServiceRows, type ServiceRow } from '../service-rows';
import { Button, Card, Field, FieldLabel, Logo, TextArea, LANGUAGES, inputClassSm } from '../ui';

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

export default function Onboarding() {
  const { business, workspaceReady, firstAssistant, refresh, signOut } = useSession();
  const navigate = useNavigate();
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);
  const defaultHours = DAYS.map((day) => ({
    day,
    open: '09:00',
    close: '17:00',
    closed: day === 'Saturday' || day === 'Sunday',
  }));
  const [step, setStep] = useState(business && workspaceReady ? 2 : 0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [refreshPending, setRefreshPending] = useState(false);

  const [name, setName] = useState(business?.name ?? '');
  const [description, setDescription] = useState(business?.description ?? '');
  const [address, setAddress] = useState(business?.address ?? '');
  const [phone, setPhone] = useState(business?.phone ?? '');
  const [hours, setHours] = useState<HourRow[]>(() => readHourRows(business?.hours_json, defaultHours));
  const [services, setServices] = useState<ServiceRow[]>(() => readServiceRows(business?.services_json));
  const [faqs, setFaqs] = useState<FaqRow[]>(() => readFaqRows(business?.faqs_json, [{ q: '', a: '' }]));
  const [agentName, setAgentName] = useState(business?.agent?.agent_name || 'Alex');
  const [persona, setPersona] = useState(
    business?.agent?.persona || 'friendly and professional'
  );
  const [language, setLanguage] = useState(business?.agent?.language || 'en');
  const [greeting, setGreeting] = useState(business?.agent?.greeting || '');

  const draft = JSON.stringify({ name, description, address, phone, hours, services, faqs, agentName, persona, language, greeting });
  const savedDraft = useRef(draft);
  const markSaved = useUnsavedEdits(draft !== savedDraft.current);

  async function openStudio() {
    if (!active.current) return;
    setBusy(true);
    setError('');
    try {
      await refresh();
      if (active.current) navigate('/overview');
    } catch {
      if (active.current) setError('Workspace saved, but the studio could not be loaded. Retry opening the studio.');
    } finally {
      if (active.current) setBusy(false);
    }
  }

  async function finish() {
    if (!active.current || busy || refreshPending) return;
    if (!name.trim() || !description.trim() || !agentName.trim() || !persona.trim() || !language.trim()) {
      setError('Complete the required workspace and assistant details first.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const workspace = {
        name,
        description,
        address,
        phone,
        timezone: business?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
        hours_json: serializeHourRows(hours),
        services_json: serializeServiceRows(services),
        faqs_json: serializeFaqRows(faqs),
      };
      // POST returns this user's canonical workspace even on retries/concurrent
      // creation (index.ts); a later failed read can leave session business null.
      // Keep the following PUT: a retry may contain edits made after the original
      // creation. e2e/onboarding-retry.spec.ts covers interrupted setup with the
      // same workspace ID, not every refresh-failure/edited-payload combination.
      const biz = business ?? (await api.createBusiness(workspace));
      if (!active.current) return;
      await api.updateBusiness(biz.id, workspace);
      if (!active.current) return;
      // Workspace creation provisions a draft primary assistant. Update it through
      // the studio API so setup does not implicitly publish a public call line.
      const primary = firstAssistant ?? (await api.assistants()).find(a => a.public_slug === biz.slug);
      if (!active.current) return;
      if (!primary) throw new Error('Your first assistant could not be loaded. Reload to resume setup.');
      await api.updateAssistant(primary.id, { name: agentName, persona, language, greeting });
      if (!active.current) return;
      savedDraft.current = draft;
      markSaved();
      // Both writes are acknowledged. Recovery from here must only read;
      // incomplete setup above still accepts intentional edited-draft retries.
      setRefreshPending(true);
      await openStudio();
    } catch (err) {
      if (!active.current) return;
      setError(err instanceof Error ? err.message : 'Something went wrong');
      setBusy(false);
    }
  }

  const steps = ['Your business', 'Hours & offerings', 'Your receptionist'];

  return (
    <div className="studio-theme atmosphere min-h-screen bg-base">
      <div className="mx-auto max-w-2xl px-5 py-10">
        <div className="rise mb-10 flex items-center justify-between">
          <Link to="/" aria-label="OpenFon home"><Logo /></Link>
          <ol className="flex items-center gap-2.5 font-mono text-[11px] text-ink-faint">
            {steps.map((s, i) => (
              <li key={s} className={`flex items-center gap-1.5 ${i === step ? 'text-iris' : ''}`}>
                <span
                  className={`flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-semibold ${
                    i < step
                      ? 'bg-ok text-white'
                      : i === step
                        ? 'bg-iris text-white'
                        : 'bg-wash-iris text-ink-faint shadow-[inset_0_0_0_1px_rgb(88_73_190/0.12)]'
                  }`}
                >
                  {i < step ? '✓' : i + 1}
                </span>
                <span className="hidden sm:inline">{s}</span>
              </li>
            ))}
          </ol>
        </div>

        <div className="mb-6 flex justify-end"><button className="text-sm text-ink-soft underline" onClick={() => { if (!confirmDiscardUnsaved()) return; active.current = false; void signOut().catch(() => {}); navigate('/auth'); }}>Sign out</button></div>
        <p className="rise rise-1 font-mono text-[11px] uppercase tracking-[0.2em] text-ink-faint">
          Step {step + 1} of {steps.length}
        </p>
        <h1 className="rise rise-1 mt-1 mb-2 font-display text-4xl font-semibold tracking-tight text-ink">
          {steps[step]}
        </h1>
        <p className="rise rise-2 mb-7 max-w-md text-sm leading-relaxed text-ink-soft">
          {step === 0 && 'Tell your receptionist who it works for. You can edit everything later.'}
          {step === 1 && 'Give your assistant accurate hours and service details. Test its answers before sharing your line.'}
          {step === 2 && 'Give your agent a name and a voice. It greets every caller with this.'}
        </p>

        <Card className="rise rise-3 space-y-5 shadow-raise sm:p-7">
          <fieldset disabled={busy || refreshPending} className="space-y-5">
          {step === 0 && (
            <>
              <Field label="Business name" required value={name} onChange={(e) => setName(e.target.value)} placeholder="Zahnarztpraxis Dr. Gruber" />
              <TextArea
                label="What do you do?"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Zahnarztpraxis für Vorsorge, professionelle Zahnreinigung und Zahnerhalt."
              />
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Address" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="Musterstraße 12, Wien" />
                <Field label="Phone" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+43 1 234 5678" />
              </div>
            </>
          )}

          {step === 1 && (
            <>
              <div>
                <FieldLabel>Opening hours</FieldLabel>
                <div className="mt-2 space-y-1.5">
                  {hours.map((h, i) => (
                    <div
                      key={h.day}
                      className="flex items-center gap-3 text-sm"
                      role="group"
                      aria-label={`${h.day} opening hours`}
                    >
                      <span className="w-12 font-mono text-xs text-ink-soft">{h.day.slice(0, 3)}</span>
                      <input
                        type="checkbox"
                        className="accent-iris"
                        aria-label={`Open on ${h.day}`}
                        checked={!h.closed}
                        onChange={(e) => setHours(hours.map((x, j) => (j === i ? { ...x, closed: !e.target.checked } : x)))}
                      />
                      {h.closed ? (
                        <span className="text-ink-faint">Closed</span>
                      ) : (
                        <>
                          <input
                            type="time"
                            className={`${inputClassSm} px-2 py-1 font-mono text-xs`}
                            aria-label={`${h.day} opening time`}
                            value={h.open}
                            onChange={(e) => setHours(hours.map((x, j) => (j === i ? { ...x, open: e.target.value } : x)))}
                          />
                          <span className="text-ink-faint">–</span>
                          <input
                            type="time"
                            className={`${inputClassSm} px-2 py-1 font-mono text-xs`}
                            aria-label={`${h.day} closing time`}
                            value={h.close}
                            onChange={(e) => setHours(hours.map((x, j) => (j === i ? { ...x, close: e.target.value } : x)))}
                          />
                        </>
                      )}
                    </div>
                  ))}
                </div>
              </div>
              <ListEditor
                title="Services & prices"
                rows={services}
                onChange={setServices}
                empty={{ name: '', price: '' }}
                render={(row, set, rowIndex) => (
                  <>
                    <input
                      className={`${inputClassSm} flex-1`}
                      placeholder="Service (e.g. Checkup)"
                      aria-label={`Service ${rowIndex + 1} name`}
                      value={row.name}
                      onChange={(e) => set({ ...row, name: e.target.value })}
                    />
                    <input
                      className={`${inputClassSm} w-28`}
                      placeholder="€80"
                      aria-label={`Service ${rowIndex + 1} price`}
                      value={row.price ?? ''}
                      onChange={(e) => set({ ...row, price: e.target.value })}
                    />
                  </>
                )}
              />
              <ListEditor
                title="Common questions (FAQ)"
                rows={faqs}
                onChange={setFaqs}
                empty={{ q: '', a: '' }}
                render={(row, set, rowIndex) => (
                  <div className="flex-1 space-y-1.5">
                    <input
                      className={`${inputClassSm} w-full`}
                      placeholder="Do you take walk-ins?"
                      aria-label={`FAQ ${rowIndex + 1} question`}
                      value={row.q}
                      onChange={(e) => set({ ...row, q: e.target.value })}
                    />
                    <input
                      className={`${inputClassSm} w-full`}
                      placeholder="Yes, weekdays before noon."
                      aria-label={`FAQ ${rowIndex + 1} answer`}
                      value={row.a}
                      onChange={(e) => set({ ...row, a: e.target.value })}
                    />
                  </div>
                )}
              />
            </>
          )}

          {step === 2 && (
            <>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Agent name" value={agentName} onChange={(e) => setAgentName(e.target.value)} />
                <label className="block">
                  <FieldLabel>Language</FieldLabel>
                  <select
                    className="w-full rounded-[10px] border border-line-strong bg-surface px-3.5 py-2.5 text-sm text-ink outline-none focus:border-iris focus:ring-[3px] focus:ring-iris/15"
                    value={language}
                    onChange={(e) => setLanguage(e.target.value)}
                  >
                    {LANGUAGES.map(([code, name]) => (
                      <option key={code} value={code}>
                        {name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <Field
                label="Personality"
                value={persona}
                onChange={(e) => setPersona(e.target.value)}
                hint="e.g. friendly and professional, warm and chatty, brisk and efficient"
              />
              <TextArea
                label="Greeting (optional)"
                value={greeting}
                onChange={(e) => setGreeting(e.target.value)}
                placeholder={`Thanks for calling ${name || 'us'}! This is ${agentName}. How can I help you today?`}
              />
            </>
          )}

          </fieldset>

          {error && <p className="rounded-[10px] border border-rose/20 bg-wash-rose px-3 py-2 text-sm text-rose">{error}</p>}

          {refreshPending && <Button disabled={busy} onClick={() => { if (!busy) void openStudio(); }}>
            {busy ? 'Opening studio…' : 'Retry opening studio'}
          </Button>}

          <div className="flex justify-between border-t border-line pt-5">
            <Button variant="ghost" disabled={step === 0 || busy || refreshPending} onClick={() => setStep(step - 1)}>
              ← Back
            </Button>
            {step < 2 ? (
              <Button
                onClick={() => setStep(step + 1)}
                disabled={step === 0 && (!name.trim() || !description.trim())}
              >
                Continue →
              </Button>
            ) : (
              <Button
                onClick={() => void finish()}
                disabled={busy || refreshPending || !agentName.trim() || !persona.trim() || !language.trim()}
              >
                {busy ? 'Saving…' : 'Save and open studio →'}
              </Button>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}

export function ListEditor<T>({
  title,
  rows,
  onChange,
  empty,
  render,
}: {
  title: string;
  rows: T[];
  onChange: (rows: T[]) => void;
  empty: T;
  render: (row: T, set: (r: T) => void, rowIndex: number) => React.ReactNode;
}) {
  return (
    <div role="group" aria-label={title}>
      <FieldLabel>{title}</FieldLabel>
      <div className="mt-2 space-y-2">
        {rows.map((row, i) => (
          <div key={i} className="flex items-start gap-2">
            {render(row, (r) => onChange(rows.map((x, j) => (j === i ? r : x))), i)}
            <button
              type="button"
              className="mt-1.5 rounded px-1 text-ink-faint transition-colors hover:text-rose"
              onClick={() => onChange(rows.filter((_, j) => j !== i))}
              aria-label={`Remove ${title} item ${i + 1}`}
            >
              ✕
            </button>
          </div>
        ))}
      </div>
      <button
        type="button"
        className="mt-2.5 text-sm font-semibold text-iris underline decoration-iris/30 underline-offset-2 hover:decoration-iris"
        onClick={() => onChange([...rows, empty])}
        aria-label={`Add ${title} item`}
      >
        + Add another
      </button>
    </div>
  );
}
