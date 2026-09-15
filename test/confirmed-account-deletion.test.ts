import { describe, expect, it, vi } from 'vitest';
import { CompatibilitySessionCoordinator, type CompatibilitySignOutCallbacks, type CompatibilitySessionSnapshot } from '../web/src/session-load';

const id = '00112233-4455-4677-8899-aabbccddeeff';
const marker = (phase = 'unconfirmed') => JSON.stringify({ version: 1, id, phase });
function storage() {
  return {
    value: null as string | null, readFault: false, writeFault: false, removeFault: false,
    read() { if (this.readFault) throw new Error('read fault'); return this.value; },
    write(value: string) { if (this.writeFault) throw new Error('write fault'); this.value = value; },
    remove() { if (this.removeFault) throw new Error('remove fault'); this.value = null; },
  };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const callbacks = () => ({ clearLocal: vi.fn(), confirmed: vi.fn(), failed: vi.fn() });
const snapshot = (): CompatibilitySessionSnapshot => ({
  me: { id: 'synthetic', email: 'synthetic@example.invalid' }, business: null,
  workspaceReady: false, firstAssistant: null, firstAssistantReady: false,
});

// Original-only adapter reproduces Account's existing await DELETE -> signOut
// with caught rejection. It is not an application shim. Fixed runs require and
// use the actual new coordinator method. Tagged negatives never fail merely
// because a new method is absent on the original head.
async function deletion(c: CompatibilitySessionCoordinator, remove: () => Promise<unknown>, logout: () => Promise<unknown>, cb: CompatibilitySignOutCallbacks) {
  const extended = c as CompatibilitySessionCoordinator & {
    deleteAccount?: (remove: () => Promise<unknown>, callbacks: CompatibilitySignOutCallbacks) => Promise<boolean>;
  };
  if (typeof extended.deleteAccount === 'function') return extended.deleteAccount(remove, cb);
  await remove();
  await c.signOut(logout, cb).catch(() => {});
  return true;
}

describe('confirmed account deletion', () => {
  it('[original] acknowledged deletion is not downgraded by a redundant logout rejection', async () => {
    const c = new CompatibilitySessionCoordinator(storage()), cb = callbacks();
    const remove = vi.fn(async () => undefined), logout = vi.fn(async () => { throw new Error('redundant request'); });
    await deletion(c, remove, logout, cb);
    expect(logout).not.toHaveBeenCalled(); // Original first failure: one redundant request.
    expect(remove).toHaveBeenCalledOnce(); expect(cb.clearLocal).toHaveBeenCalledOnce();
    expect(cb.confirmed).toHaveBeenCalledOnce(); expect(cb.failed).not.toHaveBeenCalled();
  });

  it('[original] acknowledged deletion does not wait on a second pending request', async () => {
    const c = new CompatibilitySessionCoordinator(storage()), cb = callbacks(), held = deferred();
    const logout = vi.fn(() => held.promise);
    const done = deletion(c, async () => undefined, logout, cb);
    try {
      await vi.waitFor(() => expect(cb.clearLocal).toHaveBeenCalledOnce());
      expect(logout).not.toHaveBeenCalled(); // Finite assertion, no wait for hung original.
      expect(cb.confirmed).toHaveBeenCalledOnce();
    } finally { held.resolve(); await done; }
  });

  it('[original] a newer refresh makes the delayed deletion completion obsolete', async () => {
    const c = new CompatibilitySessionCoordinator(storage()), cb = callbacks(), held = deferred();
    const logout = vi.fn(async () => undefined);
    const done = deletion(c, () => held.promise, logout, cb);
    const publish = vi.fn(); await c.refresh(async () => snapshot(), publish, vi.fn());
    held.resolve(); await done;
    expect(cb.clearLocal).not.toHaveBeenCalled(); // Original clears the newer snapshot.
    expect(cb.confirmed).not.toHaveBeenCalled(); expect(cb.failed).not.toHaveBeenCalled();
    expect(logout).not.toHaveBeenCalled(); expect(publish).toHaveBeenCalledOnce();
  });

  it('[original] a stored newer intent is neither promoted nor removed', async () => {
    const store = storage(), c = new CompatibilitySessionCoordinator(store), cb = callbacks(), held = deferred();
    const done = deletion(c, () => held.promise, vi.fn(async () => undefined), cb);
    store.value = marker(); const newer = store.value;
    held.resolve(); await done;
    expect(store.value).toBe(newer); // Original replaces and removes the newer intent.
    expect(cb.clearLocal).not.toHaveBeenCalled(); expect(cb.confirmed).not.toHaveBeenCalled();
  });

  it('has the actual fixed method and clears without storage', async () => {
    const c = new CompatibilitySessionCoordinator(), cb = callbacks();
    expect(typeof c.deleteAccount).toBe('function');
    await expect(c.deleteAccount(async () => undefined, cb)).resolves.toBe(true);
    expect(cb.clearLocal).toHaveBeenCalledOnce(); expect(cb.confirmed).toHaveBeenCalledOnce();
  });

  for (const failure of ['rejected', 'ambiguous response'] as const) {
    it(`${failure} DELETE does not clear or persist confirmation`, async () => {
      const store = storage(), c = new CompatibilitySessionCoordinator(store), cb = callbacks();
      const error = new Error(failure);
      await expect(c.deleteAccount(async () => { throw error; }, cb)).rejects.toBe(error);
      expect(store.value).toBeNull(); expect(cb.clearLocal).not.toHaveBeenCalled();
      expect(cb.confirmed).not.toHaveBeenCalled(); expect(cb.failed).not.toHaveBeenCalled();
      const publish = vi.fn(); await c.refresh(async () => snapshot(), publish, vi.fn());
      expect(publish).toHaveBeenCalledOnce();
    });
  }

  it('pending DELETE leaves the current session and intent unchanged until acknowledged', async () => {
    const store = storage(), c = new CompatibilitySessionCoordinator(store), cb = callbacks(), held = deferred();
    const done = c.deleteAccount(() => held.promise, cb);
    try { expect(cb.clearLocal).not.toHaveBeenCalled(); expect(store.value).toBeNull(); }
    finally { held.resolve(); await done; }
    expect(cb.confirmed).toHaveBeenCalledOnce();
  });

  it('unmount invalidation suppresses completion even when storage remains absent', async () => {
    const c = new CompatibilitySessionCoordinator(storage()), cb = callbacks(), held = deferred();
    const done = c.deleteAccount(() => held.promise, cb); c.invalidate(); held.resolve();
    await expect(done).resolves.toBe(false); expect(cb.clearLocal).not.toHaveBeenCalled();
    expect(cb.confirmed).not.toHaveBeenCalled(); expect(cb.failed).not.toHaveBeenCalled();
  });

  it('older completion cannot interfere with a later deletion attempt', async () => {
    const store = storage(), c = new CompatibilitySessionCoordinator(store), old = callbacks(), newer = callbacks();
    const first = deferred(), second = deferred();
    const a = c.deleteAccount(() => first.promise, old), b = c.deleteAccount(() => second.promise, newer);
    try {
      first.resolve(); await expect(a).resolves.toBe(false);
      expect(old.clearLocal).not.toHaveBeenCalled(); expect(store.value).toBeNull();
    } finally { first.resolve(); second.resolve(); await Promise.all([a, b]); }
    expect(newer.confirmed).toHaveBeenCalledOnce();
  });

  it('a newer pending normal sign-out retains its state and ownership', async () => {
    const store = storage(), c = new CompatibilitySessionCoordinator(store), old = callbacks(), newer = callbacks();
    const deleting = deferred(), loggingOut = deferred();
    const a = c.deleteAccount(() => deleting.promise, old);
    const b = c.signOut(() => loggingOut.promise, newer); const pending = store.value;
    try {
      deleting.resolve(); await expect(a).resolves.toBe(false);
      expect(store.value).toBe(pending); expect(old.clearLocal).not.toHaveBeenCalled();
      const blocked = vi.fn(); await c.refresh(async () => snapshot(), vi.fn(), vi.fn(), blocked);
      expect(blocked).toHaveBeenCalledWith('pending');
    } finally { deleting.resolve(); loggingOut.resolve(); await Promise.all([a, b]); }
    expect(newer.confirmed).toHaveBeenCalledOnce();
  });

  it('a recreated coordinator intent survives the obsolete owner completion', async () => {
    const store = storage(), old = new CompatibilitySessionCoordinator(store), cb = callbacks(), held = deferred();
    const done = old.deleteAccount(() => held.promise, cb); old.invalidate();
    const newer = new CompatibilitySessionCoordinator(store);
    await expect(newer.signOut(async () => { throw new Error('new owner failure'); }, callbacks())).rejects.toThrow('new owner failure');
    const current = store.value; held.resolve(); await expect(done).resolves.toBe(false);
    expect(store.value).toBe(current); expect(cb.clearLocal).not.toHaveBeenCalled();
  });

  it('an independently confirmed newer marker is left byte-exact', async () => {
    const store = storage(), c = new CompatibilitySessionCoordinator(store), cb = callbacks(), held = deferred();
    const done = c.deleteAccount(() => held.promise, cb); store.value = marker('confirmed');
    held.resolve(); await expect(done).resolves.toBe(false);
    expect(store.value).toBe(marker('confirmed')); expect(cb.clearLocal).not.toHaveBeenCalled();
  });

  it('a later acknowledged deletion invalidates an older in-flight session load', async () => {
    const c = new CompatibilitySessionCoordinator(storage()), held = deferred(), publish = vi.fn();
    const load = c.refresh(async () => { await held.promise; return snapshot(); }, publish, vi.fn());
    await c.deleteAccount(async () => undefined, callbacks()); held.resolve(); await load;
    expect(publish).not.toHaveBeenCalled();
  });

  it('unknown storage before DELETE prevents a request without claiming confirmation', async () => {
    const store = storage(); store.readFault = true;
    const c = new CompatibilitySessionCoordinator(store), remove = vi.fn(), cb = callbacks();
    await expect(c.deleteAccount(remove, cb)).rejects.toMatchObject({ recovery: 'unknown' });
    expect(remove).not.toHaveBeenCalled(); expect(cb.clearLocal).not.toHaveBeenCalled();
  });

  it('unreadable storage after acknowledgement retains known local-only recovery', async () => {
    const store = storage(), c = new CompatibilitySessionCoordinator(store), cb = callbacks();
    await expect(c.deleteAccount(async () => { store.readFault = true; }, cb)).rejects.toMatchObject({ recovery: 'local' });
    expect(cb.clearLocal).toHaveBeenCalledOnce();
    const logout = vi.fn(); await expect(c.signOut(logout, callbacks())).rejects.toMatchObject({ recovery: 'local' });
    expect(logout).not.toHaveBeenCalled(); store.readFault = false;
    await c.signOut(logout, callbacks()); expect(logout).not.toHaveBeenCalled();
  });

  it('failed confirmation write with readable absence still finishes owned cleanup', async () => {
    const store = storage(); store.writeFault = true;
    const c = new CompatibilitySessionCoordinator(store), cb = callbacks();
    await expect(c.deleteAccount(async () => undefined, cb)).resolves.toBe(true);
    expect(store.value).toBeNull(); expect(cb.confirmed).toHaveBeenCalledOnce();
  });

  it('failed removal persists confirmation and recreated recovery never calls logout', async () => {
    const store = storage(); store.removeFault = true;
    const c = new CompatibilitySessionCoordinator(store);
    await expect(c.deleteAccount(async () => undefined, callbacks())).rejects.toMatchObject({ recovery: 'local' });
    expect(JSON.parse(store.value!).phase).toBe('confirmed');
    const recreated = new CompatibilitySessionCoordinator(store), logout = vi.fn(), load = vi.fn(async () => snapshot());
    await recreated.refresh(load, vi.fn(), vi.fn()); expect(load).not.toHaveBeenCalled();
    await expect(recreated.signOut(logout, callbacks())).rejects.toMatchObject({ recovery: 'local' });
    store.removeFault = false; await recreated.signOut(logout, callbacks());
    expect(logout).not.toHaveBeenCalled(); expect(store.value).toBeNull();
  });

  it('local cleanup after deletion cannot clear a subsequently replaced owner', async () => {
    const store = storage(); store.removeFault = true;
    const c = new CompatibilitySessionCoordinator(store);
    await expect(c.deleteAccount(async () => undefined, callbacks())).rejects.toMatchObject({ recovery: 'local' });
    store.value = marker(); store.removeFault = false; const logout = vi.fn();
    await expect(c.signOut(logout, callbacks())).rejects.toMatchObject({ recovery: 'local' });
    expect(logout).not.toHaveBeenCalled(); expect(store.value).toBe(marker());
  });
});
