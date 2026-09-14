/** Real Asterisk Local-channel harness, called by asterisk-smoke.mjs --asterisk.
 * Uses only a named disposable container and test-generated config/audio.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
const exec = promisify(execFile);
/** Only a new, correlated HTTP rejection proves a revoked PBX attempt happened.
 * Zero channels alone can be observed before asynchronous originate starts. */
export async function waitForPbxRejection({wait, attempts, after, call}) {
  let rejected;
  await wait(()=>Boolean(rejected=attempts.find(x=>x.sequence>after && x.call===call && x.status===401)), 'revoked route actual PBX HTTP rejection');
  assert.equal(rejected.rateWriteAttempts,0,'revoked handshake attempts no D1 rate-counter write');
  return rejected;
}
/** The proxy stays on host loopback. Native Linux therefore needs the host
 * namespace, while Docker Desktop provides its own host-loopback forwarding.
 * A host-gateway DNS alias alone does not make a bridge reach 127.0.0.1. */
export function asteriskRuntimeNetwork({ platform, daemonHost, operatingSystem, securityOptions = [] }) {
  if (!daemonHost?.startsWith('unix://')) {
    throw Error('Asterisk runtime requires a local Unix-socket Docker daemon; remote/TCP/SSH daemons are unsupported.');
  }
  if (operatingSystem === 'Docker Desktop') {
    return { host: 'host.docker.internal', dockerArgs: [], mode: 'docker-desktop' };
  }
  if (platform === 'linux' && operatingSystem && !securityOptions.some(option => /rootless/i.test(option))) {
    return { host: '127.0.0.1', dockerArgs: ['--network=host'], mode: 'linux-host' };
  }
  throw Error('Asterisk runtime supports Docker Desktop or a local rootful Linux Docker Engine.');
}

// Resolve once using Docker CLI precedence, then pin every daemon command to
// that endpoint. Changing the saved context cannot redirect run or cleanup.
export async function prepareAsteriskRuntimeDocker(run, env = process.env, platform = process.platform) {
  let daemonHost;
  if (!env.DOCKER_CONTEXT && env.DOCKER_HOST) daemonHost = env.DOCKER_HOST;
  else {
    const contextName = env.DOCKER_CONTEXT || (await run(['context', 'show'], env)).trim();
    const [context] = JSON.parse(await run(['context', 'inspect', contextName], env));
    daemonHost = context?.Endpoints?.docker?.Host;
  }
  if (!daemonHost?.startsWith('unix://')) {
    throw Error('Asterisk runtime requires a local Unix-socket Docker daemon; remote/TCP/SSH daemons are unsupported.');
  }
  // Explicit --host plus cleared context/TLS overrides targets this local socket
  // even if the caller changes context or environment after preparation.
  const pinnedEnv = { ...env, DOCKER_CONTEXT: '', DOCKER_HOST: daemonHost,
    DOCKER_TLS: '', DOCKER_TLS_VERIFY: '', DOCKER_CERT_PATH: '' };
  const docker = (...args) => run(['--host', daemonHost, ...args], pinnedEnv);
  const operatingSystem = JSON.parse(await docker('info', '--format', '{{json .OperatingSystem}}'));
  const securityOptions = JSON.parse(await docker('info', '--format', '{{json .SecurityOptions}}')) || [];
  const network = asteriskRuntimeNetwork({ platform, daemonHost, operatingSystem, securityOptions });
  return { docker, network };
}

