import { useState } from 'react';
import OwnerPicker, { type OwnerValue } from './OwnerPicker';
import type { PersonOption, TeamId, Todo, TodoStatus } from '../types';

// The meeting's To-do review: every open to-do of the team (whatever meeting
// it came from), reviewed as done or not done, plus the 7-day to-dos added
// in this meeting. Closing one here records this meeting as the one that
// closed it, so the five-line export and the recap can list it.

export type PanelTodo = Todo & { meeting_title?: string | null; meeting_date?: string | null };

interface TodoPanelProps {
  meetingId: string;
  /** The meeting's date (YYYY-MM-DD): ages are counted up to it. */
  meetingDate?: string;
  initialTodos: PanelTodo[];
  team?: TeamId;
  /** Server-rendered picker list (including inactive people). */
  people?: PersonOption[];
  /** Owner a new to-do starts with: the signed-in person, or unassigned. */
  defaultOwner?: OwnerValue;
}

const UNASSIGNED: OwnerValue = { owner_id: null, owner: null };

const STATUS_LABELS: Record<TodoStatus, string> = {
  open: 'Open',
  done: 'Done',
  not_done: 'Not Done',
  dropped: 'Dropped',
};

const STATUS_COLORS: Record<TodoStatus, string> = {
  open: 'bg-state-warning/15 text-state-warning border-state-warning/20',
  done: 'bg-state-success/15 text-state-success border-state-success/20',
  not_done: 'bg-state-danger/15 text-state-danger border-state-danger/20',
  dropped: 'bg-bg-elevated text-ink-muted border-line',
};

