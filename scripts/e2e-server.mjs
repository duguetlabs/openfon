import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

// Fresh state per run keeps signup/spend limit tests representative without
// weakening production rate limits or touching the developer's local database.
const state = mkdtempSync(join(tmpdir(), 'openfon-e2e-'));
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const migrated = spawnSync(npx, ['wrangler', 'd1', 'migrations', 'apply', 'openfon', '--local', '--persist-to', state], { stdio: 'inherit' });
if (migrated.status !== 0) {
  rmSync(state, { recursive: true, force: true });
  process.exit(migrated.status || 1);
}
const worker = spawn(npx, ['wrangler', 'dev', '--local', '--port', '8790', '--inspector-port', '9232', '--persist-to', state,
  '--var', 'DEFAULT_LLM_API_KEY:local-test-key', '--var', 'DEFAULT_STT_API_KEY:local-test-key',
  '--var', 'AZURE_SPEECH_KEY:local-test-key', '--var', 'REALTIME_API_KEY:local-test-key'], { stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => worker.kill(signal));
worker.on('error', error => { console.error(error.message); rmSync(state, { recursive: true, force: true }); process.exit(1); });
worker.on('exit', code => { rmSync(state, { recursive: true, force: true }); process.exit(code || 0); });
