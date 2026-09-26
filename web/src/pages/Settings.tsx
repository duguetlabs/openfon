import SummarySettings from './SummarySettings';
import ProviderSettings from './ProviderSettings';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type Agent, type Business, type EngineProfile } from '../api';
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
import { Button, Card, Field, FieldLabel, SectionTitle, TextArea, inputClassSm } from '../ui';
import { ListEditor } from './Onboarding';

// A provider-only save refreshes the shared session. Adopt server changes only
// where the sibling form still matches its last loaded value.
function preserveDraftFields<T extends object>(draft: T | null, previous: T | null | undefined, incoming: T): T {
  if (!draft || !previous) return incoming;
  const merged = { ...incoming };
  for (const key of Object.keys(incoming) as (keyof T)[]) {
    if (JSON.stringify(draft[key]) !== JSON.stringify(previous[key])) merged[key] = draft[key];
  }
  return merged;
}

function settingsSnapshot(business: Business) {
  return {
    business, agent: business.agent ? { ...business.agent } : null,
    hours: readHourRows(business.hours_json, []),
    services: readServiceRows(business.services_json),
    faqs: readFaqRows(business.faqs_json, []),
    closures: readClosureRows(business.closures_json),
  };
}

function businessPayload(business: Business, rows: Pick<ReturnType<typeof settingsSnapshot>, 'hours' | 'services' | 'faqs' | 'closures'>) {
  return {
    name: business.name.trim(), description: business.description, address: business.address,
    phone: business.phone, website: business.website, timezone: business.timezone,
    max_concurrent_calls: business.max_concurrent_calls, max_calls_per_day: business.max_calls_per_day,
    hours_json: serializeHourRows(rows.hours), services_json: serializeServiceRows(rows.services),
    faqs_json: serializeFaqRows(rows.faqs), closures_json: serializeClosureRows(rows.closures),
  };
}

