import { useState } from 'react';
import type { Rock } from '../types';

// Quarter end: each rock is done or not done, and the team aims for 80 % done.
// "Done" marks the rock complete; "Not done" records the outcome and leaves
// the rock as it is, so the team can carry it into the next quarter (change
// its due date) or drop it.

const TARGET = 80;

interface Props {
  label: string;
  startDate: string;
  endDate: string;
  current: boolean;
  rocks: Rock[];
}

const fmt = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

export default function QuarterEndReview({ label, startDate, endDate, current, rocks: initial }: Props) {
  const [rocks, setRocks] = useState<Rock[]>(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');

  const outcomeOf = (r: Rock): 'done' | 'not_done' | null => (r.status === 'complete' ? 'done' : r.outcome);
  const done = rocks.filter((r) => outcomeOf(r) === 'done').length;
  const notDone = rocks.filter((r) => outcomeOf(r) === 'not_done').length;
  const undecided = rocks.length - done - notDone;
  const pct = rocks.length ? Math.round((done / rocks.length) * 100) : null;

  const mark = async (rock: Rock, outcome: 'done' | 'not_done' | null) => {
    setBusy(rock.id);
    setError('');
    const prev = rocks;
    setRocks((all) =>
      all.map((r) => (r.id === rock.id ? { ...r, outcome, status: outcome === 'done' ? 'complete' : r.status === 'complete' ? 'on_track' : r.status } : r))
    );
    try {
      const body: Record<string, unknown> = { outcome };
      if (outcome !== 'done' && rock.status === 'complete') body.status = 'on_track';
      const res = await fetch(`/api/rocks/${rock.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? 'Could not save');
      if (data.rock) setRocks((all) => all.map((r) => (r.id === rock.id ? { ...r, ...data.rock } : r)));
    } catch (err) {
      setRocks(prev);
      setError(err instanceof Error ? err.message : 'Could not save');
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className={`card ${current ? 'border-accent' : ''}`}>
      <div className="flex flex-wrap items-end justify-between gap-3 mb-4">
        <div>
          <p className="eyebrow">{current ? 'This quarter' : endDate < new Date().toISOString().slice(0, 10) ? 'Past quarter' : 'Ahead'}</p>
          <h2 className="section-title">{label}</h2>
          <p className="text-xs text-ink-muted">
            {fmt(startDate)} – {fmt(endDate)} · {rocks.length} rock{rocks.length === 1 ? '' : 's'}
          </p>
        </div>
        <div className="text-right">
          <div className={`font-display text-3xl font-semibold tracking-tight tabular-nums ${pct == null ? 'text-ink-muted' : pct >= TARGET ? 'text-state-success' : 'text-amber-900'}`}>
            {pct == null ? '—' : `${pct}%`}
          </div>
          <div className="eyebrow">done · target {TARGET}%</div>
        </div>
      </div>
      <p className="text-xs text-ink-muted mb-3">
        <span className="text-state-success font-medium">{done} done</span> · <span className={notDone ? 'text-state-danger font-medium' : ''}>{notDone} not done</span>
        {undecided > 0 && ` · ${undecided} not yet called`}
      </p>
      {error && <p className="text-xs text-state-danger mb-2">{error}</p>}
      <div className="border border-line rounded-xl overflow-hidden">
        {rocks.map((r, i) => {
          const o = outcomeOf(r);
          return (
            <div key={r.id} className={`flex items-center gap-3 px-4 py-3 ${i < rocks.length - 1 ? 'border-b border-line' : ''}`}>
              <div className="flex-1 min-w-0">
                <p className={`text-sm ${o === 'done' ? 'text-ink-muted line-through' : 'text-ink-primary'}`}>{r.title}</p>
                <p className="text-xs text-ink-muted">
                  {r.owner ?? 'No owner'}
                  {r.level && ` · ${r.level}`}
                  {r.due_date && ` · due ${r.due_date}`}
                  {o !== 'done' && r.status === 'off_track' && <span className="text-state-danger"> · off track</span>}
                </p>
              </div>
              <div className="flex gap-1 flex-shrink-0" role="radiogroup" aria-label={`${r.title}: done or not done`}>
                <button
                  role="radio"
                  aria-checked={o === 'done'}
                  disabled={busy === r.id}
                  onClick={() => mark(r, o === 'done' ? null : 'done')}
                  className={`text-xs px-2.5 py-1 rounded-full border font-medium ${o === 'done' ? 'bg-state-success/15 text-state-success border-state-success/30' : 'border-line text-ink-muted hover:text-ink-primary'}`}
                >
                  Done
                </button>
                <button
                  role="radio"
                  aria-checked={o === 'not_done'}
                  disabled={busy === r.id}
                  onClick={() => mark(r, o === 'not_done' ? null : 'not_done')}
                  className={`text-xs px-2.5 py-1 rounded-full border font-medium ${o === 'not_done' ? 'bg-state-danger/15 text-state-danger border-state-danger/30' : 'border-line text-ink-muted hover:text-ink-primary'}`}
                >
                  Not done
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
