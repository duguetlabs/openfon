import { PromptExamples } from '../PromptExamples';
import { AssistantVoiceSettings } from '../VoiceSettings';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation, useNavigate, useNavigationType, useParams, useSearchParams } from 'react-router-dom';
import { api, ApiError, type Assistant, type AssistantListItem, type CallRow, type KnowledgeCollection, type KnowledgeItem, type OverviewResponse } from '../api';
import { Button, Card, Field, TextArea, Spinner, inputClass, fmtDuration, fmtTime } from '../ui';
import { VoiceCall } from '../voice';
import '../studio.css';
import { useUnsavedEdits } from '../unsaved-edits';
const errorText = (e: unknown) => e instanceof Error ? e.message : 'The request could not be completed. Please try again.';
export function PageTitle({ title, description, children }: {
    title: string;
    description: string;
    children?: ReactNode;
}) { return <div className="studio-title"><div><p className="studio-eyebrow">YOUR WORKSPACE</p><h1>{title}</h1><p>{description}</p></div>{children}</div>; }
export function Notice({ error, message }: {
    error?: string;
    message?: string;
}) { return error ? <p role="alert" className="studio-notice studio-error">{error}</p> : message ? <p role="status" className="studio-notice">{message}</p> : null; }
export function CallList({ calls }: {
    calls: CallRow[];
}) { return <div className="studio-call-list">{calls.map(c => <Link key={c.id} to={`/calls/${c.id}`}><div><strong>{c.summary || (c.status === 'active' ? 'Call in progress' : c.status === 'abandoned' ? c.connected_at ? 'Call interrupted' : 'Never connected' : c.status === 'failed' ? 'Call failed' : 'Conversation')}</strong><p>{c.assistant_name || 'Assistant'} · {fmtTime(c.started_at)} · {fmtDuration(c.duration_s)}</p></div><span className="studio-badge">{c.environment || 'live'} · {c.outcome?.replaceAll('_', ' ') || c.status}</span><span aria-hidden>↗</span></Link>)}</div>; }
export function Overview() {
    const [days, setDays] = useState<7 | 30 | 90>(30);
    const [data, setData] = useState<OverviewResponse | null>(null);
    const [error, setError] = useState('');
    const [reload, setReload] = useState(0);
    useEffect(() => { let active = true; setData(null); setError(''); void api.overview(days).then(d => { if (active)
        setData(d); }).catch(e => { if (active)
        setError(errorText(e)); }); return () => { active = false; }; }, [days, reload]);
    return <><PageTitle title="A little more room to breathe." description="Your live conversations, messages, and next steps in one place."><select aria-label="Overview period" className={inputClass} value={days} onChange={e => setDays(Number(e.target.value) as 7 | 30 | 90)}>{[7, 30, 90].map(d => <option key={d} value={d}>Last {d} days</option>)}</select></PageTitle><Notice error={error}/>{error && <Button variant="ghost" onClick={() => setReload(n => n + 1)}>Retry overview</Button>}{!data && !error && <LoadingStatus />}{data && <><div className="studio-stats">{[['Live calls', data.metrics.total], ['Messages', data.metrics.messages || 0], ['Booking requests', data.metrics.booking_requests || 0], ['Talk time', fmtDuration(data.metrics.talk_time_s || 0)]].map(([label, value]) => <Card key={label}><p>{label}</p><strong>{value}</strong></Card>)}</div><div className="studio-actions"><Link to="/assistants">Manage assistants ↗</Link><Link to="/test">Make a test call ↗</Link><Link to="/knowledge">Improve answers ↗</Link></div><h2 className="studio-heading">Recent live calls</h2>{data.recentCalls.length ? <CallList calls={data.recentCalls}/> : <Card><h2>No live calls yet</h2><p className="mt-2">Create an assistant, try a private test, then publish its browser call link when you’re ready.</p><Link className="studio-link" to="/assistants">Open assistants →</Link></Card>}</>}</>;
}
export function Assistants() {
    const [rows, setRows] = useState<AssistantListItem[] | null>(null);
    const [name, setName] = useState('');
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    const [reload, setReload] = useState(0);
    const [offset, setOffset] = useState(0);
    const nav = useNavigate();
    useEffect(() => { let active = true; setError(''); void api.assistants(offset).then(d => { if (active) setRows(d); }).catch(e => { if (active) setError(errorText(e)); }); return () => { active = false; }; }, [reload, offset]);
    return <><PageTitle title="Your assistants" description="Give each line a purpose, a voice, and the knowledge it needs."/><Notice error={error}/>{error && !rows && <Button variant="ghost" onClick={() => setReload(n => n + 1)}>Retry assistants</Button>}<form className="studio-create" onSubmit={async (e) => { e.preventDefault(); if (busy) return; setBusy(true); setError(''); try {
        const a = await api.createAssistant({ name: name.trim() });
        nav(`/assistants/${a.id}`);
    }
    catch (e) {
        setError(errorText(e));
    }
    finally {
        setBusy(false);
    } }}><Field label="New assistant name" required maxLength={100} value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Front desk"/><Button disabled={busy || !name.trim()}>{busy ? 'Creating…' : 'Create assistant'}</Button></form>{!rows && !error && <LoadingStatus />}{rows?.length === 0 && <Card className="mb-5"><h2>No assistants yet</h2><p className="mt-2">Give your first assistant a name above. You can configure and test it privately before publishing.</p></Card>}<div className="studio-grid">{rows?.map(a => <Card key={a.id}><div className="studio-between"><h2>{a.name}</h2><span className="studio-badge">{a.state}</span></div><p className="studio-description">{a.persona || 'Add a personality and instructions to get started.'}</p><p className="studio-muted">{a.language} · {a.engine} · {a.last_test_at ? `Tested ${fmtTime(a.last_test_at)}` : 'Not tested yet'}</p><div className="studio-actions"><Link to={`/assistants/${a.id}`}>Configure →</Link><Link to={`/test?assistant=${a.id}`}>Test ↗</Link></div></Card>)}</div><div className="studio-actions">{offset > 0 && <Button variant="ghost" onClick={() => setOffset(Math.max(0, offset - 32))}>Previous assistants</Button>}{rows?.length === 32 && <Button variant="ghost" onClick={() => setOffset(offset + 32)}>Next assistants</Button>}</div></>;
}
export function AssistantEditor() {
    const { assistantId } = useParams();
    return <AssistantEditorForm key={assistantId} assistantId={assistantId!} />;
}
function AssistantEditorForm({ assistantId }: { assistantId: string }) {
    const navigate = useNavigate();
    const [a, setA] = useState<Assistant | null>(null);
    const [savedAssistant, setSavedAssistant] = useState<Assistant | null>(null);
    const [error, setError] = useState('');
    const [message, setMessage] = useState('');
    const [refreshError, setRefreshError] = useState('');
    const [busy, setBusy] = useState(false);
    const mounted = useRef(true);
    const [reload, setReload] = useState(0);
    useEffect(() => {
        mounted.current = true; setError('');
        let active = true;
        void api.assistant(assistantId).then(d => {
            if (active) { setA(d); setSavedAssistant(d); }
        }).catch(e => { if (active) setError(errorText(e)); });
        return () => { active = false; mounted.current = false; };
    }, [assistantId, reload]);
    const editable: (keyof Assistant)[] = ['name', 'greeting', 'persona', 'language', 'voice', 'take_messages', 'custom_instructions', 'engine', 'realtime_model', 'realtime_voice', 'llm_model'];
    async function refreshAssistant(baseline: Assistant | null) {
        try {
            const updated = await api.assistant(assistantId);
            if (!mounted.current) return;
            // A pause or a refresh retry must retain edits made since the last save.
            setA(current => current && baseline ? {
                ...updated,
                ...Object.fromEntries(editable.filter(key => current[key] !== baseline[key]).map(key => [key, current[key]])),
            } : updated);
            setSavedAssistant(updated);
            setRefreshError('');
        } catch (e) {
            if (mounted.current) setRefreshError(`Your changes were saved, but the assistant could not be refreshed. ${errorText(e)}`);
        }
    }
    async function action(fn: () => Promise<unknown>, success: string, reload: boolean | 'lifecycle' = true) {
        if (busy) return;
        setBusy(true); setError(''); setMessage('');
        try {
            const result = await fn();
            if (!mounted.current) return;
            setMessage(success);
            if (reload) {
                // The mutation response is authoritative even if the following GET fails.
                const committed = reload === 'lifecycle'
                    ? { ...savedAssistant!, state: (result as { state: Assistant['state'] }).state }
                    : result as Assistant;
                setA(current => reload === 'lifecycle' && current ? { ...current, state: committed.state } : committed);
                setSavedAssistant(committed);
                await refreshAssistant(committed);
            }
        } catch (e) { if (mounted.current) setError(errorText(e)); }
        finally { if (mounted.current) setBusy(false); }
    }
    const dirty = Boolean(a && editable.some(key => a[key] !== savedAssistant?.[key]));
    useUnsavedEdits(dirty);
    if (!a) return <><Notice error={error}/>{error ? <Button variant="ghost" onClick={() => setReload(n => n + 1)}>Retry assistant</Button> : <LoadingStatus />}</>;
    const field = (key: keyof Assistant, label: string, multiline = false) => multiline ? <TextArea key={key} label={label} value={String(a[key] ?? '')} onChange={e => setA({ ...a, [key]: e.target.value })}/> : <Field key={key} label={label} required={['name', 'language'].includes(key)} value={String(a[key] ?? '')} onChange={e => setA({ ...a, [key]: e.target.value })}/>;
    return <><PageTitle title={a.name} description="Save your changes, test a conversation, then publish when you are satisfied."><span className="studio-badge">{a.state}</span></PageTitle><Notice error={error} message={message}/>{refreshError && <><Notice error={refreshError}/><Button variant="ghost" disabled={busy} onClick={() => { if (busy) return; setBusy(true); void refreshAssistant(savedAssistant).finally(() => { if (mounted.current) setBusy(false); }); }}>Retry assistant refresh</Button></>}{dirty && <p role="status" className="studio-notice">You have unsaved changes. Save before testing or publishing.</p>}<form onSubmit={e => { e.preventDefault(); if (dirty) void action(() => api.updateAssistant(a.id, a), 'Assistant saved.'); }}><fieldset disabled={busy} className="studio-grid"><Card><h2 className="studio-heading">Personality & purpose</h2><div className="studio-fields">{field('name', 'Name')}{field('greeting', 'Opening greeting', true)}{field('persona', 'Personality and role', true)}{field('custom_instructions', 'Additional instructions', true)}<PromptExamples current={a.custom_instructions} onUse={prompt => setA(current => current ? { ...current, custom_instructions: prompt } : current)} /><label className="studio-check"><input type="checkbox" checked={Boolean(a.take_messages)} onChange={e => setA({ ...a, take_messages: e.target.checked ? 1 : 0 })}/>Take caller messages</label></div></Card><Card><h2 className="studio-heading">Voice & engine</h2><AssistantVoiceSettings assistant={a} onChange={patch => setA(current => current ? { ...current, ...patch } : current)} /><Button type="button" variant="ghost" onClick={() => void action(() => api.checkProvider(a.id), 'Text provider check succeeded for the saved assistant. Realtime audio and speech were not tested.', false)}>Check text provider</Button></Card></fieldset><div className="studio-actions"><Button disabled={busy || !dirty}>Save changes</Button><Link to={`/test?assistant=${a.id}`}>Open Test Studio →</Link><Link to="/knowledge">Manage knowledge →</Link></div></form><Card><h2 className="studio-heading">Publish your browser call line</h2><p>Publishing lets anyone with the link call this assistant. Pausing prevents new public calls. Private tests remain available.</p><div className="studio-actions">{a.state === 'active' ? <Button disabled={busy} variant="ghost" onClick={() => void action(() => api.pauseAssistant(a.id), 'Assistant paused. New public calls are disabled.', 'lifecycle')}>Pause assistant</Button> : <Button disabled={busy || dirty} onClick={() => void action(() => api.activateAssistant(a.id), 'Assistant published. Its call link is now available.', 'lifecycle')}>Publish assistant</Button>}{a.state === 'active' && <a href={`/call/${a.public_slug}`} target="_blank" rel="noreferrer">Open public call link ↗</a>}</div><Field label="Public call link" readOnly value={`${location.origin}/call/${a.public_slug}`}/>{a.state !== 'active' && <Button variant="ghost" disabled={busy || dirty} onClick={() => { if (window.confirm('Delete this assistant? Saved call history is retained.')) void action(async () => { await api.deleteAssistant(a.id); navigate('/assistants'); }, '', false); }}>Delete assistant</Button>}</Card></>;
}
function useAssistantChoices(reload: number, requestedId = '') {
    const [assistants, setAssistants] = useState<AssistantListItem[]>([]);
    const [assistantError, setAssistantError] = useState('');
    const [requestedMissing, setRequestedMissing] = useState(false);
    const [more, setMore] = useState(false);
    const [loading, setLoading] = useState(false);
    const offset = useRef(0);
    const generation = useRef(0);
    useEffect(() => {
        const run = ++generation.current; setLoading(true); setAssistantError(''); setRequestedMissing(false);
        const requestedLookup = requestedId ? api.assistant(requestedId).catch(error => {
            if (error instanceof ApiError && error.status === 404) return null;
            throw error;
        }) : Promise.resolve(null);
        void Promise.all([api.assistants(), requestedLookup]).then(([page, requested]) => {
            if (run !== generation.current) return;
            setRequestedMissing(Boolean(requestedId && !requested));
            offset.current = page.length; setMore(page.length === 32);
            setAssistants(requested && !page.some(a => a.id === requested.id) ? [requested, ...page] : page);
        }).catch(e => { if (run === generation.current) { setAssistants([]); setAssistantError(errorText(e)); } })
          .finally(() => { if (run === generation.current) setLoading(false); });
        return () => { generation.current++; };
    }, [reload, requestedId]);
    async function loadMore() {
        if (loading || !more) return;
        const run = generation.current; setLoading(true); setAssistantError('');
        try {
            const page = await api.assistants(offset.current);
            if (run !== generation.current) return;
            offset.current += page.length; setMore(page.length === 32);
            setAssistants(rows => [...rows, ...page.filter(a => !rows.some(row => row.id === a.id))]);
        } catch (e) { if (run === generation.current) setAssistantError(errorText(e)); }
        finally { if (run === generation.current) setLoading(false); }
    }
    return { assistants, assistantError, requestedMissing, more, loading, loadMore };
}
function MoreAssistants({ choices }: { choices: ReturnType<typeof useAssistantChoices> }) {
    return choices.more ? <Button variant="ghost" disabled={choices.loading} onClick={() => void choices.loadMore()}>Load more assistants</Button> : null;
}
export function Calls() {
    const [params, setParams] = useSearchParams();
    const [rows, setRows] = useState<CallRow[]>([]);
    const [cursor, setCursor] = useState<string | null>(null);
    const [busy, setBusy] = useState(true);
    const [error, setError] = useState('');
    const [search, setSearch] = useState(params.get('search') || '');
    const location = useLocation();
    const navigationType = useNavigationType();
    useLayoutEffect(() => {
      // Our own pending filter navigation must not overwrite a newer keystroke.
      // Back/Forward and external links still restore their URL's search value.
      if (navigationType === 'POP' || !location.state?.callsFilterUpdate) {
        setSearch(params.get('search') || '');
      }
    }, [location.key, navigationType, params]);
    const generation = useRef(0);
    const [reload, setReload] = useState(0);
    const choices = useAssistantChoices(reload, params.get('assistantId') || '');
    const { assistants, assistantError } = choices;
    const query = params.toString();
    useEffect(() => { const run = ++generation.current; setBusy(true); setError(''); setRows([]); setCursor(null); const p = new URLSearchParams(query); if (!p.has('environment'))
        p.set('environment', 'all'); void api.callPage(p).then(d => { if (run === generation.current) {
        setRows(d.items);
        setCursor(d.nextCursor);
    } }).catch(e => { if (run === generation.current)
        setError(errorText(e)); }).finally(() => { if (run === generation.current)
        setBusy(false); }); }, [query, reload]);
    function filter(key: string, value: string) { const p = new URLSearchParams(params); if (search.trim()) p.set('search', search.trim()); else p.delete('search'); if (value)
        p.set(key, value);
    else
        p.delete(key); p.delete('cursor'); setParams(p, { state: { callsFilterUpdate: true } }); }
    return <><PageTitle title="Conversations" description="Review what callers needed, what worked, and what to improve."><Button disabled={busy} variant="ghost" onClick={() => setReload(n => n + 1)}>Refresh calls</Button></PageTitle><div className="studio-filters"><form onSubmit={e => { e.preventDefault(); filter('search', search); }}><Field label="Search conversations" value={search} onChange={e => setSearch(e.target.value)} placeholder="Caller, summary, or transcript"/><Button variant="ghost">Search</Button></form><label>Environment<select className={inputClass} value={params.get('environment') || 'all'} onChange={e => filter('environment', e.target.value)}><option value="all">Live & test</option><option value="live">Live only</option><option value="test">Test only</option></select></label><label>Assistant<select className={inputClass} value={params.get('assistantId') || ''} onChange={e => filter('assistantId', e.target.value)}><option value="">All assistants</option>{assistants.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label><label>Status<select className={inputClass} value={params.get('status') || ''} onChange={e => filter('status', e.target.value)}><option value="">All statuses</option>{['active', 'completed', 'failed', 'abandoned'].map(s => <option key={s}>{s}</option>)}</select></label></div><MoreAssistants choices={choices}/><Notice error={error || assistantError}/>{busy && <LoadingStatus />}{!busy && !rows.length && !error && <Card>No conversations match these filters. <Link to="/test">Start a private test call →</Link></Card>}<CallList calls={rows}/>{cursor && <Button disabled={busy} className="mt-5" variant="ghost" onClick={async () => { if (busy) return; const run = generation.current; setBusy(true); setError(''); try {
        const p = new URLSearchParams(query);
        if (!p.has('environment'))
            p.set('environment', 'all');
        p.set('cursor', cursor);
        const d = await api.callPage(p);
        if (run === generation.current) {
            setRows(r => [...r, ...d.items]);
            setCursor(d.nextCursor);
        }
    }
    catch (e) {
        if (run === generation.current)
            setError(errorText(e));
    }
    finally {
        if (run === generation.current)
            setBusy(false);
    } }}>Load older calls</Button>}</>;
}
export function TestStudio() {
    const [params] = useSearchParams();
    const [id, setId] = useState(params.get('assistant') || '');
    const [phase, setPhase] = useState('idle');
    const [error, setError] = useState('');
    const [assistantReload, setAssistantReload] = useState(0);
    const [callId, setCallId] = useState('');
    const [lines, setLines] = useState<{
        who: string;
        text: string;
    }[]>([]);
    const [text, setText] = useState('');
    const [hasMic, setHasMic] = useState(true);
    const [audioBlocked, setAudioBlocked] = useState(false);
    const [engine, setEngine] = useState('');
    const [debugEnabled, setDebugEnabled] = useState<boolean | null>(null);
    const [debugRecording, setDebugRecording] = useState<boolean | null>(null);
    useEffect(() => { let active = true; void fetch('/api/me/debug-config').then(r => r.ok ? r.json() : Promise.reject(new Error('debug_config_unavailable'))).then(v => { if (active) setDebugEnabled(v?.testCalls === true); }).catch(() => {}); return () => { active = false; }; }, []);
    const call = useRef<VoiceCall | null>(null);
    const attempt = useRef(0);
    const pendingCallId = useRef<string | null>(null);
    const retire = (id: string) => { void api.cancelTestCall(id).catch(() => { /* The stale-ticket sweep remains the network-failure fallback. */ }); };
    function cancelPending() {
        const id = pendingCallId.current;
        pendingCallId.current = null;
        if (id) retire(id);
    }
    const choices = useAssistantChoices(assistantReload, params.get('assistant') || '');
    const { assistants, assistantError } = choices;
    useEffect(() => { setId(selected => choices.requestedMissing && selected === params.get('assistant')
        ? ''
        : selected || (params.get('assistant') ? '' : assistants[0]?.id || '')); }, [assistants, choices.requestedMissing, params]);
    useEffect(() => () => { attempt.current++; call.current?.hangup(); cancelPending(); }, []);
    const active = phase === 'connecting' || phase === 'live';
    async function start() { if (active) return; const run = ++attempt.current; call.current?.hangup(); cancelPending(); setPhase('connecting'); setError(''); setLines([]); setCallId(''); try {
        const voice = new VoiceCall();
        call.current = voice;
        setAudioBlocked(false); setEngine(''); setDebugRecording(null);
        voice.on(e => { if (run !== attempt.current)
            return; if (e.type === 'audio') setAudioBlocked(e.blocked);
            if (e.type === 'engine') setEngine(e.label);
            if (e.type === 'debug') setDebugRecording(e.recording);
            if (e.type === 'status') {
            if (e.status === 'error') {
                voice.hangup();
                cancelPending();
                setError(e.detail || 'Connection failed');
            }
            setPhase(e.status);
        } if (e.type === 'transcript')
            setLines(l => [...l, { who: 'You', text: e.text }]); if (e.type === 'agent_text')
            setLines(l => [...l, { who: 'Assistant', text: e.text }]); });
        voice.prepareAudio();
        const reserved = await api.startTestCall(id);
        if (run !== attempt.current) {
            retire(reserved.callId);
            return;
        }
        pendingCallId.current = reserved.callId;
        setCallId(reserved.callId);
        await voice.connect(reserved.callId);
        if (run !== attempt.current) {
            voice.hangup();
            return;
        }
        setHasMic(voice.hasMic);
    }
    catch (e) {
        if (run === attempt.current) {
            call.current?.hangup();
            cancelPending();
            setError(errorText(e));
            setPhase('error');
        }
    } }
    return <><PageTitle title="Test Studio" description="A private rehearsal. Test calls are kept separate from your live activity."/><Notice error={error || assistantError} message={choices.requestedMissing ? 'The requested assistant is unavailable. Choose another assistant to continue.' : ''}/>{assistantError && <Button variant="ghost" onClick={() => setAssistantReload(n => n + 1)}>Retry assistants</Button>}<div className="studio-grid"><Card><h2 className="studio-heading">Try the conversation</h2><label>Assistant<select disabled={active} className={inputClass} value={id} onChange={e => setId(e.target.value)}>{choices.requestedMissing && <option value="">Choose an assistant</option>}{assistants.map(a => <option key={a.id} value={a.id}>{a.name} · {a.state}</option>)}</select></label><MoreAssistants choices={choices}/><p className="studio-description">Ask about opening hours, request a service, or leave a message. Use headphones for the clearest audio. You can also type once connected.</p>{(debugEnabled || debugRecording === true) && <p className="studio-description" role="status"><strong>Debug mode on for test calls.</strong> Audio and diagnostics are retained privately for seven days. Starting a test records it; use only conversations you have permission to record. Download or delete recordings from the call log. {debugRecording === false && 'Recording could not start for this call.'}</p>}{debugEnabled === null && debugRecording !== true && <p className="studio-description">Test calls may record audio, transcripts and configuration for seven days for debugging. Only use conversations you have permission to record.</p>}<div className="studio-actions">{active ? <Button variant="danger" onClick={() => { attempt.current++; call.current?.hangup(); cancelPending(); if (phase === 'connecting') setCallId(''); setPhase('ended'); }}>End test call</Button> : <Button disabled={!id || !assistants.some(a => a.id === id) || choices.loading || Boolean(assistantError)} onClick={() => void start()}>Start test call</Button>}<span role="status">{phase === 'connecting' ? 'Connecting…' : phase === 'live' ? hasMic ? 'Microphone on' : 'Text mode — microphone unavailable' : phase === 'ended' ? 'Call ended' : phase === 'error' ? 'Call failed' : 'Ready to test'}</span></div>{active && engine && <p className="studio-muted">{engine}</p>}{active && audioBlocked && <div role="alert"><p>Audio is paused or unavailable. Enable audio to hear the assistant. Check your output device if it stays silent.</p><Button variant="ghost" onClick={() => call.current?.prepareAudio()}>Enable audio</Button></div>}{id && <Link className="studio-link" to={`/assistants/${id}`}>Edit assistant →</Link>}{callId && !active && <Link className="studio-link" to={`/calls/${callId}`}>Review this call →</Link>}</Card><Card><h2 className="studio-heading">Live transcript</h2><div className="studio-transcript" role="log" aria-live="polite">{!lines.length && <p className="studio-muted">Your conversation will appear here.</p>}{lines.map((l, i) => <div key={i}><strong>{l.who}</strong><p>{l.text}</p></div>)}</div><form className="studio-compose" onSubmit={e => { e.preventDefault(); if (text.trim()) {
        call.current?.sendText(text.trim());
        setText('');
    } }}><input aria-label="Message to assistant" className={inputClass} disabled={phase !== 'live'} value={text} onChange={e => setText(e.target.value)} placeholder="Type a test message…"/><Button disabled={phase !== 'live' || !text.trim()}>Send</Button></form></Card></div></>;
}
export function Knowledge() {
    const [collections, setCollections] = useState<KnowledgeCollection[]>([]);
    const [selected, setSelected] = useState('');
    const [detail, setDetail] = useState<(KnowledgeCollection & {
        items: KnowledgeItem[];
        nextCursor: string | null;
        assistants: AssistantListItem[];
    }) | null>(null);
    const [error, setError] = useState('');
    const [assistantReload, setAssistantReload] = useState(0);
    const [message, setMessage] = useState('');
    const [busy, setBusy] = useState(false);
    const [loading, setLoading] = useState(true);
    const [refreshError, setRefreshError] = useState('');
    const selection = useRef('');
    const readGeneration = useRef(0);
    const [name, setName] = useState('');
    const [editing, setEditing] = useState<Partial<KnowledgeItem> | null>(null);
    const originalEditing = useRef<Partial<KnowledgeItem> | null>(null);
    const dirtyKnowledge = editing !== null && JSON.stringify(editing) !== JSON.stringify(originalEditing.current);
    const [collectionDirty, setCollectionDirty] = useState(false);
    useUnsavedEdits(dirtyKnowledge || collectionDirty);
    function replaceEditing(next: Partial<KnowledgeItem> | null) {
        if (dirtyKnowledge && !window.confirm('Discard your unsaved knowledge changes?')) return;
        originalEditing.current = next;
        setEditing(next);
    }
    function discardKnowledge() { return !(dirtyKnowledge || collectionDirty) || window.confirm('Discard your unsaved knowledge changes?'); }
    async function loadMore() {
        if (busy || !detail?.nextCursor) return;
        const collectionId = selected; const cursor = detail.nextCursor;
        setBusy(true); setError('');
        try {
            const next = await api.knowledgeCollection(collectionId, cursor);
            setDetail(current => current?.id === collectionId ? { ...current, items: [...current.items, ...next.items.filter(item => !current.items.some(old => old.id === item.id))], nextCursor: next.nextCursor } : current);
        } catch (e) { setError(errorText(e)); }
        finally { setBusy(false); }
    }
    function selectLocal(id: string) { selection.current = id; setSelected(id); }
    async function refreshKnowledge() {
        const run = ++readGeneration.current;
        try {
            const rows = await api.knowledgeCollections();
            if (run !== readGeneration.current) return;
            // A read-only retry must never retarget an unsaved item or remount
            // collection fields into a different collection after remote deletion.
            if (selection.current && !rows.some(row => row.id === selection.current)) {
                setCollections(rows);
                throw new Error('The selected collection is no longer available. Your draft is retained; choose another collection to discard it.');
            }
            const id = selection.current || rows[0]?.id || '';
            const next = id ? await api.knowledgeCollection(id) : null;
            if (run !== readGeneration.current) return;
            setCollections(rows); selectLocal(id); setDetail(next); setRefreshError(''); setError('');
        } catch (e) { if (run === readGeneration.current) throw e; }
    }
    useEffect(() => {
        void refreshKnowledge().catch(e => setError(errorText(e))).finally(() => setLoading(false));
        return () => { readGeneration.current++; };
    }, []);
    const choices = useAssistantChoices(assistantReload);
    const { assistants, assistantError } = choices;
    async function refreshAfterSave() {
        try { await refreshKnowledge(); }
        catch (e) { setRefreshError(`Your changes were saved, but knowledge could not be refreshed. ${errorText(e)}`); }
    }
    async function retryRefresh() {
        if (busy) return;
        setBusy(true);
        try { await refreshKnowledge(); }
        catch (e) { if (refreshError) setRefreshError(`Your changes were saved, but knowledge could not be refreshed. ${errorText(e)}`); else setError(errorText(e)); }
        finally { setBusy(false); }
    }
    function adjustCounts(collectionId: string, items: number, active: number) {
        setCollections(rows => rows.map(row => row.id === collectionId ? { ...row, item_count: Math.max(0, (row.item_count || 0) + items), active_item_count: Math.max(0, (row.active_item_count || 0) + active) } : row));
    }
    function acceptItem(item: KnowledgeItem, created = false) {
        readGeneration.current++;
        const previous = detail?.items.find(old => old.id === item.id) ?? (originalEditing.current?.id === item.id ? originalEditing.current : undefined);
        adjustCounts(item.collection_id, created ? 1 : 0, Number(item.status === 'active') - Number(!created && previous?.status === 'active'));
        setDetail(current => current ? { ...current, items: current.items.some(old => old.id === item.id) ? current.items.map(old => old.id === item.id ? item : old) : [...current.items, item] } : current);
    }
    async function action(fn: () => Promise<unknown>, success: string) {
        if (busy) return;
        readGeneration.current++; setBusy(true); setError(''); setMessage('');
        try {
            await fn();
            // Fence reads that began before or during the accepted mutation.
            readGeneration.current++; setMessage(success);
            await refreshAfterSave();
        } catch (e) { setError(errorText(e)); }
        finally { setBusy(false); }
    }
    return <><PageTitle title="Knowledge" description="Write answers once, share them across assistants, and approve every improvement."/><Notice error={error || assistantError} message={message}/>{assistantError && <Button variant="ghost" onClick={() => setAssistantReload(n => n + 1)}>Retry assistants</Button>}{(loading || (selected && !detail && !error)) && <LoadingStatus />}{refreshError && <><Notice error={refreshError}/><Button variant="ghost" disabled={busy} onClick={() => void retryRefresh()}>Retry knowledge refresh</Button></>}{error && !detail && <Button variant="ghost" disabled={busy} onClick={() => void retryRefresh()}>Retry knowledge</Button>}<form className="studio-create" onSubmit={e => { e.preventDefault(); if (!discardKnowledge()) return; void action(async () => { const submittedName = name.trim(); const c = await api.createKnowledgeCollection({ name: submittedName, description: '' }); readGeneration.current++; setName(current => current.trim() === submittedName ? '' : current); selectLocal(c.id); setCollections(rows => [...rows, c]); setDetail({ ...c, items: [], nextCursor: null, assistants: [] }); originalEditing.current = null; setEditing(null); }, 'Collection created.'); }}><Field label="New collection" required value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Services and pricing"/><Button disabled={busy || !name.trim()}>Create collection</Button></form><label>Collection<select disabled={busy} className={inputClass} value={selected} onChange={e => { if (discardKnowledge()) { selectLocal(e.target.value); setDetail(null); originalEditing.current = null; setEditing(null); void retryRefresh(); } }}>{selected && !collections.some(c => c.id === selected) && <option value={selected}>Unavailable collection — draft retained</option>}{collections.map(c => <option key={c.id} value={c.id}>{c.name} ({c.item_count || 0} {c.item_count === 1 ? 'item' : 'items'})</option>)}</select></label>{detail && <><Card className="mt-5"><div className="studio-between"><h2>{detail.name}</h2>{!detail.is_default && <Button variant="ghost" disabled={busy} onClick={() => { if (discardKnowledge() && window.confirm(`Delete “${detail.name}” and all its knowledge items? This cannot be undone.`)) {
        void action(async () => { await api.deleteKnowledgeCollection(detail.id); readGeneration.current++; setCollections(rows => rows.filter(row => row.id !== detail.id)); setDetail(null); selectLocal(''); originalEditing.current = null; setEditing(null); }, 'Collection deleted.');
    } }}>Delete collection</Button>}</div><CollectionSettings key={detail.id} collection={detail} busy={busy} onDirtyChange={setCollectionDirty} onSave={(body) => action(async () => { await api.updateKnowledgeCollection(detail.id, body); readGeneration.current++; setDetail(current => current ? { ...current, ...body } : current); setCollections(rows => rows.map(row => row.id === detail.id ? { ...row, ...body } : row)); }, 'Collection updated.')} /><p className="studio-muted">Active items are eligible for calls by attached assistants. Drafts stay private until approved.</p><details className="studio-muted"><summary>Knowledge limits for calls</summary><p>Calls use active items from attached collections, oldest first (creation time, then ID). Items over 8 KiB of combined UTF-8 fields are omitted. Of the first 32 eligible items, only the whole-item prefix fitting a 32 KiB budget, including formatting allowance, is used. Selection stops at the first item that does not fit. Omitted items stay saved but are unavailable during calls; shorten items or detach collections to make room.</p></details><div className="studio-actions">{assistants.map(a => <label className="studio-check" key={a.id}><input type="checkbox" disabled={busy} checked={detail.assistants.some(x => x.id === a.id)} onChange={e => { const attached = e.target.checked; void action(async () => { await (attached ? api.attachKnowledgeCollection(a.id, selected) : api.detachKnowledgeCollection(a.id, selected)); readGeneration.current++; setDetail(current => current ? { ...current, assistants: attached ? [...current.assistants.filter(old => old.id !== a.id), a] : current.assistants.filter(old => old.id !== a.id) } : current); }, 'Assistant knowledge updated.'); }}/>{a.name}</label>)}</div><MoreAssistants choices={choices}/></Card><div className="studio-between mt-6"><h2 className="studio-heading">Answers & notes</h2><Button disabled={busy} variant="ghost" onClick={() => replaceEditing({ kind: 'faq', status: 'draft', title: '', question: '', answer: '', content: '' })}>Add knowledge</Button></div>{editing && <Card><form onSubmit={e => { e.preventDefault(); void action(async () => { const item = editing.id ? await api.updateKnowledgeItem(editing.id, editing) : await api.createKnowledgeItem(selected, editing); acceptItem(item, !editing.id); originalEditing.current = null; setEditing(null); }, 'Knowledge saved.'); }}><fieldset disabled={busy} className="studio-fields"><label>Type<select className={inputClass} value={editing.kind} onChange={e => setEditing({ ...editing, kind: e.target.value as KnowledgeItem['kind'] })}><option value="faq">Question & answer</option><option value="service">Service</option><option value="note">Note</option></select></label><Field label="Title" required={editing.kind === 'service'} value={editing.title || ''} onChange={e => setEditing({ ...editing, title: e.target.value })}/>{editing.kind === 'faq' ? <><TextArea label="Question" required value={editing.question || ''} onChange={e => setEditing({ ...editing, question: e.target.value })}/><TextArea label="Answer" required value={editing.answer || ''} onChange={e => setEditing({ ...editing, answer: e.target.value })}/></> : <TextArea label="Content" required value={editing.content || ''} onChange={e => setEditing({ ...editing, content: e.target.value })}/>}<label className="studio-check"><input type="checkbox" checked={editing.status === 'active'} onChange={e => setEditing({ ...editing, status: e.target.checked ? 'active' : 'draft' })}/>Approved for use in conversations</label><div className="studio-actions"><Button>Save knowledge</Button><Button type="button" variant="ghost" onClick={() => replaceEditing(null)}>Cancel</Button></div></fieldset></form></Card>}<div className="studio-grid mt-5">{detail.items.map(item => <Card key={item.id}><div className="studio-between"><h3>{item.question || item.title || 'Untitled note'}</h3><span className="studio-badge">{item.status === 'active' ? 'Approved' : 'Draft'}</span></div><p className="studio-description">{item.answer || item.content || 'Add an answer before approving this item.'}</p>{item.source_call_id && <Link className="studio-link" to={`/calls/${item.source_call_id}`}>Source conversation ↗</Link>}<div className="studio-actions"><Button variant="ghost" disabled={busy} onClick={() => replaceEditing({ ...item })}>Edit</Button><Button variant="ghost" disabled={busy} onClick={() => void action(async () => { acceptItem(await api.updateKnowledgeItem(item.id, { status: item.status === 'active' ? 'draft' : 'active' })); }, item.status === 'active' ? 'Moved to draft.' : 'Knowledge approved.')}>{item.status === 'active' ? 'Unpublish' : 'Approve'}</Button><Button variant="ghost" disabled={busy} onClick={() => { if (window.confirm('Delete this knowledge item? This cannot be undone.'))
        void action(async () => { await api.deleteKnowledgeItem(item.id); readGeneration.current++; adjustCounts(item.collection_id, -1, -Number(item.status === 'active')); setDetail(current => current ? { ...current, items: current.items.filter(old => old.id !== item.id) } : current); if (editing?.id === item.id) { originalEditing.current = null; setEditing(null); } }, 'Knowledge item deleted.'); }}>Delete</Button></div></Card>)}</div>{detail.nextCursor && <Button disabled={busy} variant="ghost" onClick={() => void loadMore()}>Load more knowledge</Button>}{!detail.items.length && !editing && <Card className="mt-5">This collection is empty. Add an answer or save a caller question from a conversation for review.</Card>}</>}</>;
}

