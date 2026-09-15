#!/usr/bin/env node
// Actual workerd sockets and both real media adapters; no carrier/provider calls.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const worker = `
import { TelnyxMediaAdapter } from './src/telnyx-media';
import { AsteriskMediaAdapter } from './src/asterisk-media';
export default { async fetch(request) {
  const url = new URL(request.url), kind = url.searchParams.get('kind'), marks = url.searchParams.get('marks') === 'yes';
  const sessionPair = new WebSocketPair(), carrierPair = new WebSocketPair();
  const session = sessionPair[0], receiver = sessionPair[1], carrier = carrierPair[0], bridge = carrierPair[1];
  for (const socket of [session, receiver, carrier, bridge]) { socket.accept(); socket.binaryType = 'arraybuffer'; }
  const acks = new Set(); let ended = '', media = 0, markerCount = 0, receiptCount = 0, iterations = 0;
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const check = (value, message) => { if (!value) throw Error(message); };
  const wait = async (predicate, label) => {
    const until = Date.now() + 2000;
    while (!predicate()) { if (Date.now() >= until) throw Error(label); await delay(1); }
  };
  const options = { sessionSend: data => receiver.send(data), carrierSend: data => bridge.send(data), onEnd: reason => { ended = reason; } };
  const adapter = kind === 'telnyx'
    ? new TelnyxMediaAdapter({ ...options, expected: { callControlId: 'c', callSessionId: 's', callLegId: 'l', authToken: 'synthetic' } })
    : new AsteriskMediaAdapter(options);
  receiver.addEventListener('message', e => adapter.sessionMessage(e.data));
  bridge.addEventListener('message', e => { void adapter.carrierMessage(e.data); });
  session.addEventListener('message', e => {
    if (typeof e.data !== 'string') return;
    const msg = JSON.parse(e.data);
    if (msg.type === 'audio_received') { acks.add(msg.id); receiptCount++; }
  });
  carrier.addEventListener('message', e => {
    if (typeof e.data !== 'string') { media++; return; }
    const msg = JSON.parse(e.data);
    check(!['audio_receipt','control_receipt','audio_received'].includes(msg.type), 'private receipt leaked');
    if (msg.event === 'media') media++;
    if (msg.event === 'mark' || msg.command === 'MARK_MEDIA') {
      markerCount++;
      if (marks) carrier.send(JSON.stringify(kind === 'telnyx'
        ? { event: 'mark', stream_id: 's', mark: msg.mark }
        : { event: 'MEDIA_MARK_PROCESSED', correlation_id: msg.correlation_id }));
    }
  });
  const pair = async (payload, type, bytes) => {
    const id = crypto.randomUUID();
    session.send(payload);
    session.send(JSON.stringify({ type, id, ...(bytes === undefined ? {} : { bytes }) }));
    await wait(() => acks.has(id) || ended, 'receipt timeout'); acks.delete(id);
  };
  try {
    // Internal real sockets implement no bufferedAmount. Safety is the receipt
    // and carrier mark accounting, never an assumed browser-only property.
    check(!('bufferedAmount' in receiver), 'runtime unexpectedly exposes bufferedAmount; revise provenance');
    if (kind === 'telnyx') {
      carrier.send(JSON.stringify({ event: 'connected', version: '1.0.0', connected: { 'x-telnyx-streaming-auth-token': 'synthetic' } }));
      carrier.send(JSON.stringify({ event: 'start', stream_id: 's', sequence_number: '1', start: { call_control_id: 'c', call_session_id: 's', media_format: { encoding: 'PCMU', sample_rate: 8000, channels: 1 } } }));
    } else carrier.send(JSON.stringify({ event: 'MEDIA_START', connection_id: 's', channel: 'test', format: 'ulaw', optimal_frame_size: 160, ptime: 20 }));
    // Ordered start reaches the receiver before local ready is sent.
    await delay(10);
    session.send(JSON.stringify({ type: 'ready', mode: 'realtime', ttsMode: 'server', greeting: '', audioReceipts: true }));
    for (; iterations < 510 && !ended; iterations++) {
      await pair(new ArrayBuffer(960), 'audio_receipt', 960);
      await delay(22); // actual adapter pump executes before the flush
      await pair(JSON.stringify({ type: 'flush' }), 'control_receipt');
    }
    if (marks) {
      check(!ended && iterations === 510, 'confirmed progress unexpectedly ended');
      check(markerCount > 500, 'normal progress did not exceed fixed lifetime count');
    } else {
      check(Boolean(ended), 'stalled carrier remained unlimited');
      check(markerCount <= 500 && media <= 500, 'stalled carrier exceeded bounded sent debt');
    }
    return Response.json({ kind, marks, iterations, ended: ended || null, media, markerCount, receiptCount, bufferedAmount: false });
  } finally {
    adapter.close();
    for (const socket of [session, receiver, carrier, bridge]) { try { socket.close(); } catch {} }
  }
}};
`;
const temp = await mkdtemp(resolve(tmpdir(), 'openfon-output-transport-'));
let mf;
try {
  const bundled = await build({ stdin: { contents: worker, resolveDir: process.cwd(), sourcefile: 'realtime-output-probe.ts', loader: 'ts' }, bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022' });
  mf = new Miniflare(convertV4MiniflareOptions({ defaultPersistRoot: temp, port: Number(process.env.OPENFON_TEST_PORT || 8813), inspectorPort: Number(process.env.OPENFON_INSPECTOR_PORT || 9253), cf: false,
    workers: [{ name: 'probe', modules: true, script: bundled.outputFiles[0].text, compatibilityDate: '2026-05-01', outboundService: async () => new Response('Network forbidden', { status: 502 }) }] }));
  for (const kind of ['telnyx', 'asterisk']) for (const marks of ['no', 'yes']) {
    const response = await mf.dispatchFetch('http://probe/run?kind=' + kind + '&marks=' + marks);
    assert.equal(response.status, 200, await response.clone().text());
    console.log('PASS', JSON.stringify(await response.json()));
  }
} finally {
  await mf?.dispose(); await rm(temp, { recursive: true, force: true });
}
