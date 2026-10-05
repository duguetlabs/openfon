import { configureSdkLogging, SDK_LOG_LEVEL } from './logging.js';
import { UsageOutbox } from './usage-outbox.js';
import { operatorAzureConfig } from './config.js';
import { fileURLToPath } from 'node:url';
import { AgentServer, ServerOptions, initializeLogger } from '@livekit/agents';
for (const key of [
  'LIVEKIT_URL',
  'LIVEKIT_API_KEY',
  'LIVEKIT_API_SECRET',
  'OPENFON_API_URL',
  'OPENFON_AGENT_SERVICE_TOKEN',
  'AZURE_OPENAI_ENDPOINT',
  'AZURE_OPENAI_API_KEY',
  'OPENFON_USAGE_DIR',
])
  if (!process.env[key]) throw new Error('Missing operator setting: ' + key);
if (process.env.LK_OPENAI_DEBUG && process.env.LK_OPENAI_DEBUG !== '0')
  throw new Error('Wire logging must remain disabled');
operatorAzureConfig();
const port = Number(process.env.LIVEKIT_AGENT_PORT ?? '8081');
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error('Invalid LIVEKIT_AGENT_PORT');
configureSdkLogging();
const server = new AgentServer(
  new ServerOptions({
    agent: fileURLToPath(new URL('./worker.js', import.meta.url)),
    agentName: 'openfon-released-web',
    logLevel: SDK_LOG_LEVEL,
    production: true,
    host: '127.0.0.1',
    port,
    wsURL: process.env.LIVEKIT_URL,
    apiKey: process.env.LIVEKIT_API_KEY,
    apiSecret: process.env.LIVEKIT_API_SECRET,
  })
);
const outbox = new UsageOutbox(
  process.env.OPENFON_USAGE_DIR!,
  process.env.OPENFON_API_URL!,
  process.env.OPENFON_AGENT_SERVICE_TOKEN!
);
let replaying = false;
async function replay() {
  if (replaying) return;
  replaying = true;
  try {
    const result = await outbox.replay();
    if (result.pending || result.dead || result.expired)
      console.error(JSON.stringify({ event: 'usage_backlog', ...result }));
  } catch {
    console.error('Usage backlog could not be read');
  } finally {
    replaying = false;
  }
}
await replay();
await outbox.assertAvailable();
const usageTimer = setInterval(() => void replay(), 30000);
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  clearInterval(usageTimer);
  await server.close();
}
process.once('SIGINT', () => {
  void close();
});
process.once('SIGTERM', () => {
  void close();
});
await server.run();
