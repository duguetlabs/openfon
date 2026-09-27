import { describe, expect, it } from 'vitest';
import { distinctModelRoutes, katalepticRoute, KATALEPTIC_ROUTING, REALTIME_BACKENDS } from '../src/backend-registry';
import { gptLiveConnection, realtimeConnection, resolveRealtime } from '../src/realtime-providers';
import type { AgentSettings, Env } from '../src/types';

describe('backend identity and route boundaries', () => {
  const native = KATALEPTIC_ROUTING.routes.filter(route => route.voiceRenderer === 'native-model');
  it('separates four verified Azure model identities, with explicit snapshot limits', () => {
    expect(native.map(route => [route.requestedModel, route.upstreamModel])).toEqual([
      ['gpt-realtime-2', 'gpt-realtime-2'], ['gpt-realtime-2.1', 'gpt-realtime-2.1'],
      ['gpt-realtime-2.1-mini', 'gpt-realtime-2.1-mini'], ['gpt-live-1', 'gpt-live-1'],
    ]);
    expect(distinctModelRoutes(native)).toEqual({ distinct: true, collisions: [], unverified: [] });
    expect(KATALEPTIC_ROUTING.routes.every(route => route.liveSessionVerified === false)).toBe(true);
    expect(distinctModelRoutes(KATALEPTIC_ROUTING.routes)).toMatchObject({ distinct: false, unverified: ['kataleptic-realtime-hd'] });
  });
  it('detects different aliases, deployment names and versions collapsing onto the same model', () => {
    const collision = { ...native[1], upstreamModel: native[0].upstreamModel, upstreamVersion: 'another-version', upstreamDeployment: 'different-deployment' };
    expect(distinctModelRoutes([native[0], collision])).toEqual({ distinct: false, collisions: [['gpt-realtime-2', 'gpt-realtime-2.1']], unverified: [] });
    expect(distinctModelRoutes([{ ...native[0], upstreamVersion: null }, native[1]])).toMatchObject({ distinct: false, unverified: ['gpt-realtime-2'] });
  });
  it.each(['wss://other.example/v1/realtime', 'wss://api.kataleptic.com/v1/realtime?engine=voicelive', 'wss://api.kataleptic.com:8443/v1/realtime', 'ws://api.kataleptic.com/v1/realtime', 'wss://api.kataleptic.com/other'])('does not lend public gateway evidence to %s', endpoint => {
    expect(katalepticRoute(endpoint, 'gpt-realtime-2')).toBeNull();
  });
  it('returns only known model evidence on the exact public gateway', () => {
    expect(katalepticRoute(KATALEPTIC_ROUTING.endpoint, 'gpt-realtime-2')).toBe(native[0]);
    expect(katalepticRoute(KATALEPTIC_ROUTING.endpoint, 'unknown')).toBeNull();
  });
  it.each(native)('preserves $requestedModel to its own adapter transport', route => {
    const env = { REALTIME_BASE_URL: REALTIME_BACKENDS.kataleptic.defaultUrl, REALTIME_MODEL: 'kataleptic-realtime-hd', REALTIME_API_KEY: 'fixture-key' } as Env;
    const cfg = resolveRealtime(env, { realtime_model: route.requestedModel } as AgentSettings);
    expect(cfg.model).toBe(route.requestedModel);
    if (route.requestedModel === 'gpt-live-1') {
      expect(new URL(gptLiveConnection(cfg).url).pathname).toBe('/v1/live/sessions');
    } else {
      expect(new URL(realtimeConnection(cfg).url).searchParams.get('model')).toBe(route.requestedModel);
    }
  });
});
