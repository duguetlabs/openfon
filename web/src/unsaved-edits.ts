import { useCallback, useEffect, useRef } from 'react';
import { useBeforeUnload, useBlocker } from 'react-router-dom';

const message = 'Discard your unsaved changes?';
// Sign-out changes authentication before navigating, so it asks the same guard
// before that mutation. Normal links and browser Back use the router blocker.
const guards = new Set<{ dirty: boolean; approved: boolean }>();
export function confirmDiscardUnsaved(): boolean {
  const pending = [...guards].filter(guard => guard.dirty && !guard.approved);
  if (pending.length && !window.confirm(message)) return false;
  for (const guard of pending) guard.approved = true;
  return true;
}

export function useUnsavedEdits(dirty: boolean): void {
  const guard = useRef({ dirty, approved: false });
  guard.current.dirty = dirty;
  if (!dirty) guard.current.approved = false;
  useEffect(() => {
    const current = guard.current;
    guards.add(current);
    return () => { guards.delete(current); };
  }, []);
  const blocker = useBlocker(useCallback(() => guard.current.dirty && !guard.current.approved, []));
  useEffect(() => {
    if (blocker.state !== 'blocked') return;
    if (window.confirm(message)) blocker.proceed();
    else blocker.reset();
  }, [blocker]);
  useBeforeUnload(useCallback((event) => {
    if (!guard.current.dirty || guard.current.approved) return;
    event.preventDefault();
    event.returnValue = '';
  }, []));
}
