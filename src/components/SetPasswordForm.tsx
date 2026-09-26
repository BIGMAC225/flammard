import { useState } from 'react';

// Choosing a password: the /setup/[token] page (default export) and the
// first-owner bootstrap form on the People page (BootstrapOwnerForm). The
// server applies the real policy (src/lib/password.ts); the browser only
// checks length and that the two fields match.

export const PASSWORD_HINT = 'At least 12 characters. A short sentence or a few unrelated words works well.';

async function post(url: string, body: unknown): Promise<Record<string, any>> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? 'Something went wrong');
  return data;
}

/** Local checks before sending; null when fine. */
export function localPasswordProblem(pw: string, confirm: string): string | null {
  if (pw.length < 12) return 'Use at least 12 characters.';
  if (pw.length > 200) return 'Use at most 200 characters.';
  if (pw !== confirm) return "The two passwords don't match.";
  return null;
}

/** New password + confirm, with the policy hint. Controlled. */
export function PasswordFields({
  password,
  confirm,
  onPassword,
  onConfirm,
  idPrefix = 'pw',
  label = 'New password',
}: {
  password: string;
  confirm: string;
  onPassword: (v: string) => void;
  onConfirm: (v: string) => void;
  idPrefix?: string;
  label?: string;
}) {
  return (
    <>
      <div>
        <label className="label" htmlFor={`${idPrefix}-new`}>
          {label}
        </label>
        <input
          id={`${idPrefix}-new`}
          type="password"
          autoComplete="new-password"
          className="input"
          value={password}
          onChange={(e) => onPassword(e.target.value)}
          aria-describedby={`${idPrefix}-hint`}
          required
          minLength={12}
          maxLength={200}
        />
        <p id={`${idPrefix}-hint`} className="text-xs text-ink-muted mt-1.5">
          {PASSWORD_HINT}
        </p>
      </div>
      <div>
        <label className="label" htmlFor={`${idPrefix}-confirm`}>
          Confirm password
        </label>
        <input
          id={`${idPrefix}-confirm`}
          type="password"
          autoComplete="new-password"
          className="input"
          value={confirm}
          onChange={(e) => onConfirm(e.target.value)}
          required
        />
      </div>
    </>
  );
}

function ErrorBox({ message }: { message: string }) {
  if (!message) return null;
  return (
    <div role="alert" className="p-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-800">
      {message}
    </div>
  );
}

/** The /setup/[token] form: "Hi <name>, choose a password". */
export default function SetPasswordForm({
  token,
  email,
  purpose,
}: {
  token: string;
  email: string | null;
  purpose: 'setup' | 'reset';
}) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const local = localPasswordProblem(password, confirm);
    if (local) return setError(local);
    setSaving(true);
    setError('');
    try {
      const data = await post('/api/auth/setup', { token, password });
      window.location.href = data.next ?? '/dashboard';
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not set the password');
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      {/* Lets password managers save the right username */}
      {email && <input type="email" name="username" autoComplete="username" value={email} readOnly hidden />}
      <ErrorBox message={error} />
      <PasswordFields password={password} confirm={confirm} onPassword={setPassword} onConfirm={setConfirm} />
      <button type="submit" className="btn-primary w-full justify-center py-3" disabled={saving}>
        {saving ? 'Saving…' : purpose === 'reset' ? 'Set new password and sign in' : 'Set password and sign in'}
      </button>
    </form>
  );
}

/**
 * First-owner bootstrap (spec §3.7), shown on the People page to the shared
 * team login while no owner can sign in. Claims a seeded owner row, or
 * creates the first owner when there is none.
 */
export function BootstrapOwnerForm({
  claimable,
  emailDomain,
}: {
  claimable: Array<{ id: string; name: string; email: string | null }>;
  emailDomain: string | null;
}) {
  const creating = claimable.length === 0;
  const [personId, setPersonId] = useState(claimable[0]?.id ?? '');
  const [name, setName] = useState('');
  const [email, setEmail] = useState(claimable[0]?.email ?? (emailDomain ? `@${emailDomain}` : ''));
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const choose = (id: string) => {
    setPersonId(id);
    const p = claimable.find((c) => c.id === id);
    if (p?.email) setEmail(p.email);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (creating && !name.trim()) return setError('Enter your name.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return setError('Enter your work email.');
    const local = localPasswordProblem(password, confirm);
    if (local) return setError(local);
    setSaving(true);
    setError('');
    try {
      const data = await post(
        '/api/people/bootstrap',
        creating
          ? { name: name.trim(), email: email.trim(), password }
          : { person_id: personId, email: email.trim(), password }
      );
      window.location.href = data.next ?? '/dashboard/people';
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not set up the owner account');
      setSaving(false);
    }
  };

  return (
    <div className="card max-w-lg">
      <p className="eyebrow mb-2">First-time setup</p>
      <h2 className="section-title mb-1">Set up your owner account</h2>
      <p className="text-sm text-ink-secondary mb-6">
        You're signed in with the team password. Claim the owner account so you can sign in as yourself, then add
        everyone else from this page.
      </p>
      <form onSubmit={submit} className="space-y-4">
        <ErrorBox message={error} />
        {creating ? (
          <div>
            <label className="label" htmlFor="bs-name">
              Your name
            </label>
            <input id="bs-name" className="input" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" required />
          </div>
        ) : (
          <div>
            <label className="label" htmlFor="bs-owner">
              Owner account
            </label>
            <select id="bs-owner" className="input" value={personId} onChange={(e) => choose(e.target.value)}>
              {claimable.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
        )}
        <div>
          <label className="label" htmlFor="bs-email">
            Work email
          </label>
          <input
            id="bs-email"
            type="email"
            className="input"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="username"
            required
          />
          <p className="text-xs text-ink-muted mt-1.5">You'll sign in with this. Correct it if it's wrong.</p>
        </div>
        <PasswordFields password={password} confirm={confirm} onPassword={setPassword} onConfirm={setConfirm} idPrefix="bs" label="Password" />
        <button type="submit" className="btn-primary w-full justify-center py-3" disabled={saving}>
          {saving ? 'Saving…' : 'Save and sign in as me'}
        </button>
      </form>
    </div>
  );
}
