import { useEffect, useState } from 'react';
import { api, type ProviderView, type ProviderUpdate } from '../api';
import { Button, Card, Field, inputClassSm } from '../ui';
import { useUnsavedEdits } from '../unsaved-edits';

export default function ProviderSettings({ onSaved }: { onSaved: () => Promise<void> }) {
  const [saved, setSaved] = useState<ProviderView | null>(null);
  const [draft, setDraft] = useState<ProviderUpdate>({});
  const [savedDraft, setSavedDraft] = useState<ProviderUpdate | null>(null);
  const [preset, setPreset] = useState('custom');
  const [busy, setBusy] = useState(false);
  const [refreshPending, setRefreshPending] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  // Include write-only key inputs and removal flags in the baseline. Empty
  // inputs mean retain, so reverting an edit to empty is clean again.
  const dirty = savedDraft !== null && (Object.keys(savedDraft) as (keyof ProviderUpdate)[])
    .some(key => draft[key] !== savedDraft[key]);
  useUnsavedEdits(dirty);
  async function load() {
    const p = await api.provider();
    setSaved(p);
    const next: ProviderUpdate = { baseUrl: p.usesInstanceDefault ? '' : p.baseUrl, model: p.model,
      realtime_provider: p.realtime_provider, realtime_base_url: p.realtime_base_url,
      stt_provider: p.stt_provider, stt_base_url: p.stt_base_url, stt_model: p.stt_model,
      apiKey: '', clearApiKey: false, realtime_api_key: '', realtime_clear_api_key: false,
      stt_api_key: '', stt_clear_api_key: false };
    setDraft(next);
    setSavedDraft(next);
    setPreset(p.usesInstanceDefault ? 'instance' : p.presets.find(x => x.baseUrl === p.baseUrl)?.id || 'custom');
  }
  useEffect(() => { void load().catch(e => setError(e.message)); }, []);
  const change = (patch: ProviderUpdate) => { setDraft(p => ({ ...p, ...patch })); setMessage(''); };
  async function run(action: () => Promise<void>) {
    setBusy(true); setError(''); setMessage('');
    try { await action(); } catch (e) { setError(e instanceof Error ? e.message : 'Provider request failed'); }
    finally { setBusy(false); }
  }
  const savedMessage = 'Provider settings saved. Test the saved configuration before calling.';
  async function refreshAfterSave() {
    let stage = 'provider settings';
    try {
      await load();
      stage = 'workspace';
      await onSaved();
      setRefreshPending(false);
    } catch {
      setError(`Provider settings were saved, but the ${stage} display could not refresh. Refresh the saved settings; you do not need to save again or re-enter API keys.`);
    }
  }
  async function save() {
    const result = await api.updateProvider(draft);
    // Persistence is confirmed before either follow-up read. Drop submitted
    // secrets and mark the acknowledged draft clean even if refresh fails.
    const clean = { ...draft, apiKey: '', clearApiKey: false,
      realtime_api_key: '', realtime_clear_api_key: false, stt_api_key: '', stt_clear_api_key: false };
    setDraft(clean);
    setSavedDraft(clean);
    setSaved(current => current && { ...current,
      apiKeyConfigured: result.apiKeyConfigured, workspaceApiKeyConfigured: result.workspaceApiKeyConfigured });
    setMessage(savedMessage);
    setRefreshPending(true);
    await refreshAfterSave();
  }
  if (!saved) return <p role={error ? 'alert' : 'status'}>{error || 'Loading provider settings…'}</p>;
  return <section aria-label="Workspace AI providers"><h2 className="font-display text-2xl mb-3">Workspace AI providers</h2>
    <p className="text-sm text-ink-soft mb-4">Kataleptic is operated by OpenFon’s maintainer and is an optional paid service. You can use your own provider accounts. Provider usage and hosting may cost money.</p>
    {error && <p role="alert" className="text-rose mb-3">{error}</p>}{message && <p role="status" className="mb-3">{message}</p>}
    {refreshPending && <Button type="button" disabled={busy} onClick={() => void run(async () => { setMessage(savedMessage); await refreshAfterSave(); })}>Refresh saved provider settings</Button>}
    <form onSubmit={e => { e.preventDefault(); if (!busy && !refreshPending) void run(save); }}>
      <fieldset disabled={busy || refreshPending} className="min-w-0 space-y-4">
        <Card className="space-y-4"><h3 className="font-semibold">Text generation & call summaries</h3>
          <label className="block text-sm">Text provider preset<select aria-label="Text provider preset" className={`${inputClassSm} w-full min-w-0 max-w-full`} value={preset} onChange={e => {
            const id = e.target.value; setPreset(id);
            const p = saved.presets.find(x => x.id === id)!;
            if (id !== 'custom') change({ baseUrl: p.baseUrl, model: p.model, apiKey: '', clearApiKey: false });
          }}>{saved.presets.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}</select></label>
          <Field label="Text base URL" value={draft.baseUrl || ''} placeholder={saved.usesInstanceDefault ? saved.baseUrl : 'Blank uses instance default'} onChange={e => { setPreset('custom'); change({ baseUrl: e.target.value }); }} hint="Base URL only; OpenFon appends /chat/completions. Changing endpoints requires a replacement key or explicit removal." />
          <Field label="Workspace text model" value={draft.model || ''} onChange={e => change({ model: e.target.value })} hint="Editable model ID. Assistants with their own model override this value. Clear that override in Assistants to use this default." />
          <Field label="Text API key" type="password" autoComplete="new-password" value={draft.apiKey || ''} onChange={e => change({ apiKey: e.target.value, clearApiKey: false })} placeholder={saved.workspaceApiKeyConfigured ? 'Saved — leave blank to keep at the same endpoint' : 'Enter your provider key'} />
          <label className="block text-sm"><input type="checkbox" checked={Boolean(draft.clearApiKey)} onChange={e => change({ clearApiKey: e.target.checked, apiKey: '' })} /> Remove saved text key</label>
          <p className="text-sm text-ink-soft">OpenRouter and Hugging Face presets configure text chat only. They do not configure speech recognition, speech synthesis, or realtime voice. Model availability and JSON support depend on the provider and your account.</p>
        </Card>
        <Card className="space-y-4"><h3 className="font-semibold">Speech recognition (pipeline)</h3>
          <label className="block text-sm">Transcription provider<select aria-label="Transcription provider" className={`${inputClassSm} w-full min-w-0 max-w-full`} value={draft.stt_provider} onChange={e => {
            const provider = e.target.value; change({ stt_provider: provider, stt_base_url: provider === 'openai' ? 'https://api.openai.com/v1' : '', stt_model: provider === 'openai' ? 'whisper-1' : '', stt_api_key: '' });
          }}><option value="instance">Instance default</option><option value="openai">OpenAI (direct)</option><option value="custom">Custom OpenAI-compatible transcription</option></select></label>
          {draft.stt_provider !== 'instance' && <><Field label="Transcription base URL" value={draft.stt_base_url || ''} readOnly={draft.stt_provider === 'openai'} onChange={e => change({ stt_base_url: e.target.value })}/><Field label="Transcription model" value={draft.stt_model || ''} onChange={e => change({ stt_model: e.target.value })}/></>}
          <Field label="Transcription API key" type="password" autoComplete="new-password" value={draft.stt_api_key || ''} onChange={e => change({ stt_api_key: e.target.value, stt_clear_api_key: false })} placeholder={saved.stt_api_key_configured ? 'Saved — leave blank to keep' : 'Separate key required for explicit provider'} />
          <label className="block text-sm"><input type="checkbox" checked={Boolean(draft.stt_clear_api_key)} onChange={e => change({ stt_clear_api_key: e.target.checked, stt_api_key: '' })}/> Remove saved transcription key</label>
        </Card>
        <Card className="space-y-4"><h3 className="font-semibold">Realtime voice</h3>
          <label className="block text-sm">Realtime provider<select aria-label="Realtime provider" className={`${inputClassSm} w-full min-w-0 max-w-full`} value={draft.realtime_provider} onChange={e => {
            const provider = e.target.value; change({ realtime_provider: provider, realtime_base_url: provider === 'openai' ? 'wss://api.openai.com/v1/realtime' : provider === 'kataleptic' ? 'wss://api.kataleptic.com/v1/realtime' : '', realtime_api_key: '' });
          }}><option value="instance">Instance default</option><option value="kataleptic">Kataleptic gateway</option><option value="openai">OpenAI (direct)</option><option value="custom">Custom OpenAI GA protocol (experimental)</option></select></label>
          {draft.realtime_provider !== 'instance' && <Field label="Realtime WebSocket URL" value={draft.realtime_base_url || ''} readOnly={draft.realtime_provider === 'openai'} onChange={e => change({ realtime_base_url: e.target.value })} />}
          <Field label="Realtime API key" type="password" autoComplete="new-password" value={draft.realtime_api_key || ''} onChange={e => change({ realtime_api_key: e.target.value, realtime_clear_api_key: false })} placeholder={saved.realtime_api_key_configured ? 'Saved — leave blank to keep' : 'Separate key required for explicit provider'} />
          <label className="block text-sm"><input type="checkbox" checked={Boolean(draft.realtime_clear_api_key)} onChange={e => change({ realtime_clear_api_key: e.target.checked, realtime_api_key: '' })}/> Remove saved realtime key</label>
          <p className="text-sm text-ink-soft">OpenAI uses gpt-realtime when the assistant model is blank. Switching to OpenAI clears known Kataleptic model/voice presets; custom values stay editable in Assistants. For independence from Kataleptic, also select an independent text provider for summaries and transcription provider for pipeline calls.</p>
        </Card>
        <Card><h3 className="font-semibold">Speech synthesis (pipeline)</h3><p className="text-sm text-ink-soft">Instance setting: {saved.tts_provider === 'azure' ? 'Azure Speech, with browser fallback' : 'Browser speech synthesis'}. Browser speech works in browser calls only. Realtime audio uses the selected realtime provider. Text presets do not change speech synthesis.</p></Card>
        <div className="flex flex-wrap gap-3"><Button>{busy ? 'Working…' : 'Save provider settings'}</Button><Button type="button" variant="ghost" onClick={() => void run(async () => { const r = await api.checkProvider(); setMessage(`Saved text connection succeeded (${r.model}). This does not verify voice or telephone calls.`); })}>Check saved text connection</Button></div>
      </fieldset>
    </form>
  </section>;
}
