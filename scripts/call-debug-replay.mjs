#!/usr/bin/env node
// Extract privately downloaded bundles; live replay is an explicit, billed opt-in.
import { readFile, stat, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
const args = process.argv.slice(2);
const value = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
if (!args[0] || args[0].startsWith('--')) {
  console.log('Usage: node scripts/call-debug-replay.mjs BUNDLE --out DIR [--allow-partial] [--live --url wss://HOST/v1/realtime --model ID --threshold 0.7]\nLive replay reads OPENFON_REPLAY_API_KEY from the environment. It sends private audio and prompt to that endpoint and incurs provider usage.'); process.exit(1);
}
if ((await stat(args[0])).size > 140 * 1024 * 1024) throw Error('Bundle exceeds the recording size limit');
const lines = (await readFile(args[0], 'utf8')).trim().split('\n').map(line => JSON.parse(line));
const manifest = lines.shift(), end = lines.pop();
if (manifest.kind !== 'manifest' || manifest.version !== 1 || end?.kind !== 'end' || end.chunks !== manifest.chunks) throw Error('Incomplete or unsupported bundle');
if ((manifest.partial || manifest.interrupted || lines.length !== manifest.records) && !args.includes('--allow-partial')) throw Error('Partial recording: pass --allow-partial to inspect it; never treat missing audio as silence');
let lastSeq = -1;
for (const r of lines) {
  if (!Number.isSafeInteger(r.seq) || r.seq <= lastSeq || !Number.isFinite(r.ms) || r.ms < 0 || r.ms > 3_600_000) throw Error('Invalid record sequence or time');
  lastSeq = r.seq;
}
if (lines.length > 100_000) throw Error('Record count exceeds limit');
const out = resolve(value('--out') || 'call-debug-output'); await mkdir(out, { recursive: true, mode: 0o700 });
const frames = new Map();
for (const r of lines) if (r.kind === 'audio') {
  if (!['caller','caller_utterance','microphone','agent'].includes(r.track) || typeof r.format !== 'string' || !Number.isSafeInteger(r.frame) || typeof r.data !== 'string' || r.data.length > 32_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(r.data) || !Number.isFinite(r.ms) || r.ms < 0 || r.ms > 3_600_000 || !Number.isSafeInteger(r.total) || r.total < 0 || r.total > 16*1024*1024) throw Error('Invalid audio frame');
  const key = `${r.track}:${r.frame}`;
  if (!frames.has(key)) frames.set(key, { ...r, parts: [], bytes: 0 });
  const f = frames.get(key), b = Buffer.from(r.data, 'base64');
  if (r.offset !== f.bytes || f.total !== r.total || f.format !== r.format) throw Error('Missing or reordered audio part');
  f.parts.push(b); f.bytes += b.length;
}
const packets = [...frames.values()].filter(f => {
  if (f.bytes === f.total) return true;
  if (!args.includes('--allow-partial')) throw Error('Incomplete audio frame');
  console.warn('Skipped incomplete audio frame', f.frame); return false;
}).map(f => {
  return { ...f, data: Buffer.concat(f.parts), parts: undefined };
}).sort((a,b) => a.seq-b.seq);
const wave = b => { const h = Buffer.alloc(44); h.write('RIFF');h.writeUInt32LE(b.length+36,4);h.write('WAVEfmt ',8);h.writeUInt32LE(16,16);h.writeUInt16LE(1,20);h.writeUInt16LE(1,22);h.writeUInt32LE(24000,24);h.writeUInt32LE(48000,28);h.writeUInt16LE(2,32);h.writeUInt16LE(16,34);h.write('data',36);h.writeUInt32LE(b.length,40);return Buffer.concat([h,b]); };
for (const track of ['caller','microphone','agent']) {
  const group = packets.filter(p => p.track === track && p.format === 'pcm_s16le_24000');
  if (!group.length) continue;
  const chunks = [];let position = 0;
  for (const p of group) {
    const offset = Math.floor(p.ms * 24)*2;
    if (offset > position) { chunks.push(Buffer.alloc(offset-position));position=offset; }
    chunks.push(p.data);position+=p.data.length;
  }
  await writeFile(resolve(out,track+'.wav'), wave(Buffer.concat(chunks)), { mode: 0o600 });
}
for (const p of packets.filter(p => p.format !== 'pcm_s16le_24000')) {
  const ext = p.format.includes('mpeg')?'mp3':p.format.includes('mp4')?'mp4':p.format.includes('wav')?'wav':'webm';
  await writeFile(resolve(out,`packet-${p.seq}.${ext}`),p.data,{mode:0o600});
}
await writeFile(resolve(out,'timeline.json'),JSON.stringify({manifest,events:lines.map(({data,...r})=>r)},null,2),{mode:0o600});
console.log('Extracted audio and timeline to',out,'(arrival timing; agent track includes delivered audio that playback may have flushed).');
if (args.includes('--live')) {
  if (manifest.partial || manifest.interrupted) throw Error('Live replay requires a complete recording');
  const url = new URL(value('--url') || '');
  if (url.protocol !== 'wss:' && !(url.protocol === 'ws:' && ['127.0.0.1','localhost','[::1]'].includes(url.hostname))) throw Error('Use wss, or ws on loopback only');
  if (url.username || url.password) throw Error('Use the environment key, not URL credentials');
  const key = process.env.OPENFON_REPLAY_API_KEY; if (!key) throw Error('OPENFON_REPLAY_API_KEY is required');
  const config = lines.find(r=>r.kind==='configuration');
  const recorded = lines.find(r=>r.kind==='session');
  if (!recorded || config?.engine !== 'realtime') throw Error('Live CLI replay currently requires Realtime; Pipeline utterances and microphone PCM are exported for separate testing');
  url.searchParams.set('model',value('--model') || config.realtimeModel);
  const session = recorded.session || {type:'realtime',instructions:recorded.instructions,audio:recorded.audio};
  if (value('--threshold') !== undefined) {
    const threshold=Number(value('--threshold'));if (!Number.isFinite(threshold)||threshold<0||threshold>1)throw Error('Threshold must be between 0 and 1');
    if(session.audio?.input?.turn_detection?.type!=='server_vad')throw Error('Recorded mode does not use server VAD');
    session.audio.input.turn_detection.threshold=threshold;
  }
  const {WebSocket}=createRequire(import.meta.url)('ws');
  const ws=new WebSocket(url,{headers:{Authorization:'Bearer '+key},maxPayload:1024*1024,handshakeTimeout:10000});const results=[];let stopped=false, acknowledged=false, resultBytes=0, resultPartial=false;
  const safeCode = v => typeof v === 'string' && /^[\w.:-]{1,128}$/.test(v) ? v : undefined;
  const done=new Promise((resolve,reject)=>{ws.on('open',resolve);ws.on('error',()=>reject(Error('Replay connection failed')));});
  ws.on('message',data=>{try{
    const e=JSON.parse(data);
    if(e.type==='session.updated') acknowledged=true;
    // Untrusted provider payloads must not echo credentials, headers or raw errors.
    const row={type:safeCode(e.type),responseId:safeCode(e.response_id ?? e.response?.id),
      status:safeCode(e.response?.status),errorCode:safeCode(e.error?.code),ms:Date.now(),
      ...(typeof e.transcript==='string' && e.transcript.length<=16384 ? {transcript:e.transcript}:{}),
      ...(['response.audio.delta','response.output_audio.delta'].includes(e.type) && typeof e.delta==='string' && e.delta.length<=512000 && /^[A-Za-z0-9+/]*={0,2}$/.test(e.delta) ? {audio:e.delta}: {})};
    const bytes=Buffer.byteLength(JSON.stringify(row));
    if(results.length>=100000 || resultBytes+bytes>128*1024*1024){resultPartial=true;ws.terminate();return;}
    results.push(row);resultBytes+=bytes;
  }catch{resultPartial=true;}});ws.on('close',()=>{stopped=true;});
  const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  const timeout=setTimeout(()=>ws.terminate(),35*60_000);
  try {
    await done;ws.send(JSON.stringify({type:'session.update',session}));
    const until=Date.now()+10000;while(!acknowledged&&!stopped&&Date.now()<until)await sleep(20);
    if(stopped||!acknowledged)throw Error('Session configuration not acknowledged');
    // Recreate generated greeting where the live session had one; business text is in the saved prompt.
    const initialText=lines.find(r=>r.kind==='caller_event'&&r.type==='agent_text')?.text;
    if(initialText)ws.send(JSON.stringify({type:'response.create',response:{instructions:'Greet the caller by saying exactly this, then wait: '+JSON.stringify(initialText)}}));
    const start=Date.now();
    for(const p of packets.filter(p=>p.track==='caller'&&p.format==='pcm_s16le_24000'&&p.forwarded===true)) {
      await sleep(Math.max(0,start+p.ms-Date.now()));if(stopped)throw Error('Provider disconnected during replay');
      if(ws.bufferedAmount>1024*1024)throw Error('Replay network fell behind; timing no longer valid');
      ws.send(JSON.stringify({type:'input_audio_buffer.append',audio:p.data.toString('base64')}));
    }
    await sleep(15000);
  } finally {
    clearTimeout(timeout);ws.terminate();
    // Provider responses can contain private transcript/audio. Keep these local.
    await writeFile(resolve(out,'replay-events.json'),JSON.stringify({partial:resultPartial,sessionAcknowledged:acknowledged,events:results},null,2),{mode:0o600});
  }
  console.log('Replay complete. Provider/model responses are nondeterministic; compare events, not just final text.');
}
