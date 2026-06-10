import { useState } from 'react';
import { api } from '../api';
import { useSession } from '../App';
import { Button, Card, Field, Logo, TextArea, LANGUAGES } from '../ui';

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

interface Hour {
  day: string;
  open: string;
  close: string;
  closed: boolean;
}
interface Service {
  name: string;
  price: string;
}
interface Faq {
  q: string;
  a: string;
}

export default function Onboarding() {
  const { refresh } = useSession();
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [address, setAddress] = useState('');
  const [phone, setPhone] = useState('');
  const [hours, setHours] = useState<Hour[]>(
    DAYS.map((day) => ({ day, open: '09:00', close: '17:00', closed: day === 'Saturday' || day === 'Sunday' }))
  );
  const [services, setServices] = useState<Service[]>([{ name: '', price: '' }]);
  const [faqs, setFaqs] = useState<Faq[]>([{ q: '', a: '' }]);
  const [agentName, setAgentName] = useState('Alex');
  const [persona, setPersona] = useState('friendly and professional');
  const [language, setLanguage] = useState('en');
  const [greeting, setGreeting] = useState('');

  async function finish() {
    setBusy(true);
    setError('');
    try {
      const biz = await api.createBusiness({
        name,
        description,
        address,
        phone,
        hours_json: JSON.stringify(hours),
        services_json: JSON.stringify(services.filter((s) => s.name.trim())),
        faqs_json: JSON.stringify(faqs.filter((f) => f.q.trim() && f.a.trim())),
      });
      await api.updateAgent(biz.id, { agent_name: agentName, persona, language, greeting });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
      setBusy(false);
    }
  }

  const steps = ['Your business', 'Hours & offerings', 'Your receptionist'];

  return (
    <div className="grain min-h-screen bg-paper">
      <div className="mx-auto max-w-2xl px-5 py-10">
        <div className="rise mb-8 flex items-center justify-between">
          <Logo />
          <ol className="flex items-center gap-2 font-mono text-xs text-ink-soft">
            {steps.map((s, i) => (
              <li key={s} className={`flex items-center gap-2 ${i === step ? 'font-bold text-pine' : ''}`}>
                <span
                  className={`flex h-5 w-5 items-center justify-center rounded-full text-[10px] ${
                    i < step ? 'bg-ok text-paper' : i === step ? 'bg-pine text-paper' : 'bg-paper-2'
                  }`}
                >
                  {i < step ? '✓' : i + 1}
                </span>
                <span className="hidden sm:inline">{s}</span>
              </li>
            ))}
          </ol>
        </div>

        <h1 className="rise rise-1 mb-2 font-display text-4xl font-semibold text-pine">{steps[step]}</h1>
        <p className="rise rise-2 mb-6 text-sm text-ink-soft">
          {step === 0 && 'Tell your receptionist who it works for. You can edit everything later.'}
          {step === 1 && 'The agent only answers from facts you give it — no made-up prices or hours.'}
          {step === 2 && 'Give your agent a name and a voice. It greets every caller with this.'}
        </p>

        <Card className="rise rise-3 space-y-4">
          {step === 0 && (
            <>
              <Field label="Business name" required value={name} onChange={(e) => setName(e.target.value)} placeholder="Riverside Dental" />
              <TextArea
                label="What do you do?"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Family dental practice offering checkups, cleanings, and cosmetic dentistry."
              />
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Address" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="12 River St, Vienna" />
                <Field label="Phone" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+43 1 234 5678" />
              </div>
            </>
          )}

          {step === 1 && (
            <>
              <div>
                <span className="mb-2 block text-xs font-bold uppercase tracking-[0.12em] text-ink-soft">Opening hours</span>
                <div className="space-y-1.5">
                  {hours.map((h, i) => (
                    <div key={h.day} className="flex items-center gap-3 text-sm">
                      <span className="w-24 font-mono text-xs">{h.day.slice(0, 3)}</span>
                      <input
                        type="checkbox"
                        checked={!h.closed}
                        onChange={(e) => setHours(hours.map((x, j) => (j === i ? { ...x, closed: !e.target.checked } : x)))}
                      />
                      {h.closed ? (
                        <span className="text-ink-soft">Closed</span>
                      ) : (
                        <>
                          <input
                            type="time"
                            className="rounded-lg border border-line bg-white/70 px-2 py-1 font-mono text-xs"
                            value={h.open}
                            onChange={(e) => setHours(hours.map((x, j) => (j === i ? { ...x, open: e.target.value } : x)))}
                          />
                          <span className="text-ink-soft">–</span>
                          <input
                            type="time"
                            className="rounded-lg border border-line bg-white/70 px-2 py-1 font-mono text-xs"
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
                render={(row, set) => (
                  <>
                    <input
                      className="flex-1 rounded-lg border border-line bg-white/70 px-3 py-1.5 text-sm"
                      placeholder="Service (e.g. Checkup)"
                      value={row.name}
                      onChange={(e) => set({ ...row, name: e.target.value })}
                    />
                    <input
                      className="w-28 rounded-lg border border-line bg-white/70 px-3 py-1.5 text-sm"
                      placeholder="€80"
                      value={row.price}
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
                render={(row, set) => (
                  <div className="flex-1 space-y-1.5">
                    <input
                      className="w-full rounded-lg border border-line bg-white/70 px-3 py-1.5 text-sm"
                      placeholder="Do you take walk-ins?"
                      value={row.q}
                      onChange={(e) => set({ ...row, q: e.target.value })}
                    />
                    <input
                      className="w-full rounded-lg border border-line bg-white/70 px-3 py-1.5 text-sm"
                      placeholder="Yes, weekdays before noon."
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
                  <span className="mb-1.5 block text-xs font-bold uppercase tracking-[0.12em] text-ink-soft">Language</span>
                  <select
                    className="w-full rounded-xl border border-line bg-white/70 px-4 py-2.5 text-sm"
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

          {error && <p className="rounded-lg bg-ring-soft px-3 py-2 text-sm text-ring">{error}</p>}

          <div className="flex justify-between pt-2">
            <Button variant="ghost" disabled={step === 0 || busy} onClick={() => setStep(step - 1)}>
              ← Back
            </Button>
            {step < 2 ? (
              <Button onClick={() => setStep(step + 1)} disabled={step === 0 && !name.trim()}>
                Continue →
              </Button>
            ) : (
              <Button onClick={() => void finish()} disabled={busy}>
                {busy ? 'Setting up…' : 'Open my line ☎'}
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
  render: (row: T, set: (r: T) => void) => React.ReactNode;
}) {
  return (
    <div>
      <span className="mb-2 block text-xs font-bold uppercase tracking-[0.12em] text-ink-soft">{title}</span>
      <div className="space-y-2">
        {rows.map((row, i) => (
          <div key={i} className="flex items-start gap-2">
            {render(row, (r) => onChange(rows.map((x, j) => (j === i ? r : x))))}
            <button
              type="button"
              className="mt-1 px-1 text-ink-soft hover:text-ring"
              onClick={() => onChange(rows.filter((_, j) => j !== i))}
              aria-label="Remove"
            >
              ✕
            </button>
          </div>
        ))}
      </div>
      <button type="button" className="mt-2 text-sm font-semibold text-pine underline" onClick={() => onChange([...rows, empty])}>
        + Add another
      </button>
    </div>
  );
}
