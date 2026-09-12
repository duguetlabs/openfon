import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';

// A deterministic local provider exercises the real Worker/socket/database path.
// It deliberately does not validate real speech providers or make paid calls.
const provider = createServer(async (request, response) => {
  if (request.method !== 'POST' || request.url !== '/v1/chat/completions' || request.headers.authorization !== 'Bearer local-test-key') {
    response.writeHead(404).end();
    return;
  }
  let raw = '';
  for await (const chunk of request) {
    raw += chunk;
    if (raw.length > 128 * 1024) { response.writeHead(413).end(); return; }
  }
  try {
    const input = JSON.parse(raw);
    const summary = input.messages?.[0]?.content?.startsWith('You analyze a phone call transcript');
    const content = summary ? JSON.stringify({summary:'Caller asked about bicycle repairs.', intent:'question', caller_name:null, caller_phone:null, message:null}) : 'Yes, we repair bicycles during opening hours.';
    response.writeHead(200, {'content-type':'application/json'}).end(JSON.stringify({choices:[{message:{role:'assistant',content}}]}));
  } catch { response.writeHead(400).end(); }
});
await new Promise((resolve, reject) => { provider.once('error', reject); provider.listen(0, '127.0.0.1', resolve); });
const providerUrl = `http://127.0.0.1:${provider.address().port}/v1`;

// Fresh state per run keeps signup/spend limit tests representative without
// weakening production rate limits or touching the developer's local database.
const state = mkdtempSync(join(tmpdir(), 'openfon-e2e-'));
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const migrated = spawnSync(npx, ['wrangler', 'd1', 'migrations', 'apply', 'openfon', '--local', '--persist-to', state], { stdio: 'inherit' });
if (migrated.status !== 0) {
  rmSync(state, { recursive: true, force: true });
  process.exit(migrated.status || 1);
}
const worker = spawn(npx, ['wrangler', 'dev', '--local', '--port', process.env.OPENFON_E2E_PORT || '8790', '--inspector-port', process.env.OPENFON_E2E_INSPECTOR_PORT || '9232', '--persist-to', state,
  '--var', `DEFAULT_LLM_BASE_URL:${providerUrl}`, '--var', `DEFAULT_STT_BASE_URL:${providerUrl}`,
  '--var', `REALTIME_BASE_URL:${providerUrl.replace('http:', 'ws:')}/realtime`, '--var', 'DEFAULT_TTS_PROVIDER:browser',
  '--var', 'DEFAULT_LLM_API_KEY:local-test-key', '--var', 'DEFAULT_STT_API_KEY:local-test-key',
  '--var', 'AZURE_SPEECH_KEY:local-test-key', '--var', 'REALTIME_API_KEY:local-test-key'], { stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => worker.kill(signal));
worker.on('error', error => { console.error(error.message); rmSync(state, { recursive: true, force: true }); process.exit(1); });
worker.on('exit', code => { provider.close(); rmSync(state, { recursive: true, force: true }); process.exit(code || 0); });
