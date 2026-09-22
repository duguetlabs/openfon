import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { api, type Assistant, type ProviderView } from './api';
import { Field, inputClass } from './ui';
import { VoicePreview, type VoiceSampleCache } from './VoicePreview';

type Option = { id: string; label: string; gender?: 'female' | 'male' | 'unspecified' };
// Microsoft publishes these labels. Other catalogs currently expose IDs only;
// never infer a voice's gender from a name or from another engine's alias.
const AZURE_GENDER: Record<string, 'female' | 'male'> = {
  'en-US-AvaMultilingualNeural': 'female', 'de-DE-SeraphinaMultilingualNeural': 'female',
  'es-ES-ArabellaMultilingualNeural': 'female', 'fr-FR-VivienneMultilingualNeural': 'female',
  'it-IT-AlessioMultilingualNeural': 'male',
};
const voiceOptions = (options: Option[], azure = false): Option[] => options.map(option => ({
  ...option, gender: azure ? AZURE_GENDER[option.id] || 'unspecified' : 'unspecified',
}));
const genderIcon = (gender: Option['gender']) => gender === 'female' ? '♀' : gender === 'male' ? '♂' : '◇';
export const choices = (ids: string[]) => ids.map(id => ({ id, label: id }));
export const TTS_MODELS = choices(['gpt-4o-mini-tts', 'tts-1', 'tts-1-hd']);
export const TTS_VOICES = choices(['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse', 'marin', 'cedar']);
export const TTS_LEGACY_VOICES = TTS_VOICES.filter(v => !['ballad', 'verse', 'marin', 'cedar'].includes(v.id));
export const AZURE_VOICES = choices(['en-US-AvaMultilingualNeural', 'de-DE-SeraphinaMultilingualNeural', 'es-ES-ArabellaMultilingualNeural', 'fr-FR-VivienneMultilingualNeural', 'it-IT-AlessioMultilingualNeural']);
const KATALEPTIC_TIERS = ['kataleptic-realtime-hd', 'gpt-realtime-2', 'gpt-realtime-2.1', 'gpt-realtime-2.1-mini'];
const LANGUAGES = [{ id: 'en', label: 'English' }, { id: 'de', label: 'Deutsch' }, { id: 'es', label: 'Español' }, { id: 'fr', label: 'Français' }, { id: 'it', label: 'Italiano' }, { id: 'nl', label: 'Nederlands' }, { id: 'sv', label: 'Svenska' }, { id: 'da', label: 'Dansk' }, { id: 'fi', label: 'Suomi' }, { id: 'ru', label: 'Русский' }];

// Native selects remain keyboard accessible; explicit custom mode preserves IDs
// absent from the catalog rather than silently replacing a saved configuration.
export function CatalogSelect({ label, value, onChange, options, defaultLabel = 'Automatic / default', allowDefault = true, hint, trailing, showGender = false }: {
  label: string; value: string; onChange: (value: string) => void; options: Option[]; defaultLabel?: string; allowDefault?: boolean; hint?: string; trailing?: ReactNode; showGender?: boolean;
}) {
  const [customValue, setCustomValue] = useState<string | null>(null);
  const custom = customValue === value; const [search, setSearch] = useState(''); const id = useId();
  const known = !value || options.some(o => o.id === value);
  const filtered = options.filter(o => o.id === value || `${o.label} ${o.id}`.toLowerCase().includes(search.toLowerCase()));
  return <div className="space-y-2">
    {options.length > 12 && <Field label={`Search ${label.toLowerCase()} options`} value={search} onChange={e => setSearch(e.target.value)} />}
    <label className="block text-sm" htmlFor={id}>{label}</label>
    <div className="flex items-center gap-2"><select id={id} className={`${inputClass} w-full min-w-0`} value={custom || !known ? '__custom' : value} onChange={e => {
      if (e.target.value === '__custom') setCustomValue(value); else { setCustomValue(null); onChange(e.target.value); }
    }}><option value="" disabled={!allowDefault}>{showGender ? `◇ ${defaultLabel}` : defaultLabel}</option>{filtered.map(o => <option key={o.id} value={o.id} aria-label={showGender ? `${o.label}, ${o.gender || 'unspecified'} voice gender` : undefined}>{showGender ? `${genderIcon(o.gender)} ` : ''}{o.label === o.id ? o.id : `${o.label} — ${o.id}`}</option>)}<option value="__custom" aria-label={showGender ? 'Custom ID, unspecified voice gender' : undefined}>{showGender ? '◇ Custom ID…' : 'Custom ID…'}</option></select>{trailing}</div>
    {(custom || !known) && <Field label={`Custom ${label.toLowerCase()}`} value={value} onChange={e => { setCustomValue(e.target.value); onChange(e.target.value); }} hint="Advanced: enter an ID supported by this provider. Existing custom values are preserved." />}
    {hint && <p className="studio-muted">{hint}</p>}
  </div>;
}

