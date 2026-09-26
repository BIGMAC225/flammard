import { useEffect, useMemo, useRef, useState } from 'react';
import UnmatchedOwners from './UnmatchedOwners';
import type { Person, PersonOption, Role, TeamId } from '../types';

// The People page (spec §5.1): the people table, an add/edit drawer, the
// one-time link panel and the unmatched-owner panel. The server enforces every
// rule; the UI only hides what the signed-in person can't do and shows the
// server's message when something is refused.

export type PersonRow = Person & { link_expires_at: string | null; link_purpose: 'setup' | 'reset' | null };

interface Actor {
  id: string;
  role: Role;
  canGrantAdmin: boolean;
}

const ROLE_OPTIONS: Array<{ id: Role; label: string; hint: string }> = [
  { id: 'owner', label: 'Owner', hint: 'Everything, including owners and admins' },
  { id: 'admin', label: 'Admin', hint: 'People, settings and import' },
  { id: 'facilitator', label: 'Facilitator', hint: 'Runs meetings; sees every team' },
  { id: 'manager', label: 'Manager', hint: 'Runs meetings and approves minutes' },
  { id: 'member', label: 'Member', hint: 'Adds and edits items' },
  { id: 'observer', label: 'Observer', hint: 'Read only' },
];
const roleLabel = (r: Role) => ROLE_OPTIONS.find((o) => o.id === r)?.label ?? r;
const TEAM_OPTIONS: Array<{ id: TeamId; label: string }> = [
  { id: 'leadership', label: 'Leadership' },
  { id: 'management', label: 'Management' },
];
const privileged = (r: Role) => r === 'owner' || r === 'admin';

async function send(url: string, method: string, body?: unknown): Promise<Record<string, any>> {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? 'Something went wrong');
  return data;
}

// The firm's time zone (from the page) so the server render and the browser agree
let displayZone: string | undefined;

function formatDate(iso: string | null, withTime = false): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const opts: Intl.DateTimeFormatOptions = withTime ? { dateStyle: 'medium', timeStyle: 'short' } : { dateStyle: 'medium' };
  try {
    return d.toLocaleString('en-US', { ...opts, timeZone: displayZone });
  } catch {
    return d.toLocaleString('en-US', opts);
  }
}

function status(p: PersonRow): { label: string; cls: string } {
  if (!p.active) return { label: 'Inactive', cls: 'bg-bg-elevated text-ink-muted' };
  if (p.has_password) return { label: 'Active', cls: 'bg-mint-100 text-mint-800' };
  if (p.link_expires_at) return { label: 'Invited', cls: 'bg-blue-50 text-blue-700' };
  return { label: 'No sign-in yet', cls: 'bg-amber-100 text-amber-800' };
}

// ── Add / edit drawer ────────────────────────────────────────────────────────

interface Draft {
  name: string;
  email: string;
  title: string;
  role: Role;
  teams: TeamId[];
  aliases: string;
}

