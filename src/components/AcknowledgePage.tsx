import { useState } from 'react';
import type { Minutes, Meeting } from '../types';

interface Props {
  token: string;
  meeting: Meeting;
  minutes: Minutes;
  alreadyAcknowledged: boolean;
  appName: string;
}

export default function AcknowledgePage({ token, meeting, minutes, alreadyAcknowledged, appName }: Props) {
  const [acknowledged, setAcknowledged] = useState(alreadyAcknowledged);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const acknowledge = async () => {
    setLoading(true);
    setError('');
    const res = await fetch(`/api/acknowledge/${token}`, { method: 'POST' });
    setLoading(false);
    if (res.ok) {
      setAcknowledged(true);
    } else {
      const j = await res.json();
      setError(j.error ?? 'Acknowledgement failed. Please try again.');
    }
  };

  const OUTCOME_COLORS: Record<string, string> = {
    approved: 'text-state-success',
    rejected: 'text-state-danger',
    deferred: 'text-state-warning',
    noted: 'text-accent',
  };

  return (
    <div className="min-h-screen bg-bg-base">
      {/* Header */}
      <div className="bg-bg-surface border-b border-line px-4 py-4">
        <div className="max-w-3xl mx-auto flex items-center justify-between">
          <span className="font-semibold text-ink-primary text-sm">{appName}</span>
          <span className="badge-sealed text-xs">Approved Minutes</span>
        </div>
      </div>

      <div className="max-w-3xl mx-auto px-4 py-8 space-y-6">
        {/* Meeting header */}
        <div>
          <h1 className="text-2xl font-semibold text-ink-primary">{meeting.title}</h1>
          <p className="text-ink-secondary mt-1">{meeting.date}{meeting.location ? ` · ${meeting.location}` : ''}</p>
        </div>

        {/* Seal status */}
        {minutes.content_hash && (
          <div className="bg-accent-muted border border-accent/20 rounded-xl p-4">
            <div className="flex items-center gap-2 mb-2">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" className="text-accent">
                <rect x="3" y="11" width="18" height="11" rx="2" stroke="currentColor" strokeWidth="1.5"/>
                <path d="M7 11V7a5 5 0 0 1 10 0v4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
              </svg>
              <span className="text-xs font-semibold text-accent uppercase tracking-wide">Cryptographically sealed</span>
            </div>
            <p className="font-mono text-xs text-ink-muted break-all">SHA-256: {minutes.content_hash}</p>
            {minutes.sealed_at && (
              <p className="text-xs text-ink-muted mt-1">Sealed {new Date(minutes.sealed_at).toUTCString()}</p>
            )}
          </div>
        )}

        {/* Summary */}
        {minutes.summary && (
          <div className="card">
            <h2 className="text-xs font-semibold text-ink-muted uppercase tracking-widest mb-3">Summary</h2>
            <p className="text-sm text-ink-secondary leading-relaxed">{minutes.summary}</p>
          </div>
        )}

        {/* Decisions */}
        {minutes.decisions.length > 0 && (
          <div className="card">
            <h2 className="text-xs font-semibold text-ink-muted uppercase tracking-widest mb-4">
              Decisions ({minutes.decisions.length})
            </h2>
            <div className="space-y-3">
              {minutes.decisions.map((d) => (
                <div key={d.id} className="flex items-start gap-3">
                  <span className={`mt-1 text-xs font-semibold uppercase tracking-wide flex-shrink-0 ${OUTCOME_COLORS[d.outcome] ?? 'text-accent'}`}>
                    {d.outcome}
                  </span>
                  <div>
                    <p className="text-sm text-ink-primary">{d.text}</p>
                    {d.mover && <p className="text-xs text-ink-muted mt-0.5">Proposed by {d.mover}</p>}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Actions */}
        {minutes.actions.length > 0 && (
          <div className="card">
            <h2 className="text-xs font-semibold text-ink-muted uppercase tracking-widest mb-4">
              Action Items ({minutes.actions.length})
            </h2>
            <div className="space-y-3">
              {minutes.actions.map((a) => (
                <div key={a.id} className="flex items-start gap-3">
                  <div className="w-1.5 h-1.5 rounded-full bg-accent mt-2 flex-shrink-0"></div>
                  <div>
                    <p className="text-sm text-ink-primary">{a.text}</p>
                    <div className="flex gap-3 mt-0.5">
                      {a.owner && <span className="text-xs text-ink-muted">Owner: {a.owner}</span>}
                      {a.due_date && <span className="text-xs text-ink-muted">Due: {a.due_date}</span>}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Discussion */}
        {minutes.discussion.length > 0 && (
          <div className="card">
            <h2 className="text-xs font-semibold text-ink-muted uppercase tracking-widest mb-4">Discussion</h2>
            <div className="space-y-4">
              {minutes.discussion.map((d, i) => (
                <div key={i}>
                  <p className="text-sm font-medium text-ink-primary mb-1">{d.topic}</p>
                  <p className="text-sm text-ink-secondary leading-relaxed">{d.notes}</p>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Acknowledgement */}
        <div className="card">
          {acknowledged ? (
            <div className="text-center py-4">
              <div className="w-12 h-12 rounded-full bg-state-success/15 flex items-center justify-center mx-auto mb-3">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" className="text-state-success">
                  <path d="M20 6L9 17l-5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </div>
              <p className="text-base font-semibold text-ink-primary">Receipt acknowledged</p>
              <p className="text-sm text-ink-secondary mt-1">
                {alreadyAcknowledged ? 'You have already acknowledged these minutes.' : 'Thank you — your acknowledgement has been recorded.'}
              </p>
            </div>
          ) : (
            <div className="text-center py-2">
              <p className="text-sm text-ink-secondary mb-4">
                By clicking below, you confirm that you have received and reviewed these meeting minutes.
              </p>
              {error && <p className="text-sm text-state-danger mb-3">{error}</p>}
              <button
                onClick={acknowledge}
                disabled={loading}
                className="btn-primary py-3 px-8 text-base"
              >
                {loading ? 'Recording…' : 'Acknowledge receipt'}
              </button>
              <p className="text-xs text-ink-muted mt-3">No account required. Your IP address and timestamp will be recorded.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
