import { useMemo, useRef, useState } from 'react';
import StepsPanel from './StepsPanel';
import type { Issue, IssueHorizon, IssuePriority, Step } from '../types';

export type BoardIssue = Issue & { meeting_title: string | null; meeting_date: string | null };

interface Props {
  initialIssues: BoardIssue[];
  stepsByIssue: Record<string, Step[]>;
  initialTab?: IssueHorizon;
}

const TABS: Array<{ id: IssueHorizon; label: string; hint: string }> = [
  { id: 'short', label: 'Short-term', hint: 'The IDS list: work these top-down in the L10.' },
  { id: 'long', label: 'Long-term', hint: 'Parked for later: review quarterly and move up when it is time.' },
];

const PRIORITY_STYLE: Record<IssuePriority, string> = {
  high: 'bg-state-danger/15 text-state-danger border-state-danger/20',
  medium: 'bg-state-warning/15 text-state-warning border-state-warning/20',
  low: 'bg-bg-elevated text-ink-secondary border-line',
};
const PRIORITY_ORDER: Record<IssuePriority, number> = { high: 0, medium: 1, low: 2 };

const byRank = (a: BoardIssue, b: BoardIssue) =>
  (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER) || String(a.created_at).localeCompare(String(b.created_at));

async function send(url: string, method: string, body?: unknown) {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? 'Something went wrong');
  return data;
}

