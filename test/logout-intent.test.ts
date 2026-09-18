import { describe, expect, it, vi } from 'vitest';
import { CompatibilitySessionCoordinator, type CompatibilitySessionSnapshot } from '../web/src/session-load';

// Structural fake keeps original-head negatives on the existing coordinator API.
// These are controlled storage faults/schedules, not browser-storage evidence.
function storage(initial: string | null = null) {
  return {
    value: initial,
    readFault: false, writeFault: false, removeFault: false,
    read() { if (this.readFault) throw new Error('read fault'); return this.value; },
    write(value: string) { if (this.writeFault) throw new Error('write fault'); this.value = value; },
    remove() { if (this.removeFault) throw new Error('remove fault'); this.value = null; },
  };
}
const id = '00112233-4455-4677-8899-aabbccddeeff';
const marker = (phase = 'unconfirmed') => JSON.stringify({ version: 1, id, phase });
const snapshot = (): CompatibilitySessionSnapshot => ({
  me: { id: 'synthetic', email: 'synthetic@example.invalid' }, business: null,
  workspaceReady: false, firstAssistant: null, firstAssistantReady: false,
});
const callbacks = () => ({ clearLocal: vi.fn(), confirmed: vi.fn(), failed: vi.fn() });
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function expectGated(coordinator: CompatibilitySessionCoordinator) {
  const load = vi.fn(async () => snapshot());
  const publish = vi.fn();
  await coordinator.refresh(load, publish, vi.fn());
  expect(load).not.toHaveBeenCalled(); // Original finite first failure: attempted auth read.
  expect(publish).not.toHaveBeenCalled();
}

