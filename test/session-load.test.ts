import { describe, expect, it, vi } from 'vitest';
import type { Assistant, Bootstrap, Business, Me } from '../web/src/api';
import {
  authSubmissionBlocked,
  CompatibilitySessionCoordinator,
  loadCompatibilitySession,
  SIGN_OUT_UNCONFIRMED_MESSAGE,
  type CompatibilitySessionSnapshot,
} from '../web/src/session-load';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function snapshot(id: string): CompatibilitySessionSnapshot {
  return {
    me: { id, email: `${id}@example.test` },
    business: { id: `workspace-${id}`, slug: `line-${id}` } as Business,
    workspaceReady: true,
    firstAssistant: { id: `assistant-${id}`, public_slug: `line-${id}`, state: 'active' } as Assistant,
    firstAssistantReady: true,
  };
}

describe('compatibility session loading', () => {
  it('does not expose a signed-in snapshot before business and bootstrap recovery finish', async () => {
    const business = { id: 'workspace-1', slug: 'primary-link' } as Business;
    const primary = { id: 'assistant-1', public_slug: 'primary-link', state: 'draft' } as Assistant;
    const pendingBusiness = deferred<Business | null>();
    const pendingBootstrap = deferred<Bootstrap>();
    const client = {
      me: vi.fn(async () => ({ id: 'owner-1', email: 'owner@example.test' }) satisfies Me),
      business: vi.fn(() => pendingBusiness.promise),
      bootstrap: vi.fn(() => pendingBootstrap.promise),
    };

    let published: Awaited<ReturnType<typeof loadCompatibilitySession>> | undefined;
    const loading = loadCompatibilitySession(client).then((snapshot) => {
      published = snapshot;
      return snapshot;
    });
    await vi.waitFor(() => expect(client.business).toHaveBeenCalledOnce());

    expect(published).toBeUndefined();
    expect(client.bootstrap).not.toHaveBeenCalled();

    pendingBusiness.resolve(business);
    await vi.waitFor(() => expect(client.bootstrap).toHaveBeenCalledOnce());
    expect(published).toBeUndefined();

    pendingBootstrap.resolve({
      account: { id: 'owner-1', email: 'owner@example.test' },
      workspace: business,
      assistants: [primary],
      setup: { account: true, workspace: true, firstAssistant: true, firstTest: false },
      readiness: { providerConfigured: false, liveAssistantCount: 0 },
    });

    await expect(loading).resolves.toMatchObject({
      me: { id: 'owner-1' },
      business,
      workspaceReady: true,
      firstAssistant: primary,
      firstAssistantReady: true,
    });
  });

  it('lets only the newest overlapping refresh publish or clear session state', async () => {
    const coordinator = new CompatibilitySessionCoordinator();
    const first = deferred<CompatibilitySessionSnapshot>();
    const second = deferred<CompatibilitySessionSnapshot>();
    const publish = vi.fn();
    const clear = vi.fn();

    const firstRun = coordinator.refresh(() => first.promise, publish, clear);
    const secondRun = coordinator.refresh(() => second.promise, publish, clear);

    first.reject(new Error('stale request failed'));
    await firstRun;
    expect(clear).not.toHaveBeenCalled();

    second.resolve(snapshot('newest'));
    await secondRun;
    expect(publish).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ me: expect.objectContaining({ id: 'newest' }) }));

    const third = deferred<CompatibilitySessionSnapshot>();
    const fourth = deferred<CompatibilitySessionSnapshot>();
    const thirdRun = coordinator.refresh(() => third.promise, publish, clear);
    const fourthRun = coordinator.refresh(() => fourth.promise, publish, clear);
    fourth.resolve(snapshot('latest-again'));
    await fourthRun;
    third.resolve(snapshot('stale-success'));
    await thirdRun;

    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenLastCalledWith(
      expect.objectContaining({ me: expect.objectContaining({ id: 'latest-again' }) })
    );
    expect(clear).not.toHaveBeenCalled();
  });

  it('keeps an accessible warning after rejected logout and clears it only after a confirmed retry', async () => {
    const coordinator = new CompatibilitySessionCoordinator();
    const pendingRefresh = deferred<CompatibilitySessionSnapshot>();
    const pendingRetry = deferred<unknown>();
    const publish = vi.fn();
    let privateSession: CompatibilitySessionSnapshot | null = snapshot('private');
    let warning: string | null = null;
    const clearLocal = vi.fn(() => {
      privateSession = null;
    });
    const failedLogout = vi.fn(async () => {
      expect(privateSession).toBeNull();
      throw new Error('network unavailable');
    });
    const callbacks = {
      clearLocal,
      confirmed: vi.fn(() => {
        warning = null;
      }),
      failed: vi.fn(() => {
        warning = SIGN_OUT_UNCONFIRMED_MESSAGE;
      }),
    };

    const refreshRun = coordinator.refresh(() => pendingRefresh.promise, publish, clearLocal);
    const logoutRun = coordinator.signOut(failedLogout, callbacks);

    expect(privateSession).toBeNull();
    expect(clearLocal).toHaveBeenCalledOnce();
    expect(failedLogout).toHaveBeenCalledOnce();
    await expect(logoutRun).rejects.toThrow('network unavailable');
    expect(warning).toBe(SIGN_OUT_UNCONFIRMED_MESSAGE);
    expect(callbacks.failed).toHaveBeenCalledOnce();
    expect(callbacks.confirmed).not.toHaveBeenCalled();

    pendingRefresh.resolve(snapshot('stale-after-logout'));
    await refreshRun;
    expect(publish).not.toHaveBeenCalled();
    expect(clearLocal).toHaveBeenCalledOnce();

    const retry = vi.fn(() => {
      expect(privateSession).toBeNull();
      expect(warning).toBe(SIGN_OUT_UNCONFIRMED_MESSAGE);
      return pendingRetry.promise;
    });
    const retryRun = coordinator.signOut(retry, callbacks);

    expect(warning).toBe(SIGN_OUT_UNCONFIRMED_MESSAGE);
    expect(clearLocal).toHaveBeenCalledTimes(2);
    expect(retry).toHaveBeenCalledOnce();

    pendingRetry.resolve(undefined);
    await retryRun;
    expect(callbacks.confirmed).toHaveBeenCalledOnce();
    expect(warning).toBeNull();
  });

  it('keeps auth blocked after logout failure until a confirmed retry', async () => {
    const coordinator = new CompatibilitySessionCoordinator();
    const confirmedLogout = deferred<unknown>();
    const failedLogout = deferred<unknown>();
    const retryLogout = deferred<unknown>();
    const submitAuth = vi.fn();
    let signOutPending = false;
    let signOutWarning = false;
    const callbacks = {
      clearLocal: vi.fn(),
      confirmed: vi.fn(() => {
        signOutPending = false;
        signOutWarning = false;
      }),
      failed: vi.fn(() => {
        signOutPending = false;
        signOutWarning = true;
      }),
    };
    const attemptAuthSubmission = () => {
      if (authSubmissionBlocked(signOutPending, signOutWarning)) return;
      submitAuth();
    };
    const startSignOut = (logout: () => Promise<unknown>) => {
      signOutPending = true;
      return coordinator.signOut(logout, callbacks);
    };

    const confirmedRun = startSignOut(() => confirmedLogout.promise);
    attemptAuthSubmission();
    expect(authSubmissionBlocked(signOutPending, signOutWarning)).toBe(true);
    expect(submitAuth).not.toHaveBeenCalled();

    confirmedLogout.resolve(undefined);
    await confirmedRun;
    expect(authSubmissionBlocked(signOutPending, signOutWarning)).toBe(false);
    attemptAuthSubmission();
    expect(submitAuth).toHaveBeenCalledOnce();

    const failedRun = startSignOut(() => failedLogout.promise);
    attemptAuthSubmission();
    expect(authSubmissionBlocked(signOutPending, signOutWarning)).toBe(true);
    expect(submitAuth).toHaveBeenCalledOnce();

    failedLogout.reject(new Error('network unavailable'));
    await expect(failedRun).rejects.toThrow('network unavailable');
    expect(authSubmissionBlocked(signOutPending, signOutWarning)).toBe(true);
    attemptAuthSubmission();
    expect(submitAuth).toHaveBeenCalledOnce();

    const retryRun = startSignOut(() => retryLogout.promise);
    attemptAuthSubmission();
    expect(submitAuth).toHaveBeenCalledOnce();
    retryLogout.resolve(undefined);
    await retryRun;
    expect(authSubmissionBlocked(signOutPending, signOutWarning)).toBe(false);
    attemptAuthSubmission();
    expect(submitAuth).toHaveBeenCalledTimes(2);
  });

  it('suppresses late refreshes after rejected logout until a confirmed retry', async () => {
    const coordinator = new CompatibilitySessionCoordinator();
    const rejectedLogout = deferred<unknown>();
    const retryLogout = deferred<unknown>();
    const load = vi.fn(async () => snapshot(`loaded-${load.mock.calls.length}`));
    const publish = vi.fn();
    const clear = vi.fn();
    const callbacks = {
      clearLocal: vi.fn(),
      confirmed: vi.fn(),
      failed: vi.fn(),
    };

    const rejectedRun = coordinator.signOut(() => rejectedLogout.promise, callbacks);
    await coordinator.refresh(load, publish, clear);
    expect(load).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();

    rejectedLogout.reject(new Error('network unavailable'));
    await expect(rejectedRun).rejects.toThrow('network unavailable');
    // A late Settings/Onboarding completion must not use the still-valid cookie
    // to repopulate private state or clear the unconfirmed sign-out warning.
    await coordinator.refresh(load, publish, clear);
    expect(load).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();

    const retryRun = coordinator.signOut(() => retryLogout.promise, callbacks);
    await coordinator.refresh(load, publish, clear);
    expect(load).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();

    retryLogout.resolve(undefined);
    await retryRun;
    await coordinator.refresh(load, publish, clear);
    expect(load).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenCalledOnce();
    expect(callbacks.confirmed).toHaveBeenCalledOnce();
    expect(callbacks.failed).toHaveBeenCalledOnce();
  });
});
