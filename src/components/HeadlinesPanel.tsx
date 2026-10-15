import { useState } from 'react';
import OwnerPicker, { type OwnerValue } from './OwnerPicker';
import type { Headline, HeadlineType, PersonOption, TeamId } from '../types';

// Headlines: one sentence of customer or employee news, good or bad, with no
// discussion. "Drop to IDS" turns a headline that needs discussion into a
// short-term issue linked to it.

interface HeadlinesPanelProps {
  meetingId: string;
  initialHeadlines: Headline[];
  team?: TeamId;
  /** Server-rendered picker list (including inactive people). */
  people?: PersonOption[];
}

const NO_PRESENTER: OwnerValue = { owner_id: null, owner: null };

const TYPE_COLORS: Record<HeadlineType, string> = {
  customer: 'bg-accent/15 text-accent',
  employee: 'bg-state-success/15 text-state-success',
  general: 'bg-bg-elevated text-ink-secondary',
};

const TYPE_LABELS: Record<HeadlineType, string> = {
  customer: 'Customer',
  employee: 'Employee',
  general: 'General',
};

export default function HeadlinesPanel({ meetingId, initialHeadlines, team, people }: HeadlinesPanelProps) {
  const [headlines, setHeadlines] = useState<Headline[]>(initialHeadlines);
  const [adding, setAdding] = useState(false);
  const [newText, setNewText] = useState('');
  const [newPresenter, setNewPresenter] = useState<OwnerValue>(NO_PRESENTER);
  const [newType, setNewType] = useState<HeadlineType>('general');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [dropped, setDropped] = useState<Record<string, 'busy' | 'done' | 'existed'>>({});

  const addHeadline = async () => {
    if (!newText.trim()) return;
    setSaving(true);
    setError('');
    const res = await fetch(`/api/meetings/${meetingId}/headlines`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: newText.trim(),
        presenter_id: newPresenter.owner_id,
        presenter: newPresenter.owner,
        type: newType,
      }),
    });
    const json = await res.json();
    setSaving(false);
    if (!res.ok) { setError(json.error ?? 'Failed to add headline'); return; }
    setHeadlines((h) => [...h, json.headline]);
    setNewText('');
    setNewPresenter(NO_PRESENTER);
    setNewType('general');
    setAdding(false);
  };

  const removeHeadline = async (id: string) => {
    const prev = headlines;
    setHeadlines((h) => h.filter((x) => x.id !== id));
    const res = await fetch(`/api/headlines/${id}`, { method: 'DELETE' });
    if (!res.ok) setHeadlines(prev);
  };

  /** Needs discussion: becomes a short-term issue linked to the headline. */
  const dropToIds = async (h: Headline) => {
    setDropped((d) => ({ ...d, [h.id]: 'busy' }));
    setError('');
    const res = await fetch(`/api/meetings/${meetingId}/issues`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: h.text.slice(0, 500), headline_id: h.id, owner_id: h.presenter_id, owner: h.presenter, issue_type: 'problem' }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      setError(json.error ?? 'Could not drop to IDS');
      setDropped((d) => { const { [h.id]: _, ...rest } = d; return rest; });
      return;
    }
    setDropped((d) => ({ ...d, [h.id]: json.existed ? 'existed' : 'done' }));
  };

  const customer = headlines.filter((h) => h.type === 'customer');
  const employee = headlines.filter((h) => h.type === 'employee');
  const general = headlines.filter((h) => h.type === 'general');

  const renderGroup = (items: Headline[], label: string) => {
    if (items.length === 0) return null;
    return (
      <div>
        <p className="text-xs font-semibold text-ink-muted uppercase tracking-wide mb-2">{label}</p>
        <div className="space-y-2">
          {items.map((h) => (
            <div key={h.id} className="flex items-start gap-3 px-4 py-3 bg-bg-elevated border border-line rounded-xl">
              <span className={`text-xs px-2 py-0.5 rounded-full font-medium flex-shrink-0 mt-0.5 ${TYPE_COLORS[h.type]}`}>
                {TYPE_LABELS[h.type]}
              </span>
              <div className="flex-1 min-w-0">
                <p className="text-sm text-ink-primary">{h.text}</p>
                <p className="text-xs text-ink-muted mt-0.5">
                  {h.presenter}
                  {h.presenter && ' · '}
                  {dropped[h.id] === 'done' ? (
                    <span className="text-state-danger">On the Issues List</span>
                  ) : dropped[h.id] === 'existed' ? (
                    <span className="text-state-danger">Already on the Issues List</span>
                  ) : (
                    <button
                      onClick={() => dropToIds(h)}
                      disabled={dropped[h.id] === 'busy'}
                      className="text-ink-muted hover:text-state-danger"
                      title="Needs discussion: add it to the Issues List"
                    >
                      {dropped[h.id] === 'busy' ? 'Dropping…' : 'Drop to IDS'}
                    </button>
                  )}
                </p>
              </div>
              <button
                onClick={() => removeHeadline(h.id)}
                className="text-ink-muted hover:text-state-danger transition-colors flex-shrink-0 p-1"
                aria-label="Remove"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                  <path d="M18 6L6 18M6 6l12 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                </svg>
              </button>
            </div>
          ))}
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-4">
      <p className="text-xs text-ink-muted">One sentence each, no discussion. If it needs talking about, drop it to IDS.</p>
      {headlines.length === 0 && !adding && (
        <p className="text-sm text-ink-muted py-4 text-center">No headlines for this meeting.</p>
      )}

      {renderGroup(customer, 'Customer')}
      {renderGroup(employee, 'Employee')}
      {renderGroup(general, 'General')}

      {error && <p className="text-xs text-state-danger">{error}</p>}

      {adding && (
        <div className="border border-line rounded-xl p-4 space-y-3 bg-bg-elevated">
          <textarea
            autoFocus
            className="input text-sm resize-none"
            rows={2}
            placeholder="One sentence: customer or employee news, good or bad"
            value={newText}
            onChange={(e) => setNewText(e.target.value)}
          />
          <div className="flex gap-2">
            <OwnerPicker
              value={newPresenter}
              onChange={setNewPresenter}
              team={team}
              initialPeople={people}
              placeholder="Presenter"
              className="text-sm flex-1"
            />
            <select
              className="input text-sm w-36"
              value={newType}
              onChange={(e) => setNewType(e.target.value as HeadlineType)}
            >
              <option value="customer">Customer</option>
              <option value="employee">Employee</option>
              <option value="general">General</option>
            </select>
          </div>
          <div className="flex gap-2">
            <button onClick={addHeadline} disabled={saving} className="btn-primary text-sm">
              {saving ? 'Adding…' : 'Add headline'}
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
          Add headline
        </button>
      )}
    </div>
  );
}
