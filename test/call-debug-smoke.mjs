// Real workerd/D1/DO persistence and registered owner routes. Synthetic PCM;
// internal probe methods bypass provider startup, not storage or application capture.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { unstable_splitSqlQuery } from 'wrangler';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const source = `
import app from './src/index';
import { CallSession } from './src/call-session';
export class Probe extends CallSession {
  constructor(state, env) { super(state,env); this.probeState=state; this.probeEnv=env; }
  async fetch(request) {
    const url=new URL(request.url);
    if(!url.pathname.startsWith('/probe'))return super.fetch(request);
    if(url.pathname==='/probe/expire') {
      const meta=await this.probeState.storage.get('debug:meta');
      await this.probeState.storage.put('debug:meta',{...meta,expiresAt:Date.now()-1});await this.alarm();return new Response('expired');
    }
    if(url.pathname==='/probe/seed') {
      this.callId=url.searchParams.get('call'); await this.loadCall();
      this.mode='realtime';
      const pair=new WebSocketPair();pair[0].accept();pair[1].accept();this.upstream=pair[0];this.ws=pair[0];
      this.debug?.event('configuration',{engine:'realtime',prompt:'Synthetic private prompt',realtimeModel:'synthetic'});
      await this.onMessage({data:new Uint8Array([1,2,3,4,5,6]).buffer});
      this.deliverRealtimeAudio(new Uint8Array([7,8,9,10]).buffer);
      this.debug?.event('upstream_close',{code:1011,clean:false});
      this.failure='Synthetic lost connection';
      await this.probeEnv.DB.prepare("UPDATE calls SET status='failed' WHERE id=?").bind(this.callId).run();
      this.ended=true;this.armAudioReceiptDeadline();
      await this.clearWatchdog();pair[0].close();pair[1].close();
      return Response.json({captured:Boolean(this.debug)});
    }
    return new Response('missing',{status:404});
  }
}
export default {fetch(request,env,ctx){
  const url=new URL(request.url);
  if(url.pathname.startsWith('/probe/')) return env.CALL_SESSION.get(env.CALL_SESSION.idFromName(url.searchParams.get('call'))).fetch(request);
  return app.fetch(request,env,ctx);
}};
`;
const temp=await mkdtemp(resolve(tmpdir(),'openfon-debug-native-'));let mf;
const bundled=await build({stdin:{contents:source,resolveDir:process.cwd(),sourcefile:'debug-probe.ts',loader:'ts'},bundle:true,write:false,format:'esm',platform:'browser',target:'es2022'});
const options={resourcePersistencePath:temp,port:8813,inspectorPort:9253,cf:false,workers:[{name:'probe',modules:true,script:bundled.outputFiles[0].text,compatibilityDate:'2026-05-01',
  bindings:{TEST_CALL_DEBUG:'true'},d1Databases:{DB:'debug-test'},durableObjects:{CALL_SESSION:{className:'Probe',useSQLite:true}},
  outboundService:async()=>new Response('Network forbidden',{status:502})}]};
const request=(path,token='owner',method='GET',origin)=>mf.dispatchFetch('https://openfon.test'+path,{method,headers:{Cookie:'ofs='+token,...(origin?{Origin:origin}:{})}});
try {
  mf=new Miniflare(convertV4MiniflareOptions(options));const db=await mf.getD1Database('DB');
  for(const f of (await readdir('migrations')).filter(f=>f.endsWith('.sql')).sort())for(const sql of unstable_splitSqlQuery(await readFile(resolve('migrations',f),'utf8')))await db.prepare(sql).run();
  for(const id of ['owner','other']) {
    await db.prepare('INSERT INTO users(id,email,password_hash) VALUES(?,?,?)').bind(id,id+'@example.invalid','unused').run();
    await db.prepare("INSERT INTO sessions(token,user_id,expires_at) VALUES(?,?,'2099-01-01')").bind(id,id).run();
    await db.prepare('INSERT INTO businesses(id,user_id,slug,name) VALUES(?,?,?,?)').bind(id,id,id,id).run();
    await db.prepare('INSERT INTO agent_settings(business_id) VALUES(?)').bind(id).run();
  }
  for(const [id,environment,channel] of [['debug','test','web'],['live','live','web'],['carrier','test','telnyx']]) {
    await db.prepare('INSERT INTO calls(id,business_id,environment,channel) VALUES(?,?,?,?)').bind(id,'owner',environment,channel).run();
    const seed=await request('/probe/seed?call='+id);assert.equal(seed.status,200,await seed.clone().text());
    assert.equal((await seed.json()).captured,id==='debug');
  }
  const base='/api/me/calls/debug/debug';
  assert.equal((await request(base,'invalid')).status,401);
  assert.equal((await request(base,'other')).status,404);
  assert.equal((await request(base,'owner','DELETE','https://evil.test')).status,403);
  assert.equal((await request('/api/me/calls/live/debug')).status,404);
  assert.equal((await request('/api/me/calls/carrier/debug')).status,404);
  const config=await request('/api/me/debug-config');assert.equal((await config.json()).testCalls,true);
  let response=await request(base+'/download');assert.equal(response.status,200);assert.equal(response.headers.get('Cache-Control'),'no-store');
  const body=await response.text(), rows=body.trim().split('\n').map(JSON.parse);
  assert.deepEqual([...Buffer.from(rows.find(r=>r.track==='caller').data,'base64')],[1,2,3,4,5,6]);
  assert.deepEqual([...Buffer.from(rows.find(r=>r.track==='agent').data,'base64')],[7,8,9,10]);
  assert.equal(rows.find(r=>r.track==='caller').forwarded,true);assert.ok(rows.find(r=>r.kind==='upstream_close'));
  assert.equal(rows[0].partial,false);assert.ok(rows[0].finishedAt);
  await writeFile(resolve(temp,'recording.ndjson'),body);
  const extract=spawnSync(process.execPath,['scripts/call-debug-replay.mjs',resolve(temp,'recording.ndjson'),'--out',resolve(temp,'audio')],{encoding:'utf8'});
  assert.equal(extract.status,0,extract.stderr);assert.equal((await readFile(resolve(temp,'audio/caller.wav'))).subarray(-6).toString('hex'),'010203040506');
  await writeFile(resolve(temp,'corrupt.ndjson'),body.slice(0,body.lastIndexOf('{"kind":"end"')));
  assert.notEqual(spawnSync(process.execPath,['scripts/call-debug-replay.mjs',resolve(temp,'corrupt.ndjson'),'--out',resolve(temp,'corrupt')]).status,0);
  await mf.dispose();mf=new Miniflare(convertV4MiniflareOptions(options));
  response=await request(base+'/download');assert.equal(await response.text(),body,'restart preserves exact export');
  await request('/probe/expire?call=debug');assert.deepEqual(await (await request(base)).json(),{available:false});
  console.log('PASS real D1/DO exact input/output, failed-call evidence, owner/anonymous/foreign/CSRF boundaries, public/carrier exclusion, restart, TTL, extractor and corruption rejection');
}finally{await mf?.dispose();await rm(temp,{recursive:true,force:true});}
