import { useEffect, useRef, useState } from 'react';
import { request } from '../cleanroom-runtime';
import { Button, Notice, errorText } from './ui';
import './diagnostics.css';

export function RecordingDisclosure({ recording }: { recording: boolean | null }) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  useEffect(() => {
    let current = true;
    void request<{ testCalls: boolean }>('/api/me/debug-config')
      .then(data => { if (current && typeof data?.testCalls === 'boolean') setEnabled(data.testCalls); })
      .catch(() => { /* Unknown configuration retains the conservative disclosure. */ });
    return () => { current = false; };
  }, []);
  if (enabled || recording === true) return <p className="of-recording-disclosure" role="status">
    <strong>Debug mode on for test calls.</strong> Audio and diagnostics are retained privately for seven days.
    Starting a test records it; use only conversations you have permission to record.
    Download or delete recordings from the conversation details.
    {recording === false && ' Recording could not start for this call.'}
  </p>;
  return enabled === null ? <p className="of-recording-disclosure">Test calls may record audio, transcripts and configuration for seven days for debugging. Only use conversations you have permission to record.</p> : null;
}

interface Recording { available: boolean; finishedAt?: number; expiresAt?: number; partial?: boolean; interrupted?: boolean }
export function CallDiagnostics({ callId, active }: { callId: string; active: boolean }) {
  const [recording, setRecording] = useState<Recording | null>(null);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const [deleting, setDeleting] = useState(false);
  const revision = useRef(0);
  const deletingRef = useRef(false);
  const path = `/api/me/calls/${encodeURIComponent(callId)}/debug`;
  useEffect(() => {
    const run = ++revision.current;
    void request<Recording>(path).then(value => {
      if (run === revision.current) { setRecording(value); setError(''); }
    }).catch(e => { if (run === revision.current) setError(errorText(e)); });
    return () => { ++revision.current; };
  }, [path, active, reload]);
  return <details className="of-call-diagnostics">
    <summary>Advanced · recording & diagnostics</summary>
    <div>
      <h3>Debug recording</h3>
      {error && <Notice error>{error}</Notice>}
      {!recording && !error && <p>Checking recording…</p>}
      {recording && !recording.available && <p>No recording is available. Older calls cannot be recovered; recordings expire after seven days or can be deleted.</p>}
      {recording?.available && <>
        <p>{recording.finishedAt ? 'Recording saved.' : 'Recording in progress or being finalized.'}{recording.expiresAt ? ` Expires ${new Date(recording.expiresAt).toLocaleString()}.` : ''}</p>
        {(recording.partial || recording.interrupted) && <Notice>Partial recording: capture reached a limit, encountered a storage issue, or was interrupted. Gaps must not be treated as silence.</Notice>}
        <p>Includes private audio, transcripts and configuration. Browser-generated speech is represented by text and playback events, not a recorded voice track.</p>
        <div className="of-diagnostic-actions">
          {recording.finishedAt && <a className="of-button line" href={`${path}/download`}>Download debug bundle</a>}
          <Button kind="danger" disabled={deleting} onClick={() => {
            if (deletingRef.current) return;
            deletingRef.current = true;
            const run = ++revision.current;
            setDeleting(true); setError('');
            void request<{ ok: boolean }>(path, 'DELETE').then(() => {
              if (run === revision.current) setRecording({ available: false });
            }).catch(e => { if (run === revision.current) setError(errorText(e)); })
              .finally(() => { deletingRef.current = false; if (run === revision.current) setDeleting(false); });
          }}>{deleting ? 'Deleting…' : 'Delete recording'}</Button>
        </div>
      </>}
      <Button kind="quiet" disabled={deleting} onClick={() => setReload(n => n + 1)}>Refresh recording</Button>
    </div>
  </details>;
}
