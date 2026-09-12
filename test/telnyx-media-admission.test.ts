import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { registerTelnyxRoutes } from '../src/telnyx-routes';
import { TelnyxMediaAdmission } from '../src/telnyx-media-admission';
import { fakeEnv, fakeCtx } from './fake-d1';
import type { Env } from '../src/types';

beforeEach(() => { vi.useFakeTimers({toFake:['Date']}); vi.setSystemTime(100000); });
afterEach(() => vi.useRealTimers());
function fixture(lookup: () => Promise<unknown> = async () => null, ownerFetch = async () => new Response(null,{status:204})) {
  const first = vi.fn(lookup), get = vi.fn(() => ({fetch:ownerFetch}));
  const prepare = vi.fn(() => ({bind:() => ({first})}));
  const env = {...fakeEnv(), TELNYX_ENABLED:'true',TELNYX_API_KEY:'synthetic',TELNYX_PUBLIC_KEY:'synthetic',TELNYX_CONNECTION_ID:'synthetic',TELNYX_PUBLIC_ORIGIN:'https://openfon.test',
    DB:{prepare},TELNYX_CALL:{idFromName:(n:string)=>n,get}} as unknown as Env;
  const app = new Hono<{Bindings:Env;Variables:{userId:string}}>(); registerTelnyxRoutes(app);
  app.onError(() => new Response(null,{status:500}));
  const request = (n=1) => app.fetch(new Request(`https://openfon.test/ws/telnyx/tnx_${n.toString(16).padStart(64,'0')}`,{headers:{Upgrade:'websocket','x-telnyx-streaming-auth-token':n.toString(16).padStart(64,'a'),'CF-Connecting-IP':`192.0.2.${n}`}}),env,fakeCtx);
  return {request,prepare,first,get};
}
it('bounds random-ID/token/source reads before D1 and refills only at two per second', async () => {
  const f = fixture();
  for(let i=1;i<=125;i++) {
    const response = await f.request(i);
    expect(response.status).toBe(i<=16?404:429);
    if(i>16) expect(response.headers.get('Retry-After')).toBe('1');
  }
  expect(f.prepare).toHaveBeenCalledTimes(16); expect(f.get).not.toHaveBeenCalled();
  for(const [sql] of f.prepare.mock.calls as unknown as string[][]) expect(sql.trim()).toMatch(/^SELECT /);
  vi.setSystemTime(Date.now()+499); expect((await f.request()).status).toBe(429);
  vi.setSystemTime(Date.now()+1); expect((await f.request()).status).toBe(404);
  expect((await f.request()).status).toBe(429); expect(f.prepare).toHaveBeenCalledTimes(17);
});
it('caps pending D1 lookups and releases on success and rejection without refunding starts', async () => {
  const pending: Array<{resolve:(value:unknown)=>void;reject:(error:Error)=>void}> = [];
  const f = fixture(() => new Promise((resolve,reject)=>pending.push({resolve,reject})));
  const requests = Array.from({length:4},()=>f.request());
  for(let i=0;i<20&&pending.length<4;i++) await Promise.resolve();
  expect(pending).toHaveLength(4); expect((await f.request()).status).toBe(429);
  expect(f.prepare).toHaveBeenCalledTimes(4);
  pending[0].reject(new Error('synthetic')); expect((await requests[0]).status).toBe(500);
  const next=f.request(); for(let i=0;i<20&&pending.length<5;i++) await Promise.resolve();
  expect(pending).toHaveLength(5);
  for(const item of pending.slice(1)) item.resolve(null);
  expect((await next).status).toBe(404); await Promise.all(requests.slice(1));
});
it('does not hold lookup capacity while authenticated owner upgrades remain pending', async () => {
  const releases: Array<()=>void> = [];
  const f = fixture(async()=>({id:'existing'}),()=>new Promise(resolve=>releases.push(()=>resolve(new Response(null,{status:204})))));
  const requests=[];
  for(let n=1;n<=5;n++) {
    requests.push(f.request(n));
    for(let i=0;i<50&&releases.length<n;i++) await Promise.resolve();
    expect(releases).toHaveLength(n);
  }
  releases.forEach(release=>release());
  expect((await Promise.all(requests)).map(r=>r.status)).toEqual([204,204,204,204,204]);
});
it('keeps release idempotent and never refills from backwards clock movement', () => {
  const budget=new TelnyxMediaAdmission();
  for(let i=0;i<16;i++) {const release=budget.acquire();expect(release).not.toBeNull();release!();release!();}
  vi.setSystemTime(0); expect(budget.acquire()).toBeNull();
  vi.setSystemTime(100500); const release=budget.acquire();expect(release).not.toBeNull();release!();
  expect(budget.acquire()).toBeNull();
});
