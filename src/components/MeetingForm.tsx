import { useState } from 'react';
import type { Attendee } from '../types';

interface MeetingFormProps {
  onCreated?: (id: string) => void;
}

export default function MeetingForm({ onCreated }: MeetingFormProps) {
  const [title, setTitle] = useState('');
  const [date, setDate] = useState(new Date().toISOString().split('T')[0]);
  const [location, setLocation] = useState('');
  const [attendees, setAttendees] = useState<Attendee[]>([{ name: '', email: '' }]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const addAttendee = () => setAttendees([...attendees, { name: '', email: '' }]);

  const removeAttendee = (i: number) =>
    setAttendees(attendees.filter((_, idx) => idx !== i));

  const updateAttendee = (i: number, field: keyof Attendee, val: string) =>
    setAttendees(attendees.map((a, idx) => (idx === i ? { ...a, [field]: val } : a)));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    const clean = attendees.filter((a) => a.name.trim());

    const res = await fetch('/api/meetings/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: title.trim(), date, location: location.trim(), attendees: clean }),
    });

    const json = await res.json();

    if (!res.ok) {
      setError(json.error ?? 'Failed to create meeting');
      setLoading(false);
      return;
    }

    if (onCreated) {
      onCreated(json.id);
    } else {
      window.location.href = `/dashboard/meetings/${json.id}`;
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6 max-w-2xl">
      {error && (
        <div className="p-3 bg-state-danger/10 border border-state-danger/20 rounded-lg text-sm text-state-danger">
          {error}
        </div>
      )}

      <div>
        <label className="label" htmlFor="title">Meeting title</label>
        <input
          id="title"
          type="text"
          required
          className="input"
          placeholder="Q2 Board Meeting"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="label" htmlFor="date">Date</label>
          <input
            id="date"
            type="date"
            required
            className="input"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </div>
        <div>
          <label className="label" htmlFor="location">Location <span className="text-ink-muted">(optional)</span></label>
          <input
            id="location"
            type="text"
            className="input"
            placeholder="Boardroom A / Zoom"
            value={location}
            onChange={(e) => setLocation(e.target.value)}
          />
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="label mb-0">Attendees <span className="text-ink-muted">(optional)</span></label>
          <button type="button" onClick={addAttendee} className="text-xs text-accent hover:text-accent-dim transition-colors">
            + Add attendee
          </button>
        </div>
        <div className="space-y-2">
          {attendees.map((a, i) => (
            <div key={i} className="flex gap-2">
              <input
                type="text"
                className="input flex-1"
                placeholder="Full name"
                value={a.name}
                onChange={(e) => updateAttendee(i, 'name', e.target.value)}
              />
              <input
                type="email"
                className="input flex-1"
                placeholder="Email (for distribution)"
                value={a.email ?? ''}
                onChange={(e) => updateAttendee(i, 'email', e.target.value)}
              />
              {attendees.length > 1 && (
                <button
                  type="button"
                  onClick={() => removeAttendee(i)}
                  className="px-2.5 text-ink-muted hover:text-state-danger transition-colors text-lg leading-none"
                >
                  ×
                </button>
              )}
            </div>
          ))}
        </div>
        <p className="text-xs text-ink-muted mt-2">Email is used for acknowledgement distribution. No account required for recipients.</p>
      </div>

      <div className="pt-2">
        <button type="submit" disabled={loading} className="btn-primary py-3 px-6">
          {loading ? 'Creating meeting…' : 'Create meeting & add content →'}
        </button>
      </div>
    </form>
  );
}
