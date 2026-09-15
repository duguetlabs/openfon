import { describe, expect, it } from 'vitest';
import type { Assistant } from '../web/src/api';
import { compatibilityAssistant, compatibilitySetupPending, studioSetupPending } from '../web/src/session-gate';

function assistant(publicSlug: string, state: Assistant['state']): Assistant {
  return { public_slug: publicSlug, state, name: 'Alex', persona: 'Friendly', language: 'en' } as Assistant;
}

describe('compatibility UI setup gate', () => {
  it('keeps complete draft essentials in onboarding until the primary assistant is active', () => {
    const business = { slug: 'primary-link' };
    const primary = assistant('primary-link', 'draft');

    expect(compatibilitySetupPending(business, true, true, primary)).toBe(true);
    expect(compatibilitySetupPending(business, true, true, { ...primary, state: 'active' })).toBe(false);
  });

  it('does not let an active secondary assistant advertise the draft primary link', () => {
    const business = { slug: 'primary-link' };
    const primary = assistant('primary-link', 'draft');
    const secondary = assistant('secondary-link', 'active');
    const selected = compatibilityAssistant(business, [secondary, primary]);

    expect(selected).toBe(primary);
    expect(compatibilitySetupPending(business, true, true, selected)).toBe(true);
  });

  it('keeps a paused primary in the activation-capable onboarding path', () => {
    expect(compatibilitySetupPending({ slug: 'primary-link' }, true, true, assistant('primary-link', 'paused'))).toBe(true);
  });
});


describe('studio setup gate', () => {
  it('allows draft and paused assistants without publishing their public line', () => {
    for (const state of ['draft', 'paused', 'active'] as const) {
      expect(studioSetupPending({ slug: 'primary' }, true, assistant('primary', state))).toBe(false);
    }
  });
  it('resumes setup when a partial workspace has an unnamed draft', () => {
    expect(studioSetupPending({ slug: 'primary' }, true, { ...assistant('primary', 'draft'), name: '' })).toBe(true);
  });
  it('still requires the workspace and first assistant to exist', () => {
    expect(studioSetupPending(null, true, assistant('primary', 'active'))).toBe(true);
    expect(studioSetupPending({ slug: 'primary' }, false, assistant('primary', 'active'))).toBe(true);
    expect(studioSetupPending({ slug: 'primary' }, true, null)).toBe(true);
  });
});
