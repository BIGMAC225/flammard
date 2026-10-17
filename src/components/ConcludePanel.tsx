import { useEffect, useMemo, useState } from 'react';
import OwnerPicker, { type OwnerValue } from './OwnerPicker';
import type { CascadingMessage, MeetingRating, PersonOption, TeamId, Todo } from '../types';

// Conclude: the last five minutes of the L10. Recap the to-dos created in
// this meeting, record the cascading messages (what to tell whom, by whom,
// how), and have every attendee rate the meeting 1–10. Saved as one set:
// the ratings and messages tables, the average on the meeting.

interface Props {
  meetingId: string;
  /** Attendee names from the meeting record; each gets a rating row. */
  attendees: string[];
  initialRatings: MeetingRating[];
  initialMessages: CascadingMessage[];
  initialNotes: string | null;
  /** To-dos created in this meeting (the read-only recap). */
  todos: Todo[];
  /** What the transcript analysis heard, shown as a hint until something is typed. */
  suggested?: { rating: number | null; notes: string | null };
  team?: TeamId;
  people?: PersonOption[];
  sealed?: boolean;
}

interface RatingRow {
  key: string;
  name: string;
  person_id: string | null;
  rating: string; // '' until rated
}
interface MessageRow {
  key: string;
  message: string;
  to_whom: string;
  by_whom: OwnerValue;
  how: string;
}

let seq = 0;
const nextKey = () => `k${++seq}`;
const nameKey = (s: string) => s.trim().toLowerCase();