describe('same-tab logout intent', () => {
  it('[original] restores failed intent before any cookie-backed load', async () => {
    const store = storage();
    await expect(new CompatibilitySessionCoordinator(store).signOut(async () => { throw new Error('revocation failed'); }, callbacks())).rejects.toThrow('revocation failed');
    await expectGated(new CompatibilitySessionCoordinator(store));
  });

  it('[original] restores pending intent without issuing a second logout', async () => {
    const store = storage();
    const pending = gate();
    const logout = vi.fn(() => pending.promise);
    const run = new CompatibilitySessionCoordinator(store).signOut(logout, callbacks());
    try {
      await expectGated(new CompatibilitySessionCoordinator(store));
      expect(logout).toHaveBeenCalledOnce();
    } finally { pending.resolve(); await run; }
  });

  for (const raw of ['{', JSON.stringify({ version: 2, id, phase: 'unconfirmed' }), marker().replace(id, 'not-an-id'), 'x'.repeat(161)]) {
    it(`[original] unknown stored state gates (${raw === '{' ? 'malformed' : raw.length > 160 ? 'oversized' : raw.includes('not-an-id') ? 'invalid identity' : 'unsupported version'})`, async () => {
      await expectGated(new CompatibilitySessionCoordinator(storage(raw)));
    });
  }

  it('[original] unreadable store gates before load', async () => {
    const store = storage(); store.readFault = true;
    await expectGated(new CompatibilitySessionCoordinator(store));
  });

  it('explicit retries retain the gate on repeated failure and clear on success', async () => {
    const store = storage(marker());
    const coordinator = new CompatibilitySessionCoordinator(store);
    const cb = callbacks();
    const logout = vi.fn().mockRejectedValueOnce(new Error('again')).mockResolvedValueOnce(undefined);
    await expect(coordinator.signOut(logout, cb)).rejects.toThrow('again');
    await expectGated(new CompatibilitySessionCoordinator(store));
    await coordinator.signOut(logout, cb);
    expect(store.value).toBeNull();
    expect(logout).toHaveBeenCalledTimes(2);
    expect(cb.failed).toHaveBeenCalledOnce();
    expect(cb.confirmed).toHaveBeenCalledOnce();
  });

  it('an old coordinator completion never removes the recreated coordinator intent', async () => {
    const store = storage(); const pending = gate();
    const oldCallbacks = callbacks();
    const oldRun = new CompatibilitySessionCoordinator(store).signOut(() => pending.promise, oldCallbacks).catch(error => error);
    const newer = new CompatibilitySessionCoordinator(store);
    await expect(newer.signOut(async () => { throw new Error('new failure'); }, callbacks())).rejects.toThrow('new failure');
    const newerMarker = store.value;
    pending.resolve(); await oldRun;
    expect(store.value).toBe(newerMarker);
    expect(oldCallbacks.confirmed).not.toHaveBeenCalled();
    await expectGated(new CompatibilitySessionCoordinator(store));
  });

  it('blocks publication if another coordinator records intent during a load', async () => {
    const store = storage(); const pending = gate(); const publish = vi.fn();
    const run = new CompatibilitySessionCoordinator(store).refresh(async () => { await pending.promise; return snapshot(); }, publish, vi.fn());
    await expect(new CompatibilitySessionCoordinator(store).signOut(async () => { throw new Error('failure'); }, callbacks())).rejects.toThrow();
    pending.resolve(); await run;
    expect(publish).not.toHaveBeenCalled();
  });

  it('write failure preserves synchronous clear and memory guards', async () => {
    const store = storage(); store.writeFault = true;
    const coordinator = new CompatibilitySessionCoordinator(store); const cb = callbacks();
    const logout = vi.fn(async () => { expect(cb.clearLocal).toHaveBeenCalledOnce(); throw new Error('failed'); });
    await expect(coordinator.signOut(logout, cb)).rejects.toThrow('failed');
    await expectGated(coordinator);
    expect(store.value).toBeNull(); // Deliberately no persistence claim after failed write.
    expect(logout).toHaveBeenCalledOnce();
  });

  it('confirmed removal failure survives recreation and retries only local cleanup', async () => {
    const store = storage(); store.removeFault = true;
    const logout = vi.fn(async () => undefined); const cb = callbacks();
    await expect(new CompatibilitySessionCoordinator(store).signOut(logout, cb)).rejects.toMatchObject({ recovery: 'local' });
    expect(JSON.parse(store.value!).phase).toBe('confirmed');
    const recreated = new CompatibilitySessionCoordinator(store);
    await expectGated(recreated);
    await expect(recreated.signOut(logout, cb)).rejects.toMatchObject({ recovery: 'local' });
    expect(logout).toHaveBeenCalledOnce();
    store.removeFault = false;
    await recreated.signOut(logout, cb);
    expect(logout).toHaveBeenCalledOnce();
    expect(store.value).toBeNull();
    expect(cb.confirmed).toHaveBeenCalledOnce();
  });

  it('a previously failed coordinator adopts later durable confirmation without another write', async () => {
    const store = storage(); const old = new CompatibilitySessionCoordinator(store);
    await expect(old.signOut(async () => { throw new Error('failed'); }, callbacks())).rejects.toThrow();
    store.removeFault = true;
    await expect(new CompatibilitySessionCoordinator(store).signOut(async () => undefined, callbacks())).rejects.toMatchObject({ recovery: 'local' });
    const logout = vi.fn(); store.removeFault = false;
    await old.signOut(logout, callbacks());
    expect(logout).not.toHaveBeenCalled(); expect(store.value).toBeNull();
  });

  it('confirmation-write failure can still remove an owned marker', async () => {
    const store = storage(); const coordinator = new CompatibilitySessionCoordinator(store);
    const cb = callbacks();
    await coordinator.signOut(async () => { store.writeFault = true; }, cb);
    expect(store.value).toBeNull(); expect(cb.confirmed).toHaveBeenCalledOnce();
  });

  it('simultaneous confirmation/removal failure retains memory-only confirmation', async () => {
    const store = storage(); const coordinator = new CompatibilitySessionCoordinator(store);
    const logout = vi.fn(async () => { store.writeFault = true; store.removeFault = true; });
    await expect(coordinator.signOut(logout, callbacks())).rejects.toMatchObject({ recovery: 'local' });
    expect(JSON.parse(store.value!).phase).toBe('unconfirmed'); // Confirmation could not be made durable.
    await expect(coordinator.signOut(logout, callbacks())).rejects.toMatchObject({ recovery: 'local' });
    expect(logout).toHaveBeenCalledOnce();
    store.writeFault = false; store.removeFault = false;
    await coordinator.signOut(logout, callbacks());
    expect(logout).toHaveBeenCalledOnce(); expect(store.value).toBeNull();
  });

  it('read failure after server success offers local recovery without repeating logout', async () => {
    const store = storage(); const coordinator = new CompatibilitySessionCoordinator(store);
    const logout = vi.fn(async () => { store.readFault = true; });
    await expect(coordinator.signOut(logout, callbacks())).rejects.toMatchObject({ recovery: 'local' });
    await expect(coordinator.signOut(logout, callbacks())).rejects.toMatchObject({ recovery: 'local' });
    expect(logout).toHaveBeenCalledOnce();
    store.readFault = false; await coordinator.signOut(logout, callbacks());
    expect(store.value).toBeNull(); expect(logout).toHaveBeenCalledOnce();
  });

  it('unknown storage recovers only through an explicit sign-out action', async () => {
    const store = storage('{'); const coordinator = new CompatibilitySessionCoordinator(store);
    await expectGated(coordinator);
    const logout = vi.fn(async () => undefined);
    await coordinator.signOut(logout, callbacks());
    expect(logout).toHaveBeenCalledOnce(); expect(store.value).toBeNull();
  });

  it('absent marker permits ordinary session loading', async () => {
    const publish = vi.fn(); const load = vi.fn(async () => snapshot());
    await new CompatibilitySessionCoordinator(storage()).refresh(load, publish, vi.fn());
    expect(load).toHaveBeenCalledOnce(); expect(publish).toHaveBeenCalledOnce();
  });


  for (const removeFault of [false, true]) {
    it(`failed replacement write keeps confirmed predecessor cleanup local (remove fault ${removeFault})`, async () => {
      const store = storage(marker()); store.writeFault = true; store.removeFault = removeFault;
      const coordinator = new CompatibilitySessionCoordinator(store); const cb = callbacks();
      const logout = vi.fn(async () => undefined);
      const attempt = coordinator.signOut(logout, cb);
      if (removeFault) {
        await expect(attempt).rejects.toMatchObject({ recovery: 'local' });
        expect(cb.failed).toHaveBeenLastCalledWith(expect.objectContaining({ recovery: 'local' }));
        expect(store.value).toBe(marker());
        await expect(coordinator.signOut(logout, cb)).rejects.toMatchObject({ recovery: 'local' });
        expect(logout).toHaveBeenCalledOnce();
        store.writeFault = false; store.removeFault = false;
        await coordinator.signOut(logout, cb);
      } else await attempt;
      expect(logout).toHaveBeenCalledOnce(); expect(store.value).toBeNull();
      expect(cb.confirmed).toHaveBeenCalledOnce();
    });
  }

  it('failed replacement write cannot adopt or clear a genuinely newer owner after server success', async () => {
    const store = storage(marker()); store.writeFault = true;
    const coordinator = new CompatibilitySessionCoordinator(store);
    const newer = marker().replace(id, '00112233-4455-4677-8899-aabbccddee00');
    const logout = vi.fn(async () => { store.value = newer; });
    await expect(coordinator.signOut(logout, callbacks())).rejects.toMatchObject({ recovery: 'local' });
    expect(store.value).toBe(newer);
    store.writeFault = false;
    await expect(coordinator.signOut(logout, callbacks())).rejects.toMatchObject({ recovery: 'local' });
    expect(logout).toHaveBeenCalledOnce(); expect(store.value).toBe(newer);
    // Only the current owner completing cleanup unlocks the older coordinator.
    await new CompatibilitySessionCoordinator(store).signOut(async () => undefined, callbacks());
    await coordinator.signOut(logout, callbacks());
    expect(logout).toHaveBeenCalledOnce(); expect(store.value).toBeNull();
  });

  it('does not let a confirmed older owner clear a newer failed intent', async () => {
    const store = storage(); store.removeFault = true;
    const old = new CompatibilitySessionCoordinator(store);
    await expect(old.signOut(async () => undefined, callbacks())).rejects.toMatchObject({ recovery: 'local' });
    // A synthetic independent intent models a new owner, not a storage event protocol.
    store.value = marker().replace(id, '00112233-4455-4677-8899-aabbccddee00');
    const newer = store.value; store.removeFault = false; const logout = vi.fn();
    await expect(old.signOut(logout, callbacks())).rejects.toMatchObject({ recovery: 'local' });
    expect(logout).not.toHaveBeenCalled(); expect(store.value).toBe(newer);
  });
});
