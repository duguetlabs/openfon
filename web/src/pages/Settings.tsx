import { useEffect, useState } from 'react';
import { api, type Agent, type Business, type EngineProfile, type VoiceCatalog } from '../api';
import { useSession } from '../App';
import {
  readClosureRows,
  readFaqRows,
  readHourRows,
  serializeClosureRows,
  serializeFaqRows,
  serializeHourRows,
  type ClosureRow,
  type FaqRow,
  type HourRow,
} from '../row-arrays';
import { readServiceRows, serializeServiceRows, type ServiceRow } from '../service-rows';
import { Button, Card, Field, FieldLabel, SectionTitle, TextArea, LANGUAGES, inputClassSm } from '../ui';
import { ListEditor } from './Onboarding';

export default function Settings() {
  const { business, refresh } = useSession();
  const [biz, setBiz] = useState<Business | null>(null);
  const [hours, setHours] = useState<HourRow[]>([]);
  const [services, setServices] = useState<ServiceRow[]>([]);
  const [faqs, setFaqs] = useState<FaqRow[]>([]);
  const [closures, setClosures] = useState<ClosureRow[]>([]);
  const [agent, setAgent] = useState<Agent | null>(null);
  const [saved, setSaved] = useState('');
  const [error, setError] = useState('');
  const [profiles, setProfiles] = useState<EngineProfile[]>([]);
  const [voiceCatalog, setVoiceCatalog] = useState<VoiceCatalog | null>(null);
  const [newProfileName, setNewProfileName] = useState('');
  const [clearApiKey, setClearApiKey] = useState(false);

  useEffect(() => {
    if (business) {
      setBiz({ ...business });
      setHours(readHourRows(business.hours_json, []));
      setServices(readServiceRows(business.services_json));
      setFaqs(readFaqRows(business.faqs_json, []));
      setClosures(readClosureRows(business.closures_json));
      setAgent(business.agent ? { ...business.agent } : null);
      setClearApiKey(false);
      void api.profiles(business.id).then(setProfiles).catch(() => {});
      void api.voices().then(setVoiceCatalog).catch(() => {});
    }
  }, [business]);

  if (!biz || !agent) return null;

  async function save() {
    setError('');
    setSaved('');
    try {
      await api.updateBusiness(biz!.id, {
        ...biz!,
        hours_json: serializeHourRows(hours),
        services_json: serializeServiceRows(services),
        faqs_json: serializeFaqRows(faqs),
        closures_json: serializeClosureRows(closures),
      });
      await api.updateAgent(biz!.id, { ...agent!, ...(clearApiKey ? { clearApiKey: true } : {}) });
      setClearApiKey(false);
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
    <div className="mx-auto max-w-2xl space-y-10">
      <div className="rise">
        <p className="font-mono text-[11px] uppercase tracking-[0.22em] text-ink-faint">Configuration</p>
        <h1 className="mt-1 font-display text-4xl font-semibold tracking-tight text-ink">Settings</h1>
        <div className="callline-accent mt-3 w-16" />
      </div>
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
            render={(row, setR, rowIndex) => (
              <>
                <input
                  className={`${inputClassSm} flex-1`}
                  placeholder="Service"
                  aria-label={`Service ${rowIndex + 1} name`}
                  value={row.name}
                  onChange={(e) => setR({ ...row, name: e.target.value })}
                />
                <input
                  className={`${inputClassSm} w-28`}
                  placeholder="Price"
                  aria-label={`Service ${rowIndex + 1} price`}
                  value={row.price ?? ''}
                  onChange={(e) => setR({ ...row, price: e.target.value })}
                />
              </>
            )}
          />
          <ListEditor
            title="Holidays & special closures"
            rows={closures}
            onChange={setClosures}
            empty={{ date: '', reason: '' }}
            render={(row, setR, rowIndex) => (
              <>
                <input
                  type="date"
                  className={`${inputClassSm} font-mono`}
                  aria-label={`Closure ${rowIndex + 1} date`}
                  value={row.date}
                  onChange={(e) => setR({ ...row, date: e.target.value })}
                />
                <input
                  className={`${inputClassSm} flex-1`}
                  placeholder="Public holiday"
                  aria-label={`Closure ${rowIndex + 1} reason`}
                  value={row.reason ?? ''}
                  onChange={(e) => setR({ ...row, reason: e.target.value })}
                />
              </>
            )}
          />
          <ListEditor
            title="FAQ"
            rows={faqs}
            onChange={setFaqs}
            empty={{ q: '', a: '' }}
            render={(row, setR, rowIndex) => (
              <div className="flex-1 space-y-1.5">
                <input
                  className={`${inputClassSm} w-full`}
                  placeholder="Question"
                  aria-label={`FAQ ${rowIndex + 1} question`}
                  value={row.q}
                  onChange={(e) => setR({ ...row, q: e.target.value })}
                />
                <input
                  className={`${inputClassSm} w-full`}
                  placeholder="Answer"
                  aria-label={`FAQ ${rowIndex + 1} answer`}
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
              <FieldLabel>Language</FieldLabel>
              <select
                className="w-full rounded-[10px] border border-line-strong bg-surface px-3.5 py-2.5 text-sm text-ink outline-none focus:border-iris focus:ring-[3px] focus:ring-iris/15"
                value={agent.language}
                onChange={(e) => setA({ language: e.target.value })}
              >
                {LANGUAGES.map(([code, name]) => (
                  <option key={code} value={code}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <Field label="Personality" value={agent.persona} onChange={(e) => setA({ persona: e.target.value })} />
          <TextArea label="Greeting" value={agent.greeting} onChange={(e) => setA({ greeting: e.target.value })} placeholder="Leave empty for the default greeting." />
          <Field
            label="Voice (Azure TTS)"
            value={agent.voice}
            onChange={(e) => setA({ voice: e.target.value })}
            list="azure-voice-options"
            hint="Default is en-US-AvaMultilingualNeural, one natural voice for all languages. A custom voice applies to your default language only."
          />
          <datalist id="azure-voice-options">
            {(voiceCatalog?.azure ?? []).map((v) => (
              <option key={v.id} value={v.id}>
                {v.label}
              </option>
            ))}
          </datalist>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="accent-iris" checked={!!agent.take_messages} onChange={(e) => setA({ take_messages: e.target.checked ? 1 : 0 })} />
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
        <SectionTitle sub="Saved combinations of engine, model, language, and voices — apply one to switch the whole setup at once.">
          Engine profiles
        </SectionTitle>
        <Card className="space-y-3">
          {profiles.length === 0 && <p className="text-sm text-ink-soft">No profiles yet. Configure the engine below, then save it here under a name.</p>}
          {profiles.map((p) => (
            <div key={p.id} className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-wash-iris/50 px-3 py-2">
              <input
                className="min-w-32 flex-1 rounded-lg border border-transparent bg-transparent px-2 py-1 text-sm font-semibold text-ink outline-none hover:border-line-strong focus:border-iris focus:bg-surface focus:ring-[3px] focus:ring-iris/15"
                value={p.name}
                onChange={(e) => setProfiles(profiles.map((x) => (x.id === p.id ? { ...x, name: e.target.value } : x)))}
                onBlur={(e) => void api.updateProfile(p.id, { name: e.target.value })}
              />
              <span className="font-mono text-[11px] text-ink-soft">
                {p.engine === 'realtime' ? `realtime · ${p.realtime_model || 'default'}` : 'pipeline'} · {p.language}
                {(p.realtime_voice || p.voice) && ` · ${p.realtime_voice || p.voice}`}
              </span>
              <button
                className="rounded-lg bg-iris px-3 py-1 text-xs font-semibold text-white transition-colors hover:bg-iris-deep"
                onClick={() =>
                  void api
                    .applyProfile(p.id)
                    .then(async () => {
                      await refresh();
                      setError('');
                      setSaved(`Applied "${p.name}".`);
                      setTimeout(() => setSaved(''), 2500);
                    })
                    .catch((err) => setError(err instanceof Error ? err.message : 'Apply failed'))
                }
              >
                Apply
              </button>
              <button
                className="px-1 text-ink-faint transition-colors hover:text-rose"
                aria-label="Delete profile"
                onClick={() => void api.deleteProfile(p.id).then(() => setProfiles(profiles.filter((x) => x.id !== p.id)))}
              >
                ✕
              </button>
            </div>
          ))}
          <div className="flex gap-2 pt-1">
            <input
              className={`${inputClassSm} flex-1 px-3.5 py-2`}
              placeholder='Save current setup as… e.g. "Realtime HD English (Emma)"'
              value={newProfileName}
              onChange={(e) => setNewProfileName(e.target.value)}
            />
            <Button
              variant="ghost"
              disabled={!newProfileName.trim()}
              onClick={() =>
                void api
                  .createProfile(biz.id, {
                    name: newProfileName.trim(),
                    engine: agent.engine,
                    realtime_model: agent.realtime_model,
                    realtime_voice: agent.realtime_voice,
                    language: agent.language,
                    voice: agent.voice,
                    llm_base_url: agent.llm_base_url,
                    llm_api_key: agent.llm_api_key,
                    llm_model: agent.llm_model,
                  })
                  .then((p) => {
                    setProfiles([...profiles, p]);
                    setNewProfileName('');
                    setError('');
                  })
                  .catch((err) => setError(err instanceof Error ? err.message : 'Could not save profile'))
              }
            >
              Save profile
            </Button>
          </div>
        </Card>
      </section>

      <section className="rise rise-2">
        <SectionTitle sub="OpenFon speaks the OpenAI API dialect — point it at Kataleptic, OpenAI, Groq, Ollama, or your own server. Empty model and endpoint fields use instance defaults; saved API keys stay until explicitly replaced or removed.">
          AI provider
        </SectionTitle>
        <Card className="space-y-4">
          <div>
            <FieldLabel>Voice engine</FieldLabel>
            <div className="mt-2 space-y-2">
              <label className="flex items-start gap-2.5 text-sm">
                <input
                  type="radio"
                  className="mt-1 accent-iris"
                  checked={agent.engine !== 'realtime'}
                  onChange={() => setA({ engine: 'pipeline' })}
                />
                <span>
                  <strong>Pipeline</strong> <span className="text-ink-soft">— transcribe → think → speak. Works with any provider, cheapest, ~2–4 s per reply.</span>
                </span>
              </label>
              <label className="flex items-start gap-2.5 text-sm">
                <input
                  type="radio"
                  className="mt-1 accent-iris"
                  checked={agent.engine === 'realtime'}
                  onChange={() => setA({ engine: 'realtime' })}
                />
                <span>
                  <strong>Realtime</strong>{' '}
                  <span className="text-ink-soft">
                    — streams audio both ways, sub-second replies, callers can interrupt the agent. Needs a realtime-capable provider; falls back to Pipeline if unavailable.
                  </span>
                </span>
              </label>
            </div>
            {agent.engine === 'realtime' && (
              <label className="mt-4 block rounded-xl border border-line bg-wash-iris/40 p-4">
                <FieldLabel>Realtime model</FieldLabel>
                <select
                  className="w-full rounded-[10px] border border-line-strong bg-surface px-3.5 py-2.5 text-sm text-ink outline-none focus:border-iris focus:ring-[3px] focus:ring-iris/15"
                  value={agent.realtime_model}
                  onChange={(e) => setA({ realtime_model: e.target.value })}
                >
                  <option value="">Instance default</option>
                  <option value="kataleptic-realtime">kataleptic-realtime — fastest (~0.5 s) and cheapest</option>
                  <option value="kataleptic-realtime-hd">kataleptic-realtime-hd — HD voices (Azure Voice Live), ~1 s</option>
                  <option value="gpt-realtime-2">gpt-realtime-2 — native speech-to-speech with built-in reasoning; not EU-hosted</option>
                </select>
                <span className="mt-1.5 block text-xs leading-relaxed text-ink-soft">
                  Takes effect on the next call — handy for comparing tiers back-to-back.
                </span>
                <div className="mt-3">
                  <Field
                    label="Realtime voice (optional)"
                    value={agent.realtime_voice}
                    onChange={(e) => setA({ realtime_voice: e.target.value })}
                    placeholder="Tier default"
                    list="rt-voice-options"
                    hint="Pick from the chosen tier's live catalog or type any voice id. Empty = tier default (cascade voices follow the caller's language automatically)."
                  />
                  <datalist id="rt-voice-options">
                    {(voiceCatalog
                      ? agent.realtime_model === 'kataleptic-realtime-hd'
                        ? voiceCatalog.azure
                        : agent.realtime_model === 'gpt-realtime-2'
                          ? voiceCatalog.native
                          : voiceCatalog.cascade
                      : []
                    ).map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.label}
                      </option>
                    ))}
                  </datalist>
                </div>
              </label>
            )}
          </div>
          <Field
            label="Base URL"
            value={agent.llm_base_url}
            onChange={(e) => setA({ llm_base_url: e.target.value })}
            placeholder="https://api.kataleptic.com/v1"
            hint="Your own endpoint must be https and needs its own API key below — this instance never sends its key to another URL."
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Model" value={agent.llm_model} onChange={(e) => setA({ llm_model: e.target.value })} placeholder="llama-3.3-70b" />
            <div>
              <Field
                label="API key"
                type="password"
                value={agent.llm_api_key}
                onChange={(e) => {
                  setClearApiKey(false);
                  setA({ llm_api_key: e.target.value });
                }}
                placeholder={
                  clearApiKey
                    ? 'Saved key will be removed'
                    : agent.workspaceApiKeyConfigured
                      ? 'Configured — enter a new key to replace it'
                      : agent.apiKeyConfigured
                        ? 'Using the instance key'
                        : 'sk-…'
                }
              />
              {agent.workspaceApiKeyConfigured && !clearApiKey && (
                <button
                  type="button"
                  className="mt-2 text-xs font-semibold text-rose underline decoration-rose/30 underline-offset-2 hover:decoration-rose"
                  onClick={() => {
                    setA({ llm_api_key: '' });
                    setClearApiKey(true);
                  }}
                >
                  Remove saved key
                </button>
              )}
              {clearApiKey && (
                <p className="mt-2 text-xs text-ink-soft" role="status">
                  The saved key will be removed when you save. Use the instance-default Base URL first if you want to
                  fall back to its key.{' '}
                  <button
                    type="button"
                    className="font-semibold text-iris underline decoration-iris/30 underline-offset-2 hover:decoration-iris"
                    onClick={() => setClearApiKey(false)}
                  >
                    Undo
                  </button>
                </p>
              )}
            </div>
          </div>
        </Card>
      </section>

      <div className="rise rise-3 sticky bottom-4 flex items-center justify-between gap-4 rounded-xl border border-line bg-surface/95 px-4 py-3 shadow-raise backdrop-blur-md">
        <p className="hidden font-mono text-[11px] uppercase tracking-[0.14em] text-ink-faint sm:block">
          Changes apply on the next call
        </p>
        <div className="flex items-center gap-3">
          {saved && <span className="text-sm font-semibold text-ok">{saved}</span>}
          {error && <span className="text-sm text-rose">{error}</span>}
          <Button onClick={() => void save()}>Save changes</Button>
        </div>
      </div>
    </div>
  );
}