function Drawer({
  person,
  actor,
  emailDomain,
  onClose,
  onSaved,
}: {
  person: PersonRow | null; // null = add
  actor: Actor;
  emailDomain: string | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const prefill = emailDomain ? `@${emailDomain}` : '';
  const [draft, setDraft] = useState<Draft>(() =>
    person
      ? {
          name: person.name,
          email: person.email ?? '',
          title: person.title ?? '',
          role: person.role,
          teams: [...person.teams],
          aliases: person.aliases.join(', '),
        }
      : { name: '', email: prefill, title: '', role: 'member', teams: [], aliases: '' }
  );
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const isSelf = person?.id === actor.id;

  useEffect(() => {
    nameRef.current?.focus();
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const toggleTeam = (t: TeamId) =>
    set('teams', draft.teams.includes(t) ? draft.teams.filter((x) => x !== t) : [...draft.teams, t]);

  const roleChoices = ROLE_OPTIONS.filter((o) => actor.canGrantAdmin || !privileged(o.id) || o.id === draft.role);

  const submit = async (e: React.SyntheticEvent) => {
    e.preventDefault();
    if (!draft.name.trim()) return setError('Enter a name.');
    // The pre-filled "@domain" alone means no email was typed
    const emailRaw = draft.email.trim();
    const email = !emailRaw || emailRaw === prefill ? null : emailRaw;
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return setError('That email address looks wrong.');
    const body: Record<string, unknown> = {
      name: draft.name.trim(),
      email,
      title: draft.title.trim() || null,
      teams: draft.teams,
      aliases: draft.aliases
        .split(',')
        .map((a) => a.trim())
        .filter(Boolean),
    };
    if (!isSelf) body.role = draft.role;
    setSaving(true);
    setError('');
    try {
      if (person) await send(`/api/people/${person.id}`, 'PATCH', body);
      else await send('/api/people', 'POST', { ...body, role: draft.role });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save');
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-labelledby="person-drawer-title">
      <button type="button" aria-label="Close" className="absolute inset-0 bg-ink-primary/30" onClick={onClose} />
      <form onSubmit={submit} className="relative w-full max-w-md h-full overflow-y-auto bg-bg-surface shadow-lift p-6 space-y-4">
        <div className="flex items-start justify-between gap-4">
          <h2 id="person-drawer-title" className="section-title">
            {person ? `Edit ${person.name}` : 'Add person'}
          </h2>
          <button type="button" className="btn-ghost px-2 py-1" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        {error && (
          <div role="alert" className="p-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-800">
            {error}
          </div>
        )}

        <div>
          <label className="label" htmlFor="pd-name">
            Name
          </label>
          <input ref={nameRef} id="pd-name" className="input" value={draft.name} onChange={(e) => set('name', e.target.value)} required maxLength={120} />
          {person && draft.name.trim() !== person.name && (
            <p className="text-xs text-ink-muted mt-1.5">Their name on every item they own changes too.</p>
          )}
        </div>

        <div>
          <label className="label" htmlFor="pd-email">
            Work email
          </label>
          <input
            id="pd-email"
            type="text"
            inputMode="email"
            autoComplete="off"
            className="input"
            value={draft.email}
            onChange={(e) => set('email', e.target.value)}
            onFocus={(e) => {
              // Put the cursor before "@domain" so the admin types the local part
              if (prefill && e.target.value === prefill) {
                const el = e.target;
                requestAnimationFrame(() => el.setSelectionRange(0, 0));
              }
            }}
            placeholder={prefill ? `name${prefill}` : 'name@example.com'}
          />
          <p className="text-xs text-ink-muted mt-1.5">Needed to sign in. Leave it empty for someone who only owns items.</p>
        </div>

        <div>
          <label className="label" htmlFor="pd-title">
            Title <span className="text-ink-muted font-normal">(optional)</span>
          </label>
          <input id="pd-title" className="input" value={draft.title} onChange={(e) => set('title', e.target.value)} maxLength={120} />
        </div>

        <div>
          <label className="label" htmlFor="pd-role">
            Role
          </label>
          <select
            id="pd-role"
            className="input"
            value={draft.role}
            onChange={(e) => set('role', e.target.value as Role)}
            disabled={isSelf}
          >
            {roleChoices.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}: {o.hint}
              </option>
            ))}
          </select>
          {isSelf && <p className="text-xs text-ink-muted mt-1.5">You can't change your own role.</p>}
        </div>

        <fieldset>
          <legend className="label">Teams</legend>
          <div className="flex gap-4">
            {TEAM_OPTIONS.map((t) => (
              <label key={t.id} className="flex items-center gap-2 text-sm text-ink-primary">
                <input type="checkbox" checked={draft.teams.includes(t.id)} onChange={() => toggleTeam(t.id)} />
                {t.label}
              </label>
            ))}
          </div>
          {draft.teams.length === 0 && (
            <p className="text-xs text-amber-800 mt-1.5">With no team they'll see Leadership only (unless their role sees every team).</p>
          )}
        </fieldset>

        <div>
          <label className="label" htmlFor="pd-aliases">
            Other names <span className="text-ink-muted font-normal">(optional, comma-separated)</span>
          </label>
          <input id="pd-aliases" className="input" value={draft.aliases} onChange={(e) => set('aliases', e.target.value)} placeholder="Nicknames used as owner names" />
        </div>

        {person && (draft.role !== person.role || draft.teams.slice().sort().join() !== person.teams.slice().sort().join()) && (
          <p className="text-xs text-ink-muted">Changing the role or teams signs {isSelf ? 'you' : 'them'} out on other devices.</p>
        )}

        <div className="flex gap-2 pt-2">
          <button type="submit" className="btn-primary" disabled={saving}>
            {saving ? 'Saving…' : person ? 'Save' : 'Add person'}
          </button>
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}

// ── Link panel ───────────────────────────────────────────────────────────────

interface Link {
  name: string;
  url: string;
  expires_at: string;
  purpose: 'setup' | 'reset';
}

function LinkPanel({ link, onDismiss }: { link: Link; onDismiss: () => void }) {
  const [copied, setCopied] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link.url);
      setCopied(true);
    } catch {
      inputRef.current?.select();
    }
  };
  return (
    <div role="status" className="card border-accent/40 mb-6">
      <p className="eyebrow mb-1">{link.purpose === 'reset' ? 'Reset link' : 'Setup link'}</p>
      <p className="text-sm text-ink-primary mb-3">
        Send this to <strong>{link.name}</strong>. It works once and expires {formatDate(link.expires_at, true)}.
        It won't be shown again.
      </p>
      <div className="flex flex-col sm:flex-row gap-2">
        <input ref={inputRef} className="input font-mono text-xs" value={link.url} readOnly onFocus={(e) => e.target.select()} aria-label="Link" />
        <button type="button" className="btn-primary shrink-0" onClick={copy}>
          {copied ? 'Copied' : 'Copy'}
        </button>
        <button type="button" className="btn-ghost shrink-0" onClick={onDismiss}>
          Done
        </button>
      </div>
    </div>
  );
}

