import { useMemo, useState } from 'react';
import { readStreamedJSON } from '../lib/stream-json';
import type { ProposedStep, Step, StepParentType } from '../types';

interface Props {
  type: StepParentType;
  parentId: string;
  parentTitle: string;
  initialSteps: Step[];
  /** Start expanded (e.g. on a detail page). */
  open?: boolean;
}

const DETAIL_LABELS: Record<1 | 2 | 3, string> = {
  1: 'Broad — a few big steps',
  2: 'Normal — steps with sub-steps',
  3: 'Detailed — a full checklist',
};

/**
 * Breaks a to-do, issue or rock into steps and sub-steps: a checklist you
 * add to by hand or let Claude propose (reviewed before saving).
 */
export default function StepsPanel({ type, parentId, parentTitle, initialSteps, open = false }: Props) {
  const [steps, setSteps] = useState<Step[]>(initialSteps);
  const [expanded, setExpanded] = useState(open);
  const [adding, setAdding] = useState<string | null>(null); // parent_step_id or '' for top level
  const [newTitle, setNewTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // AI breakdown
  const [detail, setDetail] = useState<1 | 2 | 3>(2);
  const [note, setNote] = useState('');
  const [generating, setGenerating] = useState(false);
  const [proposal, setProposal] = useState<ProposedStep[] | null>(null);
  const [picked, setPicked] = useState<boolean[][]>([]); // [step][0 = step itself, 1.. = substeps]

  const top = useMemo(() => steps.filter((s) => !s.parent_step_id), [steps]);
  const children = (id: string) => steps.filter((s) => s.parent_step_id === id);
  const doneCount = steps.filter((s) => s.done).length;

  const post = async (url: string, method: string, body?: unknown) => {
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error ?? 'Request failed');
    return json;
  };

  const toggle = async (step: Step) => {
    const done = !step.done;
    // Remember every row we change so a failed save can put all of them back
    const before = new Map<string, Step>();
    setSteps((all) =>
      all.map((s) => {
        const cascadesDown = done && s.parent_step_id === step.id;
        const cascadesUp = !done && !!step.parent_step_id && s.id === step.parent_step_id;
        if (s.id === step.id || cascadesDown || cascadesUp) {
          before.set(s.id, s);
          return { ...s, done: s.id === step.id ? done : cascadesDown };
        }
        return s;
      })
    );
    try {
      await post(`/api/steps/${step.id}`, 'PATCH', { done });
    } catch (err) {
      setSteps((all) => all.map((s) => before.get(s.id) ?? s));
      setError(err instanceof Error ? err.message : 'Could not save');
    }
  };

  const remove = async (step: Step) => {
    const removed = steps.filter((s) => s.id === step.id || s.parent_step_id === step.id);
    setSteps((all) => all.filter((s) => s.id !== step.id && s.parent_step_id !== step.id));
    try {
      await post(`/api/steps/${step.id}`, 'DELETE');
    } catch (err) {
      setSteps((all) => [...all, ...removed].sort((a, b) => a.sort_order - b.sort_order || a.created_at.localeCompare(b.created_at)));
      setError(err instanceof Error ? err.message : 'Could not delete');
    }
  };

  const addManual = async () => {
    if (!newTitle.trim()) return;
    setBusy(true);
    setError('');
    try {
      const json = await post('/api/steps', 'POST', {
        type,
        id: parentId,
        steps: [{ title: newTitle.trim() }],
        ...(adding ? { under: adding } : {}),
      });
      setSteps(json.steps);
      setNewTitle('');
      setAdding(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add');
    } finally {
      setBusy(false);
    }
  };

  const generate = async () => {
    setGenerating(true);
    setError('');
    setProposal(null);
    try {
      const res = await fetch('/api/steps/breakdown', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, id: parentId, detail, note: note.trim() || undefined }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? 'Breakdown failed');
      const json = await readStreamedJSON<{ steps: ProposedStep[] }>(res);
      if (json.error || !json.steps) throw new Error(json.error ?? 'Breakdown failed');
      setProposal(json.steps);
      setPicked(json.steps.map((s) => [true, ...s.substeps.map(() => true)]));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Breakdown failed');
    } finally {
      setGenerating(false);
    }
  };

  const acceptProposal = async () => {
    if (!proposal) return;
    const chosen = proposal
      .map((s, i) => ({
        title: s.title,
        substeps: s.substeps.filter((_, j) => picked[i]?.[j + 1]),
        keep: picked[i]?.[0],
      }))
      .filter((s) => s.keep)
      .map(({ title, substeps }) => ({ title, substeps }));
    if (!chosen.length) return;
    setBusy(true);
    setError('');
    try {
      const json = await post('/api/steps', 'POST', { type, id: parentId, steps: chosen, source: 'ai' });
      setSteps(json.steps);
      setProposal(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  };

  // Sub-steps only count when their step is ticked (they're disabled otherwise)
  const pickedCount = picked.reduce((n, row) => n + (row[0] ? row.filter(Boolean).length : 0), 0);

  const stepRow = (s: Step, depth: number) => (
    <div key={s.id} className={`flex items-start gap-2 py-1 ${depth ? 'ml-6' : ''}`}>
      <input type="checkbox" checked={s.done} onChange={() => toggle(s)} className="mt-1 accent-current" aria-label={s.title} />
      <span className={`flex-1 text-sm ${s.done ? 'line-through text-ink-muted' : 'text-ink-primary'}`}>{s.title}</span>
      {!depth && (
        <button onClick={() => { setAdding(s.id); setNewTitle(''); }} className="text-xs text-ink-muted hover:text-ink-primary" title="Add a sub-step">
          + sub
        </button>
      )}
      <button onClick={() => remove(s)} className="text-ink-muted hover:text-state-danger p-0.5" aria-label="Remove step">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M18 6L6 18M6 6l12 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
      </button>
    </div>
  );

  const addForm = (placeholder: string) => (
    <div className="flex gap-2 py-1">
      <input
        autoFocus
        className="input text-sm py-1.5"
        placeholder={placeholder}
        value={newTitle}
        onChange={(e) => setNewTitle(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') void addManual(); if (e.key === 'Escape') setAdding(null); }}
      />
      <button onClick={addManual} disabled={busy || !newTitle.trim()} className="btn-primary text-xs py-1.5 px-3">Add</button>
      <button onClick={() => setAdding(null)} className="btn-ghost text-xs py-1.5 px-2">Cancel</button>
    </div>
  );

  return (
    <div className="mt-2">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-2 text-xs text-ink-muted hover:text-ink-primary transition-colors"
        aria-expanded={expanded}
      >
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" className={`transition-transform ${expanded ? 'rotate-90' : ''}`}>
          <path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        {steps.length ? (
          <>
            Steps · {doneCount}/{steps.length} done
            <span className="inline-block w-20 h-1 rounded-full bg-bg-elevated overflow-hidden align-middle">
              <span className="block h-full bg-mint-500" style={{ width: `${Math.round((doneCount / steps.length) * 100)}%` }} />
            </span>
          </>
        ) : (
          'Break it down'
        )}
      </button>

      {expanded && (
        <div className="mt-2 rounded-xl border border-line bg-bg-elevated/60 px-4 py-3 space-y-2">
          {error && <p className="text-xs text-state-danger">{error}</p>}

          {top.map((s) => (
            <div key={s.id}>
              {stepRow(s, 0)}
              {children(s.id).map((c) => stepRow(c, 1))}
              {adding === s.id && <div className="ml-6">{addForm(`Sub-step of “${s.title}”`)}</div>}
            </div>
          ))}

          {adding === '' ? (
            addForm(`Next step for “${parentTitle}”`)
          ) : (
            !proposal && (
              <div className="flex flex-wrap items-center gap-3 pt-1">
                <button onClick={() => { setAdding(''); setNewTitle(''); }} className="text-xs text-ink-secondary hover:text-ink-primary">
                  + Add a step
                </button>
                <span className="text-ink-muted text-xs">·</span>
                <select value={detail} onChange={(e) => setDetail(Number(e.target.value) as 1 | 2 | 3)} className="input text-xs py-1 w-auto">
                  {([1, 2, 3] as const).map((d) => (
                    <option key={d} value={d}>{DETAIL_LABELS[d]}</option>
                  ))}
                </select>
                <input
                  className="input text-xs py-1 flex-1 min-w-[160px]"
                  placeholder="Anything Claude should know? (optional)"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />
                <button onClick={generate} disabled={generating} className="btn-secondary text-xs py-1.5">
                  {generating ? 'Thinking…' : steps.length ? 'Suggest more with AI' : 'Break down with AI'}
                </button>
              </div>
            )
          )}

          {proposal && (
            <div className="pt-2 border-t border-line space-y-1">
              <p className="text-xs font-semibold text-ink-muted uppercase tracking-wide">Suggested steps — untick what you don't want</p>
              {proposal.map((s, i) => (
                <div key={i}>
                  <label className="flex items-start gap-2 py-0.5 cursor-pointer">
                    <input type="checkbox" checked={picked[i]?.[0] ?? false} onChange={() => setPicked((p) => p.map((row, r) => (r === i ? [!row[0], ...row.slice(1)] : row)))} className="mt-1 accent-current" />
                    <span className={`text-sm ${picked[i]?.[0] ? 'text-ink-primary' : 'text-ink-muted line-through'}`}>{s.title}</span>
                  </label>
                  {s.substeps.map((sub, j) => (
                    <label key={j} className="flex items-start gap-2 py-0.5 ml-6 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={(picked[i]?.[0] && picked[i]?.[j + 1]) ?? false}
                        disabled={!picked[i]?.[0]}
                        onChange={() => setPicked((p) => p.map((row, r) => (r === i ? row.map((v, k) => (k === j + 1 ? !v : v)) : row)))}
                        className="mt-1 accent-current"
                      />
                      <span className={`text-sm ${picked[i]?.[0] && picked[i]?.[j + 1] ? 'text-ink-secondary' : 'text-ink-muted line-through'}`}>{sub}</span>
                    </label>
                  ))}
                </div>
              ))}
              <div className="flex gap-2 pt-2">
                <button onClick={acceptProposal} disabled={busy || !pickedCount} className="btn-primary text-xs py-1.5">
                  {busy ? 'Saving…' : `Add ${pickedCount} step${pickedCount === 1 ? '' : 's'}`}
                </button>
                <button onClick={generate} disabled={generating} className="btn-secondary text-xs py-1.5">Try again</button>
                <button onClick={() => setProposal(null)} className="btn-ghost text-xs py-1.5">Discard</button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
