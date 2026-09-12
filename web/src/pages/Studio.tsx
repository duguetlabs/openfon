import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, type Assistant, type CallRow, type KnowledgeCollection, type KnowledgeItem, type OverviewResponse } from '../api';
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
    const [rows, setRows] = useState<Assistant[] | null>(null);
    const [name, setName] = useState('');
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    const [reload, setReload] = useState(0);
    const nav = useNavigate();
    useEffect(() => { let active = true; setError(''); void api.assistants().then(d => { if (active) setRows(d); }).catch(e => { if (active) setError(errorText(e)); }); return () => { active = false; }; }, [reload]);
    return <><PageTitle title="Your assistants" description="Give each line a purpose, a voice, and the knowledge it needs."/><Notice error={error}/>{error && !rows && <Button variant="ghost" onClick={() => setReload(n => n + 1)}>Retry assistants</Button>}<form className="studio-create" onSubmit={async (e) => { e.preventDefault(); if (busy) return; setBusy(true); setError(''); try {
        const a = await api.createAssistant({ name: name.trim() });
        nav(`/assistants/${a.id}`);
    }
    catch (e) {
        setError(errorText(e));
    }
    finally {
        setBusy(false);
    } }}><Field label="New assistant name" required maxLength={100} value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Front desk"/><Button disabled={busy || !name.trim()}>{busy ? 'Creating…' : 'Create assistant'}</Button></form>{!rows && !error && <LoadingStatus />}{rows?.length === 0 && <Card className="mb-5"><h2>No assistants yet</h2><p className="mt-2">Give your first assistant a name above. You can configure and test it privately before publishing.</p></Card>}<div className="studio-grid">{rows?.map(a => <Card key={a.id}><div className="studio-between"><h2>{a.name}</h2><span className="studio-badge">{a.state}</span></div><p className="studio-description">{a.persona || 'Add a personality and instructions to get started.'}</p><p className="studio-muted">{a.language} · {a.engine} · {a.last_test_at ? `Tested ${fmtTime(a.last_test_at)}` : 'Not tested yet'}</p><div className="studio-actions"><Link to={`/assistants/${a.id}`}>Configure →</Link><Link to={`/test?assistant=${a.id}`}>Test ↗</Link></div></Card>)}</div></>;
}
export function AssistantEditor() {
    const { assistantId } = useParams();
    return <AssistantEditorForm key={assistantId} assistantId={assistantId!} />;
}
function AssistantEditorForm({ assistantId }: { assistantId: string }) {
    const [a, setA] = useState<Assistant | null>(null);
    const [savedAssistant, setSavedAssistant] = useState<Assistant | null>(null);
    const [error, setError] = useState('');
    const [message, setMessage] = useState('');
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
    async function action(fn: () => Promise<unknown>, success: string, reload: boolean | 'lifecycle' = true) {
        if (busy) return;
        setBusy(true); setError(''); setMessage('');
        try {
            await fn();
            if (!mounted.current) return;
            if (reload) {
                const updated = await api.assistant(assistantId);
                if (!mounted.current) return;
                setA(current => reload === 'lifecycle' && current ? { ...current, state: updated.state } : updated);
                setSavedAssistant(updated);
            }
            setMessage(success);
        } catch (e) { if (mounted.current) setError(errorText(e)); }
        finally { if (mounted.current) setBusy(false); }
    }
    const editable: (keyof Assistant)[] = ['name', 'greeting', 'persona', 'language', 'voice', 'take_messages', 'custom_instructions', 'engine', 'realtime_model', 'realtime_voice', 'llm_model'];
    const dirty = Boolean(a && editable.some(key => a[key] !== savedAssistant?.[key]));
    useUnsavedEdits(dirty);
    if (!a) return <><Notice error={error}/>{error ? <Button variant="ghost" onClick={() => setReload(n => n + 1)}>Retry assistant</Button> : <LoadingStatus />}</>;
    const field = (key: keyof Assistant, label: string, multiline = false) => multiline ? <TextArea key={key} label={label} value={String(a[key] ?? '')} onChange={e => setA({ ...a, [key]: e.target.value })}/> : <Field key={key} label={label} required={['name', 'language'].includes(key)} value={String(a[key] ?? '')} onChange={e => setA({ ...a, [key]: e.target.value })}/>;
    return <><PageTitle title={a.name} description="Save your changes, test a conversation, then publish when you are satisfied."><span className="studio-badge">{a.state}</span></PageTitle><Notice error={error} message={message}/>{dirty && <p role="status" className="studio-notice">You have unsaved changes. Save before testing or publishing.</p>}<form onSubmit={e => { e.preventDefault(); void action(() => api.updateAssistant(a.id, a), 'Assistant saved.'); }}><fieldset disabled={busy} className="studio-grid"><Card><h2 className="studio-heading">Personality & purpose</h2><div className="studio-fields">{field('name', 'Name')}{field('greeting', 'Opening greeting', true)}{field('persona', 'Personality and role', true)}{field('custom_instructions', 'Additional instructions', true)}{field('language', 'Language')}<label className="studio-check"><input type="checkbox" checked={Boolean(a.take_messages)} onChange={e => setA({ ...a, take_messages: e.target.checked ? 1 : 0 })}/>Take caller messages</label></div></Card><Card><h2 className="studio-heading">Voice & engine</h2><div className="studio-fields"><label>Engine<select className={inputClass} value={a.engine} onChange={e => setA({ ...a, engine: e.target.value })}><option value="pipeline">Pipeline — transcribe, think, speak</option><option value="realtime">Realtime — streaming audio</option></select></label>{field('voice', 'Speech voice')}{field('realtime_model', 'Realtime model')}{field('realtime_voice', 'Realtime voice')}{field('llm_model', 'Language model')}<p className="studio-muted">Provider credentials are managed in <Link to="/settings">Settings</Link>. Voice and model names must be supported by your provider.</p><Button type="button" variant="ghost" onClick={() => void action(() => api.checkProvider(a.id), 'Provider connection succeeded for the saved assistant configuration.', false)}>Check saved configuration</Button></div></Card></fieldset><div className="studio-actions"><Button disabled={busy}>Save changes</Button><Link to={`/test?assistant=${a.id}`}>Open Test Studio →</Link><Link to="/knowledge">Manage knowledge →</Link></div></form><Card><h2 className="studio-heading">Publish your browser call line</h2><p>Publishing lets anyone with the link call this assistant. Pausing prevents new public calls. Private tests remain available.</p><div className="studio-actions">{a.state === 'active' ? <Button disabled={busy} variant="ghost" onClick={() => void action(() => api.pauseAssistant(a.id), 'Assistant paused. New public calls are disabled.', 'lifecycle')}>Pause assistant</Button> : <Button disabled={busy || dirty} onClick={() => void action(() => api.activateAssistant(a.id), 'Assistant published. Its call link is now available.')}>Publish assistant</Button>}{a.state === 'active' && <a href={`/call/${a.public_slug}`} target="_blank" rel="noreferrer">Open public call link ↗</a>}</div><Field label="Public call link" readOnly value={`${location.origin}/call/${a.public_slug}`}/></Card></>;
}
export function Calls() {
    const [params, setParams] = useSearchParams();
    const [rows, setRows] = useState<CallRow[]>([]);
    const [cursor, setCursor] = useState<string | null>(null);
    const [assistants, setAssistants] = useState<Assistant[]>([]);
    const [busy, setBusy] = useState(true);
    const [error, setError] = useState('');
    const [search, setSearch] = useState(params.get('search') || '');
    useEffect(() => { setSearch(params.get('search') || ''); }, [params]);
    const generation = useRef(0);
    const [reload, setReload] = useState(0);
    useEffect(() => { let current = true; void api.assistants().then(rows => { if (current) setAssistants(rows); }).catch(e => { if (current) setError(errorText(e)); }); return () => { current = false; }; }, [reload]);
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
        p.delete(key); p.delete('cursor'); setParams(p); }
    return <><PageTitle title="Conversations" description="Review what callers needed, what worked, and what to improve."><Button disabled={busy} variant="ghost" onClick={() => setReload(n => n + 1)}>Refresh calls</Button></PageTitle><div className="studio-filters"><form onSubmit={e => { e.preventDefault(); filter('search', search); }}><Field label="Search conversations" value={search} onChange={e => setSearch(e.target.value)} placeholder="Caller, summary, or transcript"/><Button variant="ghost">Search</Button></form><label>Environment<select className={inputClass} value={params.get('environment') || 'all'} onChange={e => filter('environment', e.target.value)}><option value="all">Live & test</option><option value="live">Live only</option><option value="test">Test only</option></select></label><label>Assistant<select className={inputClass} value={params.get('assistantId') || ''} onChange={e => filter('assistantId', e.target.value)}><option value="">All assistants</option>{assistants.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label><label>Status<select className={inputClass} value={params.get('status') || ''} onChange={e => filter('status', e.target.value)}><option value="">All statuses</option>{['active', 'completed', 'failed', 'abandoned'].map(s => <option key={s}>{s}</option>)}</select></label></div><Notice error={error}/>{busy && <LoadingStatus />}{!busy && !rows.length && !error && <Card>No conversations match these filters. <Link to="/test">Start a private test call →</Link></Card>}<CallList calls={rows}/>{cursor && <Button disabled={busy} className="mt-5" variant="ghost" onClick={async () => { if (busy) return; const run = generation.current; setBusy(true); setError(''); try {
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
    const [assistants, setAssistants] = useState<Assistant[]>([]);
    const [id, setId] = useState(params.get('assistant') || '');
    const [phase, setPhase] = useState('idle');
    const [error, setError] = useState('');
    const [assistantError, setAssistantError] = useState('');
    const [assistantReload, setAssistantReload] = useState(0);
    const [callId, setCallId] = useState('');
    const [lines, setLines] = useState<{
        who: string;
        text: string;
    }[]>([]);
    const [text, setText] = useState('');
    const [hasMic, setHasMic] = useState(true);
    const call = useRef<VoiceCall | null>(null);
    const attempt = useRef(0);
    const pendingCallId = useRef<string | null>(null);
    const retire = (id: string) => { void api.cancelTestCall(id).catch(() => { /* The stale-ticket sweep remains the network-failure fallback. */ }); };
    function cancelPending() {
        const id = pendingCallId.current;
        pendingCallId.current = null;
        if (id) retire(id);
    }
    useEffect(() => { let current = true; setAssistantError(''); void api.assistants().then(a => { if (!current) return; setAssistants(a); setId(selected => a.some(x => x.id === selected) ? selected : a[0]?.id || ''); }).catch(e => { if (current) setAssistantError(errorText(e)); }); return () => { current = false; }; }, [assistantReload]);
    useEffect(() => () => { attempt.current++; call.current?.hangup(); cancelPending(); }, []);
    const active = phase === 'connecting' || phase === 'live';
    async function start() { if (active) return; const run = ++attempt.current; call.current?.hangup(); cancelPending(); setPhase('connecting'); setError(''); setLines([]); setCallId(''); try {
        const reserved = await api.startTestCall(id);
        if (run !== attempt.current) {
            retire(reserved.callId);
            return;
        }
        pendingCallId.current = reserved.callId;
        setCallId(reserved.callId);
        const voice = new VoiceCall();
        call.current = voice;
        voice.on(e => { if (run !== attempt.current)
            return; if (e.type === 'status') {
            if (e.status === 'error') {
                voice.hangup();
                cancelPending();
                setError(e.detail || 'Connection failed');
            }
            setPhase(e.status);
        } if (e.type === 'transcript')
            setLines(l => [...l, { who: 'You', text: e.text }]); if (e.type === 'agent_text')
            setLines(l => [...l, { who: 'Assistant', text: e.text }]); });
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
    return <><PageTitle title="Test Studio" description="A private rehearsal. Test calls are kept separate from your live activity."/><Notice error={error || assistantError}/>{assistantError && <Button variant="ghost" onClick={() => setAssistantReload(n => n + 1)}>Retry assistants</Button>}<div className="studio-grid"><Card><h2 className="studio-heading">Try the conversation</h2><label>Assistant<select disabled={active} className={inputClass} value={id} onChange={e => setId(e.target.value)}>{assistants.map(a => <option key={a.id} value={a.id}>{a.name} · {a.state}</option>)}</select></label><p className="studio-description">Ask about opening hours, request a service, or leave a message. Use headphones for the clearest audio. You can also type once connected.</p><div className="studio-actions">{active ? <Button variant="danger" onClick={() => { attempt.current++; call.current?.hangup(); cancelPending(); if (phase === 'connecting') setCallId(''); setPhase('ended'); }}>End test call</Button> : <Button disabled={!id} onClick={() => void start()}>Start test call</Button>}<span role="status">{phase === 'connecting' ? 'Connecting…' : phase === 'live' ? hasMic ? 'Microphone on' : 'Text mode — microphone unavailable' : phase === 'ended' ? 'Call ended' : phase === 'error' ? 'Call failed' : 'Ready to test'}</span></div>{id && <Link className="studio-link" to={`/assistants/${id}`}>Edit assistant →</Link>}{callId && !active && <Link className="studio-link" to={`/calls/${callId}`}>Review this call →</Link>}</Card><Card><h2 className="studio-heading">Live transcript</h2><div className="studio-transcript" role="log" aria-live="polite">{!lines.length && <p className="studio-muted">Your conversation will appear here.</p>}{lines.map((l, i) => <div key={i}><strong>{l.who}</strong><p>{l.text}</p></div>)}</div><form className="studio-compose" onSubmit={e => { e.preventDefault(); if (text.trim()) {
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
        assistants: Assistant[];
    }) | null>(null);
    const [assistants, setAssistants] = useState<Assistant[]>([]);
    const [error, setError] = useState('');
    const [assistantError, setAssistantError] = useState('');
    const [assistantReload, setAssistantReload] = useState(0);
    const [message, setMessage] = useState('');
    const [busy, setBusy] = useState(false);
    const [loading, setLoading] = useState(true);
    const [reload, setReload] = useState(0);
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
    async function loadCollections() { const c = await api.knowledgeCollections(); setCollections(c); setSelected(s => c.some(x => x.id === s) ? s : c[0]?.id || ''); }
    useEffect(() => { setLoading(true); setError(''); void loadCollections().catch(e => setError(errorText(e))).finally(() => setLoading(false)); }, [reload]);
    useEffect(() => { let current = true; setAssistantError(''); void api.assistants().then(rows => { if (current) setAssistants(rows); }).catch(e => { if (current) setAssistantError(errorText(e)); }); return () => { current = false; }; }, [assistantReload]);
    useEffect(() => { let current = true; setDetail(null); setEditing(null); if (selected)
        void api.knowledgeCollection(selected).then(d => { if (current)
            setDetail(d); }).catch(e => { if (current)
            setError(errorText(e)); }); return () => { current = false; }; }, [selected, reload]);
    async function action(fn: () => Promise<unknown>, success: string, reloadDetail = true) { if (busy) return; setBusy(true); setError(''); setMessage(''); try {
        await fn();
        await loadCollections();
        if (selected && reloadDetail)
            setDetail(await api.knowledgeCollection(selected));
        setMessage(success);
    }
    catch (e) {
        setError(errorText(e));
    }
    finally {
        setBusy(false);
    } }
    return <><PageTitle title="Knowledge" description="Write answers once, share them across assistants, and approve every improvement."/><Notice error={error || assistantError} message={message}/>{assistantError && <Button variant="ghost" onClick={() => setAssistantReload(n => n + 1)}>Retry assistants</Button>}{(loading || (selected && !detail && !error)) && <LoadingStatus />}{error && !detail && <Button variant="ghost" onClick={() => setReload(n => n + 1)}>Retry knowledge</Button>}<form className="studio-create" onSubmit={e => { e.preventDefault(); if (!discardKnowledge()) return; void action(async () => { const c = await api.createKnowledgeCollection({ name: name.trim(), description: '' }); setName(''); setSelected(c.id); }, 'Collection created.', false); }}><Field label="New collection" required value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Services and pricing"/><Button disabled={busy || !name.trim()}>Create collection</Button></form><label>Collection<select disabled={busy} className={inputClass} value={selected} onChange={e => { if (discardKnowledge()) setSelected(e.target.value); }}>{collections.map(c => <option key={c.id} value={c.id}>{c.name} ({c.item_count || 0} {c.item_count === 1 ? 'item' : 'items'})</option>)}</select></label>{detail && <><Card className="mt-5"><div className="studio-between"><h2>{detail.name}</h2>{!detail.is_default && <Button variant="ghost" disabled={busy} onClick={() => { if (discardKnowledge() && window.confirm(`Delete “${detail.name}” and all its knowledge items? This cannot be undone.`)) {
        setBusy(true);
        setError('');
        void api.deleteKnowledgeCollection(detail.id).then(async () => { setDetail(null); setSelected(''); await loadCollections(); setMessage('Collection deleted.'); }).catch(e => setError(errorText(e))).finally(() => setBusy(false));
    } }}>Delete collection</Button>}</div><CollectionSettings key={detail.id} collection={detail} busy={busy} onDirtyChange={setCollectionDirty} onSave={(body) => action(() => api.updateKnowledgeCollection(detail.id, body), 'Collection updated.')} /><p className="studio-muted">Active items are used by attached assistants. Drafts stay private until approved.</p><div className="studio-actions">{assistants.map(a => <label className="studio-check" key={a.id}><input type="checkbox" disabled={busy} checked={detail.assistants.some(x => x.id === a.id)} onChange={e => void action(() => e.target.checked ? api.attachKnowledgeCollection(a.id, selected) : api.detachKnowledgeCollection(a.id, selected), 'Assistant knowledge updated.')}/>{a.name}</label>)}</div></Card><div className="studio-between mt-6"><h2 className="studio-heading">Answers & notes</h2><Button disabled={busy} variant="ghost" onClick={() => replaceEditing({ kind: 'faq', status: 'draft', title: '', question: '', answer: '', content: '' })}>Add knowledge</Button></div>{editing && <Card><form onSubmit={e => { e.preventDefault(); void action(async () => { if (editing.id)
        await api.updateKnowledgeItem(editing.id, editing);
    else
        await api.createKnowledgeItem(selected, editing); setEditing(null); }, 'Knowledge saved.'); }}><fieldset disabled={busy} className="studio-fields"><label>Type<select className={inputClass} value={editing.kind} onChange={e => setEditing({ ...editing, kind: e.target.value as KnowledgeItem['kind'] })}><option value="faq">Question & answer</option><option value="service">Service</option><option value="note">Note</option></select></label><Field label="Title" required={editing.kind === 'service'} value={editing.title || ''} onChange={e => setEditing({ ...editing, title: e.target.value })}/>{editing.kind === 'faq' ? <><TextArea label="Question" required value={editing.question || ''} onChange={e => setEditing({ ...editing, question: e.target.value })}/><TextArea label="Answer" required value={editing.answer || ''} onChange={e => setEditing({ ...editing, answer: e.target.value })}/></> : <TextArea label="Content" required value={editing.content || ''} onChange={e => setEditing({ ...editing, content: e.target.value })}/>}<label className="studio-check"><input type="checkbox" checked={editing.status === 'active'} onChange={e => setEditing({ ...editing, status: e.target.checked ? 'active' : 'draft' })}/>Approved for use in conversations</label><div className="studio-actions"><Button>Save knowledge</Button><Button type="button" variant="ghost" onClick={() => replaceEditing(null)}>Cancel</Button></div></fieldset></form></Card>}<div className="studio-grid mt-5">{detail.items.map(item => <Card key={item.id}><div className="studio-between"><h3>{item.question || item.title || 'Untitled note'}</h3><span className="studio-badge">{item.status === 'active' ? 'Approved' : 'Draft'}</span></div><p className="studio-description">{item.answer || item.content || 'Add an answer before approving this item.'}</p>{item.source_call_id && <Link className="studio-link" to={`/calls/${item.source_call_id}`}>Source conversation ↗</Link>}<div className="studio-actions"><Button variant="ghost" disabled={busy} onClick={() => replaceEditing({ ...item })}>Edit</Button><Button variant="ghost" disabled={busy} onClick={() => void action(() => api.updateKnowledgeItem(item.id, { status: item.status === 'active' ? 'draft' : 'active' }), item.status === 'active' ? 'Moved to draft.' : 'Knowledge approved.')}>{item.status === 'active' ? 'Unpublish' : 'Approve'}</Button><Button variant="ghost" disabled={busy} onClick={() => { if (window.confirm('Delete this knowledge item? This cannot be undone.'))
        void action(() => api.deleteKnowledgeItem(item.id), 'Knowledge item deleted.'); }}>Delete</Button></div></Card>)}</div>{detail.nextCursor && <Button disabled={busy} variant="ghost" onClick={() => void loadMore()}>Load more knowledge</Button>}{!detail.items.length && !editing && <Card className="mt-5">This collection is empty. Add an answer or save a caller question from a conversation for review.</Card>}</>}</>;
}

function CollectionSettings({ collection, busy, onSave, onDirtyChange }: { collection: KnowledgeCollection; busy: boolean; onDirtyChange: (dirty: boolean) => void; onSave: (body: { name: string; description: string }) => Promise<void> }) {
  const [name, setName] = useState(collection.name);
  const [description, setDescription] = useState(collection.description);
  useEffect(() => { onDirtyChange(name.trim() !== collection.name || description !== collection.description); }, [name, description, collection.name, collection.description, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);
  return <form className="studio-fields my-5" onSubmit={e => { e.preventDefault(); void onSave({ name: name.trim(), description }); }}><Field label="Collection name" required value={name} onChange={e => setName(e.target.value)} /><TextArea label="Description" value={description} onChange={e => setDescription(e.target.value)} /><div><Button variant="ghost" disabled={busy || !name.trim()}>Save collection details</Button></div></form>;
}

function LoadingStatus() {
  return <div className="studio-loading" role="status"><Spinner /><span>Loading workspace data…</span></div>;
}
