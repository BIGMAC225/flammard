import { useState } from 'react';
import type { Issue, IssueStatus, IssuePriority } from '../types';

interface IssuesPanelProps {
  meetingId: string;
  initialIssues: Issue[];
}

const STATUS_COLORS: Record<IssueStatus, string> = {
  open: 'bg-state-danger/15 text-state-danger border-state-danger/20',
  solved: 'bg-state-success/15 text-state-success border-state-success/20',
  dropped: 'bg-bg-elevated text-ink-muted border-line',
};

const PRIORITY_COLORS: Record<IssuePriority, string> = {
  high: 'text-state-danger',
  medium: 'text-state-warning',
  low: 'text-ink-muted',
};

export default function IssuesPanel({ meetingId, initialIssues }: IssuesPanelProps) {
  const [issues, setIssues] = useState<Issue[]>(initialIssues);
  const [adding, setAdding] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [newPriority, setNewPriority] = useState<IssuePriority>('medium');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [resolutions, setResolutions] = useState<Record<string, string>>({});

  const updateStatus = async (issue: Issue, status: IssueStatus) => {
    const prev = issues;
    const resolution = status === 'solved' ? (resolutions[issue.id] ?? issue.resolution ?? '') : issue.resolution;
    setIssues((list) => list.map((x) => (x.id === issue.id ? { ...x, status, resolution: resolution ?? null } : x)));
    const res = await fetch(`/api/issues/${issue.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status, resolution: resolution ?? null }),
    });
    if (!res.ok) setIssues(prev);
  };

  const addIssue = async () => {
    if (!newTitle.trim()) return;
    setSaving(true);
    setError('');
    const res = await fetch(`/api/meetings/${meetingId}/issues`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: newTitle.trim(),
        description: newDescription.trim() || null,
        priority: newPriority,
      }),
    });
    const json = await res.json();
    setSaving(false);
    if (!res.ok) { setError(json.error ?? 'Failed to add issue'); return; }
    setIssues((list) => [...list, json.issue]);
    setNewTitle('');
    setNewDescription('');
    setNewPriority('medium');
    setAdding(false);
  };

  const removeIssue = async (id: string) => {
    const prev = issues;
    setIssues((list) => list.filter((x) => x.id !== id));
    const res = await fetch(`/api/issues/${id}`, { method: 'DELETE' });
    if (!res.ok) setIssues(prev);
  };

  const open = issues.filter((i) => i.status === 'open');
  const solved = issues.filter((i) => i.status === 'solved');
  const dropped = issues.filter((i) => i.status === 'dropped');
  const ordered = [...open, ...solved, ...dropped];

  return (
    <div className="space-y-3">
      {ordered.length === 0 && !adding && (
        <p className="text-sm text-ink-muted py-4 text-center">No issues recorded for this meeting.</p>
      )}

      {ordered.map((issue) => (
        <div key={issue.id} className="border border-line rounded-xl bg-bg-elevated overflow-hidden">
          <div className="flex items-center gap-3 px-4 py-3">
            <select
              value={issue.status}
              onChange={(e) => updateStatus(issue, e.target.value as IssueStatus)}
              className={`text-xs px-2.5 py-1 rounded-full border font-medium cursor-pointer bg-transparent flex-shrink-0 ${STATUS_COLORS[issue.status]}`}
            >
              <option value="open">Open</option>
              <option value="solved">Solved</option>
              <option value="dropped">Dropped</option>
            </select>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <p className="text-sm text-ink-primary truncate">{issue.title}</p>
                <span className={`text-xs flex-shrink-0 ${PRIORITY_COLORS[issue.priority]}`}>
                  {issue.priority}
                </span>
              </div>
              {issue.resolution && (
                <p className="text-xs text-ink-muted mt-0.5 truncate">↳ {issue.resolution}</p>
              )}
            </div>
            <div className="flex gap-1 flex-shrink-0">
              <button
                onClick={() => setExpandedId(expandedId === issue.id ? null : issue.id)}
                className="text-ink-muted hover:text-ink-primary transition-colors p-1"
                aria-label="Expand"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                  <path d={expandedId === issue.id ? "M18 15l-6-6-6 6" : "M6 9l6 6 6-6"} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </button>
              <button
                onClick={() => removeIssue(issue.id)}
                className="text-ink-muted hover:text-state-danger transition-colors p-1"
                aria-label="Remove"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                  <path d="M18 6L6 18M6 6l12 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                </svg>
              </button>
            </div>
          </div>

          {expandedId === issue.id && (
            <div className="px-4 pb-4 space-y-2 border-t border-line pt-3">
              {issue.description && (
                <p className="text-sm text-ink-secondary">{issue.description}</p>
              )}
              <div className="space-y-1">
                <label className="text-xs text-ink-muted font-medium">Resolution</label>
                <input
                  className="input text-sm"
                  placeholder="How was this resolved?"
                  value={resolutions[issue.id] ?? issue.resolution ?? ''}
                  onChange={(e) => setResolutions((r) => ({ ...r, [issue.id]: e.target.value }))}
                  onBlur={() => {
                    if (issue.status === 'solved') updateStatus(issue, 'solved');
                  }}
                />
              </div>
            </div>
          )}
        </div>
      ))}

      {adding && (
        <div className="border border-line rounded-xl p-4 space-y-3 bg-bg-elevated">
          <input
            autoFocus
            className="input text-sm"
            placeholder="Issue title"
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') addIssue(); if (e.key === 'Escape') setAdding(false); }}
          />
          <input
            className="input text-sm"
            placeholder="Description (optional)"
            value={newDescription}
            onChange={(e) => setNewDescription(e.target.value)}
          />
          <div className="flex items-center gap-2">
            <label className="text-xs text-ink-muted">Priority:</label>
            {(['low', 'medium', 'high'] as IssuePriority[]).map((p) => (
              <button
                key={p}
                onClick={() => setNewPriority(p)}
                className={`text-xs px-2.5 py-1 rounded-full border transition-colors capitalize ${
                  newPriority === p
                    ? p === 'high' ? 'bg-state-danger/15 text-state-danger border-state-danger/20'
                    : p === 'medium' ? 'bg-state-warning/15 text-state-warning border-state-warning/20'
                    : 'bg-bg-elevated text-ink-secondary border-line'
                    : 'text-ink-muted border-line hover:border-line-strong'
                }`}
              >
                {p}
              </button>
            ))}
          </div>
          {error && <p className="text-xs text-state-danger">{error}</p>}
          <div className="flex gap-2">
            <button onClick={addIssue} disabled={saving} className="btn-primary text-sm">
              {saving ? 'Adding…' : 'Add issue'}
            </button>
            <button onClick={() => { setAdding(false); setError(''); }} className="btn-secondary text-sm">
              Cancel
            </button>
          </div>
        </div>
      )}

      {!adding && (
        <button
          onClick={() => setAdding(true)}
          className="flex items-center gap-1.5 text-sm text-ink-secondary hover:text-ink-primary transition-colors"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
            <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
          </svg>
          Add issue
        </button>
      )}
    </div>
  );
}