export async function runAsteriskRuntime({ temp, db, telemetry, wait, password }) {
  const name = `openfon-asterisk-${process.pid}`;
  const image = process.env.OPENFON_ASTERISK_IMAGE || 'openfon-asterisk-runtime:22.11.0';
  const port = Number(process.env.OPENFON_TEST_PORT || 8811);
  const proxyPort = Number(process.env.OPENFON_ASTERISK_PROXY_PORT || 8821);
  const controls = {}, events = {};
  const attempts=[];let sequence=0;
  const proxy = createServer((_request,response)=>{response.writeHead(404);response.end();});
  const websockets = new WebSocketServer({noServer:true});
  const sockets = new Set();
  proxy.on('upgrade',(request,socket,head)=>{
    const attempt={sequence:++sequence,call:new URL(request.url,'http://local.test').searchParams.get('call'),status:null,rateWriteAttempts:null};attempts.push(attempt);
    const upstream = new WebSocket(`ws://127.0.0.1:${port}${request.url}`, 'media', {headers:{Authorization:request.headers.authorization || ''}});
    sockets.add(upstream);
    upstream.on('unexpected-response',(_request,response)=>{attempt.status=response.statusCode;attempt.rateWriteAttempts=response.headers['x-openfon-test-rate-writes']===undefined?null:Number(response.headers['x-openfon-test-rate-writes']);socket.end(`HTTP/1.1 ${response.statusCode} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);response.resume();upstream.terminate();});
    upstream.on('error',()=>socket.destroy());
    upstream.on('open',()=>{attempt.status=101;websockets.handleUpgrade(request,socket,head,pbx=>{
      sockets.add(pbx);
      pbx.on('message',(data,binary)=>{if(!binary){const event=JSON.parse(data.toString()).event;events[event]=(events[event]||0)+1;}if(upstream.readyState===1)upstream.send(data,{binary});});
      upstream.on('message',(data,binary)=>{if(!binary){const command=JSON.parse(data.toString()).command;controls[command]=(controls[command]||0)+1;}if(pbx.readyState===1)pbx.send(data,{binary});});
      pbx.on('close',()=>{sockets.delete(pbx);upstream.close();});
      pbx.on('error',()=>upstream.close());
      upstream.on('close',()=>{sockets.delete(upstream);pbx.close();});
    });});
  });
  const config = join(temp, 'pbx'); await mkdir(config);
  const { docker, network } = await prepareAsteriskRuntimeDocker(async (args, env) =>
    (await exec('docker', args, { env, timeout: 30000, maxBuffer: 1024 * 1024 })).stdout);
  // Never pull/build against an implicit or changed context. The selected local
  // daemon must already contain the operator-built fixture image.
  await docker('image', 'inspect', image);
  const cli = command => docker('exec', name, 'asterisk', '-rx', command);
  await writeFile(join(config, 'asterisk.conf'), `[directories]\nastetcdir => /test\nastmoddir => /usr/lib/asterisk/modules\nastvarlibdir => /var/lib/asterisk\nastdbdir => /var/lib/asterisk\nastkeydir => /var/lib/asterisk\nastdatadir => /var/lib/asterisk\nastagidir => /var/lib/asterisk/agi-bin\nastspooldir => /var/spool/asterisk\nastrundir => /var/run/asterisk\nastlogdir => /var/log/asterisk\n[options]\nverbose=3\ndebug=3\n`);
  await writeFile(join(config, 'modules.conf'), '[modules]\nautoload=yes\nnoload=chan_pjsip.so\nnoload=chan_iax2.so\nnoload=res_manager_devicestate.so\n');
  await writeFile(join(config, 'logger.conf'), '[logfiles]\nconsole=notice,warning,error,verbose,debug\n');
  await writeFile(join(config, 'websocket_client.conf'), `[openfon]\ntype=websocket_client\nconnection_type=per_call_config\nuri=ws://${network.host}:${proxyPort}/ws/asterisk/pbx\nprotocols=media\nusername=pbx\npassword=${password}\nconnection_timeout=10000\nreconnect_attempts=0\ntls_enabled=no\nenable_pingpongs=yes\npingpong_interval=5\npingpong_probes=2\n`, { mode: 0o600 });
  // Cleartext is confined to the local Docker-to-host test hop, using fixture credentials.
  await writeFile(join(config, 'extensions.conf'), `[general]\nstatic=yes\n[openfon-test]\nexten => s,1,Answer()\n same => n,Set(TIMEOUT(absolute)=15)\n same => n,MixMonitor(/test/mixed.wav,r(/test/caller.wav)t(/test/assistant.wav))\n same => n,Dial(WebSocket/openfon/c(ulaw)nf(json)v(call=runtime-one),10)\n same => n,StopMixMonitor()\n same => n,Hangup()\nexten => revoked,1,Answer()\n same => n,Dial(WebSocket/openfon/c(ulaw)nf(json)v(call=runtime-revoked),10)\n same => n,Hangup()\n`);
  const tone = Buffer.alloc(8000 * 2 * 6);
  for (let i = 0; i < tone.length / 2; i++) tone.writeInt16LE(Math.round(6000 * Math.sin(2 * Math.PI * 660 * i / 8000)), i * 2);
  await writeFile(join(config, 'tone.sln'), tone);
  try {
    await new Promise((resolve,reject)=>{proxy.once('error',reject);proxy.listen(proxyPort,'127.0.0.1',resolve);});
    await docker('run', '-d', '--rm', '--pull=never', ...network.dockerArgs, '--name', name, '--mount', `type=bind,src=${config},dst=/test`, image, 'asterisk', '-f', '-vvv', '-C', '/test/asterisk.conf');
    await wait(async () => { try { return (await cli('core show version')).includes('Asterisk'); } catch { return false; } }, 'Asterisk startup');
    const version = (await cli('core show version')).trim();
    const modules = await cli('module show like websocket');
    assert.match(modules, /chan_websocket\.so\s+.*Running/);
    assert.match(modules, /res_websocket_client\.so\s+.*Running/);
    await cli('channel originate Local/s@openfon-test/n application Playback /test/tone');
    await wait(() => telemetry.some(x => x.path === '/input'), 'actual PBX PCM into mocked AI');
    await wait(async () => {
      const row = await db.prepare("SELECT status,carrier_released_at FROM calls WHERE channel='asterisk'").first();
      return row?.carrier_released_at && row.status !== 'active';
    }, 'actual PBX hangup and D1 finalization');
    await wait(async () => (await cli('core show channels count')).includes('0 active channels'), 'PBX channel cleanup');
    const rows = await db.prepare("SELECT status,connected_at,carrier_released_at FROM calls WHERE channel='asterisk'").all();
    assert.equal(rows.results.length, 1); assert.ok(rows.results[0].connected_at);
    const turns=await db.prepare('SELECT role,text FROM call_turns ORDER BY id').all();
    assert.ok(turns.results.some(x=>x.role==='caller' && x.text==='Goodbye'));
    assert.ok(turns.results.some(x=>x.role==='agent' && x.text==='Goodbye.'));
    const recorded = await readFile(join(config, 'assistant.wav'));
    // WAV PCM16: locate data chunk, rather than assuming a fixed header length.
    let data;
    for (let offset = 12; offset + 8 <= recorded.length;) {
      const size = recorded.readUInt32LE(offset + 4);
      if (recorded.toString('ascii', offset, offset + 4) === 'data') { data = recorded.subarray(offset + 8, offset + 8 + size); break; }
      offset += 8 + size + size % 2;
    }
    assert.ok(data?.length >= 320, 'PBX recorded assistant audio');
    let peak = 0; for (let i = 0; i + 1 < data.length; i += 2) peak = Math.max(peak, Math.abs(data.readInt16LE(i)));
    assert.ok(peak > 1000, `assistant recording is non-silent (${peak})`);
    assert.equal(telemetry.find(x=>x.path==='/input').body.nonSilent, true, 'real caller tone reached AI input');
    let tone440 = 0;
    for (let base=0; base+1280<=data.length; base+=320) {
      let re=0,im=0;
      for(let i=0;i<640;i++){const sample=data.readInt16LE(base+2*i); re+=sample*Math.cos(2*Math.PI*440*i/8000); im+=sample*Math.sin(2*Math.PI*440*i/8000);}
      tone440=Math.max(tone440,2*Math.hypot(re,im)/640);
    }
    assert.ok(tone440>2000, 'mocked AI 440Hz tone survived real PBX playback');
    for(const command of ['ANSWER','FLUSH_MEDIA','MARK_MEDIA','HANGUP']) assert.ok(controls[command]>0,`actual PBX received ${command}`);
    assert.ok(events.MEDIA_MARK_PROCESSED>0, 'actual PBX acknowledged playback');
    // A real second PBX connection with revoked route must fail before reservation.
    const counters=await db.prepare("SELECT bucket,window_start,count FROM rate_counters WHERE bucket LIKE 'asterisk:%' ORDER BY bucket,window_start").all();
    await db.prepare("UPDATE asterisk_routes SET enabled=0").run();
    const beforeAttempt=sequence;
    await cli('channel originate Local/revoked@openfon-test/n application Playback /test/tone');
    const rejected=await waitForPbxRejection({wait,attempts,after:beforeAttempt,call:'runtime-revoked'});
    await wait(async()=>(await cli('core show channels count')).includes('0 active channels'),'rejected PBX channel cleanup');
    assert.deepEqual((await db.prepare("SELECT bucket,window_start,count FROM rate_counters WHERE bucket LIKE 'asterisk:%' ORDER BY bucket,window_start").all()).results,counters.results,'revoked handshake leaves rate counters unchanged');
    assert.equal((await db.prepare("SELECT COUNT(*) n FROM calls").first()).n,1,'revoked PBX creates no call');
    assert.equal(telemetry.filter(x => x.path === '/unexpected').length, 0);
    console.log(JSON.stringify({ evidence: 'real Asterisk + Local channel + workerd/D1/DO; mocked AI; no SIP trunk/PSTN', networkMode: network.mode, version, modules: modules.trim(), inputPcmBytes: telemetry.find(x=>x.path==='/input').body.bytes, assistantRecordedBytes: data.length, assistantPeak: peak, tone440Amplitude: Math.round(tone440), controlsToPbx: controls, eventsFromPbx: events, revokedRouteRejected: true, revokedHandshake: rejected, persistedTurns: turns.results.length, calls: rows.results, activeChannels: 0 }, null, 2));
  } catch (error) {
    // Only this fixture container: its config contains no real credentials.
    const logs = await docker('logs', '--tail', '100', name).catch(() => 'Container unavailable');
    console.error(logs); throw error;
  } finally {
    await docker('rm', '-f', name).catch(() => {});
    for(const socket of sockets)socket.terminate();
    websockets.close();await new Promise(resolve=>proxy.close(resolve));
  }
}
