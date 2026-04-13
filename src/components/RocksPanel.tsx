import { useState } from 'react';
import type { MeetingRock, RockStatus } from '../types';

interface RocksPanelProps {
  meetingId: string;
  initialRocks: MeetingRock[];
}

const STATUS_LABELS: Record<RockStatus, string> = {
  on_track: 'On Track',
  off_track: 'Off Track',
  complete: 'Complete',
  dropped: 'Dropped',
};

const STATUS_COLORS: Record<RockStatus, string> = {
  on_track: 'bg-state-success/15 text-state-success border-state-success/20',
  off_track: 'bg-state-danger/15 text-state-danger border-state-danger/20',
  complete: 'bg-accent/15 text-accent border-accent/20',
  dropped: 'bg-bg-elevated text-ink-muted border-line',
};

export default function RocksPanel({ meetingId, initialRocks }: RocksPanelProps) {
  const [rocks, setRocks] = useState<MeetingRock[]>(initialRocks);
  const [adding, setAdding] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newOwner, setNewOwner] = useState('');
  const [newStatus, setNewStatus] = useState<RockStatus>('on_track');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const updateStatus = async (rock: MeetingRock, status: RockStatus) => {
    const prev = rocks;
    setRocks((r) => r.map((x) => (x.id === rock.id ? { ...x, status } : x)));
    const res = await fetch(`/api/meeting-rocks/${rock.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    });
    if (!res.ok) setRocks(prev);
  };

  const addRock = async () => {
    if (!newTitle.trim()) return;
    setSaving(true);
    setError('');
    const res = await fetch(`/api/meetings/${meetingId}/rocks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: newTitle.trim(), owner: newOwner.trim() || null, status: newStatus }),
    });
    const json = await res.json();
    setSaving(false);
    if (!res.ok) { setError(json.error ?? 'Failed to add rock'); return; }
    setRocks((r) => [...r, json.rock]);
    setNewTitle('');
    setNewOwner('');
    setNewStatus('on_track');
    setAdding(false);
  };

  const removeRock = async (id: string) => {
    const prev = rocks;
    setRocks((r) => r.filter((x) => x.id !== id));
    const res = await fetch(`/api/meeting-rocks/${id}`, { method: 'DELETE' });
    if (!res.ok) setRocks(prev);
  };

  return (
    <div className="space-y-3">
      {rocks.length === 0 && !adding && (
        <p className="text-sm text-ink-muted py-4 text-center">No rocks recorded for this meeting.</p>
      )}

      {rocks.map((rock) => (
        <div key={rock.id} className="flex items-center gap-3 px-4 py-3 bg-bg-elevated border border-line rounded-xl">
          <select
            value={rock.status}
            onChange={(e) => updateStatus(rock, e.target.value as RockStatus)}
            className={`text-xs px-2.5 py-1 rounded-full border font-medium cursor-pointer bg-transparent ${STATUS_COLORS[rock.status]}`}
          >
            {Object.entries(STATUS_LABELS).map(([v, l]) => (
              <option key={v} value={v}>{l}</option>
            ))}
          </select>
          <div className="flex-1 min-w-0">
            <p className="text-sm text-ink-primary truncate">{rock.title}</p>
            {rock.owner && <p className="text-xs text-ink-muted">{rock.owner}</p>}
          </div>
          <button
            onClick={() => removeRock(rock.id)}
            className="text-ink-muted hover:text-state-danger transition-colors flex-shrink-0 p-1"
            aria-label="Remove rock"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
              <path d="M18 6L6 18M6 6l12 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
          </button>
        </div>
      ))}

      {adding && (
        <div className="border border-line rounded-xl p-4 space-y-3 bg-bg-elevated">
          <input
            autoFocus
            className="input text-sm"
            placeholder="Rock title"
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') addRock(); if (e.key === 'Escape') setAdding(false); }}
          />
          <div className="flex gap-2">
            <input
              className="input text-sm flex-1"
              placeholder="Owner (optional)"
              value={newOwner}
              onChange={(e) => setNewOwner(e.target.value)}
            />
            <select
              className="input text-sm w-36"
              value={newStatus}
              onChange={(e) => setNewStatus(e.target.value as RockStatus)}
            >
              {Object.entries(STATUS_LABELS).map(([v, l]) => (
                <option key={v} value={v}>{l}</option>
              ))}
            </select>
          </div>
          {error && <p className="text-xs text-state-danger">{error}</p>}
          <div className="flex gap-2">
            <button onClick={addRock} disabled={saving} className="btn-primary text-sm">
              {saving ? 'Adding…' : 'Add rock'}
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
          Add rock
        </button>
      )}
    </div>
  );
}
