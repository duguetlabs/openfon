import { useEffect, useRef, useState } from 'react';
import { api } from '../cleanroom-runtime';
import { Button, Field, Notice, errorText } from './ui';
import { Icon } from './icons';
import './account.css';

export function Account({ email, onDone, onDelete }: {
  email: string;
  onDone: () => void;
  onDelete: (input: { currentPassword: string; confirmation: 'DELETE' }) => Promise<void>;
}) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [deletePassword, setDeletePassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const pending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function run(task: string, action: () => Promise<void>) {
    if (pending.current) return;
    pending.current = true;
    setBusy(task); setError(''); setNotice('');
    try { await action(); }
    catch (e) { if (mounted.current) setError(errorText(e)); }
    finally { pending.current = false; if (mounted.current) setBusy(''); }
  }
  return <section className="of-account">
    <button className="of-back" onClick={onDone}><Icon name="back" />Back to your desk</button>
    <div className="of-page-heading"><div><h1>Your account</h1><p>{email}</p></div></div>
    {error && <Notice error>{error}</Notice>}
    {notice && <Notice>{notice}</Notice>}
    <section className="of-business-form">
      <h2>Change password</h2>
      <p>Other sessions will be signed out. This session stays signed in.</p>
      <form onSubmit={e => {
        e.preventDefault();
        if (next !== repeat) { setError('The new passwords do not match.'); return; }
        void run('password', async () => {
          await api.changePassword(current, next);
          if (!mounted.current) return;
          setCurrent(''); setNext(''); setRepeat('');
          setNotice('Password updated. Other sessions have been signed out.');
        });
      }}><fieldset className="of-form" disabled={Boolean(busy)}>
        <Field label="Current password"><input type="password" autoComplete="current-password" required maxLength={1024} value={current} onChange={e => setCurrent(e.target.value)} /></Field>
        <Field label="New password" hint="At least 8 characters."><input type="password" autoComplete="new-password" required minLength={8} maxLength={1024} value={next} onChange={e => setNext(e.target.value)} /></Field>
        <Field label="Repeat new password"><input type="password" autoComplete="new-password" required minLength={8} maxLength={1024} value={repeat} onChange={e => setRepeat(e.target.value)} /></Field>
        <Button type="submit" disabled={Boolean(busy)}>{busy === 'password' ? 'Updating…' : 'Update password'}</Button>
      </fieldset></form>
    </section>
    <section className="of-business-form">
      <h2>Export workspace data</h2>
      <p>Download a JSON copy of your account and workspace, including receptionists, knowledge and call records. Passwords and sign-in credentials are excluded.</p>
      <Button kind="line" disabled={Boolean(busy)} onClick={() => void run('export', async () => {
        const data = await api.exportAccount();
        if (!mounted.current) return;
        if (!data || typeof data !== 'object') throw new Error('The server did not return a workspace export. Please try again.');
        const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
        const link = document.createElement('a');
        link.href = url; link.download = `openfon-export-${new Date().toISOString().slice(0, 10)}.json`;
        document.body.appendChild(link); link.click(); link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        setNotice('Workspace export downloaded. Keep it somewhere private.');
      })}>{busy === 'export' ? 'Preparing export…' : 'Download data'}</Button>
    </section>
    <section className="of-business-form">
      <h2>Delete account</h2>
      <p>Permanently delete your account and workspace, including receptionists, knowledge, call history and saved settings. Export anything you want to keep first. End active calls before deleting. This cannot be undone.</p>
      <form onSubmit={e => {
        e.preventDefault();
        if (confirmation !== 'DELETE' || !deletePassword) return;
        void run('delete', () => onDelete({ currentPassword: deletePassword, confirmation: 'DELETE' }));
      }}><fieldset className="of-form" disabled={Boolean(busy)}>
        <Field label="Current password to confirm deletion"><input type="password" autoComplete="current-password" required maxLength={1024} value={deletePassword} onChange={e => setDeletePassword(e.target.value)} /></Field>
        <Field label="Type DELETE to confirm"><input required autoComplete="off" value={confirmation} onChange={e => setConfirmation(e.target.value)} /></Field>
        <Button type="submit" kind="danger" disabled={Boolean(busy) || confirmation !== 'DELETE' || !deletePassword}>{busy === 'delete' ? 'Deleting account…' : 'Permanently delete account'}</Button>
      </fieldset></form>
    </section>
  </section>;
}