export default function Settings() {
  const { business, refresh } = useSession();
  const [biz, setBiz] = useState<Business | null>(null);
  const [hours, setHours] = useState<HourRow[]>([]);
  const [services, setServices] = useState<ServiceRow[]>([]);
  const [faqs, setFaqs] = useState<FaqRow[]>([]);
  const [closures, setClosures] = useState<ClosureRow[]>([]);
  const [agent, setAgent] = useState<Agent | null>(null);
  const [saved, setSaved] = useState('');
  const [saving, setSaving] = useState(false);
  const savingOperation = useRef<{ kind: 'create' | 'profile' | 'settings' } | null>(null);
  const [error, setError] = useState('');
  const [settingsLoadError, setSettingsLoadError] = useState('');
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [profiles, setProfiles] = useState<EngineProfile[]>([]);
  const [profileRefreshPending, setProfileRefreshPending] = useState(false);
  const profileRefreshKind = useRef<'apply' | 'delete'>('apply');
  const profileListGeneration = useRef(0);
  const [newProfileName, setNewProfileName] = useState('');
  const newProfileNameVersion = useRef(0);
  const [profileRenamePending, setProfileRenamePending] = useState(false);
  const profileSavedNames = useRef(new Map<string, string>());
  const profileEditVersion = useRef(new Map<string, number>());
  const profileRenameRequests = useRef(new Map<string, { queued?: { name: string; version: number | undefined } }>());
  const loaded = useRef<ReturnType<typeof settingsSnapshot> | null>(null);
  const mutationGeneration = useRef(0);
  const settingsReadGeneration = useRef(0);
  const settingsRead = useRef<Promise<boolean> | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; settingsReadGeneration.current++; }; }, []);

  function beginSaving(kind: 'create' | 'profile' | 'settings') {
    // React's pending render is not the admission boundary for another handler.
    if (saving || savingOperation.current) return null;
    const operation = { kind };
    savingOperation.current = operation;
    setSaving(true);
    return operation;
  }
  function finishSaving(operation: NonNullable<typeof savingOperation.current>) {
    if (savingOperation.current !== operation) return;
    savingOperation.current = null;
    setSaving(false);
  }

  function readSettings() {
    const run = ++settingsReadGeneration.current;
    const generation = mutationGeneration.current;
    const current = () => mounted.current && run === settingsReadGeneration.current && generation === mutationGeneration.current;
    const request = (async () => {
      try {
        const business = await api.business();
        if (!current()) return false;
        if (!business) throw new Error('Workspace unavailable');
        const incoming = settingsSnapshot(business);
        const previous = loaded.current?.business.id === business.id ? loaded.current : null;
        loaded.current = incoming;
        setBiz(draft => preserveDraftFields(draft, previous?.business, incoming.business));
        setAgent(draft => incoming.agent ? preserveDraftFields(draft, previous?.agent, incoming.agent) : null);
        setHours(draft => previous && JSON.stringify(draft) !== JSON.stringify(previous.hours) ? draft : incoming.hours);
        setServices(draft => previous && JSON.stringify(draft) !== JSON.stringify(previous.services) ? draft : incoming.services);
        setFaqs(draft => previous && JSON.stringify(draft) !== JSON.stringify(previous.faqs) ? draft : incoming.faqs);
        setClosures(draft => previous && JSON.stringify(draft) !== JSON.stringify(previous.closures) ? draft : incoming.closures);
        setSettingsLoadError('');
        return true;
      } catch (e) {
        if (current()) {
          setSettingsLoadError(e instanceof Error ? e.message : 'Could not load settings');
          throw e;
        }
        return false;
      }
    })();
    settingsRead.current = request;
    return request;
  }
  useEffect(() => {
    let active = true;
    if (business) {
      const request = readSettings();
      void request.then(applied => {
        if (!active || !applied || settingsRead.current !== request) return;
        void loadProfiles(business.id).catch(() => {});
      }).catch(() => {}); // readSettings owns only its still-current load failure.
    }
    return () => { active = false; };
  }, [business]);

  function acceptProfiles(rows: EngineProfile[]) {
    const previousNames = new Map(profileSavedNames.current);
    setProfiles(current => rows.map(row => {
      const draft = current.find(old => old.id === row.id);
      return draft && previousNames.has(row.id) && draft.name !== previousNames.get(row.id) ? { ...row, name: draft.name } : row;
    }));
    for (const row of rows) profileSavedNames.current.set(row.id, row.name);
  }
  function creatingProfile() { return savingOperation.current?.kind === 'create'; }
  async function loadProfiles(id: string) {
    if (creatingProfile()) return false;
    const run = ++profileListGeneration.current;
    const rows = await api.profiles(id);
    if (creatingProfile() || run !== profileListGeneration.current) return false;
    acceptProfiles(rows);
    return true;
  }
  async function refreshProfileDisplay() {
    try {
      // Deletion changes only this list. Avoid an unrelated session refresh
      // and the effect-driven second list request it would start.
      if (profileRefreshKind.current === 'apply') {
        await refresh();
        // Effects and explicit recovery share dispatch order. If an independent
        // provider refresh starts a newer read, await its result instead of letting
        // this older snapshot supersede it or declaring recovery prematurely.
        let pending = readSettings();
        let applied = await pending;
        while (settingsRead.current && settingsRead.current !== pending) {
          pending = settingsRead.current;
          applied = await pending;
        }
        if (!applied) throw new Error('Settings changed during the read. Retry the refresh.');
      }
      if (!loaded.current) throw new Error('Workspace unavailable');
      if (!await loadProfiles(loaded.current.business.id)) throw new Error('A newer profile read started. Retry the refresh to confirm the latest list.');
      setProfileRefreshPending(false); setError('');
    } catch (err) {
      setError(`The profile change was saved, but its display could not refresh: ${err instanceof Error ? err.message : 'Request failed'}`);
    }
  }
  async function profileAction(action: () => Promise<unknown>, message: string, deletedId?: string) {
    // Blur registers its rename before the following click, even before a render.
    if (profileRefreshPending || profileRenameRequests.current.size > 0) return;
    const operation = beginSaving('profile');
    if (!operation) return;
    setError(''); mutationGeneration.current++; profileListGeneration.current++;
    try {
      await action();
      mutationGeneration.current++; profileListGeneration.current++;
      profileRefreshKind.current = deletedId ? 'delete' : 'apply';
      if (deletedId) setProfiles(current => current.filter(row => row.id !== deletedId));
      setSaved(message); setProfileRefreshPending(true);
      await refreshProfileDisplay();
    } catch (err) { setError(err instanceof Error ? err.message : 'Profile change failed'); }
    finally { finishSaving(operation); }
  }

  const displayError = error || settingsLoadError;
  const settingsRefreshNeeded = refreshFailed || Boolean(settingsLoadError);
  if (!biz || !agent) return <div>
    <p role={displayError ? 'alert' : 'status'}>{displayError || 'Loading workspace settings…'}</p>
    {settingsRefreshNeeded && <Button disabled={saving} onClick={() => void retryRefresh()}>Retry settings refresh</Button>}
  </div>;

  const workspacePayload = businessPayload(biz, { hours, services, faqs, closures });
  const baseline = loaded.current;
  const businessDirty = !baseline || JSON.stringify(workspacePayload) !== JSON.stringify(businessPayload(baseline.business, baseline));
  const dirty = businessDirty;

  async function retryRefresh() {
    const operation = beginSaving('settings');
    if (!operation) return;
    setError('');
    try {
      await refresh();
      setRefreshFailed(false);
      setSaved('Settings refreshed.');
    } catch (err) {
      setError(`Refreshing settings failed: ${err instanceof Error ? err.message : 'Request failed'}`);
    } finally { finishSaving(operation); }
  }

  async function save() {
    if (profileRefreshPending || !dirty) return;
    const operation = beginSaving('settings');
    if (!operation) return;
    // An effect read started before this mutation cannot supersede an accepted
    // stage, even if its response arrives before the final refresh completes.
    mutationGeneration.current++;
    setError('');
    setSaved('');
    let stage: 'business' | 'refresh' = 'business';
    try {
      if (businessDirty) {
        await api.updateBusiness(biz!.id, workspacePayload);
        mutationGeneration.current++;
        // Confirm each accepted stage before the next request. Later edits are
        // compared with exactly what was submitted, including row-list edits.
        loaded.current = { ...loaded.current!,
          business: { ...loaded.current!.business, ...workspacePayload },
          hours, services, faqs, closures };
      }
      stage = 'refresh';
      await refresh();
      setRefreshFailed(false);
      setSaved('Saved.');
    } catch (err) {
      const detail = err instanceof Error ? err.message : 'Request failed';
      if (stage === 'refresh') {
        setRefreshFailed(true);
        setSaved('Changes saved.');
      }
      setError(stage === 'refresh' ? `Business changes were saved, but refreshing the page data failed: ${detail}`
        : `Business save failed: ${detail}`);
    } finally { finishSaving(operation); }
  }

  async function renameProfile(id: string, name: string) {
    if (savingOperation.current || profileRefreshPending) return;
    const edit = { name, version: profileEditVersion.current.get(id) };
    // Serialize per profile so each queued edit uses the last acknowledged name,
    // never a draft captured while an earlier request was still pending.
    const running = profileRenameRequests.current.get(id);
    if (running) { running.queued = edit; return; }
    const request: { queued?: typeof edit } = { queued: edit };
    profileRenameRequests.current.set(id, request);
    setProfileRenamePending(true);
    try {
      while (request.queued) {
        const next = request.queued;
        request.queued = undefined;
        const confirmed = profileSavedNames.current.get(id);
        const normalized = next.name.trim() || confirmed || '';
        const acknowledgeName = () => setProfiles(current => current.map(profile =>
          profile.id === id && profileEditVersion.current.get(id) === next.version && profile.name === next.name
            ? { ...profile, name: normalized } : profile));
        if (normalized === confirmed) { acknowledgeName(); continue; }
        try {
          await api.updateProfile(id, { name: normalized });
          profileListGeneration.current++;
          profileSavedNames.current.set(id, normalized);
          acknowledgeName();
        } catch (err) {
          if (profileEditVersion.current.get(id) !== next.version) continue;
          setError(err instanceof Error ? err.message : 'Rename failed');
          if (confirmed !== undefined) setProfiles(current => current.map(profile =>
            profile.id === id && profile.name === next.name ? { ...profile, name: confirmed } : profile));
        }
      }
    } finally {
      profileRenameRequests.current.delete(id);
      setProfileRenamePending(profileRenameRequests.current.size > 0);
    }
  }

  async function createProfile() {
    if (!newProfileName.trim() || profileRefreshPending || profileRenameRequests.current.size > 0) return;
    const operation = beginSaving('create');
    if (!operation) return;
    const nameVersion = newProfileNameVersion.current;
    const workspaceId = biz!.id;
    const payload = {
      name: newProfileName.trim(),
      engine: agent!.engine, realtime_model: agent!.realtime_model,
      realtime_voice: agent!.realtime_voice, language: agent!.language,
      voice: agent!.voice, llm_base_url: agent!.llm_base_url,
      llm_api_key: agent!.llm_api_key, llm_model: agent!.llm_model,
    };
    profileListGeneration.current++;
    setError(''); setSaved('');
    try {
      const profile = await api.createProfile(workspaceId, payload);
      const previousName = profileSavedNames.current.get(profile.id);
      profileSavedNames.current.set(profile.id, profile.name);
      setProfiles(current => {
        const draft = current.find(row => row.id === profile.id);
        const accepted = draft && previousName !== undefined && draft.name !== previousName
          ? { ...profile, name: draft.name } : profile;
        return [...current.filter(row => row.id !== profile.id), accepted];
      });
      setNewProfileName(current => newProfileNameVersion.current === nameVersion ? '' : current);
      setSaved('Profile saved.');
      // Confirm from the returned row without adding a post-create refresh.
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save profile');
    } finally {
      profileListGeneration.current++;
      finishSaving(operation);
    }
  }

  const profileFields = ['engine', 'realtime_model', 'realtime_voice', 'language', 'voice', 'llm_model'] as const;
  const profileDraftDirty = profileFields.some(key => agent[key] !== loaded.current?.agent?.[key]);
  const profileApplyReason = 'Save or revert your engine, model, language, and voice edits before applying a profile.';

  const set = (patch: Partial<Business>) => setBiz({ ...biz, ...patch });

  return (
    <div className="settings-page space-y-8">
      <div className="rise">
        <p className="font-mono text-[11px] uppercase tracking-[0.22em] text-ink-faint">Configuration</p>
        <h1 className="mt-1 font-display text-4xl font-semibold tracking-tight text-ink">Settings</h1>
        <p className="mt-3 text-ink-soft">Shared business details, provider connections, and after-call summaries.</p>
      </div>
      <nav className="settings-nav" aria-label="Settings sections">
        <a href="#business-details">Business</a><a href="#providers">AI connections</a><a href="#call-summaries">Call summaries</a><a href="#saved-voice-setups">Saved voice setups</a>
      </nav>
      <Card className="settings-scope-note"><div><h2 className="font-semibold">Looking for an assistant’s voice or instructions?</h2><p className="text-sm text-ink-soft mt-1">Edit them in Assistants. Each assistant has its own personality, language, voice, and conversation engine.</p></div><Link className="studio-link" to="/assistants">Manage assistants →</Link></Card>
      <section id="business-details" className="settings-section rise">
        <SectionTitle sub="Shared facts used by your assistants. Changes are saved separately from AI connections and summaries.">Business</SectionTitle>
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

      <ProviderSettings onSaved={refresh} />
      <SummarySettings />
      <details id="saved-voice-setups" className="settings-advanced">
        <summary>Saved voice setups <span className="text-sm text-ink-soft">· primary assistant</span></summary>
        <section className="mt-5">
        <SectionTitle sub="Existing engine profiles are kept here for your primary assistant. Applying a profile replaces its engine, model, language, and voice; other assistants are unchanged.">
          Engine profiles
        </SectionTitle>
        <Card className="space-y-3">
          <p aria-label="Current primary assistant setup" className="text-sm text-ink-soft">Current saved setup for {agent.agent_name}: {agent.engine} · {(agent.engine === 'realtime' ? agent.realtime_model : agent.llm_model) || 'default model'} · {agent.language} · {(agent.engine === 'realtime' ? agent.realtime_voice : agent.voice) || 'default voice'}. <Link className="studio-link" to="/assistants">Edit in Assistants →</Link></p>
          <p className="text-xs text-ink-soft">Up to 64 profiles are shown. Long historical values are previews and cannot be renamed here; applying uses the full saved configuration. Delete unused profiles to reveal more.</p>
          {profiles.length === 0 && <p className="text-sm text-ink-soft">No profiles yet. Configure your primary assistant in Assistants, then return here to save its voice setup.</p>}
          {profileDraftDirty && profiles.length > 0 && <p className="text-sm text-ink-soft">{profileApplyReason}</p>}
          <p className="text-xs text-ink-soft">If you click Apply or Delete profile while a name is saving, click it again after saving finishes.</p>
          {profileRenamePending && <p role="status" className="text-sm text-ink-soft">Saving profile names…</p>}
          {profiles.map((p) => (
            <div key={p.id} className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-wash-iris/50 px-3 py-2">
              <input
                className="min-w-32 flex-1 rounded-lg border border-transparent bg-transparent px-2 py-1 text-sm font-semibold text-ink outline-none hover:border-line-strong focus:border-iris focus:bg-surface focus:ring-[3px] focus:ring-iris/15"
                aria-label={`Profile name: ${profileSavedNames.current.get(p.id) || p.name}`}
                value={p.name}
                readOnly={Boolean(p.preview_only) || saving || profileRefreshPending}
                onFocus={() => { if (!profileSavedNames.current.has(p.id)) profileSavedNames.current.set(p.id, p.name); }}
                onChange={(e) => {
                  profileEditVersion.current.set(p.id, (profileEditVersion.current.get(p.id) ?? 0) + 1);
                  setProfiles(profiles.map((x) => (x.id === p.id ? { ...x, name: e.target.value } : x)));
                }}
                onBlur={(e) => { if (!p.preview_only) renameProfile(p.id, e.target.value); }}
              />
              <span className="font-mono text-[11px] text-ink-soft">
                {p.engine === 'realtime' ? `realtime · ${p.realtime_model || 'default'}` : 'pipeline'} · {p.language}
                {(p.realtime_voice || p.voice) && ` · ${p.realtime_voice || p.voice}`}
              </span>
              <button
                disabled={profileDraftDirty || saving || profileRefreshPending || profileRenamePending}
                title={profileDraftDirty ? profileApplyReason : undefined}
                className="rounded-lg bg-iris px-3 py-1 text-xs font-semibold text-white transition-colors hover:bg-iris-deep disabled:cursor-not-allowed disabled:opacity-50"
                onClick={() => void profileAction(() => api.applyProfile(p.id), `Applied "${p.name}".`)}
              >
                Apply
              </button>
              <button
                className="px-1 text-ink-faint transition-colors hover:text-rose"
                aria-label="Delete profile"
                disabled={saving || profileRefreshPending || profileRenamePending}
                onClick={() => void profileAction(() => api.deleteProfile(p.id), 'Profile deleted.', p.id)}
              >
                ✕
              </button>
            </div>
          ))}
          <div className="flex gap-2 pt-1">
            <input
              className={`${inputClassSm} flex-1 px-3.5 py-2`}
              aria-label="New profile name"
              placeholder='Save current setup as… e.g. "German front desk"'
              value={newProfileName}
              onChange={(e) => { newProfileNameVersion.current++; setNewProfileName(e.target.value); }}
            />
            <Button
              variant="ghost"
              disabled={!newProfileName.trim() || saving || profileRefreshPending || profileRenamePending}
              onClick={() => void createProfile()}
            >
              {saving && savingOperation.current?.kind === 'create' ? 'Saving profile…' : 'Save profile'}
            </Button>
          </div>
        </Card>
      </section>
      </details>
      <div className="settings-save-bar">
        <p className="settings-save-context">
          Business changes apply on the next call
        </p>
        <div className="flex items-center gap-3">
          {saved && <span role="status" className="text-sm font-semibold text-ok">{saved}</span>}
          {displayError && <span role="alert" className="text-sm text-rose">{displayError}</span>}
          {profileRefreshPending && <Button variant="ghost" disabled={saving} onClick={() => { const operation = beginSaving('settings'); if (!operation) return; void refreshProfileDisplay().finally(() => finishSaving(operation)); }}>Retry profile refresh</Button>}
          {settingsRefreshNeeded && <Button variant="ghost" disabled={saving} onClick={() => void retryRefresh()}>Retry settings refresh</Button>}
          <Button disabled={saving || profileRefreshPending || !dirty} onClick={() => void save()}>{saving ? 'Saving…' : 'Save changes'}</Button>
        </div>
      </div>
    </div>
  );
}
