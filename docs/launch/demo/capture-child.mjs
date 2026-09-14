// Attach immediately after spawn. Early errors are stored without a rejected
// promise, and never stand in for confirmed exit of a spawned child.
export function observeCaptureChild(child) {
  let firstError;
  let exited = false;
  let finishEarly;
  let finishStop;
  let stopping;
  const earlyCompletion = new Promise(resolve => { finishEarly = resolve; });
  const onError = error => {
    firstError ??= error;
    const result = { type: 'error', error };
    finishEarly(result);
    finishStop?.(result);
  };
  const onExit = (code, signal) => {
    exited = true;
    const result = { type: 'exit', code, signal };
    finishEarly(result);
    finishStop?.(result);
    child.removeListener('error', onError);
  };
  child.once('exit', onExit);
  // A failed kill may leave the child alive; keep observing until actual exit.
  child.on('error', onError);
  const terminal = () => exited || child.exitCode !== null || child.signalCode !== null;

  async function stopOnce() {
    const priorError = firstError;
    if (terminal()) {
      child.removeListener('exit', onExit);
      child.removeListener('error', onError);
      if (firstError) throw firstError;
      return;
    }
    if (child.pid === undefined) {
      // A failed spawn has no owned PID to signal. Its error may be queued.
      const result = firstError ? { type: 'error', error: firstError } : await earlyCompletion;
      if (result.type === 'error') throw result.error;
      return;
    }
    // Never reuse earlyCompletion here: an earlier error may have settled it.
    // This fresh waiter sees only actual exit or an error during this attempt.
    const result = await new Promise(resolve => {
      let stopError;
      finishStop = outcome => {
        if (outcome.type === 'error') stopError ??= outcome.error;
        resolve(outcome);
      };
      try {
        const sent = child.kill('SIGTERM');
        if (!sent && !terminal() && !stopError) {
          onError(new Error('Capture child SIGTERM was not sent; exit is unconfirmed'));
        }
      } catch (error) { onError(error); }
    });
    finishStop = undefined;
    if (result.type === 'error') {
      if (priorError && priorError !== result.error) {
        throw new AggregateError([priorError, result.error], 'Capture child termination failed; exit is unconfirmed');
      }
      throw result.error;
    }
    if (firstError) throw firstError;
  }

  // Concurrent/repeated cleanup shares one signal attempt; never retry a kill.
  return function stop() { return stopping ??= stopOnce(); };
}
