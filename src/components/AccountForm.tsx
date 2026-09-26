import { useState } from 'react';
import { localPasswordProblem, PasswordFields } from './SetPasswordForm';

// My account (spec §5.1): change your password, or sign out every other
// device. Both need the current password; both keep this browser signed in.

async function post(body: unknown): Promise<void> {
  const res = await fetch('/api/me/password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? 'Something went wrong');
}

function Message({ error, ok }: { error: string; ok: string }) {
  if (error)
    return (
      <div role="alert" className="p-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-800">
        {error}
      </div>
    );
  if (ok)
    return (
      <div role="status" className="p-3 bg-mint-50 border border-mint-200 rounded-xl text-sm text-ink-primary">
        {ok}
      </div>
    );
  return null;
}

export default function AccountForm({ email }: { email: string }) {
  const [current, setCurrent] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');
  const [saving, setSaving] = useState(false);

  const [soCurrent, setSoCurrent] = useState('');
  const [soError, setSoError] = useState('');
  const [soOk, setSoOk] = useState('');
  const [soSaving, setSoSaving] = useState(false);

  const change = async (e: React.SyntheticEvent) => {
    e.preventDefault();
    setOk('');
    if (!current) return setError('Enter your current password.');
    const local = localPasswordProblem(password, confirm);
    if (local) return setError(local);
    setSaving(true);
    setError('');
    try {
      await post({ current_password: current, new_password: password });
      setCurrent('');
      setPassword('');
      setConfirm('');
      setOk('Password changed. Any other browsers or devices have been signed out.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not change the password');
    } finally {
      setSaving(false);
    }
  };

  const signOutOthers = async (e: React.SyntheticEvent) => {
    e.preventDefault();
    setSoOk('');
    if (!soCurrent) return setSoError('Enter your current password.');
    setSoSaving(true);
    setSoError('');
    try {
      await post({ current_password: soCurrent, sign_out_only: true });
      setSoCurrent('');
      setSoOk('Signed out everywhere else. This browser stays signed in.');
    } catch (err) {
      setSoError(err instanceof Error ? err.message : 'Could not sign out other devices');
    } finally {
      setSoSaving(false);
    }
  };

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <form onSubmit={change} className="card space-y-4">
        <h2 className="section-title">Change password</h2>
        {/* Lets password managers save the right username */}
        <input type="email" name="username" autoComplete="username" value={email} readOnly hidden />
        <Message error={error} ok={ok} />
        <div>
          <label className="label" htmlFor="acct-current">
            Current password
          </label>
          <input
            id="acct-current"
            type="password"
            autoComplete="current-password"
            className="input"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            required
          />
        </div>
        <PasswordFields password={password} confirm={confirm} onPassword={setPassword} onConfirm={setConfirm} idPrefix="acct" />
        <button type="submit" className="btn-primary" disabled={saving}>
          {saving ? 'Saving…' : 'Change password'}
        </button>
        <p className="text-xs text-ink-muted">Changing your password signs you out on every other browser and device.</p>
      </form>

      <form onSubmit={signOutOthers} className="card space-y-4 self-start">
        <h2 className="section-title">Sign out other devices</h2>
        <p className="text-sm text-ink-secondary">
          Signed in on a shared or lost device? This ends every other session. You stay signed in here.
        </p>
        <Message error={soError} ok={soOk} />
        <div>
          <label className="label" htmlFor="acct-so-current">
            Current password
          </label>
          <input
            id="acct-so-current"
            type="password"
            autoComplete="current-password"
            className="input"
            value={soCurrent}
            onChange={(e) => setSoCurrent(e.target.value)}
            required
          />
        </div>
        <button type="submit" className="btn-secondary" disabled={soSaving}>
          {soSaving ? 'Signing out…' : 'Sign out other devices'}
        </button>
      </form>
    </div>
  );
}