import { ageInDays, plusDays, TODO_MAX_AGE_DAYS } from '../lib/todos';
const fmtDate = (iso: string) => new Date(`${iso.slice(0, 10)}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

export default function TodoPanel({ meetingId, meetingDate, initialTodos, team, people, defaultOwner = UNASSIGNED }: TodoPanelProps) {
  const [todos, setTodos] = useState<PanelTodo[]>(initialTodos);
  const [adding, setAdding] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newOwner, setNewOwner] = useState<OwnerValue>(defaultOwner);
  const today = meetingDate ?? new Date().toISOString().slice(0, 10);
  const [newDue, setNewDue] = useState(plusDays(today, 7));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const updateStatus = async (todo: PanelTodo, status: TodoStatus) => {
    const prev = todos;
    const resolved = status === 'open' ? null : meetingId;
    setTodos((t) => t.map((x) => (x.id === todo.id ? { ...x, status, resolved_meeting_id: resolved } : x)));
    const res = await fetch(`/api/todos/${todo.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status, resolved_meeting_id: resolved }),
    });
    if (!res.ok) setTodos(prev);
  };

  const addTodo = async () => {
    if (!newTitle.trim()) return;
    setSaving(true);
    setError('');
    const res = await fetch(`/api/meetings/${meetingId}/todos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: newTitle.trim(), owner_id: newOwner.owner_id, owner: newOwner.owner, due_date: newDue || null }),
    });
    const json = await res.json();
    setSaving(false);
    if (!res.ok) { setError(json.error ?? 'Failed to add to-do'); return; }
    setTodos((t) => [...t, json.todo]);
    setNewTitle('');
    setNewOwner(defaultOwner);
    setNewDue(plusDays(today, 7));
    setAdding(false);
  };

  const removeTodo = async (id: string) => {
    const prev = todos;
    setTodos((t) => t.filter((x) => x.id !== id));
    const res = await fetch(`/api/todos/${id}`, { method: 'DELETE' });
    if (!res.ok) setTodos(prev);
  };

  // Previous to-dos up for review, then this meeting's new ones, then what was closed
  const fromBefore = todos.filter((t) => t.status === 'open' && t.meeting_id !== meetingId);
  const addedHere = todos.filter((t) => t.status === 'open' && t.meeting_id === meetingId);
  const notDone = todos.filter((t) => t.status === 'not_done');
  const done = todos.filter((t) => t.status === 'done');
  const dropped = todos.filter((t) => t.status === 'dropped');
  const reviewed = done.length + notDone.length + dropped.length;

  const row = (todo: PanelTodo) => {
    const age = ageInDays(todo.created_at, today);
    return (
      <div key={todo.id} className="flex items-center gap-3 px-4 py-3 bg-bg-elevated border border-line rounded-xl">
        <select
          value={todo.status}
          onChange={(e) => updateStatus(todo, e.target.value as TodoStatus)}
          className={`text-xs px-2.5 py-1 rounded-full border font-medium cursor-pointer bg-transparent flex-shrink-0 ${STATUS_COLORS[todo.status]}`}
        >
          {Object.entries(STATUS_LABELS).map(([v, l]) => (
            <option key={v} value={v}>{l}</option>
          ))}
        </select>
        <div className="flex-1 min-w-0">
          <p className={`text-sm truncate ${todo.status === 'done' ? 'line-through text-ink-muted' : 'text-ink-primary'}`}>
            {todo.title}
          </p>
          <p className="text-xs text-ink-muted">
            {todo.owner ?? 'Unassigned'}
            {' · '}
            <span title={`Added ${todo.created_at.slice(0, 10)}`}>
              added {fmtDate(todo.created_at)}
              {todo.meeting_id !== meetingId && todo.meeting_title ? ` (${todo.meeting_title})` : ''}
            </span>
            {todo.due_date && ` · due ${fmtDate(todo.due_date)}`}
          </p>
        </div>
        {todo.status === 'open' && (
          <span
            className={`text-xs px-2 py-0.5 rounded-full font-medium tabular-nums flex-shrink-0 ${
              age > TODO_MAX_AGE_DAYS ? 'bg-state-danger/15 text-state-danger' : 'bg-bg-surface text-ink-muted border border-line'
            }`}
            title={age > TODO_MAX_AGE_DAYS ? `Over ${TODO_MAX_AGE_DAYS} days: make it an issue` : 'Days since it was added'}
          >
            {age}d
          </span>
        )}
        <button
          onClick={() => removeTodo(todo.id)}
          className="text-ink-muted hover:text-state-danger transition-colors flex-shrink-0 p-1"
          aria-label="Delete to-do"
          title="Delete this to-do"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
            <path d="M18 6L6 18M6 6l12 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
          </svg>
        </button>
      </div>
    );
  };

  const group = (label: string, items: PanelTodo[]) =>
    items.length > 0 && (
      <div className="space-y-2">
        <p className="text-xs font-semibold text-ink-muted uppercase tracking-wide">
          {label} <span className="font-normal ml-1">({items.length})</span>
        </p>
        {items.map(row)}
      </div>
    );

  return (
    <div className="space-y-4">
      {todos.length === 0 && !adding && (
        <p className="text-sm text-ink-muted py-4 text-center">No open to-dos. Add the 7-day to-dos agreed in this meeting below.</p>
      )}

      {group('To review — done or not done', fromBefore)}
      {group('Added in this meeting', addedHere)}
      {reviewed > 0 && group('Reviewed', [...notDone, ...done, ...dropped])}

      {adding && (
        <div className="border border-line rounded-xl p-4 space-y-3 bg-bg-elevated">
          <input
            autoFocus
            className="input text-sm"
            placeholder="To-do title (one owner, due in 7 days)"
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') addTodo(); if (e.key === 'Escape') setAdding(false); }}
          />
          <div className="flex gap-2">
            <OwnerPicker value={newOwner} onChange={setNewOwner} team={team} initialPeople={people} className="text-sm flex-1" />
            <input type="date" className="input text-sm w-40" value={newDue} onChange={(e) => setNewDue(e.target.value)} aria-label="Due date" title="Due date: the next meeting by default" />
          </div>
          {error && <p className="text-xs text-state-danger">{error}</p>}
          <div className="flex gap-2">
            <button onClick={addTodo} disabled={saving} className="btn-primary text-sm">
              {saving ? 'Adding…' : 'Add to-do'}
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
          Add to-do
        </button>
      )}
    </div>
  );
}
