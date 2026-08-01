import { describe, expect, it } from 'vitest';
import { LlmConfigError, resolveLlm, sameLlmEndpoint, validateLlmBaseUrl } from '../src/providers';
import type { AgentSettings, Env } from '../src/types';

// Only the LLM fields matter here; the rest of Env/AgentSettings is stubbed.
const INSTANCE_KEY = 'instance-key-not-a-real-secret';
const env = {
  DEFAULT_LLM_BASE_URL: 'https://api.kataleptic.com/v1',
  DEFAULT_LLM_MODEL: 'llama-3.3-70b',
  DEFAULT_LLM_API_KEY: INSTANCE_KEY,
} as unknown as Env;

function settings(over: Partial<AgentSettings>): AgentSettings {
  return { llm_base_url: '', llm_api_key: '', llm_model: '', ...over } as AgentSettings;
}

describe('resolveLlm', () => {
  it('uses the instance defaults when the business overrides nothing', () => {
    expect(resolveLlm(env, null)).toEqual({
      baseUrl: 'https://api.kataleptic.com/v1',
      apiKey: INSTANCE_KEY,
      model: 'llama-3.3-70b',
    });
    expect(resolveLlm(env, settings({}))).toEqual({
      baseUrl: 'https://api.kataleptic.com/v1',
      apiKey: INSTANCE_KEY,
      model: 'llama-3.3-70b',
    });
  });

  it('never sends the instance key to a business-chosen endpoint', () => {
    // The exploit: point the agent at your own server, leave the key empty,
    // and the next call used to arrive there with the host's key attached.
    const attacker = settings({ llm_base_url: 'https://attacker.example.com/v1' });
    expect(() => resolveLlm(env, attacker)).toThrow(LlmConfigError);
    try {
      resolveLlm(env, attacker);
    } catch (err) {
      expect(`${err}`).not.toContain(INSTANCE_KEY);
    }
  });

  it('uses the business key with the business endpoint', () => {
    const cfg = resolveLlm(env, settings({ llm_base_url: 'https://api.openai.com/v1', llm_api_key: 'sk-tenant', llm_model: 'gpt-4.1-mini' }));
    expect(cfg).toEqual({ baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-tenant', model: 'gpt-4.1-mini' });
  });

  it('still allows the instance key when the URL is the instance URL', () => {
    // Trailing slash / host casing must not read as a different endpoint.
    const cfg = resolveLlm(env, settings({ llm_base_url: 'https://API.kataleptic.com/v1/' }));
    expect(cfg.apiKey).toBe(INSTANCE_KEY);
    expect(cfg.baseUrl).toBe('https://API.kataleptic.com/v1/');
  });

  it('treats credentials on the instance host as a custom endpoint, and rejects it', () => {
    // "https://user:pass@<instance host>/v1" must not normalize equal to the
    // clean instance URL — that would skip the credential check entirely and
    // hand the instance key to a URL carrying someone else's basic auth.
    const sneaky = settings({ llm_base_url: 'https://user:pass@api.kataleptic.com/v1' });
    expect(() => resolveLlm(env, sneaky)).toThrow(/credentials/);
    try {
      resolveLlm(env, sneaky);
    } catch (err) {
      expect(`${err}`).not.toContain(INSTANCE_KEY);
    }
  });

  it('overrides the model alone without touching the endpoint or key', () => {
    const cfg = resolveLlm(env, settings({ llm_model: 'mixtral' }));
    expect(cfg).toEqual({ baseUrl: 'https://api.kataleptic.com/v1', apiKey: INSTANCE_KEY, model: 'mixtral' });
  });

  it('rejects a stored endpoint that the write path would refuse today', () => {
    // Rows predating the validator (or edited straight in D1) get re-checked.
    const legacy = settings({ llm_base_url: 'http://169.254.169.254/latest', llm_api_key: 'sk-tenant' });
    expect(() => resolveLlm(env, legacy)).toThrow(LlmConfigError);
  });

  it('honours ALLOWED_LLM_HOSTS at call time', () => {
    const locked = { ...env, ALLOWED_LLM_HOSTS: 'api.openai.com' } as Env;
    const allowed = settings({ llm_base_url: 'https://api.openai.com/v1', llm_api_key: 'sk-tenant' });
    const denied = settings({ llm_base_url: 'https://api.groq.com/openai/v1', llm_api_key: 'sk-tenant' });
    expect(resolveLlm(locked, allowed).baseUrl).toBe('https://api.openai.com/v1');
    expect(() => resolveLlm(locked, denied)).toThrow(LlmConfigError);
  });
});

describe('validateLlmBaseUrl', () => {
  it('accepts ordinary public https endpoints', () => {
    expect(validateLlmBaseUrl('https://api.openai.com/v1')).toBeNull();
    expect(validateLlmBaseUrl(' https://llm.example.co.uk:8443/openai/v1 ')).toBeNull();
  });

  it('requires https', () => {
    expect(validateLlmBaseUrl('http://api.example.com/v1')).toMatch(/https/);
  });

  it('rejects anything that is not an absolute URL', () => {
    expect(validateLlmBaseUrl('api.example.com/v1')).toMatch(/absolute URL/);
    expect(validateLlmBaseUrl('')).toMatch(/absolute URL/);
    expect(validateLlmBaseUrl('/v1')).toMatch(/absolute URL/);
  });

  it('rejects credentials embedded in the URL', () => {
    expect(validateLlmBaseUrl('https://user:pass@api.example.com/v1')).toMatch(/credentials/);
    expect(validateLlmBaseUrl('https://token@api.example.com/v1')).toMatch(/credentials/);
    // Allowlisting the host does not excuse them.
    expect(validateLlmBaseUrl('https://user:pass@api.openai.com/v1', 'api.openai.com')).toMatch(/credentials/);
  });

  it('rejects schemes fetch cannot speak, allowlisted or not', () => {
    expect(validateLlmBaseUrl('ftp://api.example.com/v1')).toMatch(/http\(s\)/);
    expect(validateLlmBaseUrl('ftp://api.openai.com/v1', 'api.openai.com')).toMatch(/http\(s\)/);
    expect(validateLlmBaseUrl('htt://api.openai.com/v1', 'api.openai.com')).toMatch(/http\(s\)/);
  });

  it('rejects loopback, private, and link-local literals', () => {
    const urls = [
      'https://localhost/v1',
      'https://api.localhost/v1',
      'https://127.0.0.1/v1',
      'https://10.0.0.5/v1',
      'https://172.16.4.4/v1',
      'https://192.168.1.1/v1',
      'https://169.254.169.254/latest/meta-data', // cloud metadata
      'https://100.64.0.1/v1',
      'https://0.0.0.0/v1',
      'https://[::1]/v1',
      'https://[fd00::1]/v1',
      'https://[fe80::1]/v1',
      'https://[::ffff:127.0.0.1]/v1',
      'https://redis.internal/v1',
    ];
    for (const url of urls) {
      expect(`${url} -> ${validateLlmBaseUrl(url)}`).toMatch(/loopback, private, or link-local/);
    }
  });

  it('sees through obfuscated IPv4 forms', () => {
    // The URL parser normalizes these to 127.0.0.1 before we inspect them.
    expect(validateLlmBaseUrl('https://2130706433/v1')).toMatch(/loopback/);
    expect(validateLlmBaseUrl('https://0x7f.0x0.0x0.0x1/v1')).toMatch(/loopback/);
  });

  it('narrows to ALLOWED_LLM_HOSTS when the operator sets one', () => {
    expect(validateLlmBaseUrl('https://api.openai.com/v1', 'api.openai.com, api.groq.com')).toBeNull();
    expect(validateLlmBaseUrl('https://api.mistral.ai/v1', 'api.openai.com')).toMatch(/not permitted/);
    // Listing a host is the operator's own call, so it also covers the local
    // model case that would otherwise fail the https/loopback rules.
    expect(validateLlmBaseUrl('http://localhost:11434/v1', 'localhost')).toBeNull();
  });
});

describe('sameLlmEndpoint', () => {
  it('ignores trailing slashes and host casing', () => {
    expect(sameLlmEndpoint('https://api.example.com/v1', 'https://API.example.com/v1/')).toBe(true);
    expect(sameLlmEndpoint('https://api.example.com/v1', 'https://api.example.com/v2')).toBe(false);
    expect(sameLlmEndpoint('https://api.example.com/v1', 'http://api.example.com/v1')).toBe(false);
  });

  it('keeps embedded credentials in the comparison', () => {
    expect(sameLlmEndpoint('https://user:pass@api.example.com/v1', 'https://api.example.com/v1')).toBe(false);
    expect(sameLlmEndpoint('https://token@api.example.com/v1', 'https://api.example.com/v1')).toBe(false);
  });
});
