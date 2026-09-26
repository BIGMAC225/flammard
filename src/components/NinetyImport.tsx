import { useMemo, useRef, useState } from 'react';
import OwnerPicker from './OwnerPicker';
import {
  KIND_LABELS,
  MAX_ROWS,
  UNVERIFIED_KINDS,
  parseNinetyWorkbook,
  periodKey,
  rockStatusFrom,
  rockTitleKey,
  type NinetyKind,
  type NinetyRow,
  type ParsedFile,
} from '../lib/ninety';
import { quarterRange } from '../lib/quarters';
import { readWorkbook } from '../lib/xlsx';
import type { CompanySettings, PersonOption, TeamId } from '../types';

// Ninety importer (spec §6.5): upload the XLSX exports → they are parsed here
// in the browser (open items only) → preview (duplicates, owner matches,
// periods) → choose owners, quarters and rows → one commit.

interface PeriodRow {
  id: string;
  team: TeamId;
  name: string;
  start_date: string;
  end_date: string;
}
interface Preview {
  existing: string[];
  existingKeys: string[];
  owners: Record<string, { person_id: string; name: string } | null>;
  periods: PeriodRow[];
  rocksByTitle: Record<string, Array<{ id: string; title: string }>>;
  settings: CompanySettings;
}
type OwnerMode = 'match' | 'choose' | 'create' | 'text';
interface OwnerState {
  mode: OwnerMode;
  person_id: string | null;
  person_name: string | null;
  add_alias: boolean;
  create_name: string;
}
type PeriodState =
  | { mode: 'existing'; period_id: string }
  | { mode: 'create'; name: string; start_date: string; end_date: string }
  | { mode: 'none' };

const TEAM_LABEL: Record<TeamId, string> = { leadership: 'Leadership', management: 'Management' };
const key = (s: string) => s.trim().toLowerCase();
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const GROUPS: Array<{ id: string; label: string; test: (r: NinetyRow) => boolean; kind: NinetyKind }> = [
  { id: 'issue-short', label: 'Issues: short-term', test: (r) => r.kind === 'issue' && r.horizon !== 'long', kind: 'issue' },
  { id: 'issue-long', label: 'Issues: long-term', test: (r) => r.kind === 'issue' && r.horizon === 'long', kind: 'issue' },
  { id: 'todo', label: 'To-dos', test: (r) => r.kind === 'todo', kind: 'todo' },
  { id: 'rock', label: 'Rocks', test: (r) => r.kind === 'rock', kind: 'rock' },
  { id: 'milestone', label: 'Milestones', test: (r) => r.kind === 'milestone', kind: 'milestone' },
  { id: 'headline', label: 'Headlines', test: (r) => r.kind === 'headline', kind: 'headline' },
  { id: 'measurable', label: 'Measurables', test: (r) => r.kind === 'measurable', kind: 'measurable' },
];