function CollectionSettings({ collection, busy, onSave, onDirtyChange }: { collection: KnowledgeCollection; busy: boolean; onDirtyChange: (dirty: boolean) => void; onSave: (body: { name: string; description: string }) => Promise<void> }) {
  const [name, setName] = useState(collection.name);
  const [description, setDescription] = useState(collection.description);
  const baseline = useRef({ name: collection.name, description: collection.description });
  useEffect(() => {
    const previous = baseline.current;
    setName(current => current.trim() === previous.name ? collection.name : current);
    setDescription(current => current === previous.description ? collection.description : current);
    baseline.current = { name: collection.name, description: collection.description };
  }, [collection.name, collection.description]);
  useEffect(() => { onDirtyChange(name.trim() !== collection.name || description !== collection.description); }, [name, description, collection.name, collection.description, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);
  return <form className="studio-fields my-5" onSubmit={e => { e.preventDefault(); void onSave({ name: name.trim(), description }); }}><Field label="Collection name" required value={name} onChange={e => setName(e.target.value)} /><TextArea label="Description" value={description} onChange={e => setDescription(e.target.value)} /><div><Button variant="ghost" disabled={busy || !name.trim() || (name.trim() === collection.name && description === collection.description)}>Save collection details</Button></div></form>;
}

function LoadingStatus() {
  return <div className="studio-loading" role="status"><Spinner /><span>Loading workspace data…</span></div>;
}
