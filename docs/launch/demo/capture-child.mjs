// Attach immediately after spawn. The observation promise never rejects before
// cleanup awaits it; an error is deliberately distinct from confirmed exit.
export function observeCaptureChild(child) {
  let observed;
  let complete;
  const completion = new Promise(resolve => { complete = resolve; });
  const onError = error => {
    observed = { type: 'error', error };
    complete(observed);
  };
  const onExit = (code, signal) => {
    observed ??= { type: 'exit', code, signal };
    complete(observed);
    child.removeListener('error', onError);
  };
  child.once('exit', onExit);
  // Keep observing errors until actual exit: a failed kill may leave it alive.
  child.on('error', onError);

  return async function stop() {
    if (observed?.type === 'error') throw observed.error;
    if (child.exitCode !== null || child.signalCode !== null) {
      child.removeListener('exit', onExit);
      child.removeListener('error', onError);
      return;
    }
    // The completion listeners already exist before signalling the owned child.
    try { child.kill('SIGTERM'); }
    catch (error) { onError(error); }
    const result = await completion;
    if (result.type === 'error') throw result.error;
  };
}
