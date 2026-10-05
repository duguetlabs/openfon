import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AzureUsageCapture, type UsageObservation } from '../src/usage.js';
import { operatorAzureConfig, modelOptions } from '../src/config.js';
test('operator connection admits only Azure TLS resource roots with api-key authentication', () => {
  const env = {
    AZURE_OPENAI_ENDPOINT: 'https://fixture.cognitiveservices.azure.com/',
    AZURE_OPENAI_API_KEY: 'synthetic',
  };
  const config = operatorAzureConfig(env);
  assert.equal(
    config.baseURL,
    'https://fixture.cognitiveservices.azure.com/openai/v1'
  );
  assert.equal(config.apiKeyHeader, 'api-key');
  for (const url of [
    'http://fixture.openai.azure.com',
    'https://fixture.openai.azure.com.evil.test',
    'https://fixture.openai.azure.com/path',
    'https://u:p@fixture.openai.azure.com',
    'https://fixture.openai.azure.com?key=x',
  ])
    assert.throws(() =>
      operatorAzureConfig({ ...env, AZURE_OPENAI_ENDPOINT: url })
    );
  assert.throws(() =>
    operatorAzureConfig({
      ...env,
      AZURE_OPENAI_LIVE_DEPLOYMENT: 'gpt-realtime-2',
    })
  );
});
test('voice usage remains cumulative, deterministic and distinct from delegated tokens', async () => {
  const sent: UsageObservation[] = [];
  const capture = new AzureUsageCapture(
    'call',
    'job',
    async (o) => {
      sent.push(o);
    },
    () => assert.fail('unexpected failure')
  );
  capture.observe({ type: 'session.started', session: { id: 'sess_1' } });
  for (const seconds of [1.2, 1.2, 3.5])
    capture.observe({ type: 'session.usage.updated', usage: { seconds } });
  capture.observe({
    type: 'response.event',
    event: {
      type: 'response.completed',
      response: {
        id: 'resp_1',
        model: 'gpt-5.4-mini',
        usage: {
          input_tokens: 10,
          input_tokens_details: { cached_tokens: 4 },
          output_tokens: 3,
          output_tokens_details: { reasoning_tokens: 2 },
          total_tokens: 13,
        },
      },
    },
  });
  capture.observe({ type: 'session.closed', usage: { seconds: 4.1 } });
  await capture.flush();
  assert.deepEqual(
    sent
      .filter((s) => s.source === 'azure_voice')
      .map((s) => s.metrics.voiceSessionSeconds),
    ['1.2', '3.5', '4.1']
  );
  assert.equal(sent.length, 4);
  assert.deepEqual(sent[2]!.metrics, {
    inputTokens: 10,
    cachedInputTokens: 4,
    outputTokens: 3,
    reasoningTokens: 2,
    totalTokens: 13,
  });
  assert.equal(sent[2]!.providerResponseId, 'resp_1');
  assert.equal(sent[3]!.final, true);
  assert.ok(!JSON.stringify(sent).includes('api-key'));
});
test('missing terminal usage remains unknown and failures are surfaced', async () => {
  const sent: UsageObservation[] = [];
  let failures = 0;
  const capture = new AzureUsageCapture(
    'call',
    'job',
    async (o) => {
      sent.push(o);
    },
    () => failures++
  );
  capture.observe({ type: 'session.started', session: { id: 's' } });
  capture.observe({ type: 'session.closed' });
  await capture.flush();
  assert.deepEqual(sent[0]!.metrics, {});
  assert.equal(sent[0]!.final, true);
  const failed = new AzureUsageCapture(
    'call',
    'job',
    async () => {
      throw Error('unavailable');
    },
    () => failures++
  );
  failed.observe({ type: 'session.started', session: { id: 's' } });
  failed.observe({ type: 'session.closed', usage: { seconds: NaN } });
  await assert.rejects(() => failed.flush());
  assert.equal(failures, 1);
});
test('transport ending without final usage records unknown, and late or repeated final snapshots remain distinct and deduplicated', async () => {
  const sent: UsageObservation[] = [];
  const capture = new AzureUsageCapture(
    'call',
    'job',
    async (o) => {
      sent.push(o);
    },
    () => assert.fail()
  );
  capture.observe({ type: 'session.started', session: { id: 's' } });
  capture.finish();
  capture.finish();
  await capture.flush();
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.final, false);
  assert.deepEqual(sent[0]!.metrics, {});
  capture.observe({ type: 'session.closed', usage: { seconds: 3.125 } });
  capture.observe({ type: 'session.closed', usage: { seconds: 3.125 } });
  capture.finish();
  await capture.flush();
  assert.equal(sent.length, 2);
  assert.equal(sent[1]!.final, true);
  assert.equal(sent[1]!.metrics.voiceSessionSeconds, '3.125');
});
