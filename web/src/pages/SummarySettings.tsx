import { useEffect, useRef, useState } from 'react';
import { api, type SummaryView } from '../api';
import { CatalogSelect, choices } from '../VoiceSettings';
import { Button, Card, Field, inputClass } from '../ui';
import { useUnsavedEdits } from '../unsaved-edits';

type Draft = Pick<SummaryView, 'mode' | 'baseUrl' | 'model'> & { apiKey: string };
const draftOf = (s: SummaryView): Draft => ({ mode: s.mode, baseUrl: s.baseUrl, model: s.model, apiKey: '' });
const presets = [
  { id: 'kataleptic', name: 'Kataleptic', url: 'https://api.kataleptic.com/v1', model: 'llama-3.3-70b' },
  { id: 'openai', name: 'OpenAI', url: 'https://api.openai.com/v1', model: 'gpt-4.1-mini' },
  { id: 'openrouter', name: 'OpenRouter', url: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4.1-mini' },
];

export default function SummarySettings() {
  const [saved, setSaved] = useState<SummaryView | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [catalog, setCatalog] = useState<Awaited<ReturnType<typeof api.providerCatalog>> | null>(null);
  const active = useRef(false); const pending = useRef(false);
  const dirty = !!saved && !!draft && JSON.stringify(draft) !== JSON.stringify(draftOf(saved));
  useUnsavedEdits(dirty);
  const accept = (s: SummaryView) => { setSaved(s); setDraft(draftOf(s)); };
  useEffect(() => {
    let current = true; active.current = true;
    void api.summarySettings().then(s => { if (current) accept(s); }).catch(e => { if (current) setError(e.message); });
    void api.providerCatalog().then(c => { if (current) setCatalog(c); }).catch(() => {});
    return () => { current = false; active.current = false; };
  }, []);
  async function run(save: boolean) {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(''); setMessage('');
    try {
      const next = save && saved && draft ? await api.updateSummarySettings({ ...draft, revision: saved.revision }) : await api.summarySettings();
      if (active.current) { accept(next); if (save) setMessage('Call summary settings saved. Voice profiles are unchanged.'); }
    } catch (e) {
      if (active.current) setError(e instanceof Error ? e.message : 'Summary settings request failed.');
    } finally { pending.current = false; if (active.current) setBusy(false); }
  }
  const change = (patch: Partial<Draft>) => { setDraft(d => d && { ...d, ...patch }); setMessage(''); };
  const selected = draft?.mode !== 'custom' ? draft?.mode : presets.find(p => p.url === draft.baseUrl)?.id || 'custom';
  const options = draft?.baseUrl === presets[0].url ? catalog?.models.filter(m => m.kind === 'text') || choices(['llama-3.3-70b', 'mistral-nemo-12b'])
    : draft?.baseUrl === presets[1].url ? choices(['gpt-4.1-mini', 'gpt-4o-mini']) : [];
  return <section id="call-summaries" aria-label="Call summaries">
    <h2 className="font-display text-2xl mb-3">Call summaries</h2>
    <p className="text-sm text-ink-soft mb-4">Summaries run after a call. Choose one model for this workspace, independently of the voice, conversation engine and Pipeline reply model.</p>
    {error && <p role="alert" className="text-rose mb-3">{error}</p>}
    {message && <p role="status" className="mb-3">{message}</p>}
    {error && <Button type="button" variant="ghost" disabled={busy} onClick={() => void run(false)}>Reload summary settings (discard edits)</Button>}
    {!draft || !saved ? <p role="status">{error ? 'Summary settings unavailable.' : 'Loading call summaries…'}</p> :
      <form onSubmit={e => { e.preventDefault(); if (dirty) void run(true); }}>
        <fieldset disabled={busy} className="min-w-0 space-y-4"><Card className="space-y-4">
          <label className="block text-sm">Summary provider<select aria-label="Summary provider" className={`${inputClass} w-full min-w-0`} value={selected} onChange={e => {
            const p = presets.find(p => p.id === e.target.value);
            change({ mode: e.target.value === 'legacy' || e.target.value === 'workspace' ? e.target.value : 'custom', baseUrl: p?.url || '', model: p?.model || '', apiKey: '' });
          }}><option value="workspace">Workspace text provider</option>{presets.map(p => <option key={p.id} value={p.id}>{p.name} — separate key</option>)}<option value="custom">Custom OpenAI-compatible — separate key</option><option value="legacy">Keep existing behavior (compatibility)</option></select></label>
          {draft.mode === 'legacy' ? <p className="text-sm text-ink-soft">Existing assistant text-model overrides still determine summaries in compatibility mode. Select Workspace text provider or a separate provider to make summaries independent of voice profiles.</p> : <>
            {draft.mode === 'custom' && <Field label="Summary base URL" value={draft.baseUrl} onChange={e => change({ baseUrl: e.target.value })} hint="OpenAI-compatible /chat/completions endpoint. Changing the endpoint requires a replacement key." />}
            <CatalogSelect key={`${draft.mode}:${draft.baseUrl}`} label="Summary model" value={draft.model} onChange={model => change({ model })} options={options} allowDefault={draft.mode === 'workspace'} defaultLabel={draft.mode === 'workspace' ? 'Workspace text model (ignores assistant overrides)' : 'Choose a model'} hint="Used only for post-call summaries. Custom IDs must be supported by the selected provider." />
            {draft.mode === 'custom' ? <><Field label="Summary API key" type="password" autoComplete="new-password" value={draft.apiKey} onChange={e => change({ apiKey: e.target.value })} placeholder={saved.apiKeyConfigured && saved.baseUrl === draft.baseUrl ? 'Saved — leave blank to keep at this endpoint' : 'Separate summary key required'} /><p className="text-sm text-ink-soft">To remove this key, switch to Workspace text provider and save. Keys are never copied into voice profiles.</p></> : <p className="text-sm text-ink-soft">Uses the saved workspace text endpoint and key. Set a summary model here or inherit the workspace text model; assistant overrides do not apply.</p>}
          </>}
        </Card><Button disabled={!dirty}>{busy ? 'Saving…' : 'Save summary settings'}</Button></fieldset>
      </form>}
  </section>;
}
