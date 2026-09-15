import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useSession } from '../App';
import { Button, Card, Field } from '../ui';
import { Notice, PageTitle } from './Studio';

export default function Account() {
  const { me, signOut } = useSession();
  const navigate = useNavigate();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [repeatPassword, setRepeatPassword] = useState('');
  const [deletePassword, setDeletePassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  async function run(task: string, action: () => Promise<void>) {
    if (busy) return;
    setBusy(task); setError(''); setMessage('');
    try { await action(); }
    catch (e) { setError(e instanceof Error ? e.message : 'The request could not be completed.'); }
    finally { setBusy(''); }
  }

  return <>
    <PageTitle title="Your account" description="Manage your password and your workspace data." />
    <Notice error={error} message={message} />
    <Card><p className="studio-muted">Signed in as</p><h2 className="studio-heading mt-2">{me?.email}</h2></Card>
    <div className="studio-grid mt-6">
      <Card><h2 className="studio-heading">Change password</h2><p className="studio-muted mb-5">Other sessions will be signed out. This session stays signed in.</p>
        <form onSubmit={e => { e.preventDefault(); if (newPassword !== repeatPassword) { setError('The new passwords do not match.'); return; } void run('password', async () => {
          await api.changePassword({ currentPassword, newPassword });
          setCurrentPassword(''); setNewPassword(''); setRepeatPassword(''); setMessage('Password updated. Other sessions have been signed out.');
        }); }}><fieldset disabled={Boolean(busy)} className="studio-fields">
          <Field label="Current password" type="password" autoComplete="current-password" required maxLength={1024} value={currentPassword} onChange={e => setCurrentPassword(e.target.value)} />
          <Field label="New password" type="password" autoComplete="new-password" required minLength={8} maxLength={1024} value={newPassword} onChange={e => setNewPassword(e.target.value)} hint="At least 8 characters." />
          <Field label="Repeat new password" type="password" autoComplete="new-password" required minLength={8} maxLength={1024} value={repeatPassword} onChange={e => setRepeatPassword(e.target.value)} />
          <div><Button>{busy === 'password' ? 'Updating…' : 'Update password'}</Button></div>
        </fieldset></form>
      </Card>
      <Card><h2 className="studio-heading">Export workspace data</h2><p className="studio-description">Download a JSON copy of your account and workspace data, including assistants, knowledge, and call records. Passwords, API keys, session tokens, and configured provider URLs are excluded. Provider endpoints must be set up again when restoring configuration.</p><Button disabled={Boolean(busy)} variant="ghost" onClick={() => void run('export', async () => {
        const data = await api.exportAccount();
        const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
        const link = document.createElement('a'); link.href = url; link.download = `openfon-export-${new Date().toISOString().slice(0,10)}.json`; document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
        setMessage('Workspace export downloaded. Keep it somewhere private.');
      })}>{busy === 'export' ? 'Preparing export…' : 'Download data'}</Button></Card>
    </div>
    <Card className="mt-6"><h2 className="studio-heading">Delete account</h2><p className="studio-description">Permanently delete your account and workspace, including assistants, knowledge, call history, and saved provider credentials. Export anything you want to keep first. End active calls before deleting. This cannot be undone.</p>
      <form onSubmit={e => { e.preventDefault(); if (confirmation !== 'DELETE') return; void run('delete', async () => {
        await api.deleteAccount({ currentPassword: deletePassword, confirmation: 'DELETE' });
        await signOut().catch(() => {}); navigate('/auth', { replace: true });
      }); }}><fieldset disabled={Boolean(busy)} className="studio-fields">
        <Field label="Current password to confirm deletion" type="password" autoComplete="current-password" required maxLength={1024} value={deletePassword} onChange={e => setDeletePassword(e.target.value)} />
        <Field label="Type DELETE to confirm" required value={confirmation} onChange={e => setConfirmation(e.target.value)} autoComplete="off" />
        <div><Button variant="danger" disabled={Boolean(busy) || confirmation !== 'DELETE' || !deletePassword}>{busy === 'delete' ? 'Deleting account…' : 'Permanently delete account'}</Button></div>
      </fieldset></form>
    </Card>
  </>;
}
