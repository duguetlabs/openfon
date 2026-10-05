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
    <strong>Recording is on for private tests.</strong> Audio is retained privately for seven days.
    Starting a test records it; use only conversations you have permission to record.
    Download or delete recordings from the conversation details.
    {recording === false && ' Recording could not start for this call.'}
  </p>;
  return enabled === null ? <p className="of-recording-disclosure">Test calls may retain audio and transcripts for seven days. Only use conversations you have permission to record.</p> : null;
}

interface Recording { available: boolean; finishedAt?: number; expiresAt?: number; partial?: boolean; interrupted?: boolean }
export function CallDiagnostics({ callId, active }: { callId: string; active: boolean }) {
  const [recording, setRecording] = useState<Recording | null>(null);
  const [readError, setReadError] = useState('');
  const [deleteError, setDeleteError] = useState('');
  const [reload, setReload] = useState(0);
  const [deleting, setDeleting] = useState(false);
  const revision = useRef(0);
  const deletingRef = useRef(false);
  const mutationRevision = useRef(0);
  const path = `/api/me/calls/${encodeURIComponent(callId)}/debug`;
  useEffect(() => () => { ++mutationRevision.current; deletingRef.current = false; }, [path]);
  useEffect(() => {
    const run = ++revision.current;
    if (deletingRef.current) return;
    void request<Recording>(path).then(value => {
      if (run === revision.current) { setRecording(value); setReadError(''); }
    }).catch(e => { if (run === revision.current) setReadError(errorText(e)); });
    return () => { ++revision.current; };
  }, [path, active, reload]);
  return <details className="of-call-diagnostics">
    <summary>Call recording</summary>
    <div>
      <h3>Call recording</h3>
      {readError && <Notice error>{readError}</Notice>}
      {deleteError && <Notice error>{deleteError}</Notice>}
      {!recording && !readError && <p>Checking recording…</p>}
      {recording && !recording.available && <p>No recording is available. Older calls cannot be recovered; recordings expire after seven days or can be deleted.</p>}
      {recording?.available && <>
        <p>{recording.finishedAt ? 'Recording saved.' : 'Recording in progress or being finalized.'}{recording.expiresAt ? ` Expires ${new Date(recording.expiresAt).toLocaleString()}.` : ''}</p>
        {(recording.partial || recording.interrupted) && <Notice>Partial recording: capture reached a limit, encountered a storage issue, or was interrupted. Gaps must not be treated as silence.</Notice>}
        <p>The download contains captured audio. Some older conversations have no recorded assistant voice; their words remain in the transcript.</p>
        <div className="of-diagnostic-actions">
          {recording.finishedAt && <a className="of-button line" href={`${path}/download`}>Download recording</a>}
          <Button kind="danger" disabled={deleting} onClick={() => {
            if (deletingRef.current) return;
            deletingRef.current = true;
            const run = ++mutationRevision.current;
            ++revision.current; // A read started before deletion cannot restore its old recording.
            setDeleting(true); setDeleteError(''); setReadError('');
            void request<Recording>(path, 'DELETE').then(result => {
              if (run !== mutationRevision.current) return;
              if (result?.available !== false) throw new Error('The server did not confirm recording deletion. Refresh its status before trying again.');
              ++revision.current;
              setRecording({ available: false });
            }).catch(e => { if (run === mutationRevision.current) setDeleteError(errorText(e)); })
              .finally(() => {
                if (run !== mutationRevision.current) return;
                deletingRef.current = false; setDeleting(false);
              });
          }}>{deleting ? 'Deleting…' : 'Delete recording'}</Button>
        </div>
      </>}
      <Button kind="quiet" disabled={deleting} onClick={() => setReload(n => n + 1)}>Refresh recording</Button>
    </div>
  </details>;
}
