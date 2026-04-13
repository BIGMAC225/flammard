import { useState } from 'react';
import type { Todo, TodoStatus } from '../types';

interface TodoPanelProps {
  meetingId: string;
  initialTodos: Todo[];
}

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

export default function TodoPanel({ meetingId, initialTodos }: TodoPanelProps) {
  const [todos, setTodos] = useState<Todo[]>(initialTodos);
  const [adding, setAdding] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newOwner, setNewOwner] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const updateStatus = async (todo: Todo, status: TodoStatus) => {
    const prev = todos;
    setTodos((t) => t.map((x) => (x.id === todo.id ? { ...x, status } : x)));
    const res = await fetch(`/api/todos/${todo.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
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
      body: JSON.stringify({ title: newTitle.trim(), owner: newOwner.trim() || null }),
    });
    const json = await res.json();
    setSaving(false);
    if (!res.ok) { setError(json.error ?? 'Failed to add to-do'); return; }
    setTodos((t) => [...t, json.todo]);
    setNewTitle('');
    setNewOwner('');
    setAdding(false);
  };

  const removeTodo = async (id: string) => {
    const prev = todos;
    setTodos((t) => t.filter((x) => x.id !== id));
    const res = await fetch(`/api/todos/${id}`, { method: 'DELETE' });
    if (!res.ok) setTodos(prev);
  };

  const open = todos.filter((t) => t.status === 'open');
  const done = todos.filter((t) => t.status === 'done');
  const notDone = todos.filter((t) => t.status === 'not_done');
  const dropped = todos.filter((t) => t.status === 'dropped');
  const ordered = [...open, ...notDone, ...done, ...dropped];

  return (
    <div className="space-y-3">
      {ordered.length === 0 && !adding && (
        <p className="text-sm text-ink-muted py-4 text-center">No to-dos for this meeting.</p>
      )}

      {ordered.map((todo) => (
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
            {todo.owner && <p className="text-xs text-ink-muted">{todo.owner}</p>}
          </div>
          <button
            onClick={() => removeTodo(todo.id)}
            className="text-ink-muted hover:text-state-danger transition-colors flex-shrink-0 p-1"
            aria-label="Remove to-do"
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
            placeholder="To-do title"
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') addTodo(); if (e.key === 'Escape') setAdding(false); }}
          />
          <input
            className="input text-sm"
            placeholder="Owner (optional)"
            value={newOwner}
            onChange={(e) => setNewOwner(e.target.value)}
          />
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