export default function NinetyImport({ initialPeople }: { initialPeople?: PersonOption[] }) {
  const [files, setFiles] = useState<ParsedFile[]>([]);
  const [failed, setFailed] = useState<Array<{ file: string; error: string }>>([]);
  const [fileTeam, setFileTeam] = useState<Record<string, TeamId | ''>>({});
  const [preview, setPreview] = useState<Preview | null>(null);
  const [included, setIncluded] = useState<Record<string, boolean>>({});
  const [owners, setOwners] = useState<Record<string, OwnerState>>({});
  const [periods, setPeriods] = useState<Record<string, PeriodState>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [result, setResult] = useState<{ counts: Record<string, number>; warnings: string[] } | null>(null);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const reset = () => {
    setFiles([]);
    setFailed([]);
    setFileTeam({});
    setPreview(null);
    setIncluded({});
    setOwners({});
    setPeriods({});
    setResult(null);
    setError('');
    if (inputRef.current) inputRef.current.value = '';
  };

  // ── Rows: one per key across files (duplicate downloads collapse), file team applied
  const { rows, dupesByFile } = useMemo(() => {
    const seen = new Set<string>();
    const out: NinetyRow[] = [];
    const dupes: Record<string, number> = {};
    for (const f of files) {
      for (const r of f.rows) {
        if (seen.has(r.key)) {
          dupes[f.file] = (dupes[f.file] ?? 0) + 1;
          continue;
        }
        seen.add(r.key);
        out.push({ ...r, team: (fileTeam[f.file] || r.team) as TeamId | null });
      }
    }
    return { rows: out, dupesByFile: dupes };
  }, [files, fileTeam]);

  const existingKeys = useMemo(() => new Set(preview?.existingKeys ?? []), [preview]);
  const today = new Date().toLocaleDateString('en-CA');

  // Why a row can't be imported (null = it can)
  const blocked = (r: NinetyRow): string | null => {
    if (existingKeys.has(r.key)) return 'Already imported';
    if (r.kind === 'milestone') {
      if (!r.rockName) return 'No rock named';
      const parent = rows.find((x) => x.kind === 'rock' && rockTitleKey(x.team, x.title) === rockTitleKey(r.team, r.rockName!));
      if (parent && !existingKeys.has(parent.key)) return included[parent.key] ? null : 'Its rock is not being imported';
      const existing = (preview?.rocksByTitle[r.team ?? ''] ?? []).some((x) => key(x.title) === key(r.rockName!));
      return existing || parent ? null : `No rock "${r.rockName}" in this team`;
    }
    return null;
  };
  const isIn = (r: NinetyRow) => !!included[r.key] && !blocked(r);
  const chosen = rows.filter(isIn);

  // ── Load files
  const load = async (list: FileList | File[]) => {
    const picked = Array.from(list).filter((f) => /\.xlsx$/i.test(f.name));
    if (!picked.length) {
      setError('Choose one or more .xlsx files exported from Ninety');
      return;
    }
    setBusy('Reading the files…');
    setError('');
    const parsed: ParsedFile[] = [...files];
    const bad: Array<{ file: string; error: string }> = [...failed];
    for (const f of picked) {
      if (parsed.some((p) => p.file === f.name)) continue;
      try {
        const wb = await readWorkbook(await f.arrayBuffer());
        parsed.push(parseNinetyWorkbook(f.name, wb));
      } catch (err) {
        bad.push({ file: f.name, error: err instanceof Error ? err.message : 'Could not read the file' });
      }
    }
    setFiles(parsed);
    setFailed(bad);
    setFileTeam((t) => {
      const next = { ...t };
      for (const p of parsed) if (!(p.file in next)) next[p.file] = p.team ?? '';
      return next;
    });

    // Preview everything parsed so far
    const all: NinetyRow[] = [];
    const seen = new Set<string>();
    for (const p of parsed) for (const r of p.rows) if (!seen.has(r.key)) (seen.add(r.key), all.push(r));
    if (all.length > MAX_ROWS) {
      setError(`That is ${all.length} rows; an import takes at most ${MAX_ROWS}. Import the files in smaller groups.`);
      setBusy(null);
      return;
    }
    setBusy('Checking for duplicates and matching owners…');
    try {
      const res = await fetch('/api/import/ninety/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows: all }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? `Preview failed (${res.status})`);
      const pv = json as Preview;
      setPreview(pv);
      initChoices(all, pv);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Preview failed');
    } finally {
      setBusy(null);
    }
  };

  const initChoices = (all: NinetyRow[], pv: Preview) => {
    const exist = new Set(pv.existingKeys);
    setIncluded((prev) => {
      const next = { ...prev };
      for (const r of all) if (!(r.key in next)) next[r.key] = !exist.has(r.key) && r.kind !== 'headline';
      return next;
    });
    const textOnly = new Set(pv.settings.text_only_owner_names.map(key));
    setOwners((prev) => {
      const next = { ...prev };
      for (const name of new Set(all.map((r) => r.ownerName).filter((n): n is string => !!n))) {
        if (next[name]) continue;
        const m = pv.owners[name];
        const useMatch = !!m && !textOnly.has(key(name));
        next[name] = {
          mode: useMatch ? 'match' : 'text',
          person_id: useMatch ? m!.person_id : null,
          person_name: useMatch ? m!.name : null,
          add_alias: true,
          create_name: name,
        };
      }
      return next;
    });
    setPeriods((prev) => {
      const next = { ...prev };
      for (const r of all) {
        if (r.kind !== 'rock' || !r.quarter || !r.team) continue;
        const k = periodKey(r.team, r.quarter);
        if (next[k]) continue;
        next[k] = defaultPeriod(r.team, r.quarter, pv);
      }
      return next;
    });
  };

  const defaultPeriod = (team: TeamId, quarter: string, pv: Preview): PeriodState => {
    const same = pv.periods.find((p) => p.team === team && key(p.name) === key(quarter));
    if (same) return { mode: 'existing', period_id: same.id };
    const range = quarterRange(quarter, pv.settings);
    return { mode: 'create', name: quarter.trim(), start_date: range?.start_date ?? '', end_date: range?.end_date ?? '' };
  };

  // ── Derived panels
  const ownerNames = [...new Set(chosen.map((r) => r.ownerName).filter((n): n is string => !!n))].sort();
  const quarterKeys = [
    ...new Set(chosen.filter((r) => r.kind === 'rock' && r.quarter && r.team).map((r) => periodKey(r.team!, r.quarter!))),
  ].sort();
  // A team change on a file can introduce a (team, quarter) pair the preview didn't set up
  const pState = (k: string): PeriodState => {
    if (periods[k]) return periods[k];
    if (!preview) return { mode: 'none' };
    const [team, ...q] = k.split('|');
    return defaultPeriod(team as TeamId, q.join('|'), preview);
  };

  const ownerLabel = (name: string | null) => {
    if (!name) return 'Unassigned';
    const o = owners[name];
    if (!o) return name;
    if (o.mode === 'match' || o.mode === 'choose') return o.person_name ?? 'Choose a person';
    if (o.mode === 'create') return `${o.create_name} (new)`;
    return `${name} (text)`;
  };

  const periodOf = (r: NinetyRow): PeriodRow | { name: string; start_date: string } | null => {
    if (!r.quarter || !r.team) return null;
    const p = pState(periodKey(r.team, r.quarter));
    if (!p || p.mode === 'none') return null;
    if (p.mode === 'existing') return preview?.periods.find((x) => x.id === p.period_id) ?? null;
    return { name: p.name, start_date: p.start_date };
  };

  const statusOf = (r: NinetyRow): string => {
    if (r.kind === 'issue' || r.kind === 'todo') return 'Open';
    if (r.kind === 'milestone') return r.completedOn ? 'Done' : 'Open';
    if (r.kind === 'headline') return r.headlineType ?? 'general';
    if (r.kind === 'measurable') return plural(r.values?.length ?? 0, 'value');
    const { status } = rockStatusFrom(r.statusRaw);
    const p = periodOf(r);
    if (status === 'on_track' && p?.start_date && p.start_date > today) return 'Planned';
    return { on_track: 'On track', off_track: 'Off track', complete: 'Complete', dropped: 'Dropped' }[status];
  };

  const problems: string[] = [];
  if (chosen.some((r) => !r.team)) problems.push('Choose a team for every file with included rows');
  for (const k of quarterKeys) {
    const p = pState(k);
    if (p?.mode === 'create' && (!p.name.trim() || !p.start_date || !p.end_date || p.end_date < p.start_date)) {
      problems.push(`Give the period for ${k.split('|').slice(1).join('|')} a name and valid dates`);
    }
    if (p?.mode === 'existing' && !p.period_id) problems.push(`Choose a period for ${k.split('|').slice(1).join('|')}`);
  }
  for (const n of ownerNames) {
    const o = owners[n];
    if (o && (o.mode === 'match' || o.mode === 'choose') && !o.person_id) problems.push(`Choose a person for "${n}"`);
    if (o?.mode === 'create' && !o.create_name.trim()) problems.push(`Give the new person for "${n}" a name`);
  }

  // ── Commit
  const commit = async () => {
    const ownerPayload: Record<string, unknown> = {};
    for (const n of ownerNames) {
      const o = owners[n];
      if (o.mode === 'match' || o.mode === 'choose') {
        const differs = key(o.person_name ?? '') !== key(n);
        ownerPayload[n] = { person_id: o.person_id, add_alias: differs && o.add_alias };
      } else if (o.mode === 'create') {
        const teams = [...new Set(chosen.filter((r) => r.ownerName === n && r.team).map((r) => r.team!))];
        ownerPayload[n] = { create: { name: o.create_name.trim(), teams } };
      } else ownerPayload[n] = { text_only: true };
    }
    const periodPayload: Record<string, unknown> = {};
    for (const k of quarterKeys) {
      const p = pState(k);
      periodPayload[k] =
        p.mode === 'existing'
          ? { period_id: p.period_id }
          : p.mode === 'create'
            ? { create: { name: p.name.trim(), start_date: p.start_date, end_date: p.end_date } }
            : { none: true };
    }
    setBusy('Importing…');
    setError('');
    try {
      const res = await fetch('/api/import/ninety/commit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          files: files.filter((f) => f.recognised).map((f) => f.file),
          rows: chosen,
          owners: ownerPayload,
          periods: periodPayload,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? `Import failed (${res.status})`);
      setResult({ counts: json.counts ?? {}, warnings: json.warnings ?? [] });
      window.dispatchEvent(new CustomEvent('ninety-import:changed'));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import failed');
    } finally {
      setBusy(null);
    }
  };

  // ── Render
  if (result) {
    const c = result.counts;
    const items: Array<[string, number | undefined]> = [
      ['issues', c.issues],
      ['to-dos', c.todos],
      ['rocks', c.rocks],
      ['milestones', c.steps],
      ['headlines', c.headlines],
      ['metrics', c.metrics],
      ['scorecard values', c.entries],
      ['people created', c.people],
      ['periods created', c.periods],
      ['aliases added', c.aliases],
    ];
    return (
      <section className="card space-y-4">
        <h2 className="section-title">Import complete</h2>
        <ul className="grid gap-1 sm:grid-cols-2 text-sm text-ink-secondary">
          {items.filter(([, n]) => n).map(([label, n]) => (
            <li key={label}><span className="font-semibold text-ink-primary tabular-nums">{n}</span> {label}</li>
          ))}
        </ul>
        {!!c.skipped_duplicates && <p className="text-sm text-ink-muted">{plural(c.skipped_duplicates, 'item')} already imported were skipped.</p>}
        {result.warnings.map((w) => (
          <p key={w} className="text-xs text-state-warning">{w}</p>
        ))}
        <div className="flex flex-wrap gap-3">
          <a className="btn-secondary text-sm" href="/dashboard/issues">Issues</a>
          <a className="btn-secondary text-sm" href="/dashboard/todos">To-Dos</a>
          <a className="btn-secondary text-sm" href="/dashboard/rocks">Rocks</a>
          <button type="button" className="btn-ghost text-sm" onClick={reset}>Import more files</button>
        </div>
      </section>
    );
  }

  return (
    <div className="space-y-6">
      {/* Upload */}
      <section
        className={`card border-dashed text-center ${dragging ? 'ring-2 ring-accent-ring' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          void load(e.dataTransfer.files);
        }}
      >
        <p className="text-sm text-ink-secondary">
          Drop Ninety XLSX exports here (issues, to-dos, rocks; headlines and scorecard too), or
        </p>
        <button type="button" className="btn-secondary text-sm mt-3" disabled={!!busy} onClick={() => inputRef.current?.click()}>
          Choose files
        </button>
        <input ref={inputRef} type="file" accept=".xlsx" multiple hidden onChange={(e) => e.target.files && void load(e.target.files)} />
        <p className="text-xs text-ink-muted mt-3">
          Files are read in your browser. Only open items are imported; completed and archived ones are skipped.
        </p>
        {files.length > 0 && (
          <button type="button" className="btn-ghost text-xs mt-2" disabled={!!busy} onClick={reset}>Start over</button>
        )}
      </section>

      {busy && <p className="text-sm text-ink-secondary">{busy}</p>}
      {error && <p className="text-sm text-state-danger">{error}</p>}

      {/* Files */}
      {(files.length > 0 || failed.length > 0) && (
        <section className="card p-0 overflow-hidden">
          {files.map((f, i) => (
            <div key={f.file} className={`px-5 py-4 ${i ? 'border-t border-line' : ''}`}>
              <div className="flex flex-wrap items-center gap-3">
                <p className="text-sm font-medium text-ink-primary flex-1 min-w-0 truncate">{f.file}</p>
                {f.recognised ? (
                  <>
                    <span className="text-xs text-ink-muted">{f.kinds.map((k) => KIND_LABELS[k]).join(', ')}</span>
                    {f.kinds.some((k) => UNVERIFIED_KINDS.includes(k)) && <span className="badge bg-state-warning/15 text-state-warning">unverified format</span>}
                    <select
                      className="input py-1.5 text-sm w-auto"
                      aria-label={`Team for ${f.file}`}
                      value={fileTeam[f.file] ?? ''}
                      onChange={(e) => setFileTeam((t) => ({ ...t, [f.file]: e.target.value as TeamId | '' }))}
                    >
                      <option value="">Team…</option>
                      <option value="leadership">Leadership</option>
                      <option value="management">Management</option>
                    </select>
                  </>
                ) : (
                  <span className="badge bg-state-danger/15 text-state-danger">not recognised</span>
                )}
              </div>
              <p className="text-xs text-ink-muted mt-1">
                {plural(f.rows.length, 'open item')}
                {f.skipped > 0 && ` · ${plural(f.skipped, 'completed or archived item')} skipped (open items only)`}
                {dupesByFile[f.file] ? ` · ${plural(dupesByFile[f.file], 'row')} also in another file (counted once)` : ''}
              </p>
              {!f.recognised &&
                f.sheets.map((s) => (
                  <p key={s.name} className="text-xs text-ink-muted mt-1">
                    Sheet “{s.name}”: {s.headers.length ? s.headers.join(', ') : 'empty'}
                  </p>
                ))}
              {f.warnings.map((w) => (
                <p key={w} className="text-xs text-state-warning mt-1">{w}</p>
              ))}
            </div>
          ))}
          {failed.map((f) => (
            <div key={f.file} className="px-5 py-4 border-t border-line">
              <p className="text-sm font-medium text-ink-primary">{f.file}</p>
              <p className="text-xs text-state-danger mt-1">{f.error}</p>
            </div>
          ))}
        </section>
      )}

      {preview && rows.length > 0 && (
        <>
          {/* Owners */}
          {ownerNames.length > 0 && (
            <section className="card space-y-4">
              <div>
                <h2 className="section-title">Owners</h2>
                <p className="text-sm text-ink-secondary mt-0.5">
                  Match each Ninety name to a person, create one, or keep the name as text with no account (for example a consultant).
                </p>
              </div>
              {ownerNames.map((n) => {
                const o = owners[n];
                if (!o) return null;
                const count = chosen.filter((r) => r.ownerName === n).length;
                const match = preview.owners[n];
                const update = (patch: Partial<OwnerState>) => setOwners((s) => ({ ...s, [n]: { ...s[n], ...patch } }));
                const differs = (o.mode === 'match' || o.mode === 'choose') && o.person_name && key(o.person_name) !== key(n);
                return (
                  <div key={n} className="flex flex-wrap items-center gap-3 border-t border-line/70 pt-3">
                    <div className="w-48 min-w-0">
                      <p className="text-sm font-medium text-ink-primary truncate">{n}</p>
                      <p className="text-xs text-ink-muted">{plural(count, 'item')}</p>
                    </div>
                    <select
                      className="input py-1.5 text-sm w-auto"
                      aria-label={`What to do with ${n}`}
                      value={o.mode}
                      onChange={(e) => {
                        const mode = e.target.value as OwnerMode;
                        if (mode === 'match' && match) update({ mode, person_id: match.person_id, person_name: match.name });
                        else if (mode === 'choose') update({ mode, person_id: null, person_name: null });
                        else update({ mode });
                      }}
                    >
                      {match && <option value="match">Match: {match.name}</option>}
                      <option value="choose">Choose person…</option>
                      <option value="create">Create person “{n}”</option>
                      <option value="text">Keep as text (no account)</option>
                    </select>
                    {o.mode === 'choose' && (
                      <OwnerPicker
                        value={{ owner_id: o.person_id, owner: o.person_name }}
                        onChange={(v) => update({ person_id: v.owner_id, person_name: v.owner })}
                        allowUnassigned={false}
                        placeholder="Choose a person"
                        initialPeople={initialPeople}
                        className="py-1.5 w-auto"
                      />
                    )}
                    {o.mode === 'create' && (
                      <input
                        className="input py-1.5 text-sm w-56"
                        aria-label="New person's name"
                        value={o.create_name}
                        onChange={(e) => update({ create_name: e.target.value })}
                      />
                    )}
                    {differs && (
                      <label className="flex items-center gap-1.5 text-xs text-ink-secondary">
                        <input type="checkbox" checked={o.add_alias} onChange={(e) => update({ add_alias: e.target.checked })} />
                        Remember “{n}” as an alias
                      </label>
                    )}
                  </div>
                );
              })}
            </section>
          )}

          {/* Quarters */}
          {quarterKeys.length > 0 && (
            <section className="card space-y-4">
              <div>
                <h2 className="section-title">Quarters</h2>
                <p className="text-sm text-ink-secondary mt-0.5">Place each Ninety quarter in a Flammard period. New periods use the quarters in Settings.</p>
              </div>
              {quarterKeys.map((k) => {
                const [team, ...rest] = k.split('|') as [TeamId, ...string[]];
                const quarter = rest.join('|');
                const p = pState(k);
                const teamPeriods = preview.periods.filter((x) => x.team === team);
                const update = (next: PeriodState) => setPeriods((s) => ({ ...s, [k]: next }));
                const value = p.mode === 'existing' ? `p:${p.period_id}` : p.mode;
                return (
                  <div key={k} className="flex flex-wrap items-center gap-3 border-t border-line/70 pt-3">
                    <div className="w-48">
                      <p className="text-sm font-medium text-ink-primary">{quarter}</p>
                      <p className="text-xs text-ink-muted">{TEAM_LABEL[team]} · {plural(chosen.filter((r) => r.kind === 'rock' && r.team === team && r.quarter === quarter).length, 'rock')}</p>
                    </div>
                    <select
                      className="input py-1.5 text-sm w-auto"
                      aria-label={`Period for ${quarter}`}
                      value={value}
                      onChange={(e) => {
                        const v = e.target.value;
                        if (v.startsWith('p:')) update({ mode: 'existing', period_id: v.slice(2) });
                        else if (v === 'create') {
                          const r = quarterRange(quarter, preview.settings);
                          update({ mode: 'create', name: quarter, start_date: r?.start_date ?? '', end_date: r?.end_date ?? '' });
                        } else update({ mode: 'none' });
                      }}
                    >
                      {teamPeriods.map((x) => (
                        <option key={x.id} value={`p:${x.id}`}>Existing: {x.name} ({x.start_date} – {x.end_date})</option>
                      ))}
                      <option value="create">Create period</option>
                      <option value="none">No period (keep the quarter text)</option>
                    </select>
                    {p.mode === 'create' && (
                      <div className="flex flex-wrap items-center gap-2">
                        <input className="input py-1.5 text-sm w-40" aria-label="Period name" value={p.name}
                          onChange={(e) => update({ ...p, name: e.target.value })} />
                        <input className="input py-1.5 text-sm w-auto" type="date" aria-label="Start date" value={p.start_date}
                          onChange={(e) => update({ ...p, start_date: e.target.value })} />
                        <span className="text-ink-muted text-sm">to</span>
                        <input className="input py-1.5 text-sm w-auto" type="date" aria-label="End date" value={p.end_date}
                          onChange={(e) => update({ ...p, end_date: e.target.value })} />
                      </div>
                    )}
                  </div>
                );
              })}
            </section>
          )}

          {/* Items */}
          <section className="space-y-3">
            {GROUPS.map((g) => {
              const list = rows.filter(g.test);
              if (!list.length) return null;
              const selectable = list.filter((r) => !blocked(r));
              const on = selectable.filter((r) => included[r.key]).length;
              const toggleAll = (v: boolean) =>
                setIncluded((s) => {
                  const next = { ...s };
                  for (const r of selectable) next[r.key] = v;
                  return next;
                });
              return (
                <details key={g.id} className="card p-0 overflow-hidden" open={g.kind !== 'headline'}>
                  <summary className="px-5 py-3 cursor-pointer flex items-center gap-3">
                    <input
                      type="checkbox"
                      aria-label={`Select all ${g.label}`}
                      checked={selectable.length > 0 && on === selectable.length}
                      ref={(el) => {
                        if (el) el.indeterminate = on > 0 && on < selectable.length;
                      }}
                      disabled={!selectable.length}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => toggleAll(e.target.checked)}
                    />
                    <span className="text-sm font-semibold text-ink-primary">{g.label}</span>
                    <span className="text-xs text-ink-muted">{on} of {list.length} selected</span>
                    {UNVERIFIED_KINDS.includes(g.kind) && <span className="badge bg-state-warning/15 text-state-warning">unverified format</span>}
                    {g.kind === 'headline' && <span className="text-xs text-ink-muted">Imported headlines are not shown anywhere until a later update</span>}
                  </summary>
                  <ul>
                    {list.map((r) => {
                      const why = blocked(r);
                      return (
                        <li key={r.key} className={`px-5 py-2.5 border-t border-line/70 flex gap-3 ${why ? 'opacity-50' : ''}`}>
                          <input
                            type="checkbox"
                            className="mt-1"
                            aria-label={`Import ${r.title}`}
                            disabled={!!why}
                            checked={!why && !!included[r.key]}
                            onChange={(e) => setIncluded((s) => ({ ...s, [r.key]: e.target.checked }))}
                          />
                          <div className="flex-1 min-w-0">
                            <p className="text-sm text-ink-primary">{r.title}</p>
                            <p className="text-xs text-ink-muted mt-0.5">
                              {ownerLabel(r.ownerName)} · {r.team ? TEAM_LABEL[r.team] : <span className="text-state-danger">no team</span>}
                              {r.dueDate ? ` · due ${r.dueDate}` : r.createdAt ? ` · created ${r.createdAt.slice(0, 10)}` : ''}
                              {r.kind === 'rock' && r.quarter ? ` · ${r.quarter}` : ''}
                              {r.kind === 'rock' && r.level ? ` · ${r.level}` : ''}
                              {r.kind === 'issue' && r.priorityNumber != null ? ` · priority ${r.priorityNumber}` : ''}
                              {r.kind === 'issue' && r.who ? ` · who: ${r.who}` : ''}
                              {r.kind === 'milestone' && r.rockName ? ` · rock: ${r.rockName}` : ''}
                              {' · '}
                              <span className="text-ink-secondary">{statusOf(r)}</span>
                            </p>
                            {why && <p className="text-xs text-ink-muted mt-0.5">{why}</p>}
                            {r.warnings.map((w) => (
                              <p key={w} className="text-xs text-state-warning mt-0.5">{w}</p>
                            ))}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </details>
              );
            })}
          </section>

          {/* Commit */}
          <section className="flex flex-wrap items-center gap-4">
            <button type="button" className="btn-primary" disabled={!!busy || !chosen.length || problems.length > 0} onClick={commit}>
              Import {plural(chosen.length, 'item')}
            </button>
            {problems.map((p) => (
              <span key={p} className="text-xs text-state-warning">{p}</span>
            ))}
          </section>
        </>
      )}
    </div>
  );
}
