/** Explicit paid acceptance: isolated real Worker/D1/DO + local SFU + genuine Kataleptic.
 * Credentials stay in process memory. Output contains synthetic conversation only. */
import {execFileSync,spawn} from 'node:child_process';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {mkdtemp,readFile,readdir,writeFile,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions,Log,LogLevel} from 'miniflare';
import {unstable_splitSqlQuery} from 'wrangler';
import {initializeLogger} from '@livekit/agents';
import {Room,RoomEvent,AudioSource,AudioFrame,AudioStream,LocalAudioTrack,TrackPublishOptions,TrackSource,dispose} from '@livekit/rtc-node';
initializeLogger({pretty:false,level:'error'});
if(!process.argv.includes('--allow-paid'))throw Error('Requires explicit --allow-paid');
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const temp=await mkdtemp(resolve(tmpdir(),'openfon-composed-voice-'));await chmod(temp,0o700);
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const run=randomUUID(),label='openfon.composed-voice-smoke',docker='/usr/local/bin/docker';
const env={LIVEKIT_URL:'ws://127.0.0.1:18881',LIVEKIT_API_KEY:'fixture-'+run,LIVEKIT_API_SECRET:randomBytes(32).toString('hex'),LIVEKIT_AGENT_SERVICE_TOKEN:randomBytes(32).toString('hex')};
const config={port:18881,bind_addresses:['0.0.0.0'],rtc:{tcp_port:18882,udp_port:18883,node_ip:'127.0.0.1',use_external_ip:false},keys:{[env.LIVEKIT_API_KEY]:env.LIVEKIT_API_SECRET},logging:{level:'error'}};
const image='livekit/livekit-server@sha256:6fd3b7088874c4d119160dd688798dfec852bc014786d392caad15f6f63912a3';
let container='',mf,agent,caller,source,reader,socket,db,callId,agentOutput='';let failure='',feedingSilence=false,cancelled=false;let silencePump;
const events=[],pcm=[],diagnostics=[];const provenance={};let audioSamples=0,peak=0;
const mark=(name,data={})=>{const event={name,...data};diagnostics.push(event);console.log(JSON.stringify(event));};
const wait=async(predicate,label,timeout=20000)=>{const deadline=Date.now()+timeout;while(Date.now()<deadline){if(cancelled)throw Error('Harness stopped');if(await predicate())return;await delay(100);}throw Error('Timed out: '+label);};
function wav(data){const b=Buffer.alloc(44+data.length);b.write('RIFF');b.writeUInt32LE(36+data.length,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(24000,24);b.writeUInt32LE(48000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(data.length,40);data.copy(b,44);return b;}
let timer;const hardDeadline=new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Overall 150s deadline')),150000);});
async function smoke(){
 for(const port of [18879,18880,18881,18882]){const net=await import('node:net');await new Promise((resolve,reject)=>{const s=net.createServer();s.once('error',()=>reject(Error('Port occupied '+port)));s.listen(port,'127.0.0.1',()=>s.close(resolve));});}
 const key=execFileSync('dsecret',['kataleptic - openfon api key','credential'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();if(!key)throw Error('Vault key unavailable');
 container=execFileSync(docker,['run','-d','--rm','--pull=never','--label',label+'='+run,'-p','127.0.0.1:18881:18881','-p','127.0.0.1:18882:18882','-p','127.0.0.1:18883:18883/udp','-e','LIVEKIT_CONFIG',image],{env:{...process.env,LIVEKIT_CONFIG:JSON.stringify(config)},encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();
 if(!/^[0-9a-f]{64}$/.test(container))throw Error('Owned container missing');
 await wait(async()=>{try{return(await fetch('http://127.0.0.1:18881/',{signal:AbortSignal.timeout(250)})).ok;}catch{return false;}},'SFU');
 const bundle=await build({entryPoints:[root+'/src/index.ts'],bundle:true,format:'esm',platform:'browser',target:'es2022',write:false,external:['cloudflare:*']});
 provenance.workerBundleSha256=createHash('sha256').update(bundle.outputFiles[0].text).digest('hex');
 provenance.agentFiles={};for(const file of(await readdir(root+'/voice-agent/dist')).filter(x=>x.endsWith('.js')).sort())provenance.agentFiles[file]=createHash('sha256').update(await readFile(root+'/voice-agent/dist/'+file)).digest('hex');
 mf=new Miniflare(convertV4MiniflareOptions({port:18879,inspectorPort:18880,defaultPersistRoot:temp+'/state',cf:false,log:new Log(LogLevel.NONE),workers:[{name:'openfon',modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-05-01',d1Databases:{DB:'composed-smoke-db'},durableObjects:{CALL_SESSION:{className:'CallSession',useSQLite:true},ASTERISK_CALL:{className:'AsteriskCall',useSQLite:true}},bindings:{...env,WEB_VOICE_TRANSPORT:'livekit',DEFAULT_LLM_BASE_URL:'https://api.kataleptic.com/v1',DEFAULT_LLM_MODEL:'llama-3.3-70b',DEFAULT_LLM_API_KEY:key,REALTIME_API_KEY:key}}]}));await mf.ready;
 db=await mf.getD1Database('DB','openfon');for(const name of(await readdir(root+'/migrations')).filter(n=>n.endsWith('.sql')).sort())await db.batch(unstable_splitSqlQuery(await readFile(root+'/migrations/'+name,'utf8')).map(sql=>db.prepare(sql)));
 await db.batch([
 db.prepare("INSERT INTO users(id,email,password_hash) VALUES('owner','composed@example.invalid','unused')"),
 db.prepare("INSERT INTO sessions(token,user_id,expires_at) VALUES('synthetic-session','owner','2099-01-01')"),
 db.prepare("INSERT INTO businesses(id,user_id,slug,name,description) VALUES('biz','owner','composed','Dr Gruber Zahnarzt','Synthetic acceptance business. No appointment is ever confirmed by this assistant.')"),
 db.prepare("INSERT INTO agent_settings(business_id) VALUES('biz')"),
 db.prepare("INSERT INTO provider_settings(business_id) VALUES('biz')"),
 db.prepare("INSERT INTO assistants(id,business_id,public_slug,state,name,persona,greeting,language,engine,realtime_model,realtime_voice,custom_instructions) VALUES('assistant','biz','synthetic-agent','active','Alex','Brief and friendly receptionist','Hello, this is Dr Gruber dental practice. How can I help?','en','realtime','gpt-live-1','marin','Take a short callback request. Never claim to confirm an appointment. Once the caller says goodbye, say a brief goodbye and end the call.')")]);
 const childEnv={...process.env,...env,OPENFON_API_URL:'http://127.0.0.1:18879',OPENFON_AGENT_SERVICE_TOKEN:env.LIVEKIT_AGENT_SERVICE_TOKEN,KATALEPTIC_API_KEY:key,LK_OPENAI_DEBUG:'0'};
 agent=spawn(process.execPath,[root+'/voice-agent/dist/runner.js'],{cwd:root+'/voice-agent',env:childEnv,stdio:['ignore','pipe','pipe']});
 for(const stream of[agent.stdout,agent.stderr])stream.on('data',chunk=>{agentOutput=(agentOutput+String(chunk)).slice(-64000);for(const line of String(chunk).split('\n')){try{const item=JSON.parse(line);if(item.event==='openfon_voice_lifecycle')mark('agent-lifecycle',{phase:item.phase});}catch{}}});
 await delay(3500);if(agent.exitCode!==null)throw Error('Node agent exited before admission');
 const reservation=await mf.dispatchFetch('http://127.0.0.1:18879/api/me/assistants/assistant/test-calls',{method:'POST',headers:{Cookie:'ofs=synthetic-session'}});if(reservation.status!==201)throw Error('Reservation status '+reservation.status);({callId}=await reservation.json());mark('reservation',{callId});
 const response=await mf.dispatchFetch('http://127.0.0.1:18879/ws/call/'+callId,{headers:{Upgrade:'websocket',Cookie:'ofs=synthetic-session'}});if(response.status!==101)throw Error('WS status '+response.status);socket=response.webSocket;socket.accept();socket.addEventListener('message',event=>{if(typeof event.data==='string'){try{const msg=JSON.parse(event.data);events.push(msg);if(['error','done'].includes(msg.type))mark('control',{type:msg.type,error:msg.error});}catch{}}});socket.send(JSON.stringify({type:'start'}));
 await wait(()=>events.some(x=>x.type==='ready'),'application ready');const grant=events.find(x=>x.type==='ready');if(grant.mode!=='livekit')throw Error('Wrong transport');mark('ready');
 caller=new Room();caller.on(RoomEvent.TrackSubscribed,track=>{reader=new AudioStream(track,24000,1).getReader();void(async()=>{try{while(true){const result=await reader.read();if(result.done)break;const copy=Buffer.from(result.value.data.buffer,result.value.data.byteOffset,result.value.data.byteLength);pcm.push(Buffer.from(copy));audioSamples+=result.value.data.length;for(const v of result.value.data)peak=Math.max(peak,Math.abs(v));}}catch{}})();});
 await caller.connect(grant.serverUrl,grant.participantToken);source=new AudioSource(24000,1);const options=new TrackPublishOptions();options.source=TrackSource.SOURCE_MICROPHONE;await caller.localParticipant.publishTrack(LocalAudioTrack.createAudioTrack('Synthetic spoken input',source),options);
 await wait(()=>peak>100,'greeting audio',35000);mark('greeting-audio',{audioSamples,peak});
 await delay(5000);
 const spoken='Hello. My name is Alex Test. Please ask the dentist to call me back tomorrow about a toothache. My phone number is zero one two three four five six seven eight nine. Thank you. Goodbye.';
 execFileSync('/usr/bin/say',['-v','Samantha','-r','160','-o',temp+'/input.aiff',spoken],{stdio:'ignore'});execFileSync('/opt/homebrew/bin/ffmpeg',['-v','error','-y','-i',temp+'/input.aiff','-ar','24000','-ac','1','-f','s16le',temp+'/input.pcm'],{stdio:'ignore'});const input=await readFile(temp+'/input.pcm');await writeFile(temp+'/input.wav',wav(input),{mode:0o600});
 const before=audioSamples;for(let offset=0;offset<input.length;offset+=480){const bytes=Buffer.alloc(480);input.copy(bytes,0,offset,Math.min(offset+480,input.length));await source.captureFrame(new AudioFrame(new Int16Array(bytes.buffer,bytes.byteOffset,240),24000,1,240));}await source.waitForPlayout();mark('spoken-input',{seconds:input.length/48000});feedingSilence=true;silencePump=(async()=>{while(feedingSilence){try{await source.captureFrame(new AudioFrame(new Int16Array(2400),24000,1,2400));await delay(90);}catch{break;}}})();
 await wait(()=>events.some(x=>x.type==='transcript'&&x.text),'caller transcript',30000);mark('caller-transcript');
 await wait(()=>audioSamples>before+24000,'reply audio',30000);mark('reply-audio');
 // Allow genuine tool-triggered polite closure; a timeout is recorded, never called a successful goodbye.
 const isFinished=async()=>{const row=await db.prepare('SELECT status FROM calls WHERE id=?').bind(callId).first();return row.status!=='active';};
 let modelClosed=true,followupInput=false;
 try{await wait(isFinished,'initial model closure',16000);}catch{
   // A legitimate clarification question must stay open. Answer it as a second utterance.
   feedingSilence=false;await silencePump;
   execFileSync('/usr/bin/say',['-v','Samantha','-r','150','-o',temp+'/followup.aiff','Yes, that is correct. That is all I need. Thank you. Goodbye.'],{stdio:'ignore'});
   execFileSync('/opt/homebrew/bin/ffmpeg',['-v','error','-y','-i',temp+'/followup.aiff','-ar','24000','-ac','1','-f','s16le',temp+'/followup.pcm'],{stdio:'ignore'});
   const followup=await readFile(temp+'/followup.pcm');await writeFile(temp+'/followup.wav',wav(followup),{mode:0o600});
   for(let offset=0;offset<followup.length;offset+=480){const bytes=Buffer.alloc(480);followup.copy(bytes,0,offset,Math.min(offset+480,followup.length));await source.captureFrame(new AudioFrame(new Int16Array(bytes.buffer,bytes.byteOffset,240),24000,1,240));}
   await source.waitForPlayout();followupInput=true;mark('followup-input');
   feedingSilence=true;silencePump=(async()=>{while(feedingSilence){try{await source.captureFrame(new AudioFrame(new Int16Array(2400),24000,1,2400));await delay(90);}catch{break;}}})();
   try{await wait(isFinished,'model closure after confirmation',20000);}catch{modelClosed=false;socket.send(JSON.stringify({type:'hangup'}));}
 }
 await wait(async()=>{const row=await db.prepare('SELECT status FROM calls WHERE id=?').bind(callId).first();return row.status!=='active';},'finalized',35000);
 const call=await db.prepare('SELECT status,outcome,summary,intent,message_json,duration_s FROM calls WHERE id=?').bind(callId).first();const turns=(await db.prepare('SELECT role,text,source_id,source_revision,source_final FROM call_turns WHERE call_id=? ORDER BY id').bind(callId).all()).results;
 const proof={provenance,callId,call,turns,modelClosed,followupInput,audioSamples,peak,partialEvents:events.filter(x=>x.final===false&&x.eventId).length,finalEvents:events.filter(x=>x.final===true&&x.eventId).length,realProvider:true,physicalMicrophone:false,transport:'local SFU',inputSha256:createHash('sha256').update(input).digest('hex')};
 await writeFile(temp+'/result.json',JSON.stringify(proof,null,2),{mode:0o600});mark('result',{...proof,turns:turns.length});
 if(!modelClosed||call.status!=='completed'||!call.summary||!turns.some(t=>t.role==='caller'&&t.source_final)||!turns.some(t=>t.role==='agent'&&t.source_final))throw Error('Completed conversation/persistence acceptance failed');
}
try{await Promise.race([smoke(),hardDeadline]);}catch(error){failure=error.message;mark('failure',{message:failure});}
finally{
 clearTimeout(timer);cancelled=true;feedingSilence=false;if(silencePump)await Promise.race([silencePump,delay(2000)]);try{socket?.send(JSON.stringify({type:'hangup'}));}catch{};try{socket?.close();}catch{};
 void reader?.cancel().catch(()=>{});if(caller)await Promise.race([caller.disconnect(),delay(2000)]);await source?.close();
 if(agent&&agent.exitCode===null&&agent.signalCode===null){agent.kill('SIGTERM');await Promise.race([new Promise(resolve=>agent.once('exit',resolve)),delay(8000)]);if(agent.exitCode===null&&agent.signalCode===null){agent.kill('SIGKILL');await delay(250);}}
 // Only safe structured fields from logs; never persist provider payloads or credential-bearing strings.
 const safeLogs=[];for(const line of agentOutput.split('\n')){try{const row=JSON.parse(line);if(row.event==='openfon_voice_lifecycle'){safeLogs.push({event:row.event,phase:row.phase});continue;}safeLogs.push({level:row.level,msg:typeof row.msg==='string'?{length:row.msg.length,sha256:createHash('sha256').update(row.msg).digest('hex')}:undefined,errType:row.err?.type,errMessage:typeof row.err?.message==='string'?{length:row.err.message.length,sha256:createHash('sha256').update(row.err.message).digest('hex')}:undefined});}catch{}}
 await writeFile(temp+'/diagnostics.json',JSON.stringify({failure,provenance,diagnostics,logs:safeLogs},null,2),{mode:0o600});
 if(db&&callId){try{const turns=(await db.prepare('SELECT role,text,source_id,source_revision,source_final FROM call_turns WHERE call_id=? ORDER BY id').bind(callId).all()).results;const call=await db.prepare('SELECT status,outcome,summary,intent,message_json FROM calls WHERE id=?').bind(callId).first();await writeFile(temp+'/final-state.json',JSON.stringify({call,turns},null,2),{mode:0o600});}catch{}}
 if(pcm.length)await writeFile(temp+'/output.wav',wav(Buffer.concat(pcm)),{mode:0o600});
 await mf?.dispose();if(container){const owner=execFileSync(docker,['inspect','--format','{{index .Config.Labels "'+label+'"}}',container],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();if(owner!==run)throw Error('Container ownership mismatch');execFileSync(docker,['stop','--time','3',container],{stdio:'ignore',timeout:7000});}
 await dispose();console.log(JSON.stringify({evidence:temp,failed:Boolean(failure),ownedResourcesDisposed:true}));
}
process.exitCode=failure?1:0;