export default function IssuesBoard({ initialIssues, stepsByIssue, initialTab = 'short' }: Props) {
  const [issues, setIssues] = useState<BoardIssue[]>(initialIssues);
  const [tab, setTab] = useState<IssueHorizon>(initialTab);
  const [error, setError] = useState('');
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const [solvingId, setSolvingId] = useState<string | null>(null);
  const [resolution, setResolution] = useState('');

  // Add form
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<IssuePriority>('medium');
  const [saving, setSaving] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);

  const lists = useMemo(() => {
    const open = issues.filter((i) => i.status === 'open');
    return {
      short: open.filter((i) => i.horizon === 'short').sort(byRank),
      long: open.filter((i) => i.horizon === 'long').sort(byRank),
    };
  }, [issues]);
  const list = lists[tab];

  const fail = (err: unknown, restore: BoardIssue[]) => {
    setIssues(restore);
    setError(err instanceof Error ? err.message : 'Something went wrong');
  };

  const selectTab = (t: IssueHorizon) => {
    setTab(t);
    try {
      const url = new URL(window.location.href);
      url.searchParams.set('list', t);
      window.history.replaceState(null, '', url);
    } catch {
      /* ignore */
    }
  };

  /** Saves `ordered` (one list, top to bottom) as ranks 1..n. */
  const saveOrder = async (ordered: BoardIssue[]) => {
    const prev = issues;
    const rankOf = new Map(ordered.map((i, n) => [i.id, n + 1]));
    setIssues((all) => all.map((i) => (rankOf.has(i.id) ? { ...i, rank: rankOf.get(i.id)! } : i)));
    setError('');
    try {
      await send('/api/issues/reorder', 'POST', { horizon: tab, ids: ordered.map((i) => i.id) });
    } catch (err) {
      fail(err, prev);
    }
  };

  const move = (id: string, to: number) => {
    const from = list.findIndex((i) => i.id === id);
    if (from < 0 || to < 0 || to >= list.length || from === to) return;
    const next = [...list];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    saveOrder(next);
  };

  const sortByPriority = () => {
    const next = [...list].sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] || byRank(a, b));
    saveOrder(next);
  };

  const patch = async (issue: BoardIssue, changes: Partial<Issue>) => {
    const prev = issues;
    setIssues((all) => all.map((i) => (i.id === issue.id ? { ...i, ...changes } : i)));
    setError('');
    try {
      const data = await send(`/api/issues/${issue.id}`, 'PATCH', changes);
      if (data.issue) setIssues((all) => all.map((i) => (i.id === issue.id ? { ...i, ...data.issue } : i)));
    } catch (err) {
      fail(err, prev);
    }
  };

  const remove = async (issue: BoardIssue) => {
    if (!window.confirm(`Delete "${issue.title}"? This cannot be undone. Use Drop to keep a record instead.`)) return;
    const prev = issues;
    setIssues((all) => all.filter((i) => i.id !== issue.id));
    try {
      await send(`/api/issues/${issue.id}`, 'DELETE');
    } catch (err) {
      fail(err, prev);
    }
  };

  const add = async () => {
    if (!title.trim()) return;
    setSaving(true);
    setError('');
    try {
      const data = await send('/api/issues', 'POST', {
        title: title.trim(),
        description: description.trim() || null,
        priority,
        horizon: tab,
      });
      setIssues((all) => [...all, { ...data.issue, meeting_title: null, meeting_date: null }]);
      setTitle('');
      setDescription('');
      setPriority('medium');
      titleRef.current?.focus();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add the issue');
    } finally {
      setSaving(false);
    }
  };

  const solve = (issue: BoardIssue) => {
    patch(issue, { status: 'solved', resolution: resolution.trim() || null });
    setSolvingId(null);
    setResolution('');
  };

  const other: IssueHorizon = tab === 'short' ? 'long' : 'short';

  return (
    <div>
      {/* Tabs + actions */}
      <div className="flex flex-wrap items-end justify-between gap-3 mb-3">
        <div className="inline-flex rounded-xl border border-line p-1 bg-bg-elevated" role="tablist">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => selectTab(t.id)}
              className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                tab === t.id ? 'bg-bg-base text-ink-primary shadow-sm' : 'text-ink-muted hover:text-ink-primary'
              }`}
            >
              {t.label} <span className="ml-1 tabular-nums text-ink-muted">{lists[t.id].length}</span>
            </button>
          ))}
        </div>
        <div className="flex gap-2">
          {list.length > 1 && (
            <button onClick={sortByPriority} className="btn-secondary text-sm" title="Re-rank this list: high, then medium, then low">
              Sort by priority
            </button>
          )}
          <button
            onClick={() => {
              setAdding(true);
              setTimeout(() => titleRef.current?.focus(), 0);
            }}
            className="btn-primary text-sm"
          >
            + Add issue
          </button>
        </div>
      </div>
      <p className="text-xs text-ink-muted mb-4">{TABS.find((t) => t.id === tab)!.hint} Drag to rank, or use the arrows.</p>

      {error && <p className="mb-3 p-3 rounded-xl text-sm bg-red-50 border border-red-200 text-red-800">{error}</p>}

      {adding && (
        <div className="border border-line rounded-xl p-4 space-y-3 bg-bg-elevated mb-4">
          <input
            ref={titleRef}
            className="input text-sm"
            placeholder={tab === 'short' ? 'New issue for the IDS list' : 'New long-term issue'}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') add();
              if (e.key === 'Escape') setAdding(false);
            }}
          />
          <input
            className="input text-sm"
            placeholder="Details (optional)"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') add();
            }}
          />
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-ink-muted">Priority:</span>
            {(['high', 'medium', 'low'] as IssuePriority[]).map((p) => (
              <button
                key={p}
                onClick={() => setPriority(p)}
                className={`text-xs px-2.5 py-1 rounded-full border capitalize transition-colors ${
                  priority === p ? PRIORITY_STYLE[p] : 'text-ink-muted border-line hover:border-line-strong'
                }`}
              >
                {p}
              </button>
            ))}
            <span className="text-xs text-ink-muted ml-2">Added to the bottom of the {tab === 'short' ? 'short-term' : 'long-term'} list.</span>
          </div>
          <div className="flex gap-2">
            <button onClick={add} disabled={saving || !title.trim()} className="btn-primary text-sm">
              {saving ? 'Adding…' : 'Add issue'}
            </button>
            <button onClick={() => setAdding(false)} className="btn-secondary text-sm">
              Done
            </button>
          </div>
        </div>
      )}

      {list.length === 0 ? (
        <div className="card text-center py-10">
          <p className="text-sm text-ink-secondary">{tab === 'short' ? 'No open short-term issues.' : 'No long-term issues parked.'}</p>
        </div>
      ) : (
        <ol className="border border-line rounded-xl overflow-hidden">
          {list.map((issue, n) => (
            <li
              key={issue.id}
              onDragOver={(e) => {
                if (!dragId) return;
                e.preventDefault();
                setOverId(issue.id);
              }}
              onDragLeave={() => setOverId((o) => (o === issue.id ? null : o))}
              onDrop={(e) => {
                e.preventDefault();
                if (dragId) move(dragId, n);
                setDragId(null);
                setOverId(null);
              }}
              className={`flex items-start gap-3 px-4 py-3 bg-bg-base ${n < list.length - 1 ? 'border-b border-line' : ''} ${
                dragId === issue.id ? 'opacity-40' : ''
              } ${overId === issue.id && dragId !== issue.id ? 'ring-2 ring-inset ring-accent' : ''}`}
            >
              {/* Rank + arrows */}
              <div
                className="flex flex-col items-center gap-0.5 flex-shrink-0 pt-0.5 w-8 cursor-grab active:cursor-grabbing"
                draggable
                onDragStart={(e) => {
                  setDragId(issue.id);
                  e.dataTransfer.effectAllowed = 'move';
                  e.dataTransfer.setData('text/plain', issue.id);
                }}
                onDragEnd={() => {
                  setDragId(null);
                  setOverId(null);
                }}
                title="Drag to re-rank"
              >
                <span className="font-display text-lg font-semibold tabular-nums text-ink-primary leading-none">
                  {n + 1}
                </span>
                <div className="flex">
                  <button
                    onClick={() => move(issue.id, n - 1)}
                    disabled={n === 0}
                    className="p-0.5 text-ink-muted hover:text-ink-primary disabled:opacity-20"
                    aria-label="Move up"
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
                      <path d="M18 15l-6-6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </button>
                  <button
                    onClick={() => move(issue.id, n + 1)}
                    disabled={n === list.length - 1}
                    className="p-0.5 text-ink-muted hover:text-ink-primary disabled:opacity-20"
                    aria-label="Move down"
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
                      <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </button>
                </div>
              </div>

              {/* Body */}
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-ink-primary">{issue.title}</p>
                {issue.description && <p className="text-xs text-ink-muted mt-0.5">{issue.description}</p>}
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1 text-xs">
                  {issue.meeting_id && issue.meeting_title ? (
                    <a href={`/dashboard/meetings/${issue.meeting_id}?tab=eos`} className="text-accent hover:text-accent-dim">
                      {issue.meeting_title} · {issue.meeting_date}
                    </a>
                  ) : (
                    <span className="text-ink-muted">Added {String(issue.created_at).slice(0, 10)}</span>
                  )}
                  {n > 0 && (
                    <button onClick={() => move(issue.id, 0)} className="text-ink-muted hover:text-ink-primary">
                      Move to top
                    </button>
                  )}
                  <button onClick={() => patch(issue, { horizon: other })} className="text-ink-muted hover:text-ink-primary">
                    {other === 'long' ? 'Move to long-term' : 'Move to short-term'}
                  </button>
                  <button
                    onClick={() => {
                      setSolvingId(solvingId === issue.id ? null : issue.id);
                      setResolution('');
                    }}
                    className="text-state-success hover:underline"
                  >
                    Solve
                  </button>
                  <button onClick={() => patch(issue, { status: 'dropped' })} className="text-ink-muted hover:text-ink-primary">
                    Drop
                  </button>
                  <button onClick={() => remove(issue)} className="text-ink-muted hover:text-state-danger">
                    Delete
                  </button>
                </div>

                {solvingId === issue.id && (
                  <div className="flex gap-2 mt-2">
                    <input
                      autoFocus
                      className="input text-sm flex-1"
                      placeholder="How was it solved? (optional)"
                      value={resolution}
                      onChange={(e) => setResolution(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') solve(issue);
                        if (e.key === 'Escape') setSolvingId(null);
                      }}
                    />
                    <button onClick={() => solve(issue)} className="btn-primary text-sm">
                      Mark solved
                    </button>
                  </div>
                )}

                <StepsPanel type="issue" parentId={issue.id} parentTitle={issue.title} initialSteps={stepsByIssue[issue.id] ?? []} />
              </div>

              {/* Priority */}
              <select
                value={issue.priority}
                onChange={(e) => patch(issue, { priority: e.target.value as IssuePriority })}
                className={`text-xs px-2.5 py-1 rounded-full border font-medium capitalize cursor-pointer bg-transparent flex-shrink-0 ${PRIORITY_STYLE[issue.priority]}`}
                aria-label="Priority"
              >
                <option value="high">High</option>
                <option value="medium">Medium</option>
                <option value="low">Low</option>
              </select>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
