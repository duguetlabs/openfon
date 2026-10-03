/** Explicit staging acceptance through normal account APIs. No remote D1 access.
 * Two synthetic audio calls, one microphone-denied typed call, and two selected-voice previews; credentials stay in memory. */
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import WebSocket from 'ws';
import { Room, RoomEvent, AudioSource, AudioFrame, AudioStream, LocalAudioTrack, TrackPublishOptions, TrackSource, dispose } from '@livekit/rtc-node';

const ORIGIN = 'https://openfon-staging.duguetlabs.workers.dev';
const SIGNALING = 'wss://voice-staging.openfon.ai';
if (!process.argv.includes('--stage-ready') || !process.argv.includes('--allow-paid')) {
  throw Error('Requires explicit --stage-ready --allow-paid; do not run before deployment approval.');
}
const directory = await mkdtemp(resolve(tmpdir(), 'openfon-staging-voice-'));
await chmod(directory, 0o700);
const run = randomUUID();
const email = `openfon-staging-${run}@example.invalid`;
const password = randomBytes(32).toString('base64url');
let cookie = '', accountId, businessId, cancelled = false, current;
const proofs = [], diagnostics = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function bounded(work, milliseconds, label) {
  let timer;
  try { return await Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Timed out: ' + label)), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const mark = (phase, data = {}) => {
  const item = { phase, ...data };
  diagnostics.push(item);
  console.log(JSON.stringify(item));
};
async function wait(predicate, label, milliseconds = 20000) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    if (cancelled) throw Error('Harness stopped');
    if (await predicate()) return;
    await delay(250);
  }
  throw Error(`Timed out: ${label}`);
}
async function request(path, method = 'GET', body, timeout = 15000) {
  const response = await fetch(ORIGIN + path, {
    method, redirect: 'error', signal: AbortSignal.timeout(timeout),
    headers: { Origin: ORIGIN, ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  // Only retain the known session cookie, never arbitrary server headers.
  const setCookie = response.headers.getSetCookie().find(value => value.startsWith('ofs='));
  if (setCookie) cookie = setCookie.split(';')[0];
  if (!response.ok) {
    await response.body?.cancel();
    throw Error(`${method} ${path} returned ${response.status}`);
  }
  return response;
}
async function json(path, method = 'GET', body) {
  return (await request(path, method, body)).json();
}
function wav(pcm) {
  const output = Buffer.alloc(44 + pcm.length);
  output.write('RIFF'); output.writeUInt32LE(36 + pcm.length, 4); output.write('WAVEfmt ', 8);
  output.writeUInt32LE(16, 16); output.writeUInt16LE(1, 20); output.writeUInt16LE(1, 22);
  output.writeUInt32LE(24000, 24); output.writeUInt32LE(48000, 28); output.writeUInt16LE(2, 32); output.writeUInt16LE(16, 34);
  output.write('data', 36); output.writeUInt32LE(pcm.length, 40); pcm.copy(output, 44);
  return output;
}
async function speechFixture(name, voice, text) {
  const prefix = resolve(directory, name);
  execFileSync('/usr/bin/say', ['-v', voice, '-r', '150', '-o', prefix + '.aiff', text], { stdio: 'ignore', timeout: 20000 });
  execFileSync('/opt/homebrew/bin/ffmpeg', ['-v', 'error', '-y', '-i', prefix + '.aiff', '-ar', '24000', '-ac', '1', '-f', 's16le', prefix + '.pcm'], { stdio: 'ignore', timeout: 20000 });
  const pcm = await readFile(prefix + '.pcm');
  await writeFile(prefix + '.wav', wav(pcm), { mode: 0o600 });
  return pcm;
}
function safeCall(call) {
  // The full API object may include configuration snapshots. Store only conversation evidence.
  return { id: call.id, status: call.status, outcome: call.outcome, summary: call.summary,
    intent: call.intent, message_json: call.message_json, duration_s: call.duration_s,
    turns: (call.turns ?? []).map(({ id, role, text, ts }) => ({ id, role, text, ts })) };
}
async function sendSpeech(state, pcm) {
  state.silence = false;
  await state.pump;
  for (let offset = 0; offset < pcm.length; offset += 480) {
    if (cancelled || state.disposed) throw Error('Audio input stopped');
    const bytes = Buffer.alloc(480);
    pcm.copy(bytes, 0, offset, Math.min(offset + 480, pcm.length));
    await bounded(state.source.captureFrame(new AudioFrame(new Int16Array(bytes.buffer, bytes.byteOffset, 240), 24000, 1, 240)), 3000, 'input audio queue');
  }
  await bounded(state.source.waitForPlayout(), 15000, 'input playout');
  state.silence = true;
  state.pump = (async () => {
    while (state.silence && !state.disposed) {
      try {
        await state.source.captureFrame(new AudioFrame(new Int16Array(2400), 24000, 1, 2400));
        await delay(90);
      } catch { break; }
    }
  })();
}
async function stopCall(state) {
  if (!state || state.disposed) return;
  state.disposed = true; state.silence = false;
  await Promise.race([state.pump, delay(2000)]);
  if (state.socket?.readyState === WebSocket.OPEN) state.socket.send(JSON.stringify({ type: 'hangup' }));
  state.socket?.close();
  void state.reader?.cancel().catch(() => {});
  if (state.room) await Promise.race([state.room.disconnect(), delay(2000)]);
  if(state.source)await bounded(state.source.close(), 3000, 'audio source close');
  if (state.pcm.length) await writeFile(resolve(directory, state.label + '-output.wav'), wav(Buffer.concat(state.pcm)), { mode: 0o600 });
}
const cases = [
  { voice: 'marin', language: 'en', osVoice: 'Samantha', greeting: 'Hello, this is the OpenFon test dental practice. How can I help?',
    input: 'Hello. My name is Alex Test. Please ask the dentist to call me back tomorrow about a toothache. My phone number is zero one two three four five six seven eight nine. Thank you. Goodbye.',
    followup: 'Yes, that is correct. That is all I need. Thank you. Goodbye.' },
  { voice: 'cedar', language: 'de', osVoice: 'Anna', greeting: 'Guten Tag, hier ist die OpenFon Test-Zahnarztpraxis. Wie kann ich Ihnen helfen?',
    input: 'Guten Tag. Mein Name ist Alex Test. Bitte bitten Sie den Zahnarzt, mich morgen wegen Zahnschmerzen zurückzurufen. Meine Telefonnummer lautet null eins zwei drei vier fünf sechs sieben acht neun. Vielen Dank. Auf Wiederhören.',
    followup: 'Ja, das ist richtig. Das ist alles. Vielen Dank und auf Wiederhören.' },
];
cases.push({...cases[0],noMicrophone:true});
const selectedCases=process.argv.includes('--typed-only')?cases.filter(spec=>spec.noMicrophone):cases;
async function runCase(spec) {
  const label = spec.language + '-' + spec.voice + (spec.noMicrophone?'-typed':'');
  const assistant = await json('/api/me/assistants', 'POST', {
    name: 'Synthetic ' + label, persona: 'Friendly and concise dental receptionist', greeting: spec.greeting,
    language: spec.language, engine: 'realtime', realtime_model: 'gpt-live-1', realtime_voice: spec.voice, voice: '',
    custom_instructions: 'This is a synthetic test. Take callback messages only. Never claim an appointment is confirmed. After the caller confirms they need no more help, say a brief goodbye and end the call.',
  });
  const saved = await json('/api/me/assistants/' + assistant.id);
  if (saved.realtime_voice !== spec.voice || saved.language !== spec.language) throw Error('Saved voice/language mismatch');
  let preview=Buffer.alloc(0),previewPeak=0;
  if(!spec.noMicrophone){
  preview = Buffer.from(await (await request('/api/me/assistants/' + assistant.id + '/voice-preview', 'POST', {
    engine: saved.engine, language: saved.language, voice: saved.voice,
    realtime_model: saved.realtime_model, realtime_voice: saved.realtime_voice,
  }, 45000)).arrayBuffer());
  if (preview.length < 1000 || preview.toString('ascii', 0, 4) !== 'RIFF') throw Error('Invalid voice preview');
  await writeFile(resolve(directory, label + '-preview.wav'), preview, { mode: 0o600 });
  const previewPcm=execFileSync('/opt/homebrew/bin/ffmpeg',['-v','error','-i',resolve(directory,label+'-preview.wav'),'-ar','24000','-ac','1','-f','s16le','pipe:1'],{stdio:['ignore','pipe','ignore'],timeout:10000,maxBuffer:4*1024*1024});
  for(let i=0;i+1<previewPcm.length;i+=2)previewPeak=Math.max(previewPeak,Math.abs(previewPcm.readInt16LE(i)));
  if(previewPeak<=100)throw Error('Selected voice preview contains no audible signal');
  }
  const input = spec.noMicrophone?Buffer.from(spec.input):await speechFixture(label + '-input', spec.osVoice, spec.input);
  const followup = spec.noMicrophone?Buffer.from(spec.followup):await speechFixture(label + '-followup', spec.osVoice, spec.followup);
  const reservation = await json('/api/me/assistants/' + assistant.id + '/test-calls', 'POST');
  const state = current = { label, callId: reservation.callId, pcm: [], events: [], peak: 0, samples: 0, silence: false, disposed: false };
  mark('call-reserved', { label, callId: state.callId });
  try {
    state.socket = new WebSocket(ORIGIN.replace(/^http/, 'ws') + '/ws/call/' + state.callId, { headers: { Origin: ORIGIN, Cookie: cookie } });
    state.socket.on('error', () => { state.socketFailed = true; });
    let grant;
    state.socket.on('message', bytes => {
      try {
        const message = JSON.parse(String(bytes));
        if (message.type === 'ready') grant = message;
        // Exclude ready tokens and all server objects except known transcript fields.
        state.events.push({ type: message.type, text: message.text, eventId: message.eventId, revision: message.revision, final: message.final });
      } catch { /* binary audio is not expected on the control socket */ }
    });
    await wait(() => state.socket.readyState === WebSocket.OPEN || state.socketFailed, 'control connection');
    if (state.socketFailed) throw Error('Control connection failed');
    state.socket.send(JSON.stringify({ type: 'start' }));
    await wait(() => Boolean(grant), 'LiveKit admission');
    if (grant.mode !== 'livekit' || grant.serverUrl !== SIGNALING) throw Error('Unexpected staging voice routing');
    state.room = new Room();
    state.room.on(RoomEvent.TrackSubscribed, track => {
      state.reader = new AudioStream(track, 24000, 1).getReader();
      void (async () => {
        try {
          while (!state.disposed) {
            const next = await state.reader.read(); if (next.done) break;
            const samples = next.value.data;
            state.pcm.push(Buffer.from(Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength)));
            state.samples += samples.length;
            for (const value of samples) state.peak = Math.max(state.peak, Math.abs(value));
          }
        } catch { /* disconnect ends capture */ }
      })();
    });
    await bounded(state.room.connect(grant.serverUrl, grant.participantToken), 30000, 'media connection');
    if(!spec.noMicrophone){
    state.source = new AudioSource(24000, 1);
    const options = new TrackPublishOptions(); options.source = TrackSource.SOURCE_MICROPHONE;
    await bounded(state.room.localParticipant.publishTrack(LocalAudioTrack.createAudioTrack('Synthetic test microphone', state.source), options), 15000, 'microphone publication');
    }
    await wait(() => state.peak > 100, 'greeting audio', 30000);
    await delay(5000);
    if(spec.noMicrophone)state.socket.send(JSON.stringify({type:'text',text:spec.input}));
    else await sendSpeech(state, input);
    const callPath = '/api/me/calls/' + state.callId;
    const completed = async () => { state.call = safeCall(await json(callPath)); return state.call.status !== 'active'; };
    let usedFollowup = false;
    try { await wait(completed, 'initial farewell', 16000); }
    catch {
      usedFollowup = true;
      if(spec.noMicrophone)state.socket.send(JSON.stringify({type:'text',text:spec.followup}));
      else await sendSpeech(state, followup);
      await wait(completed, 'farewell after confirmation', 30000);
    }
    if (state.call.status !== 'completed' || !state.call.summary || !state.call.message_json ||
        !state.call.turns.some(turn => turn.role === 'caller') || !state.call.turns.some(turn => turn.role === 'agent')) {
      throw Error('Call completion, transcript, summary or action extraction failed');
    }
    const extracted=JSON.parse(state.call.message_json);
    if(!String(extracted.caller_name).toLowerCase().includes('alex')||String(extracted.caller_phone).replace(/[^0-9]/g,'')!=='0123456789'||!extracted.message)throw Error('Synthetic caller details were not accurately extracted');
    if(spec.noMicrophone){
      const typedTurns=state.call.turns.filter(turn=>turn.role==='caller');
      const expected=[spec.input,...(usedFollowup?[spec.followup]:[])];
      if(typedTurns.length!==expected.length||typedTurns.some((turn,index)=>turn.text!==expected[index]))throw Error('Typed commands were not persisted exactly once in order');
    }
    const finalEvents=state.events.filter(event=>event.final===true&&['transcript','agent_text'].includes(event.type));
    if(!finalEvents.length||finalEvents.some(event=>!state.call.turns.some(turn=>turn.role===(event.type==='transcript'?'caller':'agent')&&turn.text===event.text)))throw Error('Final transcript events do not match persisted call');
    const proof = { label, inputMode:spec.noMicrophone?'typed-no-microphone':'synthetic-microphone', assistantId: assistant.id, call: state.call, usedFollowup, automaticClosure: true,
      savedVoice: saved.realtime_voice, savedLanguage: saved.language, previewSha256: preview.length?hash(preview):null, previewBytes: preview.length, previewPeak,
      inputSha256: hash(input), followupSha256: hash(followup), outputSamples: state.samples, outputPeak: state.peak,
      partialEvents: state.events.filter(event => event.final === false).length, finalEvents: state.events.filter(event => event.final === true).length,
      events: state.events.filter(event => ['transcript', 'agent_text', 'ended'].includes(event.type)),
      physicalMicrophone: false, subjectiveVoiceIdentity: false, apiOnlyOwnerTest: true };
    proofs.push(proof);
    await writeFile(resolve(directory, label + '-result.json'), JSON.stringify(proof, null, 2), { mode: 0o600 });
    mark('call-pass', { label, callId: state.callId, partialEvents: proof.partialEvents, finalEvents: proof.finalEvents, automaticClosure: true });
  } catch(error) {
    // Preserve known conversation fields before normal owned-account cleanup.
    await writeFile(resolve(directory,label+'-failure.json'),JSON.stringify({
      label,callId:state.callId,failure:error.message,call:state.call,
      outputSamples:state.samples,outputPeak:state.peak,
      events:state.events.filter(event=>['transcript','agent_text','ended'].includes(event.type)),
    },null,2),{mode:0o600});
    throw error;
  } finally { await stopCall(state); }
}
let failure = '', deleted = false;
try {
  const account = await json('/api/auth/signup', 'POST', { email, password }); accountId = account.id;
  if (!cookie) await json('/api/auth/login', 'POST', { email, password });
  if (!cookie) throw Error('No owned session');
  const business = await json('/api/me/business', 'POST', {
    name: 'OpenFon synthetic staging ' + run.slice(0, 8), description: 'Isolated acceptance workspace. No real customers or appointments.',
    timezone: 'Europe/Berlin', hours_json: JSON.stringify(['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'].map(day => ({ day, open: '08:00', close: '18:00', closed: false }))),
  });
  businessId = business.id;
  for (const spec of selectedCases) await runCase(spec);
} catch (error) { failure = error.message; mark('failure', { message: failure }); }
finally {
  try{await stopCall(current);}catch(error){mark('media-cleanup-unconfirmed',{message:error.message});}
  if(!accountId){try{const recovered=await json('/api/auth/login','POST',{email,password});accountId=recovered.id;}catch{/* no admitted account or service unavailable */}}
  if (accountId && cookie) {
    try {
      if (current?.callId) {
        // A failed test still owns its cleanup. Never delete other accounts or bypass active-call guards.
        await wait(async () => (await json('/api/me/calls/' + current.callId)).status !== 'active', 'cleanup call completion', 35000);
      }
      await json('/api/me/account', 'DELETE', { currentPassword: password, confirmation: 'DELETE' }); deleted = true;
    } catch (error) { mark('cleanup-required', { accountId, email, message: error.message }); }
  }
  cancelled = true;
  await dispose();
  await writeFile(resolve(directory, 'summary.json'), JSON.stringify({ run, origin: ORIGIN, signaling: SIGNALING, accountId, businessId, deleted,
    failure, casesPassed: proofs.length, diagnostics, limits: ['Native RTC with synthetic speech; not physical microphone or subjective voice-identity validation', 'Own test-call APIs; no anonymous public-link or carrier call', 'Two selected voices only; no all-voice acceptance'] }, null, 2), { mode: 0o600 });
  mark('finished', { evidence: directory, casesPassed: proofs.length, deleted, failed: Boolean(failure) || !deleted });
}
process.exitCode = failure || !deleted ? 1 : 0;
