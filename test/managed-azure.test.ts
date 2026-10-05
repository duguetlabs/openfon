import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  azureConfig,
  managedVoice,
  savedManagedVoice,
  managedVoiceCatalog,
} from '../src/managed-azure';
import { resolveSummary } from '../src/summary-settings';
import {
  azureTextMetrics,
  processManagedCall,
} from '../src/managed-processing';
import { buildSystemPrompt } from '../src/prompt';
import type { Env, Business, AgentSettings } from '../src/types';
const env = {
  OPENFON_MANAGED_WEB: 'true',
  AZURE_OPENAI_ENDPOINT: 'https://fixture.cognitiveservices.azure.com/',
  AZURE_OPENAI_API_KEY: 'fixture-key',
} as Env;
afterEach(() => vi.unstubAllGlobals());
describe('managed Azure routing and context', () => {
  it('forces operator-only endpoint/key independent of legacy workspace settings', () => {
    const result = resolveSummary(
      env,
      {
        mode: 'custom',
        base_url: 'https://customer.example',
        api_key: 'customer-key',
        model: 'customer-model',
        revision: 'r',
      },
      null,
      null
    );
    expect(result).toEqual({
      baseUrl: 'https://fixture.cognitiveservices.azure.com/openai/v1',
      apiKey: 'fixture-key',
      model: 'gpt-5.4-mini',
    });
    expect(() =>
      azureConfig({
        ...env,
        AZURE_OPENAI_API_KEY: undefined,
        DEFAULT_LLM_API_KEY: 'legacy-key',
      })
    ).toThrow();
    for (const endpoint of [
      'https://fixture.openai.azure.com.evil.test/',
      'http://fixture.openai.azure.com/',
      'https://fixture.openai.azure.com/?api-key=x',
      'https://u:p@fixture.openai.azure.com/',
    ])
      expect(() =>
        azureConfig({ ...env, AZURE_OPENAI_ENDPOINT: endpoint })
      ).toThrow();
  });
  it('offers friendly compatible voices with no provider/model/endpoint metadata', () => {
    const catalog = managedVoiceCatalog();
    expect(catalog.voices).toHaveLength(19);
    expect(catalog.voices.find((v) => v.id === 'marin')).toEqual({
      id: 'marin',
      label: 'Marin',
    });
    expect(Object.keys(catalog)).toEqual(['voices', 'defaultVoice']);
    expect(() => managedVoice('invented')).toThrow();
  });
  it.each([' ', 'azure-only'])('rejects a nonempty incompatible saved voice %j', async voice => {
    const {managedBrowserSettings}=await import('../src/livekit-settings');
    expect(()=>managedVoice(voice)).toThrow('Choose an available voice');
    expect(()=>managedBrowserSettings(env,{engine:'pipeline',realtime_voice:'',voice} as AgentSettings)).toThrow('Choose an available voice');
  });
  it('preserves the released Marin default for both blank saved fields without accepting blank input', async () => {
    const {managedBrowserSettings}=await import('../src/livekit-settings');
    const saved={engine:'pipeline',realtime_voice:'',voice:''} as AgentSettings;
    expect(savedManagedVoice(saved)).toBe('marin');
    expect(managedBrowserSettings(env,saved).realtime_voice).toBe('marin');
    expect(saved).toEqual({engine:'pipeline',realtime_voice:'',voice:''});
    expect(()=>managedVoice('')).toThrow('Choose an available voice');
  });
  it('preserves compatible legacy voice meaning and leaves nonmanaged default behavior intact', async () => {
    const {managedBrowserSettings}=await import('../src/livekit-settings');
    const saved={engine:'pipeline',realtime_voice:'',voice:'cedar'} as AgentSettings;
    expect(managedBrowserSettings(env,saved).realtime_voice).toBe('cedar');
    expect(saved.voice).toBe('cedar');expect(saved.realtime_voice).toBe('');
    expect(managedBrowserSettings({...env,OPENFON_MANAGED_WEB:'false',REALTIME_API_KEY:'synthetic'}, {...saved,voice:''}).realtime_voice).toBe('marin');
  });
  it('separates business facts and inherited responsibilities from assistant overrides and enforced restrictions', () => {
    const business = {
      name: 'Practice',
      description: 'Fact',
      timezone: 'Europe/Vienna',
      hours_json: '[]',
      services_json: '[]',
      faqs_json: '[]',
      closures_json: '[]',
      default_language: 'de',
      contact_email: 'contact@example.test',
      shared_instructions: 'Escalate emergencies',
    } as Business;
    const settings = {
      agent_name: 'Anna',
      language: '',
      persona: 'warm',
      custom_instructions: 'Handle callbacks',
    } as AgentSettings;
    const prompt = buildSystemPrompt(
      business,
      settings,
      new Date('2026-10-05T00:00:00Z')
    );
    expect(prompt).toContain('Email: contact@example.test');
    expect(prompt).toContain('Escalate emergencies');
    expect(prompt).toContain('ASSISTANT-SPECIFIC INSTRUCTIONS');
    expect(prompt).toContain('never these restrictions');
    expect(prompt).toContain('use German');
  });
  it('records provider token units without adding subsets to totals', () => {
    expect(
      azureTextMetrics({
        input_tokens: 20,
        input_tokens_details: { cached_tokens: 5 },
        output_tokens: 8,
        output_tokens_details: { reasoning_tokens: 3 },
        total_tokens: 28,
      })
    ).toEqual({
      inputTokens: 20,
      cachedInputTokens: 5,
      outputTokens: 8,
      reasoningTokens: 3,
      totalTokens: 28,
    });
    expect(azureTextMetrics({ input_tokens: NaN, output_tokens: -1 })).toEqual(
      {}
    );
  });
  it('direct Responses extraction uses caller evidence IDs and stable identities regardless of array order', async () => {
    const actions = [
      { kind: 'callback', source_turn_id: '1', content: 'Call back' },
    ];
    const fetch = vi.fn(async (_url: unknown, options: RequestInit) => {
      expect(_url).toBe(
        'https://fixture.cognitiveservices.azure.com/openai/v1/responses'
      );
      expect(options.headers).toEqual({
        'api-key': 'fixture-key',
        'Content-Type': 'application/json',
      });
      expect(options.redirect).toBe('manual');
      return Response.json({
        id: 'resp_1',
        model: 'gpt-5.4-mini',
        status: 'completed',
        usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
        output: [
          {
            type: 'message',
            content: [
              {
                type: 'output_text',
                text: JSON.stringify({
                  summary: 'Callback requested',
                  actions,
                }),
              },
            ],
          },
        ],
      });
    });
    vi.stubGlobal('fetch', fetch);
    const turns = [{ id: '1', role: 'caller', text: 'Please call me back' }];
    const first = await processManagedCall(env, turns, 'en');
    actions.reverse();
    const second = await processManagedCall(env, turns, 'en');
    expect(first.actions).toHaveLength(1);
    expect(first.actions).toEqual(second.actions);
    expect(first.actions[0]!.source_key).toMatch(/^[a-f0-9]{64}_callback$/);
  });
  it('retains usage for incomplete reasoning instead of inventing a summary', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          id: 'resp_incomplete',
          model: 'gpt-5.4-mini',
          status: 'incomplete',
          usage: { input_tokens: 9, output_tokens: 1400 },
          output: [],
        })
      )
    );
    const result = await processManagedCall(
      env,
      [{ id: 't', role: 'caller', text: 'Hello' }],
      'en'
    );
    expect(result.processingFailed).toBe(true);
    expect(result.summary).toBeNull();
    expect(result.actions).toEqual([]);
    expect(result.usage.outputTokens).toBe(1400);
  });
});
describe('partial extraction is not a complete action snapshot', () => {
  it.each([
    undefined,
    [{ kind: 'todo', source_turn_id: '99', content: 'Unsupported source' }],
    [{ kind: 'todo', source_turn_id: '1', content: '' }],
  ])('preserves usage and rejects malformed actions %j', async (actions) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          id: 'resp_partial',
          model: 'gpt-5.4-mini',
          status: 'completed',
          usage: { input_tokens: 7 },
          output: [
            {
              type: 'message',
              content: [
                {
                  type: 'output_text',
                  text: JSON.stringify({ summary: 'Partial', actions }),
                },
              ],
            },
          ],
        })
      )
    );
    const result = await processManagedCall(
      env,
      [{ id: '1', role: 'caller', text: 'Please call back' }],
      'en'
    );
    expect(result.processingFailed).toBe(true);
    expect(result.actions).toEqual([]);
    expect(result.usage.inputTokens).toBe(7);
  });
});
it('preserves several distinct same-kind actions from one caller turn with valid bounded keys', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({
        id: 'resp_multiple',
        model: 'gpt-5.4-mini',
        status: 'completed',
        usage: { input_tokens: 7 },
        output: [
          {
            type: 'message',
            content: [
              {
                type: 'output_text',
                text: JSON.stringify({
                  summary: 'Two requests',
                  actions: [
                    {
                      kind: 'booking_request',
                      source_turn_id: '1',
                      content: 'Appointment for Alice',
                    },
                    {
                      kind: 'booking_request',
                      source_turn_id: '1',
                      content: 'Appointment for Bob',
                    },
                  ],
                }),
              },
            ],
          },
        ],
      })
    )
  );
  const result = await processManagedCall(
    env,
    [
      {
        id: '1',
        role: 'caller',
        text: 'I need appointments for Alice and Bob',
      },
    ],
    'en'
  );
  expect(result.processingFailed).toBeUndefined();
  expect(result.actions).toHaveLength(2);
  for (const action of result.actions) {
    expect(action.source_turn_id).toBe(1);
    expect(action.source_key).toMatch(/^[a-z0-9_-]{1,80}$/);
  }
});
