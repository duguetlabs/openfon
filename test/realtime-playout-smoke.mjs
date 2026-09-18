#!/usr/bin/env node
// Actual Chromium AudioContext + production queue/player. Synthetic PCM and
// socket transport; this does not establish physical audibility or PSTN quality.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';

const bundle = await build({ stdin: {
  contents: `import { VoiceCall } from './web/src/voice';
    import { RealtimeAudioQueue } from './src/realtime-output';
    window.audioFlow = { VoiceCall, RealtimeAudioQueue };`,
  resolveDir: process.cwd(), loader: 'ts',
}, bundle: true, format: 'iife', write: false });
const browser = await chromium.launch({
  ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}),
  args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'],
});
try {
  const page = await browser.newPage();
  await page.setContent('<title>OpenFon synthetic audio pacing test</title>');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const result = await page.evaluate(async () => {
    let socket;
    class Socket {
      static OPEN = 1;
      readyState = 1;
      send() {}
      close() { this.readyState = 3; }
      constructor() { socket = this; }
    }
    window.WebSocket = Socket;
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
      getUserMedia: async () => { throw Error('synthetic input; no microphone'); },
    } });
    const { VoiceCall, RealtimeAudioQueue } = window.audioFlow;
    const voice = new VoiceCall();
    const events = []; voice.on(e => { if (e.type === 'status') events.push(e.status); });
    await voice.connect('synthetic');
    const message = data => socket.onmessage({ data: typeof data === 'string' || data instanceof ArrayBuffer ? data : JSON.stringify(data) });
    message({ type: 'ready', mode: 'realtime', audioReceipts: true });
    const queue = new RealtimeAudioQueue(Date.now());
    // Thirty seconds produced immediately, in irregular provider-sized chunks.
    const input = new Int16Array(30 * 24000);
    for (let i = 0; i < input.length; i++) input[i] = Math.round(Math.sin(i * 2 * Math.PI * 220 / 24000) * 1000);
    for (let offset = 0; offset < input.byteLength; offset += 65536) queue.push(input.buffer.slice(offset, offset + 65536));
    const started = Date.now(); let delivered = 0, peak = 0, frames = 0;
    try {
      while (queue.pending && !voice.ended) {
        if (Date.now() - started > 35000) throw Error('pacing deadline');
        let audio;
        while ((audio = queue.take(Date.now()))) {
          message(audio); message({ type: 'audio_receipt', bytes: audio.byteLength, id: `00000000-0000-4000-8000-${String(++frames).padStart(12, "0")}` });
          delivered += audio.byteLength; peak = Math.max(peak, voice.queuedPcmBytes);
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
      return { delivered, expected: input.byteLength, peak, frames, ended: voice.ended,
        remaining: voice.queuedPcmBytes, nodes: voice.liveSources.size,
        audioClock: voice.playCtx?.currentTime, events };
    } finally { voice.hangup(); }
  });
  console.log(JSON.stringify(result));
  assert.equal(result.delivered, result.expected);
  assert.equal(result.ended, false);
  assert.equal(result.remaining, 0);
  assert.equal(result.nodes, 0);
  assert(result.audioClock >= 30);
  assert(result.peak <= 96000, `playback backlog exceeded two seconds: ${result.peak}`);
  assert(!result.events.includes('error'));
  console.log(JSON.stringify({ status: 'PASS', ...result }));
} finally { await browser.close(); }
