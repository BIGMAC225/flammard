import { useState, useCallback } from 'react';
import type { Decision, ActionItem, DiscussionPoint, DecisionOutcome } from '../types';

interface Props {
  meetingId: string;
  initialSummary: string;
  initialDecisions: Decision[];
  initialActions: ActionItem[];
  initialDiscussion: DiscussionPoint[];
  isSealed: boolean;
}

type Tab = 'summary' | 'decisions' | 'actions' | 'discussion';

const OUTCOMES: DecisionOutcome[] = ['approved', 'rejected', 'deferred', 'noted'];
const OUTCOME_LABELS: Record<DecisionOutcome, string> = {
  approved: 'Approved',
  rejected: 'Rejected',
  deferred: 'Deferred',
  noted: 'Noted',
};

function nanoid() {
  return Math.random().toString(36).slice(2, 9);
}

export default function MinutesDraftEditor({
  meetingId,
  initialSummary,
  initialDecisions,
  initialActions,
  initialDiscussion,
  isSealed,
}: Props) {
  const [tab, setTab] = useState<Tab>('summary');
  const [summary, setSummary] = useState(initialSummary ?? '');
  const [decisions, setDecisions] = useState<Decision[]>(initialDecisions ?? []);
  const [actions, setActions] = useState<ActionItem[]>(initialActions ?? []);
  const [discussion, setDiscussion] = useState<DiscussionPoint[]>(initialDiscussion ?? []);
  const [saving, setSaving] = useState(false);
  const [approving, setApproving] = useState(false);
  const [saveMsg, setSaveMsg] = useState('');
  const [error, setError] = useState('');

  const save = useCallback(async () => {
    setSaving(true);
    setError('');
    const res = await fetch(`/api/meetings/${meetingId}/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ summary, decisions, actions, discussion }),
    });
    setSaving(false);
    if (res.ok) {
      setSaveMsg('Saved');
      setTimeout(() => setSaveMsg(''), 2000);
    } else {
      const j = await res.json();
      setError(j.error ?? 'Save failed');
    }
  }, [meetingId, summary, decisions, actions, discussion]);

  const approve = useCallback(async () => {
    if (!confirm('Approve and cryptographically seal these minutes? This cannot be undone.')) return;
    setApproving(true);
    setError('');
    // Save first, then approve
    await fetch(`/api/meetings/${meetingId}/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ summary, decisions, actions, discussion }),
    });
    const res = await fetch(`/api/meetings/${meetingId}/approve`, { method: 'POST' });
    setApproving(false);
    if (res.ok) {
      window.location.reload();
    } else {
      const j = await res.json();
      setError(j.error ?? 'Approval failed');
    }
  }, [meetingId, summary, decisions, actions, discussion]);

  // ── Decision helpers ───────────────────────────────────
  const addDecision = () =>
    setDecisions([...decisions, { id: `d${nanoid()}`, text: '', outcome: 'approved' }]);

  const updateDecision = (id: string, patch: Partial<Decision>) =>
    setDecisions(decisions.map((d) => (d.id === id ? { ...d, ...patch } : d)));

  const removeDecision = (id: string) =>
    setDecisions(decisions.filter((d) => d.id !== id));

  // ── Action helpers ─────────────────────────────────────
  const addAction = () =>
    setActions([...actions, { id: `a${nanoid()}`, text: '', status: 'open' }]);

  const updateAction = (id: string, patch: Partial<ActionItem>) =>
    setActions(actions.map((a) => (a.id === id ? { ...a, ...patch } : a)));

  const removeAction = (id: string) =>
    setActions(actions.filter((a) => a.id !== id));

  // ── Discussion helpers ─────────────────────────────────
  const addDiscussion = () =>
    setDiscussion([...discussion, { topic: '', notes: '' }]);

  const updateDiscussion = (i: number, patch: Partial<DiscussionPoint>) =>
    setDiscussion(discussion.map((d, idx) => (idx === i ? { ...d, ...patch } : d)));

  const removeDiscussion = (i: number) =>
    setDiscussion(discussion.filter((_, idx) => idx !== i));

  const tabs: { id: Tab; label: string; count?: number }[] = [
    { id: 'summary', label: 'Summary' },
    { id: 'decisions', label: 'Decisions', count: decisions.length },
    { id: 'actions', label: 'Actions', count: actions.length },
    { id: 'discussion', label: 'Discussion', count: discussion.length },
  ];

  return (
    <div className="space-y-5">
      {error && (
        <div className="p-3 bg-state-danger/10 border border-state-danger/20 rounded-lg text-sm text-state-danger">
          {error}
        </div>
      )}

      {isSealed && (
        <div className="p-4 bg-accent-muted border border-accent/20 rounded-xl flex items-center gap-3 text-sm text-accent">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
            <rect x="3" y="11" width="18" height="11" rx="2" stroke="currentColor" strokeWidth="1.5"/>
            <path d="M7 11V7a5 5 0 0 1 10 0v4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
          </svg>
          These minutes are sealed and cannot be edited.
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1 p-1 bg-bg-elevated rounded-lg w-fit">
        {tabs.map(({ id, label, count }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`px-4 py-1.5 rounded-md text-sm font-medium transition-colors flex items-center gap-2 ${
              tab === id ? 'bg-bg-surface text-ink-primary shadow-sm' : 'text-ink-secondary hover:text-ink-primary'
            }`}
          >
            {label}
            {count !== undefined && count > 0 && (
              <span className={`text-xs px-1.5 py-0.5 rounded-full ${tab === id ? 'bg-accent text-white' : 'bg-bg-base text-ink-muted'}`}>
                {count}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Summary */}
      {tab === 'summary' && (
        <div>
          <label className="label">Executive summary</label>
          <textarea
            className="input min-h-[120px] resize-y"
            placeholder="2–3 sentence summary of the meeting purpose and key outcomes…"
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            readOnly={isSealed}
          />
        </div>
      )}

      {/* Decisions */}
      {tab === 'decisions' && (
        <div className="space-y-3">
          {decisions.length === 0 && (
            <p className="text-sm text-ink-muted py-4 text-center">No decisions recorded yet.</p>
          )}
          {decisions.map((d) => (
            <div key={d.id} className="bg-bg-elevated border border-line rounded-xl p-4 space-y-3">
              <div className="flex gap-3">
                <textarea
                  className="input flex-1 resize-none min-h-[64px]"
                  placeholder="Decision text…"
                  value={d.text}
                  onChange={(e) => updateDecision(d.id, { text: e.target.value })}
                  readOnly={isSealed}
                />
                {!isSealed && (
                  <button onClick={() => removeDecision(d.id)} className="text-ink-muted hover:text-state-danger transition-colors text-lg self-start">×</button>
                )}
              </div>
              <div className="flex flex-wrap gap-3">
                <div className="flex-1 min-w-32">
                  <label className="label text-xs">Outcome</label>
                  <select
                    className="input py-1.5 text-xs"
                    value={d.outcome}
                    onChange={(e) => updateDecision(d.id, { outcome: e.target.value as DecisionOutcome })}
                    disabled={isSealed}
                  >
                    {OUTCOMES.map((o) => (
                      <option key={o} value={o}>{OUTCOME_LABELS[o]}</option>
                    ))}
                  </select>
                </div>
                <div className="flex-1 min-w-32">
                  <label className="label text-xs">Proposed by <span className="text-ink-muted">(optional)</span></label>
                  <input
                    type="text"
                    className="input py-1.5 text-xs"
                    placeholder="Name"
                    value={d.mover ?? ''}
                    onChange={(e) => updateDecision(d.id, { mover: e.target.value || undefined })}
                    readOnly={isSealed}
                  />
                </div>
              </div>
            </div>
          ))}
          {!isSealed && (
            <button onClick={addDecision} className="btn-secondary text-sm w-full justify-center py-2.5">
              + Add decision
            </button>
          )}
        </div>
      )}

      {/* Actions */}
      {tab === 'actions' && (
        <div className="space-y-3">
          {actions.length === 0 && (
            <p className="text-sm text-ink-muted py-4 text-center">No action items recorded yet.</p>
          )}
          {actions.map((a) => (
            <div key={a.id} className="bg-bg-elevated border border-line rounded-xl p-4 space-y-3">
              <div className="flex gap-3">
                <textarea
                  className="input flex-1 resize-none min-h-[64px]"
                  placeholder="Action item description…"
                  value={a.text}
                  onChange={(e) => updateAction(a.id, { text: e.target.value })}
                  readOnly={isSealed}
                />
                {!isSealed && (
                  <button onClick={() => removeAction(a.id)} className="text-ink-muted hover:text-state-danger transition-colors text-lg self-start">×</button>
                )}
              </div>
              <div className="flex flex-wrap gap-3">
                <div className="flex-1 min-w-32">
                  <label className="label text-xs">Owner <span className="text-ink-muted">(optional)</span></label>
                  <input
                    type="text"
                    className="input py-1.5 text-xs"
                    placeholder="Name"
                    value={a.owner ?? ''}
                    onChange={(e) => updateAction(a.id, { owner: e.target.value || undefined })}
                    readOnly={isSealed}
                  />
                </div>
                <div className="flex-1 min-w-32">
                  <label className="label text-xs">Due date <span className="text-ink-muted">(optional)</span></label>
                  <input
                    type="date"
                    className="input py-1.5 text-xs"
                    value={a.due_date ?? ''}
                    onChange={(e) => updateAction(a.id, { due_date: e.target.value || undefined })}
                    readOnly={isSealed}
                  />
                </div>
                <div className="flex-1 min-w-28">
                  <label className="label text-xs">Status</label>
                  <select
                    className="input py-1.5 text-xs"
                    value={a.status}
                    onChange={(e) => updateAction(a.id, { status: e.target.value as ActionItem['status'] })}
                    disabled={isSealed}
                  >
                    <option value="open">Open</option>
                    <option value="completed">Completed</option>
                    <option value="overdue">Overdue</option>
                  </select>
                </div>
              </div>
            </div>
          ))}
          {!isSealed && (
            <button onClick={addAction} className="btn-secondary text-sm w-full justify-center py-2.5">
              + Add action item
            </button>
          )}
        </div>
      )}

      {/* Discussion */}
      {tab === 'discussion' && (
        <div className="space-y-3">
          {discussion.length === 0 && (
            <p className="text-sm text-ink-muted py-4 text-center">No discussion points recorded yet.</p>
          )}
          {discussion.map((d, i) => (
            <div key={i} className="bg-bg-elevated border border-line rounded-xl p-4 space-y-2">
              <div className="flex gap-3">
                <input
                  type="text"
                  className="input flex-1 font-medium"
                  placeholder="Discussion topic"
                  value={d.topic}
                  onChange={(e) => updateDiscussion(i, { topic: e.target.value })}
                  readOnly={isSealed}
                />
                {!isSealed && (
                  <button onClick={() => removeDiscussion(i)} className="text-ink-muted hover:text-state-danger transition-colors text-lg self-start">×</button>
                )}
              </div>
              <textarea
                className="input resize-none min-h-[80px] text-sm"
                placeholder="Key points discussed…"
                value={d.notes}
                onChange={(e) => updateDiscussion(i, { notes: e.target.value })}
                readOnly={isSealed}
              />
            </div>
          ))}
          {!isSealed && (
            <button onClick={addDiscussion} className="btn-secondary text-sm w-full justify-center py-2.5">
              + Add discussion point
            </button>
          )}
        </div>
      )}

      {/* Footer actions */}
      {!isSealed && (
        <div className="flex items-center justify-between pt-4 border-t border-line">
          <div className="flex items-center gap-3">
            <button onClick={save} disabled={saving} className="btn-secondary text-sm py-2">
              {saving ? 'Saving…' : 'Save draft'}
            </button>
            {saveMsg && <span className="text-sm text-state-success">{saveMsg}</span>}
          </div>
          <button
            onClick={approve}
            disabled={approving}
            className="btn-primary text-sm py-2.5 px-5"
          >
            {approving ? (
              <>
                <svg className="animate-spin w-3.5 h-3.5" viewBox="0 0 24 24" fill="none">
                  <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeDasharray="60 40"/>
                </svg>
                Sealing…
              </>
            ) : (
              <>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                  <rect x="3" y="11" width="18" height="11" rx="2" stroke="currentColor" strokeWidth="1.5"/>
                  <path d="M7 11V7a5 5 0 0 1 10 0v4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                </svg>
                Approve & seal
              </>
            )}
          </button>
        </div>
      )}
    </div>
  );
}
