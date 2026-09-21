import { useEffect, useRef, useState } from 'react';
import { Button, Card } from '../ui';
interface Recording { available: boolean; finishedAt?: number; expiresAt?: number; partial?: boolean; interrupted?: boolean; bytes?: number }
export default function CallDebugPanel({ callId, active }: { callId: string; active: boolean }) {
  const [recording, setRecording] = useState<Recording | null>(null);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const [deleting, setDeleting] = useState(false);
  const revision = useRef(0);
  const path = `/api/me/calls/${encodeURIComponent(callId)}/debug`;
  useEffect(() => {
    let mounted = true; const run = ++revision.current;
    void fetch(path).then(async r => { if (!r.ok) throw Error('Could not load debug recording.'); return r.json() as Promise<Recording>; })
      .then(value => { if (mounted && run === revision.current) { setRecording(value); setError(''); } }).catch(e => { if (mounted && run === revision.current) setError(e.message); });
    return () => { mounted = false; };
  }, [path, active, reload]);
  return <Card className="mb-5"><h2 className="font-semibold">Debug recording</h2>
    {error && <p role="alert">{error}</p>}
    {!recording && !error && <p>Checking recording…</p>}
    {recording && !recording.available && <p>No recording is available. Older calls cannot be recovered; recordings expire after seven days or can be deleted.</p>}
    {recording?.available && <>
      <p>{recording.finishedAt ? 'Recording saved.' : 'Recording in progress or being finalized.'} Expires {new Date(recording.expiresAt!).toLocaleString()}.</p>
      {(recording.partial || recording.interrupted) && <p role="status">Partial recording: capture reached a limit, encountered a storage issue, or was interrupted. Gaps must not be treated as silence.</p>}
      <p className="text-sm">Includes private audio, transcripts and configuration. Browser-generated speech is represented by text and playback events, not a recorded voice track.</p>
      {recording.finishedAt && <a className="mr-4 text-iris underline" href={`${path}/download`}>Download debug bundle</a>}
      <Button variant="ghost" disabled={deleting} onClick={async () => {
        revision.current++; setDeleting(true); setError('');
        try { const r = await fetch(path, { method: 'DELETE' }); if (!r.ok) throw Error('Could not delete recording.'); setRecording({ available: false }); }
        catch (e) { setError(e instanceof Error ? e.message : 'Could not delete recording.'); }
        finally { setDeleting(false); }
      }}>{deleting ? 'Deleting…' : 'Delete recording'}</Button>
    </>}
    <Button variant="ghost" onClick={() => setReload(n => n + 1)}>Refresh recording</Button>
  </Card>;
}