// ── Page island ──────────────────────────────────────────────────────────────

export default function PeopleAdmin({
  initialPeople,
  actor,
  emailDomain,
  timeZone,
}: {
  initialPeople: PersonRow[];
  actor: Actor;
  emailDomain: string | null;
  timeZone?: string;
}) {
  displayZone = timeZone;
  const [people, setPeople] = useState<PersonRow[]>(initialPeople);
  const [editing, setEditing] = useState<PersonRow | 'new' | null>(null);
  const [link, setLink] = useState<Link | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [version, setVersion] = useState(0);

  const options: PersonOption[] = useMemo(
    () => people.map((p) => ({ id: p.id, name: p.name, teams: p.teams, active: p.active })),
    [people]
  );

  const reload = async () => {
    try {
      const data = await send('/api/people', 'GET');
      setPeople(data.people ?? []);
      setVersion((v) => v + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not reload people');
    }
  };

  const canManage = (p: PersonRow) => actor.canGrantAdmin || !privileged(p.role);

  const createLink = async (p: PersonRow) => {
    const purpose = p.has_password ? 'reset' : 'setup';
    if (p.link_expires_at && !window.confirm(`${p.name} already has an unused link. Create a new one? The old link will stop working.`)) return;
    setBusyId(p.id);
    setError('');
    try {
      const data = await send(`/api/people/${p.id}/link`, 'POST', { purpose });
      setLink({ name: p.name, url: data.url, expires_at: data.expires_at, purpose: data.purpose });
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the link');
    } finally {
      setBusyId(null);
    }
  };

  const setActive = async (p: PersonRow, active: boolean) => {
    if (!active && !window.confirm(`Deactivate ${p.name}? They'll be signed out and can't sign in. Their items keep their name.`)) return;
    setBusyId(p.id);
    setError('');
    try {
      await send(`/api/people/${p.id}`, 'PATCH', { active });
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update');
    } finally {
      setBusyId(null);
    }
  };

  const noTeams = people.filter((p) => p.active && p.teams.length === 0);

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <h2 className="section-title">People</h2>
        <button type="button" className="btn-primary" onClick={() => setEditing('new')}>
          Add person
        </button>
      </div>

      {link && <LinkPanel link={link} onDismiss={() => setLink(null)} />}

      {error && (
        <div role="alert" className="mb-4 p-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-800">
          {error}
        </div>
      )}

      {noTeams.length > 0 && (
        <div className="mb-4 p-3 bg-amber-50 border border-amber-200 rounded-xl text-sm text-amber-900">
          {noTeams.map((p) => p.name).join(', ')} {noTeams.length === 1 ? 'has' : 'have'} no team, so they only see
          Leadership (unless their role sees every team). Edit them to choose a team.
        </div>
      )}

      <div className="border border-line/70 rounded-2xl overflow-x-auto bg-bg-surface shadow-card">
        <table className="table-brand min-w-[56rem]">
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Role</th>
              <th>Teams</th>
              <th>Status</th>
              <th>Last sign-in</th>
              <th className="text-right">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {people.map((p) => {
              const st = status(p);
              const manageable = canManage(p);
              const busy = busyId === p.id;
              const self = p.id === actor.id;
              return (
                <tr key={p.id} className={p.active ? '' : 'opacity-60'}>
                  <td>
                    <div className="font-semibold">
                      {p.name}
                      {self && <span className="ml-1.5 text-xs font-normal text-ink-muted">(you)</span>}
                    </div>
                    {p.title && <div className="text-xs text-ink-muted">{p.title}</div>}
                    {p.aliases.length > 0 && <div className="text-xs text-ink-muted">Also: {p.aliases.join(', ')}</div>}
                  </td>
                  <td>{p.email ?? <span className="text-ink-muted">No email</span>}</td>
                  <td>{roleLabel(p.role)}</td>
                  <td>
                    {p.teams.length ? (
                      TEAM_OPTIONS.filter((t) => p.teams.includes(t.id))
                        .map((t) => t.label)
                        .join(', ')
                    ) : (
                      <span className="text-amber-800">None</span>
                    )}
                  </td>
                  <td>
                    <span className={`badge ${st.cls}`}>{st.label}</span>
                    {st.label === 'Invited' && p.link_expires_at && (
                      <div className="text-[11px] text-ink-muted mt-0.5">until {formatDate(p.link_expires_at)}</div>
                    )}
                  </td>
                  <td className="whitespace-nowrap">{p.last_login_at ? formatDate(p.last_login_at, true) : <span className="text-ink-muted">Never</span>}</td>
                  <td>
                    {manageable ? (
                      <div className="flex justify-end gap-1 whitespace-nowrap">
                        <button type="button" className="btn-ghost px-2.5 py-1 text-xs" onClick={() => setEditing(p)} disabled={busy}>
                          Edit
                        </button>
                        {p.active && (
                          <span title={p.email ? undefined : 'Add a work email first'}>
                            <button
                              type="button"
                              className="btn-ghost px-2.5 py-1 text-xs"
                              onClick={() => createLink(p)}
                              disabled={busy || !p.email}
                            >
                              {p.has_password ? 'Create reset link' : 'Create setup link'}
                            </button>
                          </span>
                        )}
                        {!self &&
                          (p.active ? (
                            <button type="button" className="btn-ghost px-2.5 py-1 text-xs text-red-700" onClick={() => setActive(p, false)} disabled={busy}>
                              Deactivate
                            </button>
                          ) : (
                            <button type="button" className="btn-ghost px-2.5 py-1 text-xs" onClick={() => setActive(p, true)} disabled={busy}>
                              Reactivate
                            </button>
                          ))}
                      </div>
                    ) : (
                      <p className="text-right text-xs text-ink-muted">Owner only</p>
                    )}
                  </td>
                </tr>
              );
            })}
            {people.length === 0 && (
              <tr>
                <td colSpan={7} className="text-center text-ink-muted py-8">
                  No people yet. Add the first one.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <UnmatchedOwners key={version} people={options} />

      {editing && (
        <Drawer
          person={editing === 'new' ? null : editing}
          actor={actor}
          emailDomain={emailDomain}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await reload();
          }}
        />
      )}
    </div>
  );
}
