import { useEffect, useState } from 'react';
import { api, type Agent, type Business } from '../api';
import { useSession } from '../App';
import { Button, Card, Field, SectionTitle, TextArea } from '../ui';
import { ListEditor } from './Onboarding';

interface Hour {
  day: string;
  open: string;
  close: string;
  closed: boolean;
}

function parse<T>(json: string, fallback: T): T {
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

export default function Settings() {
  const { business, refresh } = useSession();
  const [biz, setBiz] = useState<Business | null>(null);
  const [hours, setHours] = useState<Hour[]>([]);
  const [services, setServices] = useState<{ name: string; price: string }[]>([]);
  const [faqs, setFaqs] = useState<{ q: string; a: string }[]>([]);
  const [agent, setAgent] = useState<Agent | null>(null);
  const [saved, setSaved] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (business) {
      setBiz({ ...business });
      setHours(parse(business.hours_json, []));
      setServices(parse(business.services_json, []));
      setFaqs(parse(business.faqs_json, []));
      setAgent(business.agent ? { ...business.agent } : null);
    }
  }, [business]);

  if (!biz || !agent) return null;

  async function save() {
    setError('');
    setSaved('');
    try {
      await api.updateBusiness(biz!.id, {
        ...biz!,
        hours_json: JSON.stringify(hours),
        services_json: JSON.stringify(services.filter((s) => s.name.trim())),
        faqs_json: JSON.stringify(faqs.filter((f) => f.q.trim() && f.a.trim())),
      });
      await api.updateAgent(biz!.id, agent!);
      await refresh();
      setSaved('Saved.');
      setTimeout(() => setSaved(''), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    }
  }

  const set = (patch: Partial<Business>) => setBiz({ ...biz, ...patch });
  const setA = (patch: Partial<Agent>) => setAgent({ ...agent, ...patch });

  return (
    <div className="mx-auto max-w-2xl space-y-8">
      <section className="rise">
        <SectionTitle sub="The facts your agent answers from.">Business</SectionTitle>
        <Card className="space-y-4">
          <Field label="Name" value={biz.name} onChange={(e) => set({ name: e.target.value })} />
          <TextArea label="Description" value={biz.description} onChange={(e) => set({ description: e.target.value })} />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Address" value={biz.address} onChange={(e) => set({ address: e.target.value })} />
            <Field label="Phone" value={biz.phone} onChange={(e) => set({ phone: e.target.value })} />
            <Field label="Website" value={biz.website} onChange={(e) => set({ website: e.target.value })} />
            <Field label="Timezone" value={biz.timezone} onChange={(e) => set({ timezone: e.target.value })} />
          </div>
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
            render={(row, setR) => (
              <>
                <input
                  className="flex-1 rounded-lg border border-line bg-white/70 px-3 py-1.5 text-sm"
                  placeholder="Service"
                  value={row.name}
                  onChange={(e) => setR({ ...row, name: e.target.value })}
                />
                <input
                  className="w-28 rounded-lg border border-line bg-white/70 px-3 py-1.5 text-sm"
                  placeholder="Price"
                  value={row.price}
                  onChange={(e) => setR({ ...row, price: e.target.value })}
                />
              </>
            )}
          />
          <ListEditor
            title="FAQ"
            rows={faqs}
            onChange={setFaqs}
            empty={{ q: '', a: '' }}
            render={(row, setR) => (
              <div className="flex-1 space-y-1.5">
                <input
                  className="w-full rounded-lg border border-line bg-white/70 px-3 py-1.5 text-sm"
                  placeholder="Question"
                  value={row.q}
                  onChange={(e) => setR({ ...row, q: e.target.value })}
                />
                <input
                  className="w-full rounded-lg border border-line bg-white/70 px-3 py-1.5 text-sm"
                  placeholder="Answer"
                  value={row.a}
                  onChange={(e) => setR({ ...row, a: e.target.value })}
                />
              </div>
            )}
          />
        </Card>
      </section>

      <section className="rise rise-1">
        <SectionTitle sub="Who picks up the phone.">Receptionist</SectionTitle>
        <Card className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Agent name" value={agent.agent_name} onChange={(e) => setA({ agent_name: e.target.value })} />
            <label className="block">
              <span className="mb-1.5 block text-xs font-bold uppercase tracking-[0.12em] text-ink-soft">Language</span>
              <select
                className="w-full rounded-xl border border-line bg-white/70 px-4 py-2.5 text-sm"
                value={agent.language}
                onChange={(e) => setA({ language: e.target.value })}
              >
                <option value="en">English</option>
                <option value="de">Deutsch</option>
                <option value="es">Español</option>
                <option value="fr">Français</option>
              </select>
            </label>
          </div>
          <Field label="Personality" value={agent.persona} onChange={(e) => setA({ persona: e.target.value })} />
          <TextArea label="Greeting" value={agent.greeting} onChange={(e) => setA({ greeting: e.target.value })} placeholder="Leave empty for the default greeting." />
          <Field
            label="Voice (Azure TTS)"
            value={agent.voice}
            onChange={(e) => setA({ voice: e.target.value })}
            hint="e.g. en-US-JennyNeural, de-AT-IngridNeural. Empty = instance default."
          />
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={!!agent.take_messages} onChange={(e) => setA({ take_messages: e.target.checked ? 1 : 0 })} />
            Take messages when the agent can't help
          </label>
          <TextArea
            label="Extra instructions"
            value={agent.custom_instructions}
            onChange={(e) => setA({ custom_instructions: e.target.value })}
            placeholder="Anything else your receptionist should know or do."
          />
        </Card>
      </section>

      <section className="rise rise-2">
        <SectionTitle sub="OpenFon speaks the OpenAI API dialect — point it at Kataleptic, OpenAI, Groq, Ollama, or your own server. Empty fields use the instance defaults.">
          AI provider
        </SectionTitle>
        <Card className="space-y-4">
          <Field label="Base URL" value={agent.llm_base_url} onChange={(e) => setA({ llm_base_url: e.target.value })} placeholder="https://api.kataleptic.com/v1" />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Model" value={agent.llm_model} onChange={(e) => setA({ llm_model: e.target.value })} placeholder="llama-3.3-70b" />
            <Field label="API key" type="password" value={agent.llm_api_key} onChange={(e) => setA({ llm_api_key: e.target.value })} placeholder="sk-…" />
          </div>
        </Card>
      </section>

      <div className="rise rise-3 flex items-center gap-4 pb-8">
        <Button onClick={() => void save()}>Save changes</Button>
        {saved && <span className="text-sm font-semibold text-ok">{saved}</span>}
        {error && <span className="text-sm text-ring">{error}</span>}
      </div>
    </div>
  );
}
