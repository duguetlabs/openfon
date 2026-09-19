import { useEffect, useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type Assistant, type ProviderView } from './api';
import { Field, inputClass } from './ui';

type Option = { id: string; label: string };
export const choices = (ids: string[]) => ids.map(id => ({ id, label: id }));
export const TTS_MODELS = choices(['gpt-4o-mini-tts', 'tts-1', 'tts-1-hd']);
export const TTS_VOICES = choices(['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse', 'marin', 'cedar']);
export const TTS_LEGACY_VOICES = TTS_VOICES.filter(v => !['ballad', 'verse', 'marin', 'cedar'].includes(v.id));
export const AZURE_VOICES = choices(['en-US-AvaMultilingualNeural', 'de-DE-SeraphinaMultilingualNeural', 'es-ES-ArabellaMultilingualNeural', 'fr-FR-VivienneMultilingualNeural', 'it-IT-AlessioMultilingualNeural']);
const LANGUAGES = [{ id: 'en', label: 'English' }, { id: 'de', label: 'Deutsch' }, { id: 'es', label: 'Español' }, { id: 'fr', label: 'Français' }, { id: 'it', label: 'Italiano' }, { id: 'nl', label: 'Nederlands' }, { id: 'sv', label: 'Svenska' }, { id: 'da', label: 'Dansk' }, { id: 'fi', label: 'Suomi' }, { id: 'ru', label: 'Русский' }];

// Native selects remain keyboard accessible; explicit custom mode preserves IDs
// absent from the catalog rather than silently replacing a saved configuration.
export function CatalogSelect({ label, value, onChange, options, defaultLabel = 'Automatic / default', allowDefault = true, hint }: {
  label: string; value: string; onChange: (value: string) => void; options: Option[]; defaultLabel?: string; allowDefault?: boolean; hint?: string;
}) {
  const [custom, setCustom] = useState(false); const [search, setSearch] = useState(''); const id = useId();
  const known = !value || options.some(o => o.id === value);
  const filtered = options.filter(o => o.id === value || `${o.label} ${o.id}`.toLowerCase().includes(search.toLowerCase()));
  return <div className="space-y-2">
    {options.length > 12 && <Field label={`Search ${label.toLowerCase()} options`} value={search} onChange={e => setSearch(e.target.value)} />}
    <label className="block text-sm" htmlFor={id}>{label}</label>
    <select id={id} className={`${inputClass} w-full min-w-0`} value={custom || !known ? '__custom' : value} onChange={e => {
      if (e.target.value === '__custom') setCustom(true); else { setCustom(false); onChange(e.target.value); }
    }}><option value="" disabled={!allowDefault}>{defaultLabel}</option>{filtered.map(o => <option key={o.id} value={o.id}>{o.label === o.id ? o.id : `${o.label} — ${o.id}`}</option>)}<option value="__custom">Custom ID…</option></select>
    {(custom || !known) && <Field label={`Custom ${label.toLowerCase()}`} value={value} onChange={e => onChange(e.target.value)} hint="Advanced: enter an ID supported by this provider. Existing custom values are preserved." />}
    {hint && <p className="studio-muted">{hint}</p>}
  </div>;
}

