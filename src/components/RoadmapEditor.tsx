import { useState } from 'react';
import OwnerPicker, { type OwnerValue } from './OwnerPicker';
import type { Period, PersonOption, RockLevel, RockStatus, TeamId } from '../types';

// Small forms on the roadmap and rocks pages: add a period, add a rock, and
// the inline controls on each rock card (status, period, owner, due date,
// level, Adopt as Rock, Drop to IDS). Every rock has one owner and a due
// date. Everything reloads the page on success — the boards are
// server-rendered.

const STATUS_LABELS: Record<RockStatus, string> = {
  planned: 'Planned',
  on_track: 'On Track',
  off_track: 'Off Track',
  complete: 'Complete',
  dropped: 'Dropped',
};

async function call(url: string, method: string, body?: unknown) {
  const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? 'Request failed');
  return json;
}

export function AddPeriod() {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      await call('/api/periods', 'POST', { name, start_date: start, end_date: end });
      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save');
      setSaving(false);
    }
  };

  if (!open) return <button onClick={() => setOpen(true)} className="btn-secondary text-sm">Add a period</button>;
  return (
    <div className="border border-line rounded-xl p-4 bg-bg-elevated space-y-3 w-full max-w-lg">
      <div className="grid sm:grid-cols-3 gap-3">
        <input autoFocus className="input text-sm" placeholder="Name, e.g. Aug–Nov 2026" value={name} onChange={(e) => setName(e.target.value)} />
        <input type="date" className="input text-sm" value={start} onChange={(e) => setStart(e.target.value)} aria-label="Start date" />
        <input type="date" className="input text-sm" value={end} onChange={(e) => setEnd(e.target.value)} aria-label="End date" />
      </div>
      {error && <p className="text-xs text-state-danger">{error}</p>}
      <div className="flex gap-2">
        <button onClick={save} disabled={saving || !name.trim() || !start || !end} className="btn-primary text-sm">{saving ? 'Saving…' : 'Add period'}</button>
        <button onClick={() => setOpen(false)} className="btn-secondary text-sm">Cancel</button>
      </div>
    </div>
  );
}

export function AddRock({
  periods,
  defaultPeriodId,
  team,
  people,
  quarterEnd = '',
  status,
}: {
  periods: Period[];
  defaultPeriodId?: string | null;
  team?: TeamId;
  /** Server-rendered picker list (including inactive people). */
  people?: PersonOption[];
  /** Default due date: the end of the current firm quarter. */
  quarterEnd?: string;
  /** Status for the new rock (the Rocks page adds working rocks; the roadmap leaves it to the period). */
  status?: RockStatus;
}) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [owner, setOwner] = useState<OwnerValue>({ owner_id: null, owner: null });
  const [periodId, setPeriodId] = useState(defaultPeriodId ?? '');
  const [dueDate, setDueDate] = useState(quarterEnd);
  const [level, setLevel] = useState<RockLevel | ''>('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const save = async () => {
    if (!owner.owner) { setError('Every rock needs one owner'); return; }
    if (!dueDate) { setError('Every rock needs a due date'); return; }
    setSaving(true);
    setError('');
    try {
      const data = await call('/api/rocks', 'POST', {
        title, owner_id: owner.owner_id, owner: owner.owner, period_id: periodId || null, due_date: dueDate, level: level || null, status,
      });
      if (data.warning) window.alert(data.warning);
      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save');
      setSaving(false);
    }
  };

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="flex items-center gap-1.5 text-sm text-ink-secondary hover:text-ink-primary transition-colors">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
        Add rock
      </button>
    );
  }
  return (
    <div className="border border-line rounded-xl p-4 bg-bg-elevated space-y-3">
      <input autoFocus className="input text-sm" placeholder="Rock title" value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void save(); if (e.key === 'Escape') setOpen(false); }} />
      <div className="grid sm:grid-cols-2 gap-3">
        <OwnerPicker value={owner} onChange={setOwner} team={team} initialPeople={people} allowUnassigned={false} placeholder="Owner (required)" className="text-sm" />
        <select className="input text-sm" value={periodId} onChange={(e) => setPeriodId(e.target.value)} aria-label="Period">
          <option value="">No period yet</option>
          {periods.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
        <label className="text-xs text-ink-muted flex items-center gap-2">
          Due
          <input type="date" className="input text-sm flex-1" value={dueDate} onChange={(e) => setDueDate(e.target.value)} aria-label="Due date" />
        </label>
        <select className="input text-sm" value={level} onChange={(e) => setLevel(e.target.value as RockLevel | '')} aria-label="Level">
          <option value="">Level: not set</option>
          <option value="company">Company rock</option>
          <option value="individual">Individual rock</option>
        </select>
      </div>
      {error && <p className="text-xs text-state-danger">{error}</p>}
      <div className="flex gap-2">
        <button onClick={save} disabled={saving || !title.trim()} className="btn-primary text-sm">{saving ? 'Saving…' : 'Add rock'}</button>
        <button onClick={() => setOpen(false)} className="btn-secondary text-sm">Cancel</button>
      </div>
    </div>
  );
}

