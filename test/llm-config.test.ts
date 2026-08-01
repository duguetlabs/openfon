import { afterEach, describe, expect, it, vi } from 'vitest';
import { chatComplete, LlmConfigError, resolveLlm, sameLlmEndpoint, validateLlmBaseUrl } from '../src/providers';
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
    // …and the URL that comes back is the operator's, not the stored spelling.
    expect(cfg.baseUrl).toBe('https://api.kataleptic.com/v1');
  });

  it('returns the instance URL verbatim whenever it lends the instance key', () => {
    // sameLlmEndpoint is a normalizer, and no normalizer is injective — this
    // IPv6 pair collides, because stripping the brackets makes the port
    // indistinguishable from a final hextet. The instance key must still be
    // unable to leave the operator's own URL, so the check being fooled costs
    // the business its custom endpoint and nothing else.
    const v6 = { ...env, DEFAULT_LLM_BASE_URL: 'https://[2001:db8::1]:8443/v1' } as Env;
    const collides = settings({ llm_base_url: 'https://[2001:db8::1:8443]/v1' });
    expect(sameLlmEndpoint('https://[2001:db8::1]:8443/v1', 'https://[2001:db8::1:8443]/v1')).toBe(true);
    const cfg = resolveLlm(v6, collides);
    expect(cfg.apiKey).toBe(INSTANCE_KEY);
    expect(cfg.baseUrl).toBe('https://[2001:db8::1]:8443/v1');
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

  it('does not lend the instance key to a re-routed query string', () => {
    // A gateway that routes on the query is still a different endpoint: with
    // the default pointing at ?target=trusted, ?target=attacker must not
    // inherit the instance key and have the gateway forward it onward.
    const gateway = { ...env, DEFAULT_LLM_BASE_URL: 'https://gw.example.com/v1?target=trusted' } as Env;
    const rerouted = settings({ llm_base_url: 'https://gw.example.com/v1?target=attacker' });
    expect(() => resolveLlm(gateway, rerouted)).toThrow(LlmConfigError);
    expect(resolveLlm(gateway, settings({ llm_base_url: 'https://gw.example.com/v1?target=trusted' })).apiKey).toBe(INSTANCE_KEY);
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

  it('sees through the DNS root dot', () => {
    // "localhost." is the same host as "localhost" to any resolver.
    expect(validateLlmBaseUrl('https://localhost./v1')).toMatch(/loopback/);
    expect(validateLlmBaseUrl('https://foo.internal./v1')).toMatch(/loopback/);
    expect(validateLlmBaseUrl('https://foo.localhost./v1')).toMatch(/loopback/);
    expect(validateLlmBaseUrl('https://127.0.0.1./v1')).toMatch(/loopback/);
    // …and it cuts the other way too: an allowlisted host stays allowlisted.
    expect(validateLlmBaseUrl('https://api.openai.com./v1', 'api.openai.com')).toBeNull();
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

  it('matches allowlist entries an operator would plausibly write', () => {
    // url.hostname is always punycode, so a unicode entry has to be parsed
    // the same way or the operator's intended host can never match.
    expect(validateLlmBaseUrl('https://bücher.example/v1', 'bücher.example')).toBeNull();
    expect(validateLlmBaseUrl('https://xn--bcher-kva.example/v1', 'bücher.example')).toBeNull();
    expect(validateLlmBaseUrl('https://bücher.example/v1', 'xn--bcher-kva.example')).toBeNull();
    // A scheme, a port, or a stray root dot in the entry is tolerated too.
    expect(validateLlmBaseUrl('https://api.openai.com/v1', 'https://api.openai.com')).toBeNull();
    expect(validateLlmBaseUrl('http://localhost:11434/v1', 'localhost:11434')).toBeNull();
    expect(validateLlmBaseUrl('https://api.openai.com/v1', 'api.openai.com.')).toBeNull();
    // …and none of that widens the list.
    expect(validateLlmBaseUrl('https://evil.example/v1', 'bücher.example')).toMatch(/not permitted/);
  });
});

describe('chatComplete', () => {
  const cfg = { baseUrl: 'https://api.example.com/v1', apiKey: 'sk-tenant', model: 'm' };
  afterEach(() => vi.unstubAllGlobals());

  it('does not follow redirects, so the validated URL is the one that gets called', async () => {
    // The endpoint checks only ever see the saved URL; following a 302 would
    // let a host that passed them hand the request to an internal address.
    const fetchStub = vi.fn(async () => new Response('', { status: 302, headers: { location: 'http://169.254.169.254/' } }));
    vi.stubGlobal('fetch', fetchStub);
    await expect(chatComplete(cfg, [{ role: 'user', content: 'hi' }])).rejects.toThrow(/redirects are not followed/);
    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect((fetchStub.mock.calls[0] as unknown as [string, RequestInit])[1].redirect).toBe('manual');
  });

  it('builds the request path without a doubled slash', async () => {
    // "…/v1/" used to work only because providers 301 the doubled slash and
    // fetch followed; with redirects off that would be a hard failure.
    const fetchStub = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchStub);
    await chatComplete({ ...cfg, baseUrl: 'https://api.example.com/v1/' }, [{ role: 'user', content: 'hi' }]);
    expect(fetchStub.mock.calls[0][0]).toBe('https://api.example.com/v1/chat/completions');
  });

  it('still reads an ordinary completion', async () => {
    const body = JSON.stringify({ choices: [{ message: { content: 'Good morning.' } }] });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 200 })));
    await expect(chatComplete(cfg, [{ role: 'user', content: 'hi' }])).resolves.toBe('Good morning.');
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

  it('keeps the query string in the comparison, verbatim', () => {
    expect(sameLlmEndpoint('https://gw.example.com/v1?target=a', 'https://gw.example.com/v1?target=b')).toBe(false);
    expect(sameLlmEndpoint('https://gw.example.com/v1', 'https://gw.example.com/v1?target=b')).toBe(false);
    expect(sameLlmEndpoint('https://gw.example.com/v1?a=1&b=2', 'https://gw.example.com/v1?a=1&b=2')).toBe(true);
    // Reordered parameters read as a different endpoint — the safe direction.
    expect(sameLlmEndpoint('https://gw.example.com/v1?a=1&b=2', 'https://gw.example.com/v1?b=2&a=1')).toBe(false);
  });

  it('ignores the DNS root dot and the fragment', () => {
    expect(sameLlmEndpoint('https://api.example.com./v1', 'https://api.example.com/v1')).toBe(true);
    expect(sameLlmEndpoint('https://api.example.com:8443/v1', 'https://api.example.com.:8443/v1')).toBe(true);
    // fetch never sends a fragment, so it cannot change where the call lands.
    expect(sameLlmEndpoint('https://api.example.com/v1#x', 'https://api.example.com/v1')).toBe(true);
  });
});
