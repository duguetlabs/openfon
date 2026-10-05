import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import { initializeLogger } from '@livekit/agents';
import { realtime } from '@livekit/agents-plugin-openai';
initializeLogger({ pretty: false, level: 'error' });
test('pinned SDK opens direct Azure path with api-key only and unchanged GPT-Live session protocol', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  let headers: Record<string, unknown> | undefined,
    path: string | undefined,
    start: Record<string, unknown> | undefined;
  server.on('connection', (socket, request) => {
    headers = request.headers;
    path = request.url;
    socket.on('message', (raw) => {
      const event = JSON.parse(raw.toString());
      if (event.type === 'session.start') {
        start = event;
        socket.send(
          JSON.stringify({
            type: 'session.started',
            session: { id: 'session_synthetic' },
          })
        );
      }
      if (event.type === 'session.close')
        socket.send(
          JSON.stringify({ type: 'session.closed', usage: { seconds: 0 } })
        );
    });
  });
  const model = new realtime.GPTLiveModel({
    baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/openai/v1`,
    apiKey: 'synthetic',
    apiKeyHeader: 'api-key',
    connOptions: { timeoutMs: 1000, maxRetry: 0, retryIntervalMs: 1 },
  });
  const session = model.session();
  session.on('error', () => {});
  try {
    await session._updateSession();
    for (let i = 0; i < 100 && !session.sessionId; i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(session.sessionId, 'session_synthetic');
    assert.equal(headers?.['api-key'], 'synthetic');
    assert.equal(headers?.authorization, undefined);
    assert.equal(path, '/openai/v1/live/sessions');
    assert.equal(start?.type, 'session.start');
  } finally {
    await session.close();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await model.close();
  }
});