export function AssistantVoiceSettings({ assistant: a, onChange }: { assistant: Assistant; onChange: (patch: Partial<Assistant>) => void }) {
  const [provider, setProvider] = useState<ProviderView | null>(null);
  const [catalog, setCatalog] = useState<Awaited<ReturnType<typeof api.providerCatalog>> | null>(null);
  const [error, setError] = useState('');
  const [catalogUnavailable, setCatalogUnavailable] = useState(false);
  useEffect(() => { let active = true;
    void api.provider().then(p => { if (active) setProvider(p); })
      .catch(() => { if (active) setError('Provider settings could not load. Existing values are preserved; reload to retry, or use custom IDs.'); });
    void api.providerCatalog().then(c => { if (active) setCatalog(c); })
      .catch(() => { if (active) setCatalogUnavailable(true); });
    return () => { active = false; };
  }, []);
  const realtimeProvider = provider?.effective_realtime_provider || (provider?.realtime_provider === 'instance' ? 'kataleptic' : provider?.realtime_provider);
  const kataleptic = realtimeProvider === 'kataleptic';
  const effectiveModel = a.realtime_model || provider?.effective_realtime_model || '';
  const family = kataleptic ? effectiveModel === 'kataleptic-realtime-hd' ? 'hd' : effectiveModel.startsWith('gpt-realtime') ? 'native' : 'cascade' : realtimeProvider === 'openai' ? 'native' : 'custom';
  const selected = a.engine === 'pipeline' ? 'pipeline' : !a.realtime_model ? 'default' : kataleptic && ['kataleptic-realtime', 'kataleptic-realtime-hd', 'gpt-realtime-2', 'gpt-realtime-2.1', 'gpt-realtime-2.1-mini'].includes(a.realtime_model) ? a.realtime_model : 'custom';
  const textModels = catalog?.models.filter(m => m.kind === 'text') || choices(['llama-3.3-70b', 'mistral-nemo-12b']);
  const speech = provider?.effective_tts_provider || 'unknown';
  const speechVoices = speech === 'azure' ? AZURE_VOICES : speech === 'openai' ? ['tts-1', 'tts-1-hd'].includes(provider?.tts_model || '') ? TTS_LEGACY_VOICES : TTS_VOICES : [];
  return <div className="studio-fields">
    {error && <p role="alert">{error}</p>}
    <CatalogSelect label="Default language" value={a.language} onChange={language => onChange({ language })} options={LANGUAGES} defaultLabel="Choose a language" allowDefault={false} hint="The opening language. Supported callers can switch languages during the conversation." />
    <label>Conversation engine<select aria-label="Conversation engine" className={inputClass} value={selected} onChange={e => {
      const value = e.target.value;
      if (value === 'pipeline') onChange({ engine: 'pipeline' });
      else if (value === 'default') onChange({ engine: 'realtime', realtime_model: '', realtime_voice: '' });
      else if (value === 'custom') onChange({ engine: 'realtime', realtime_model: kataleptic ? 'llama-3.3-70b' : 'gpt-realtime', realtime_voice: '' });
      else onChange({ engine: 'realtime', realtime_model: value, realtime_voice: '' });
    }}><option value="default">Workspace realtime default{provider?.effective_realtime_model ? ` — ${provider.effective_realtime_model}` : ''}</option>
      {kataleptic && <><option value="kataleptic-realtime">Standard — Whisper + chat + Piper</option><option value="kataleptic-realtime-hd">HD — Azure Voice Live</option><option value="gpt-realtime-2">Native — GPT Realtime 2</option><option value="gpt-realtime-2.1">Native — GPT Realtime 2.1</option><option value="gpt-realtime-2.1-mini">Native Mini — GPT Realtime 2.1 Mini</option></>}
      <option value="custom">{kataleptic ? 'Standard with a chosen chat model' : 'Custom realtime model'}</option><option value="pipeline">Custom Pipeline — separate transcription, language model and speech</option>
    </select></label>
    {a.engine === 'pipeline' ? <>
      <p className="studio-muted">Transcribe → think → speak. Each component can use a separate provider and API key in <Link to="/settings#providers">workspace provider settings</Link>. Shared by this workspace; keys never live in presets.</p>
      <p className="studio-muted">Transcription: {provider?.effective_stt_model || 'workspace default'} · Speech: {speech === 'unknown' ? 'workspace configuration unavailable' : speech}</p>
      {speech === 'browser' ? <p className="studio-muted">Browser speech chooses an installed voice matching the reply language. Choose a speech provider in Settings for a specific server voice.</p> : <CatalogSelect label="Speech voice" value={a.voice} onChange={voice => onChange({ voice })} options={speechVoices} defaultLabel={speech === 'openai' || speech === 'custom' ? 'Provider default — alloy' : 'Automatic language-matched voice'} />}
    </> : <>
      {selected === 'custom' && <CatalogSelect label="Realtime model" value={a.realtime_model} onChange={realtime_model => onChange({ realtime_model })} options={kataleptic ? textModels : choices(['gpt-realtime', 'gpt-realtime-mini'])} />}
      <p className="studio-muted">{family === 'hd' ? 'Azure Voice Live manages recognition and the conversation model. Choose an Azure voice.' : family === 'native' ? 'Native speech-to-speech. The conversation model is built in; voices are multilingual.' : kataleptic ? 'Kataleptic streams recognition, chat and Piper speech. Choose an automatic language-matched voice or pin a Piper voice.' : 'Custom realtime uses the OpenAI GA protocol. Model and voice IDs depend on your provider.'}</p>
      <CatalogSelect label="Realtime voice" value={a.realtime_voice} onChange={realtime_voice => onChange({ realtime_voice })} options={family === 'hd' ? AZURE_VOICES : family === 'native' ? catalog?.voices.native || choices(['marin', 'cedar', 'alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse']) : kataleptic ? catalog?.voices.cascade || choices(['en_US-lessac-medium', 'de_DE-thorsten-medium', 'fr_FR-siwis-medium', 'es_ES-sharvard-medium']) : []} />
    </>}
    <CatalogSelect label={a.engine === 'pipeline' ? 'Language model' : 'Summary language model'} value={a.llm_model} onChange={llm_model => onChange({ llm_model })} options={provider?.baseUrl?.startsWith('https://api.kataleptic.com/') ? textModels : provider?.baseUrl === 'https://api.openai.com/v1' ? choices(['gpt-4.1-mini', 'gpt-4o-mini']) : []} defaultLabel={`Workspace default${provider?.effective_text_model ? ` — ${provider.effective_text_model}` : ''}`} hint={a.engine === 'realtime' ? 'Used for call summaries, not the realtime conversation brain.' : 'Generates conversational replies and call summaries.'} />
    {(catalogUnavailable || (catalog && !catalog.live)) && <p className="studio-muted">Showing built-in suggestions; live Kataleptic catalog is temporarily unavailable.</p>}
    <p className="studio-muted"><Link to="/settings#providers">Manage providers and separate API keys →</Link></p>
  </div>;
}