export function RockControls({
  rockId,
  title = 'Rock',
  status,
  periodId,
  periods,
  owner = null,
  ownerId = null,
  dueDate = null,
  level = null,
  team,
  people,
  quarterEnd = '',
}: {
  rockId: string;
  /** The rock's title (used when dropping it to IDS). */
  title?: string;
  status: RockStatus;
  periodId: string | null;
  periods: Period[];
  owner?: string | null;
  ownerId?: string | null;
  dueDate?: string | null;
  level?: RockLevel | null;
  team?: TeamId;
  /** Server-rendered picker list (including inactive people). */
  people?: PersonOption[];
  /** The end of the current firm quarter (the due date a rock gets when adopted). */
  quarterEnd?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [due, setDue] = useState(dueDate ?? '');

  const update = async (body: Record<string, unknown>) => {
    setBusy(true);
    setError('');
    try {
      const data = await call(`/api/rocks/${rockId}`, 'PATCH', body);
      if (data.warning) window.alert(data.warning);
      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save');
      setBusy(false);
    }
  };

  /** The team chooses this candidate as a Rock for the quarter. */
  const adopt = () => {
    if (!ownerId && !owner) { setError('Give the rock an owner first'); return; }
    update({ status: 'on_track', due_date: due || quarterEnd || undefined });
  };

  /** Off track: it goes to the Issues List. */
  const dropToIds = async () => {
    setBusy(true);
    setError('');
    try {
      await call('/api/issues', 'POST', { title: `Rock off track: ${title}`.slice(0, 500), rock_id: rockId, owner_id: ownerId, owner, priority: 'high', issue_type: 'problem' });
      window.location.href = '/dashboard/issues';
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not drop to IDS');
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!confirm('Delete this rock and its steps? Meeting records keep their own copy.')) return;
    setBusy(true);
    try {
      await call(`/api/rocks/${rockId}`, 'DELETE');
      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete');
      setBusy(false);
    }
  };

  const tone: Record<RockStatus, string> = {
    planned: 'bg-bg-elevated text-ink-secondary border-line',
    on_track: 'bg-mint-100 text-mint-800 border-mint-200',
    off_track: 'bg-red-100 text-red-800 border-red-200',
    complete: 'bg-blue-50 text-blue-700 border-blue-200',
    dropped: 'bg-bg-elevated text-ink-muted border-line',
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        value={status}
        disabled={busy}
        onChange={(e) => update({ status: e.target.value })}
        className={`text-xs px-2.5 py-1 rounded-full border font-semibold cursor-pointer ${tone[status]}`}
        aria-label="Rock status"
      >
        {(Object.keys(STATUS_LABELS) as RockStatus[]).map((s) => (
          <option key={s} value={s}>{STATUS_LABELS[s]}</option>
        ))}
      </select>
      <select value={periodId ?? ''} disabled={busy} onChange={(e) => update({ period_id: e.target.value || null })} className="text-xs px-2 py-1 rounded-full border border-line bg-bg-surface text-ink-secondary cursor-pointer" aria-label="Period">
        <option value="">No period</option>
        {periods.map((p) => (
          <option key={p.id} value={p.id}>{p.name}</option>
        ))}
      </select>
      <OwnerPicker
        size="sm"
        value={{ owner_id: ownerId, owner }}
        onChange={(v) => update({ owner_id: v.owner_id, owner: v.owner })}
        team={team}
        initialPeople={people}
        allowUnassigned={false}
        placeholder="Owner (required)"
        disabled={busy}
        aria-label="Rock owner"
      />
      <input
        type="date"
        value={due}
        disabled={busy}
        onChange={(e) => setDue(e.target.value)}
        onBlur={() => { if (due && due !== (dueDate ?? '')) update({ due_date: due }); }}
        className={`text-xs px-2 py-1 rounded-full border bg-bg-surface cursor-pointer ${dueDate ? 'border-line text-ink-secondary' : 'border-state-warning text-state-warning'}`}
        aria-label="Due date"
        title={dueDate ? `Due ${dueDate}` : 'No due date yet'}
      />
      <select value={level ?? ''} disabled={busy} onChange={(e) => update({ level: e.target.value || null })} className="text-xs px-2 py-1 rounded-full border border-line bg-bg-surface text-ink-secondary cursor-pointer" aria-label="Level">
        <option value="">Level?</option>
        <option value="company">Company</option>
        <option value="individual">Individual</option>
      </select>
      {status === 'planned' && (
        <button onClick={adopt} disabled={busy} className="text-xs px-2.5 py-1 rounded-full border border-accent/30 bg-accent/10 text-accent font-semibold hover:bg-accent/20" title="Make this candidate a Rock for the quarter">
          Adopt as Rock
        </button>
      )}
      {status === 'off_track' && (
        <button onClick={dropToIds} disabled={busy} className="text-xs text-state-danger hover:underline" title="Add this rock to the Issues List">
          Drop to IDS
        </button>
      )}
      <button onClick={remove} disabled={busy} className="text-xs text-ink-muted hover:text-state-danger ml-auto" aria-label="Delete rock">Delete</button>
      {error && <p className="w-full text-xs text-state-danger">{error}</p>}
    </div>
  );
}