export function AssistantVoiceSettings({ assistant: a, onChange }: { assistant: Assistant; onChange: (patch: Partial<Assistant>) => void }) {
  const sampleCache = useRef<VoiceSampleCache>(new Map());
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
  // Kataleptic serves any retired tier (its old cascade) on HD; show what runs.
  const family = kataleptic ? effectiveModel.startsWith('gpt-realtime') ? 'native' : 'hd' : realtimeProvider === 'openai' ? 'native' : 'custom';
  const selected = a.engine === 'pipeline' ? 'pipeline' : !a.realtime_model ? 'default' : kataleptic ? KATALEPTIC_TIERS.includes(a.realtime_model) ? a.realtime_model : 'kataleptic-realtime-hd' : 'custom';
  const textModels = catalog?.models.filter(m => m.kind === 'text') || choices(['llama-3.3-70b', 'gpt-5.4-mini']);
  const speech = provider?.effective_tts_provider || 'unknown';
  const speechVoices = speech === 'azure' ? AZURE_VOICES : speech === 'openai' ? ['tts-1', 'tts-1-hd'].includes(provider?.tts_model || '') ? TTS_LEGACY_VOICES : TTS_VOICES : [];
  const sampleKey = JSON.stringify([a.id, a.engine, a.language, a.voice, a.realtime_model, a.realtime_voice, provider]);
  const preview = <VoicePreview key={sampleKey} assistant={a} browserSpeech={a.engine === 'pipeline' && speech === 'browser'} disabled={!provider} cache={sampleCache.current} cacheKey={sampleKey} />;
  return <div className="studio-fields">
    {error && <p role="alert">{error}</p>}
    <CatalogSelect label="Default language" value={a.language} onChange={language => onChange({ language })} options={LANGUAGES} defaultLabel="Choose a language" allowDefault={false} hint="The opening language. Supported callers can switch languages during the conversation." />
    <label>Conversation engine<select aria-label="Conversation engine" className={inputClass} value={selected} onChange={e => {
      const value = e.target.value;
      if (value === 'pipeline') onChange({ engine: 'pipeline' });
      else if (value === 'default') onChange({ engine: 'realtime', realtime_model: '', realtime_voice: '' });
      else if (value === 'custom') onChange({ engine: 'realtime', realtime_model: 'gpt-realtime', realtime_voice: '' });
      else onChange({ engine: 'realtime', realtime_model: value, realtime_voice: '' });
    }}><option value="default">Workspace realtime default{provider?.effective_realtime_model ? ` — ${provider.effective_realtime_model}` : ''}</option>
      {kataleptic && <><option value="kataleptic-realtime-hd">HD — Azure Voice Live</option><option value="gpt-realtime-2">Native — GPT Realtime 2</option><option value="gpt-realtime-2.1">Native — GPT Realtime 2.1</option><option value="gpt-realtime-2.1-mini">Native Mini — GPT Realtime 2.1 Mini</option></>}
      {!kataleptic && <option value="custom">Custom realtime model</option>}<option value="pipeline">Custom Pipeline — separate transcription, language model and speech</option>
    </select></label>
    {a.engine === 'pipeline' ? <>
      <p className="studio-muted">Transcribe → think → speak. Each component can use a separate provider and API key in <Link to="/settings#providers">workspace provider settings</Link>. Shared by this workspace; keys never live in presets.</p>
      <p className="studio-muted">Transcription: {provider?.effective_stt_model || 'workspace default'} · Speech: {speech === 'unknown' ? 'workspace configuration unavailable' : speech}</p>
      {speech === 'browser' ? <div className="flex items-center gap-2"><p className="studio-muted">Browser speech uses an installed voice matching the language.</p>{preview}</div> : <CatalogSelect key={`${speech}:${provider?.tts_model}`} label="Speech voice" value={a.voice} onChange={voice => onChange({ voice })} options={voiceOptions(speechVoices, speech === 'azure')} showGender trailing={preview} defaultLabel={speech === 'openai' || speech === 'custom' ? 'Provider default — alloy' : 'Automatic language-matched voice'} />}
    </> : <>
      {selected === 'custom' && <CatalogSelect key={realtimeProvider} label="Realtime model" value={a.realtime_model} onChange={realtime_model => onChange({ realtime_model })} options={choices(['gpt-realtime', 'gpt-realtime-mini'])} />}
      <p className="studio-muted">{family === 'hd' ? 'Azure Voice Live manages recognition and the conversation model. Choose an Azure voice.' : family === 'native' ? 'Native speech-to-speech. The conversation model is built in; voices are multilingual.' : 'Custom realtime uses the OpenAI GA protocol. Model and voice IDs depend on your provider.'}</p>
      <CatalogSelect key={`${realtimeProvider}:${effectiveModel}`} label="Realtime voice" value={a.realtime_voice} onChange={realtime_voice => onChange({ realtime_voice })} showGender trailing={preview} options={voiceOptions(family === 'hd' ? AZURE_VOICES : family === 'native' ? catalog?.voices.native || choices(['marin', 'cedar', 'alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse']) : [], family === 'hd')} />
    </>}
    <p className="studio-muted">{speech === 'browser' && a.engine === 'pipeline' ? 'Local AI voice sample.' : 'AI samples preload for the selected voice. Provider charges may apply.'} {!(speech === 'browser' && a.engine === 'pipeline') && '♀ Female · ♂ Male · ◇ Gender unspecified by provider.'}</p>
    {a.engine === 'pipeline' && <CatalogSelect key={provider?.baseUrl} label="Language model" value={a.llm_model} onChange={llm_model => onChange({ llm_model })} options={provider?.baseUrl?.startsWith('https://api.kataleptic.com/') ? textModels : provider?.baseUrl === 'https://api.openai.com/v1' ? choices(['gpt-4.1-mini', 'gpt-4o-mini']) : []} defaultLabel={`Workspace default${provider?.effective_text_model ? ` — ${provider.effective_text_model}` : ''}`} hint="Generates Pipeline conversational replies. Configure post-call summaries separately in workspace settings." />}
    <p className="studio-muted"><Link to="/settings#call-summaries">Configure call summaries in workspace settings →</Link></p>
    {(catalogUnavailable || (catalog && !catalog.live)) && <p className="studio-muted">Showing built-in suggestions; live Kataleptic catalog is temporarily unavailable.</p>}
    <p className="studio-muted"><Link to="/settings#providers">Manage providers and separate API keys →</Link></p>
  </div>;
}
