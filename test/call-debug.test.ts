import { afterEach, describe, expect, it, vi } from 'vitest';
import { CallDebug, debugMeta, debugResponse, debugProviderEvent, debugClientEvent, DEBUG_RETENTION_MS } from '../src/call-debug';
import { CallSession } from '../src/call-session';
function fixture() {
  const data = new Map<string, unknown>();
  const put = vi.fn(async (key: string | Record<string, unknown>, value?: unknown) => {
    if (typeof key === 'string') data.set(key, structuredClone(value));
    else for (const [k,v] of Object.entries(key)) data.set(k, structuredClone(v));
  });
  const storage = { put, get: vi.fn(async (k: string) => structuredClone(data.get(k))),
    list: vi.fn(async ({prefix,limit}: {prefix:string;limit:number}) => new Map([...data].filter(([k])=>k.startsWith(prefix)).slice(0,limit))),
    delete: vi.fn(async (keys: string | string[]) => { for (const k of typeof keys==='string'?[keys]:keys) data.delete(k); }),
    deleteAll: vi.fn(async()=>data.clear()), setAlarm: vi.fn(async()=>{}), deleteAlarm: vi.fn(async()=>{}) };
  const state = { storage, waitUntil: vi.fn() } as unknown as DurableObjectState;
  return { state, storage, data };
}
afterEach(()=>vi.useRealTimers());
describe('test call debug recordings',()=>{
  it('persists exact audio, ordering and configuration, then exports after finalization',async()=>{
    const {state,storage}=fixture();const recorder=(await CallDebug.start(state,'call'))!;
    recorder.event('configuration',{engine:'realtime',prompt:'Synthetic prompt'});
    const pcm=new Uint8Array(50_002).map((_,i)=>i%255);
    recorder.audio('caller',pcm.buffer,'pcm_s16le_24000',{forwarded:true});
    expect((await debugResponse(state,new Request('https://internal/debug/download'),recorder)).status).toBe(409);
    await recorder.finish();
    const response=await debugResponse(state,new Request('https://internal/debug/download'),recorder);
    const rows=(await response.text()).trim().split('\n').map(s=>JSON.parse(s));
    expect(rows[0]).toMatchObject({kind:'manifest',partial:false,callId:'call'});
    expect(rows.at(-1).kind).toBe('end');
    const audio=rows.filter(r=>r.kind==='audio');expect(audio.map(r=>r.offset)).toEqual([0,24000,48000]);
    expect(Buffer.concat(audio.map(r=>Buffer.from(r.data,'base64')))).toEqual(Buffer.from(pcm));
    expect(storage.put.mock.calls.some(c=>c[2] && (c[2] as any).allowUnconfirmed)).toBe(true);
    // A reconstructed object can read the persisted evidence.
    expect((await debugResponse(state,new Request('https://internal/debug'),null)).status).toBe(200);
    expect(await CallDebug.start(state,'call')).toBeNull();
  });
  it('drains pending writes before deleting and prevents evidence resurrection',async()=>{
    const {state,data}=fixture();const recorder=(await CallDebug.start(state,'call'))!;
    recorder.audio('caller',new Uint8Array(100_000).buffer,'pcm_s16le_24000');
    await debugResponse(state,new Request('https://internal/debug',{method:'DELETE'}),recorder);
    recorder.audio('caller',new Uint8Array(1000).buffer,'pcm_s16le_24000');await recorder.finish();
    expect([...data.keys()]).toEqual(['debug:meta']);
    expect(await (await debugResponse(state,new Request('https://internal/debug'),null)).json()).toEqual({available:false});
    expect(await CallDebug.start(state,'call')).toBeNull();
  });
  it('expires audio without deleting unrelated watchdog state',async()=>{
    vi.useFakeTimers();const {state,data}=fixture();const recorder=(await CallDebug.start(state,'call'))!;
    recorder.event('test');await recorder.finish();data.set('lastActivity',123);
    vi.setSystemTime(Date.now()+DEBUG_RETENTION_MS+1);
    expect(await (await debugResponse(state,new Request('https://internal/debug'),null)).json()).toEqual({available:false});
    expect([...data.keys()]).toEqual(['lastActivity']);
  });
  it('marks oversize events and storage failures partial instead of throwing into calls',async()=>{
    const {state,storage}=fixture();const recorder=(await CallDebug.start(state,'call'))!;
    recorder.event('too_large',{text:'x'.repeat(100_000)});
    recorder.event('small');storage.put.mockRejectedValueOnce(Error('disk'));
    await recorder.finish();expect((await debugMeta(state.storage))?.partial).toBe(true);
  });
  it('keeps bounded memory when storage stalls',async()=>{
    const {state,storage}=fixture();const recorder=(await CallDebug.start(state,'call'))!;
    let release!:()=>void;storage.put.mockImplementationOnce(()=>new Promise<void>(r=>{release=r;}));
    for(let i=0;i<1000;i++)recorder.audio('caller',new Uint8Array(4096).buffer,'pcm_s16le_24000');
    await Promise.resolve();
    expect(recorder.meta.partial).toBe(true);expect(recorder.meta.bytes).toBeLessThan(2*1024*1024);
    release();await recorder.finish();
  });
  it('retains recordings when call cleanup clears the watchdog and purges on its retention alarm',async()=>{
    const {state,storage,data}=fixture();const recorder=(await CallDebug.start(state,'call'))!;recorder.event('test');
    const call=new CallSession(state,{} as any) as any;call.debug=recorder;data.set('callId','call');
    await call.clearWatchdog();expect(storage.deleteAll).not.toHaveBeenCalled();expect(data.has('callId')).toBe(false);
    expect((await debugMeta(state.storage))?.finishedAt).toBeDefined();
    expect(storage.setAlarm).toHaveBeenCalledWith(recorder.meta.expiresAt);
    vi.useFakeTimers();vi.setSystemTime(recorder.meta.expiresAt+1);await call.alarm();expect(data.size).toBe(0);
  });
  it('active recording deletion leaves the call watchdog running',async()=>{
    const {state,storage,data}=fixture();const recorder=(await CallDebug.start(state,'call'))!;
    const call=new CallSession(state,{} as any) as any;call.debug=recorder;
    data.set('callId','call');data.set('hardDeadline',Date.now()-1);
    const finalize=vi.spyOn(call,'finalizeFromAlarm').mockResolvedValue(undefined);
    await recorder.remove();await call.alarm();expect(finalize).toHaveBeenCalledOnce();
    expect(storage.setAlarm).not.toHaveBeenCalledWith(recorder.meta.expiresAt);
  });
  it('ignores unserializable diagnostic fields without affecting the call',async()=>{
    const {state}=fixture();const recorder=(await CallDebug.start(state,'call'))!;
    const circular:any={};circular.self=circular;
    expect(()=>recorder.event('bad',circular)).not.toThrow();await recorder.finish();expect(recorder.meta.partial).toBe(true);
  });
  it('does not retain provider error messages, credentials or arbitrary browser fields',()=>{
    const projected=JSON.stringify(debugProviderEvent({type:'error',error:{type:'upstream',code:'busy',message:'SECRET'},headers:{Authorization:'SECRET'},session:{api_key:'SECRET'}}));
    expect(projected).not.toContain('SECRET');expect(projected).toContain('busy');
    expect(debugClientEvent({name:'capture',value:'microphone',api_key:'SECRET'})).toEqual({name:'capture',clientMs:undefined,value:'microphone'});
    expect(debugClientEvent({name:'steal',value:'SECRET'})).toBeNull();
  });
});
