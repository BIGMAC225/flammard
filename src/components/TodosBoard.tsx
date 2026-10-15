import { useRef, useState } from 'react';
import OwnerPicker, { type OwnerValue } from './OwnerPicker';
import StepsPanel from './StepsPanel';
import { ageInDays, plusDays, TODO_MAX_AGE_DAYS } from '../lib/todos';
import type { PersonOption, Step, TeamId, Todo, TodoStatus } from '../types';

export type BoardTodo = Todo & { meeting_title: string | null; meeting_date: string | null };

interface Props {
  initialTodos: BoardTodo[];
  stepsByTodo: Record<string, Step[]>;
  team: TeamId;
  /** Server-rendered picker list (including inactive people). */
  people: PersonOption[];
  /** Owner a new to-do starts with: the signed-in person, or unassigned. */
  defaultOwner: OwnerValue;
}

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

/** Open to-dos: add new ones, close them out, break them into steps. */
export default function TodosBoard({ initialTodos, stepsByTodo, team, people, defaultOwner }: Props) {
  const [todos, setTodos] = useState<BoardTodo[]>(initialTodos);
  const [title, setTitle] = useState('');
  const [owner, setOwner] = useState<OwnerValue>(defaultOwner);
  const today = new Date().toISOString().slice(0, 10);
  const [dueDate, setDueDate] = useState(plusDays(today, 7));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [closedCount, setClosedCount] = useState(0);
  const titleRef = useRef<HTMLInputElement>(null);

  const add = async () => {
    if (!title.trim()) return;
    setSaving(true);
    setError('');
    try {
      const data = await send('/api/todos', 'POST', { title: title.trim(), owner_id: owner.owner_id, owner: owner.owner, due_date: dueDate || null });
      setTodos((all) => [{ ...data.todo, meeting_title: null, meeting_date: null }, ...all]);
      setTitle('');
      setDueDate(plusDays(today, 7));
      titleRef.current?.focus();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add the to-do');
    } finally {
      setSaving(false);
    }
  };

  const close = async (todo: BoardTodo, status: TodoStatus) => {
    const prev = todos;
    setTodos((all) => all.filter((t) => t.id !== todo.id));
    setError('');
    try {
      await send(`/api/todos/${todo.id}`, 'PATCH', { status });
      setClosedCount((n) => n + 1);
    } catch (err) {
      setTodos(prev);
      setError(err instanceof Error ? err.message : 'Could not update the to-do');
    }
  };

  const reassign = async (todo: BoardTodo, next: OwnerValue) => {
    const prev = todos;
    setTodos((all) => all.map((t) => (t.id === todo.id ? { ...t, ...next } : t)));
    setError('');
    try {
      const data = await send(`/api/todos/${todo.id}`, 'PATCH', { owner_id: next.owner_id, owner: next.owner });
      if (data.todo) setTodos((all) => all.map((t) => (t.id === todo.id ? { ...t, owner: data.todo.owner, owner_id: data.todo.owner_id } : t)));
    } catch (err) {
      setTodos(prev);
      setError(err instanceof Error ? err.message : 'Could not change the owner');
    }
  };

  const reschedule = async (todo: BoardTodo, due_date: string) => {
    const prev = todos;
    setTodos((all) => all.map((t) => (t.id === todo.id ? { ...t, due_date } : t)));
    setError('');
    try {
      await send(`/api/todos/${todo.id}`, 'PATCH', { due_date });
    } catch (err) {
      setTodos(prev);
      setError(err instanceof Error ? err.message : 'Could not change the due date');
    }
  };

  const remove = async (todo: BoardTodo) => {
    if (!window.confirm(`Delete "${todo.title}"? This cannot be undone.`)) return;
    const prev = todos;
    setTodos((all) => all.filter((t) => t.id !== todo.id));
    try {
      await send(`/api/todos/${todo.id}`, 'DELETE');
    } catch (err) {
      setTodos(prev);
      setError(err instanceof Error ? err.message : 'Could not delete the to-do');
    }
  };

  return (
    <div>
      <div className="border border-line rounded-xl p-4 bg-bg-elevated mb-4">
        <div className="flex flex-col sm:flex-row gap-2">
          <input
            ref={titleRef}
            className="input text-sm flex-1"
            placeholder="New to-do"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') add();
            }}
          />
          <OwnerPicker
            value={owner}
            onChange={setOwner}
            team={team}
            initialPeople={people}
            className="text-sm sm:w-44"
            aria-label="Owner of the new to-do"
          />
          <input type="date" className="input text-sm sm:w-40" value={dueDate} onChange={(e) => setDueDate(e.target.value)} aria-label="Due date" title="Due in 7 days by default" />
          <button onClick={add} disabled={saving || !title.trim()} className="btn-primary text-sm">
            {saving ? 'Adding…' : 'Add'}
          </button>
        </div>
      </div>

      {error && <p className="mb-3 p-3 rounded-xl text-sm bg-red-50 border border-red-200 text-red-800">{error}</p>}
      {closedCount > 0 && (
        <p className="mb-3 text-xs text-ink-muted">
          {closedCount} closed this visit.{' '}
          <button className="text-accent hover:underline" onClick={() => window.location.reload()}>
            Refresh
          </button>{' '}
          to see them in the lists below.
        </p>
      )}

      <p className="text-xs font-semibold text-ink-muted uppercase tracking-wide mb-2">
        Open <span className="font-normal ml-1">({todos.length})</span>
      </p>
      {todos.length === 0 ? (
        <div className="card text-center py-10">
          <p className="text-sm text-ink-secondary">No open to-dos.</p>
        </div>
      ) : (
        <div className="border border-line rounded-xl overflow-hidden">
          {todos.map((todo, i) => (
            <div key={todo.id} className={`flex items-start gap-3 px-4 py-3 ${i < todos.length - 1 ? 'border-b border-line' : ''}`}>
              <button
                onClick={() => close(todo, 'done')}
                className="mt-0.5 w-5 h-5 rounded-md border border-line-strong flex-shrink-0 hover:border-state-success hover:bg-state-success/10 transition-colors"
                aria-label="Mark done"
                title="Mark done"
              />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-ink-primary">
                  {todo.title}
                  {(() => {
                    const age = ageInDays(String(todo.created_at), today);
                    return (
                      <span
                        className={`ml-2 align-middle text-xs px-2 py-0.5 rounded-full font-normal tabular-nums ${
                          age > TODO_MAX_AGE_DAYS ? 'bg-state-danger/15 text-state-danger' : 'bg-bg-elevated text-ink-muted'
                        }`}
                        title={age > TODO_MAX_AGE_DAYS ? `Over ${TODO_MAX_AGE_DAYS} days: make it an issue` : 'Days since it was added'}
                      >
                        {age}d
                      </span>
                    );
                  })()}
                </p>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-0.5 text-xs">
                  <OwnerPicker
                    size="sm"
                    value={{ owner_id: todo.owner_id, owner: todo.owner }}
                    onChange={(v) => reassign(todo, v)}
                    team={team}
                    initialPeople={people}
                    aria-label={`Owner of ${todo.title}`}
                  />
                  {todo.meeting_id && todo.meeting_title ? (
                    <a href={`/dashboard/meetings/${todo.meeting_id}?tab=eos`} className="text-accent hover:text-accent-dim">
                      {todo.meeting_title} · {todo.meeting_date}
                    </a>
                  ) : (
                    <span className="text-ink-muted">Added {String(todo.created_at).slice(0, 10)}</span>
                  )}
                  <label className="text-ink-muted flex items-center gap-1">
                    due
                    <input
                      type="date"
                      defaultValue={todo.due_date ?? ''}
                      onBlur={(e) => { if (e.target.value && e.target.value !== (todo.due_date ?? '')) reschedule(todo, e.target.value); }}
                      className={`text-xs px-1.5 py-0.5 rounded-md border bg-transparent ${todo.due_date && todo.due_date < today ? 'border-state-danger/40 text-state-danger' : 'border-line text-ink-secondary'}`}
                      aria-label={`Due date of ${todo.title}`}
                    />
                  </label>
                  <button onClick={() => close(todo, 'not_done')} className="text-ink-muted hover:text-state-danger">
                    Not done
                  </button>
                  <button onClick={() => close(todo, 'dropped')} className="text-ink-muted hover:text-ink-primary">
                    Drop
                  </button>
                  <button onClick={() => remove(todo)} className="text-ink-muted hover:text-state-danger">
                    Delete
                  </button>
                </div>
                <StepsPanel type="todo" parentId={todo.id} parentTitle={todo.title} initialSteps={stepsByTodo[todo.id] ?? []} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