export default function ConcludePanel({
  meetingId,
  attendees,
  initialRatings,
  initialMessages,
  initialNotes,
  todos,
  suggested,
  team,
  people,
  sealed = false,
}: Props) {
  const [ratings, setRatings] = useState<RatingRow[]>(() => {
    const rows: RatingRow[] = initialRatings.map((r) => ({ key: nextKey(), name: r.name, person_id: r.person_id, rating: String(r.rating) }));
    for (const name of attendees) {
      if (name.trim() && !rows.some((r) => nameKey(r.name) === nameKey(name))) rows.push({ key: nextKey(), name, person_id: null, rating: '' });
    }
    return rows;
  });
  const [messages, setMessages] = useState<MessageRow[]>(() =>
    initialMessages.map((m) => ({
      key: nextKey(),
      message: m.message,
      to_whom: m.to_whom ?? '',
      by_whom: { owner_id: m.by_whom_id, owner: m.by_whom },
      how: m.how ?? '',
    }))
  );
  const [notes, setNotes] = useState(initialNotes ?? '');
  const [extraRater, setExtraRater] = useState<OwnerValue>({ owner_id: null, owner: null });
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [error, setError] = useState('');

  const rated = ratings.filter((r) => r.rating !== '');
  const average = useMemo(
    () => (rated.length ? Math.round((rated.reduce((n, r) => n + Number(r.rating), 0) / rated.length) * 10) / 10 : null),
    [rated]
  );

  const touch = () => {
    setDirty(true);
    setSavedAt(null);
  };

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const setRating = (key: string, value: string) => {
    if (value !== '' && !/^(10|[1-9])$/.test(value)) return;
    setRatings((rows) => rows.map((r) => (r.key === key ? { ...r, rating: value } : r)));
    touch();
  };

  const addRater = (v: OwnerValue) => {
    setExtraRater({ owner_id: null, owner: null });
    if (!v.owner) return;
    if (ratings.some((r) => nameKey(r.name) === nameKey(v.owner!))) return;
    setRatings((rows) => [...rows, { key: nextKey(), name: v.owner!, person_id: v.owner_id, rating: '' }]);
    touch();
  };

  const removeRater = (key: string) => {
    setRatings((rows) => rows.filter((r) => r.key !== key));
    touch();
  };

  const addMessage = (message = '') => {
    setMessages((rows) => [...rows, { key: nextKey(), message, to_whom: '', by_whom: { owner_id: null, owner: null }, how: '' }]);
    touch();
  };
  const setMessage = (key: string, patch: Partial<MessageRow>) => {
    setMessages((rows) => rows.map((m) => (m.key === key ? { ...m, ...patch } : m)));
    touch();
  };
  const removeMessage = (key: string) => {
    setMessages((rows) => rows.filter((m) => m.key !== key));
    touch();
  };

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      const res = await fetch(`/api/meetings/${meetingId}/conclude`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ratings: ratings.map((r) => ({ name: r.name, person_id: r.person_id, rating: r.rating === '' ? null : Number(r.rating) })),
          messages: messages
            .filter((m) => m.message.trim())
            .map((m) => ({ message: m.message, to_whom: m.to_whom, by_whom: m.by_whom.owner, by_whom_id: m.by_whom.owner_id, how: m.how })),
          conclude_notes: notes,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? 'Could not save');
      setDirty(false);
      setSavedAt(new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save');
    } finally {
      setSaving(false);
    }
  };

  const useSuggestedNotes = () => {
    if (!suggested?.notes) return;
    if (messages.length === 0) addMessage(suggested.notes);
    else setNotes(suggested.notes);
    touch();
  };

  return (
    <div className="space-y-6">
      {/* ── Recap: to-dos created in this meeting ───────────────────────── */}
      <div>
        <p className="text-xs font-semibold text-ink-muted uppercase tracking-wide mb-2">
          Recap: to-dos from this meeting <span className="font-normal ml-1">({todos.length})</span>
        </p>
        {todos.length === 0 ? (
          <p className="text-sm text-ink-muted">No to-dos were added in this meeting. Add them in the To-Dos section above.</p>
        ) : (
          <ul className="border border-line rounded-xl overflow-hidden">
            {todos.map((t, i) => (
              <li key={t.id} className={`flex items-center gap-3 px-4 py-2.5 text-sm ${i < todos.length - 1 ? 'border-b border-line' : ''}`}>
                <span className="flex-1 min-w-0 truncate text-ink-primary">{t.title}</span>
                <span className="text-xs text-ink-muted flex-shrink-0">{t.owner ?? 'Unassigned'}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* ── Cascading messages ──────────────────────────────────────────── */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <p className="text-xs font-semibold text-ink-muted uppercase tracking-wide">
            Cascading messages <span className="font-normal ml-1">({messages.length})</span>
          </p>
          {suggested?.notes && messages.length === 0 && !notes && !sealed && (
            <button onClick={useSuggestedNotes} className="text-xs text-accent hover:text-accent-dim">
              Use what the analysis heard
            </button>
          )}
        </div>
        <p className="text-xs text-ink-muted mb-2">What does the rest of the firm need to hear from this meeting, from whom, and how?</p>
        {messages.length > 0 && (
          <div className="space-y-2 mb-2">
            {messages.map((m) => (
              <div key={m.key} className="border border-line rounded-xl p-3 bg-bg-elevated space-y-2">
                <div className="flex gap-2">
                  <input
                    className="input text-sm flex-1"
                    placeholder="Message"
                    value={m.message}
                    disabled={sealed}
                    onChange={(e) => setMessage(m.key, { message: e.target.value })}
                  />
                  {!sealed && (
                    <button onClick={() => removeMessage(m.key)} className="text-ink-muted hover:text-state-danger p-1" aria-label="Remove message">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                        <path d="M18 6L6 18M6 6l12 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                      </svg>
                    </button>
                  )}
                </div>
                <div className="grid sm:grid-cols-3 gap-2">
                  <input
                    className="input text-sm"
                    placeholder="To whom (e.g. all staff)"
                    value={m.to_whom}
                    disabled={sealed}
                    onChange={(e) => setMessage(m.key, { to_whom: e.target.value })}
                  />
                  <OwnerPicker
                    value={m.by_whom}
                    onChange={(v) => setMessage(m.key, { by_whom: v })}
                    team={team}
                    initialPeople={people}
                    placeholder="By whom"
                    disabled={sealed}
                    className="text-sm"
                  />
                  <input
                    className="input text-sm"
                    placeholder="How (e.g. Friday huddle, email)"
                    value={m.how}
                    disabled={sealed}
                    onChange={(e) => setMessage(m.key, { how: e.target.value })}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
        {!sealed && (
          <button onClick={() => addMessage()} className="flex items-center gap-1.5 text-sm text-ink-secondary hover:text-ink-primary transition-colors">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
              <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
            Add message
          </button>
        )}
      </div>

      {/* ── Ratings ─────────────────────────────────────────────────────── */}
      <div>
        <div className="flex items-end justify-between gap-3 mb-2">
          <div>
            <p className="text-xs font-semibold text-ink-muted uppercase tracking-wide">Rate the meeting</p>
            <p className="text-xs text-ink-muted mt-0.5">Each attendee, 1 to 10. Anything under 8: say what would make it a 10.</p>
          </div>
          <div className="text-right">
            <div className="font-display text-3xl font-semibold tracking-tight text-ink-primary tabular-nums">
              {average != null ? average.toFixed(1) : '—'}
            </div>
            <div className="eyebrow">
              average{rated.length ? ` of ${rated.length}` : ''}
              {average == null && suggested?.rating != null ? ` · analysis heard ${suggested.rating}` : ''}
            </div>
          </div>
        </div>
        <div className="border border-line rounded-xl overflow-hidden">
          {ratings.length === 0 && <p className="px-4 py-3 text-sm text-ink-muted">No attendees on this meeting yet. Add a person below.</p>}
          {ratings.map((r, i) => (
            <div key={r.key} className={`flex items-center gap-3 px-4 py-2.5 ${i < ratings.length - 1 ? 'border-b border-line' : ''}`}>
              <span className="flex-1 min-w-0 text-sm text-ink-primary truncate">{r.name}</span>
              <div className="flex gap-1" role="radiogroup" aria-label={`${r.name}'s rating`}>
                {Array.from({ length: 10 }, (_, n) => String(n + 1)).map((v) => (
                  <button
                    key={v}
                    role="radio"
                    aria-checked={r.rating === v}
                    disabled={sealed}
                    onClick={() => setRating(r.key, v)}
                    className={`w-7 h-7 rounded-md text-xs font-medium tabular-nums border transition-colors ${
                      r.rating === v
                        ? Number(v) >= 8
                          ? 'bg-state-success/15 text-state-success border-state-success/30'
                          : 'bg-state-warning/15 text-state-warning border-state-warning/30'
                        : 'border-line text-ink-muted hover:border-line-strong hover:text-ink-primary'
                    }`}
                  >
                    {v}
                  </button>
                ))}
              </div>
              {!sealed && (
                <button onClick={() => removeRater(r.key)} className="text-ink-muted hover:text-state-danger p-1" aria-label={`Remove ${r.name}`}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                    <path d="M18 6L6 18M6 6l12 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                  </svg>
                </button>
              )}
            </div>
          ))}
        </div>
        {!sealed && (
          <div className="mt-2 flex items-center gap-2">
            <OwnerPicker
              value={extraRater}
              onChange={addRater}
              team={team}
              initialPeople={people}
              placeholder="Add a person to rate"
              size="sm"
              aria-label="Add a person to rate the meeting"
            />
          </div>
        )}
      </div>

      {/* ── Notes ───────────────────────────────────────────────────────── */}
      <div>
        <p className="text-xs font-semibold text-ink-muted uppercase tracking-wide mb-2">Closing notes</p>
        <textarea
          className="input text-sm resize-y"
          rows={2}
          placeholder="Anything else to close out (optional)"
          value={notes}
          disabled={sealed}
          onChange={(e) => {
            setNotes(e.target.value);
            touch();
          }}
        />
      </div>

      {!sealed && (
        <div className="flex items-center gap-3">
          <button onClick={save} disabled={saving || !dirty} className="btn-primary text-sm">
            {saving ? 'Saving…' : 'Save conclude'}
          </button>
          {savedAt && <span className="text-xs text-ink-muted">Saved {savedAt}</span>}
          {dirty && !savedAt && <span className="text-xs text-ink-muted">Unsaved changes</span>}
          {error && <span className="text-xs text-state-danger">{error}</span>}
        </div>
      )}
    </div>
  );
}
