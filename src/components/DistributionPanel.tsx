import { useState } from 'react';
import type { Attendee, Distribution } from '../types';

interface Props {
  meetingId: string;
  attendees: Attendee[];
  distributions: Distribution[];
}

export default function DistributionPanel({ meetingId, attendees, distributions }: Props) {
  const [sending, setSending] = useState(false);
  const [results, setResults] = useState<Array<{ email: string; ok: boolean; error?: string }>>([]);
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);

  const emailableAttendees = attendees.filter((a) => a.email?.trim());

  const acknowledgedMap = new Map(
    distributions.map((d) => [d.recipient_email, d])
  );

  const handleDistribute = async () => {
    if (!emailableAttendees.length) {
      setError('No attendees with email addresses. Add emails to attendees before distributing.');
      return;
    }

    setSending(true);
    setError('');
    setResults([]);

    const res = await fetch(`/api/meetings/${meetingId}/distribute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    const json = await res.json();
    setSending(false);

    if (!res.ok) {
      setError(json.error ?? 'Distribution failed');
      return;
    }

    setResults(json.results ?? []);
    setSent(true);
    setTimeout(() => window.location.reload(), 2000);
  };

  return (
    <div className="space-y-5">
      {error && (
        <div className="p-3 bg-state-danger/10 border border-state-danger/20 rounded-lg text-sm text-state-danger">
          {error}
        </div>
      )}

      {sent && results.length > 0 && (
        <div className="p-3 bg-state-success/10 border border-state-success/20 rounded-lg text-sm text-state-success">
          Distribution complete — {results.filter((r) => r.ok).length}/{results.length} sent successfully.
        </div>
      )}

      {/* Recipient list */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-ink-primary">Recipients</h3>
          <span className="text-xs text-ink-muted">
            {distributions.filter((d) => d.acknowledged_at).length}/{distributions.length} acknowledged
          </span>
        </div>

        {attendees.length === 0 ? (
          <p className="text-sm text-ink-muted py-4 text-center">No attendees added to this meeting.</p>
        ) : (
          <div className="divide-y divide-line border border-line rounded-xl overflow-hidden">
            {attendees.map((a, i) => {
              const dist = a.email ? acknowledgedMap.get(a.email) : undefined;
              return (
                <div key={i} className="flex items-center gap-3 px-4 py-3">
                  <div className="w-8 h-8 rounded-full bg-bg-elevated flex items-center justify-center text-xs font-medium text-ink-secondary flex-shrink-0">
                    {a.name.charAt(0).toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-ink-primary truncate">{a.name}</p>
                    {a.email ? (
                      <p className="text-xs text-ink-muted truncate">{a.email}</p>
                    ) : (
                      <p className="text-xs text-state-warning">No email — cannot distribute</p>
                    )}
                  </div>
                  <div className="flex-shrink-0">
                    {!a.email ? (
                      <span className="badge bg-state-warning/10 text-state-warning">No email</span>
                    ) : dist ? (
                      dist.acknowledged_at ? (
                        <span className="badge-approved">Acknowledged</span>
                      ) : (
                        <span className="badge bg-state-info/15 text-state-info">Sent</span>
                      )
                    ) : (
                      <span className="badge-draft">Not sent</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {distributions.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-ink-primary mb-3">Acknowledgement detail</h3>
          <div className="space-y-2">
            {distributions.map((d) => (
              <div key={d.id} className="flex items-center justify-between p-3 bg-bg-elevated border border-line rounded-lg text-xs">
                <div>
                  <span className="text-ink-primary font-medium">{d.recipient_name || d.recipient_email}</span>
                  <span className="text-ink-muted ml-2">{d.recipient_email}</span>
                </div>
                <div className="text-right">
                  {d.acknowledged_at ? (
                    <div>
                      <div className="text-state-success font-medium">Acknowledged</div>
                      <div className="text-ink-muted">{new Date(d.acknowledged_at).toLocaleString()}</div>
                    </div>
                  ) : (
                    <div className="text-ink-muted">
                      Sent {new Date(d.sent_at).toLocaleDateString()}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Send button */}
      {distributions.length === 0 && (
        <button
          onClick={handleDistribute}
          disabled={sending || !emailableAttendees.length}
          className="btn-primary py-3 px-6"
        >
          {sending ? (
            <>
              <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeDasharray="60 40"/>
              </svg>
              Sending…
            </>
          ) : (
            <>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                <path d="M22 2L11 13M22 2L15 22l-4-9-9-4 20-7z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
              Distribute to {emailableAttendees.length} recipient{emailableAttendees.length !== 1 ? 's' : ''}
            </>
          )}
        </button>
      )}
    </div>
  );
}
