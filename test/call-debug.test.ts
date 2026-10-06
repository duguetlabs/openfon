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

describe('bounded service recording uploads',()=>{
  const batch=(sequence=0,extra:Record<string,unknown>={})=>({sequence,complete:false,partial:false,records:[{kind:'audio',track:'caller',format:'pcm_s16le_24000',data:'AQACAA==',sourceMs:10}],...extra});
  async function setup(){const f=fixture();(f.storage as any).sync=vi.fn(async()=>{});return {...f,recorder:(await CallDebug.start(f.state,'call',true))!};}
  it('defaults partial until durable completion, deduplicates retry and rejects skipped/conflicting sequences',async()=>{
    const {recorder,state}=await setup();
    expect((await debugMeta(state.storage))?.partial).toBe(true);
    expect(await recorder.upload(batch())).toBe(200);
    const count=recorder.meta.records;
    expect(await recorder.upload(batch())).toBe(200);expect(recorder.meta.records).toBe(count);
    expect(await recorder.upload(batch(0,{partial:true}))).toBe(409);
    expect(await recorder.upload(batch(2))).toBe(409);
    const complete=batch(1,{records:[],complete:true});
    expect(await recorder.upload(complete)).toBe(200);expect(await recorder.upload(complete)).toBe(200);
    expect(await recorder.upload(batch(2))).toBe(410);
    await recorder.finish();expect((await debugMeta(state.storage))?.partial).toBe(false);
    const rows=(await (await debugResponse(state,new Request('https://internal/debug/download'),recorder)).text()).trim().split('\n').map(line=>JSON.parse(line));
    expect(rows.filter(r=>r.kind==='audio')).toMatchObject([{track:'caller',total:4,offset:0,data:'AQACAA==',sourceMs:10}]);
  });
  it('a failed write is not acknowledged or retried into duplicate data',async()=>{
    const {recorder,storage}=await setup();storage.put.mockRejectedValueOnce(Error('disk'));
    expect(await recorder.upload(batch())).toBe(503);
    expect(await recorder.upload(batch())).toBe(410);
    await recorder.finish();expect(recorder.meta.partial).toBe(true);
  });
  it('waits for durable synchronization before acknowledgement',async()=>{
    const {recorder,storage}=await setup();let release!:()=>void;
    (storage as any).sync=()=>new Promise<void>(r=>release=r);
    let done=false;const result=recorder.upload(batch()).then(()=>done=true);
    for(let i=0;i<10;i++)await new Promise(r=>setTimeout(r,0));
    expect(done).toBe(false);release();await result;await recorder.finish();
  });
  it('refuses deletion, expiration, finished recordings and restart resurrection',async()=>{
    for(const stop of ['delete','expire','finish']){
      const {recorder,state}=await setup();
      if(stop==='delete')await recorder.remove();
      if(stop==='expire')recorder.meta.expiresAt=0;
      if(stop==='finish')await recorder.finish();
      expect(await recorder.upload(batch())).toBe(410);
      expect(await CallDebug.start(state,'call',true)).toBeNull();
    }
  });
  it('rejects invalid formats, oversize packets, negative times and arbitrary events before writing',async()=>{
    const {recorder}=await setup();
    for(const records of [[{kind:'audio',track:'caller',format:'pcm_s16le_24000',data:'AA==',sourceMs:0}],[{kind:'capture',name:'secret_model',sourceMs:0}],[{kind:'capture',name:'gap',sourceMs:-1}],Array(33).fill({kind:'capture',name:'gap',sourceMs:0})]){
      expect(await recorder.upload(batch(0,{records}))).toBe(400);
    }
    expect(recorder.meta.records).toBe(0);await recorder.finish();
  });
  it('producer drop notification remains partial after completion',async()=>{
    const {recorder}=await setup();expect(await recorder.upload(batch(0,{partial:true}))).toBe(200);
    expect(await recorder.upload(batch(1,{records:[],complete:true}))).toBe(200);
    await recorder.finish();expect(recorder.meta.partial).toBe(true);
  });
});

it('service recordings exclude legacy outgoing transcripts and errors from the raw bundle',async()=>{
 const {state}=fixture(),recorder=(await CallDebug.start(state,'call',true))!;
 const session=new CallSession(state,{} as any) as any;session.debug=recorder;session.ws={send:vi.fn()};
 session.send({type:'transcript',text:'private transcript sentinel'});
 session.send({type:'agent_text',text:'private reply sentinel'});
 session.send({type:'warning',message:'private warning sentinel'});
 expect(session.ws.send).toHaveBeenCalledTimes(3);await recorder.finish();
 const bundle=await (await debugResponse(state,new Request('https://internal/debug/download'),recorder)).text();
 expect(bundle).not.toContain('sentinel');expect(bundle).not.toContain('caller_event');
});

it('automatic upload flush persists partial before an unsealed producer can crash',async()=>{
 const {state,storage,data}=fixture();(storage as any).sync=async()=>{};
 const recorder=(await CallDebug.start(state,'call',true))!;
 recorder.event('pending',{synthetic:'x'.repeat(47000)});
 const original=storage.put.getMockImplementation()!;let release!:()=>void;let entered!:()=>void;
 const writing=new Promise<void>(resolve=>entered=resolve);
 storage.put.mockImplementationOnce(async(key,value)=>{
  await original(key,value);entered();await new Promise<void>(resolve=>release=resolve);
 });
 const upload=recorder.upload({sequence:0,complete:false,partial:false,records:[{kind:'audio',track:'caller',format:'pcm_s16le_24000',data:'AAAA'.repeat(1000),sourceMs:0}]});
 await writing;expect((data.get('debug:meta') as any).partial).toBe(true);
 expect((data.get('debug:meta') as any).finishedAt).toBeUndefined();
 release();expect(await upload).toBe(200);await recorder.finish();expect(recorder.meta.partial).toBe(true);
});
