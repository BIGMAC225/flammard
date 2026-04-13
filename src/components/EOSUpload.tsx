import { useState, useRef } from 'react';
import type { EOSAnalysisResult } from '../types';

interface EOSUploadProps {
  meetingId: string;
  onAnalyzed?: (result: EOSAnalysisResult) => void;
}

const ROCK_STATUS_LABELS: Record<string, string> = {
  on_track: 'On Track',
  off_track: 'Off Track',
  complete: 'Complete',
  dropped: 'Dropped',
};

const ROCK_STATUS_COLORS: Record<string, string> = {
  on_track: 'bg-state-success/15 text-state-success',
  off_track: 'bg-state-danger/15 text-state-danger',
  complete: 'bg-accent/15 text-accent',
  dropped: 'bg-bg-elevated text-ink-muted',
};

const TODO_STATUS_COLORS: Record<string, string> = {
  done: 'bg-state-success/15 text-state-success',
  not_done: 'bg-state-danger/15 text-state-danger',
  open: 'bg-state-warning/15 text-state-warning',
  dropped: 'bg-bg-elevated text-ink-muted',
};

export default function EOSUpload({ meetingId, onAnalyzed }: EOSUploadProps) {
  const [dragging, setDragging] = useState(false);
  const [fileName, setFileName] = useState('');
  const [analyzing, setAnalyzing] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<EOSAnalysisResult | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const handleFile = async (file: File) => {
    if (!file.name.toLowerCase().endsWith('.pdf') && file.type !== 'application/pdf') {
      setError('Please upload a PDF file.');
      return;
    }
    setError('');
    setFileName(file.name);
    setResult(null);
    setSaved(false);
    setAnalyzing(true);

    const formData = new FormData();
    formData.append('file', file);

    const res = await fetch(`/api/meetings/${meetingId}/analyze-pdf`, {
      method: 'POST',
      body: formData,
    });

    const json = await res.json();
    setAnalyzing(false);

    if (!res.ok && res.status !== 207) {
      setError(json.error ?? 'Analysis failed. Please try again.');
      return;
    }

    setResult(json.analysis);
    if (json.warning) setError(json.warning);

    if (onAnalyzed) onAnalyzed(json.analysis);
    else {
      // Auto-reload after a brief pause so the user sees the result
      setTimeout(() => window.location.reload(), 1500);
    }
  };

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) handleFile(file);
  };

  if (saved) {
    return (
      <div className="flex items-center gap-3 p-4 bg-state-success/10 border border-state-success/20 rounded-xl">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" className="text-state-success flex-shrink-0">
          <path d="M20 6L9 17l-5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
        <p className="text-sm text-state-success font-medium">EOS data saved. Reloading…</p>
      </div>
    );
  }

  if (result) {
    return (
      <div className="space-y-5">
        <div className="flex items-center gap-3 p-3 bg-state-success/10 border border-state-success/20 rounded-lg">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" className="text-state-success flex-shrink-0">
            <path d="M20 6L9 17l-5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          <p className="text-sm text-state-success font-medium">
            Analysis complete — {fileName}
          </p>
        </div>

        {error && (
          <div className="p-3 bg-state-warning/10 border border-state-warning/20 rounded-lg text-sm text-state-warning">
            {error}
          </div>
        )}

        {/* Preview grid */}
        <div className="grid sm:grid-cols-2 gap-4">
          {/* Meeting info */}
          <div className="bg-bg-elevated border border-line rounded-xl p-4 space-y-1.5">
            <p className="text-xs font-semibold text-ink-muted uppercase tracking-wide mb-2">Meeting Info</p>
            {result.team_name && <p className="text-sm text-ink-primary font-medium">{result.team_name}</p>}
            {result.meeting_date && <p className="text-sm text-ink-secondary">{result.meeting_date}</p>}
            {result.attendees.length > 0 && (
              <p className="text-xs text-ink-muted">{result.attendees.map((a) => a.name).join(', ')}</p>
            )}
            {result.meeting_rating != null && (
              <p className="text-xs text-ink-secondary">Rating: {result.meeting_rating}/10</p>
            )}
          </div>

          {/* Summary */}
          {result.summary && (
            <div className="bg-bg-elevated border border-line rounded-xl p-4">
              <p className="text-xs font-semibold text-ink-muted uppercase tracking-wide mb-2">Summary</p>
              <p className="text-sm text-ink-secondary leading-relaxed">{result.summary}</p>
            </div>
          )}
        </div>

        {/* Rocks */}
        {result.rocks.length > 0 && (
          <div>
            <p className="text-xs font-semibold text-ink-muted uppercase tracking-wide mb-2">
              Rocks ({result.rocks.length})
            </p>
            <div className="space-y-1.5">
              {result.rocks.map((r, i) => (
                <div key={i} className="flex items-center gap-3 px-3 py-2 bg-bg-elevated border border-line rounded-lg">
                  <span className={`text-xs px-2 py-0.5 rounded-full font-medium flex-shrink-0 ${ROCK_STATUS_COLORS[r.status] ?? ''}`}>
                    {ROCK_STATUS_LABELS[r.status] ?? r.status}
                  </span>
                  <p className="text-sm text-ink-primary flex-1 min-w-0 truncate">{r.title}</p>
                  {r.owner && <p className="text-xs text-ink-muted flex-shrink-0">{r.owner}</p>}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* To-Dos reviewed */}
        {result.todos_reviewed.length > 0 && (
          <div>
            <p className="text-xs font-semibold text-ink-muted uppercase tracking-wide mb-2">
              To-Dos Reviewed ({result.todos_reviewed.length})
            </p>
            <div className="space-y-1.5">
              {result.todos_reviewed.map((t, i) => (
                <div key={i} className="flex items-center gap-3 px-3 py-2 bg-bg-elevated border border-line rounded-lg">
                  <span className={`text-xs px-2 py-0.5 rounded-full font-medium flex-shrink-0 ${TODO_STATUS_COLORS[t.status] ?? ''}`}>
                    {t.status === 'done' ? 'Done' : t.status === 'not_done' ? 'Not Done' : t.status}
                  </span>
                  <p className="text-sm text-ink-secondary flex-1 min-w-0 truncate">{t.title}</p>
                  {t.owner && <p className="text-xs text-ink-muted flex-shrink-0">{t.owner}</p>}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* New to-dos */}
        {result.todos_new.length > 0 && (
          <div>
            <p className="text-xs font-semibold text-ink-muted uppercase tracking-wide mb-2">
              New To-Dos ({result.todos_new.length})
            </p>
            <div className="space-y-1.5">
              {result.todos_new.map((t, i) => (
                <div key={i} className="flex items-center gap-3 px-3 py-2 bg-bg-elevated border border-line rounded-lg">
                  <span className="text-xs px-2 py-0.5 rounded-full font-medium bg-state-warning/15 text-state-warning flex-shrink-0">
                    New
                  </span>
                  <p className="text-sm text-ink-primary flex-1 min-w-0 truncate">{t.title}</p>
                  {t.owner && <p className="text-xs text-ink-muted flex-shrink-0">{t.owner}</p>}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Issues */}
        {(result.issues_solved.length > 0 || result.issues_new.length > 0) && (
          <div>
            <p className="text-xs font-semibold text-ink-muted uppercase tracking-wide mb-2">
              Issues ({result.issues_solved.length + result.issues_new.length})
            </p>
            <div className="space-y-1.5">
              {result.issues_solved.map((iss, i) => (
                <div key={`solved-${i}`} className="flex items-start gap-3 px-3 py-2 bg-bg-elevated border border-line rounded-lg">
                  <span className="text-xs px-2 py-0.5 rounded-full font-medium bg-state-success/15 text-state-success flex-shrink-0 mt-0.5">
                    Solved
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-ink-primary">{iss.title}</p>
                    {iss.resolution && <p className="text-xs text-ink-muted mt-0.5">{iss.resolution}</p>}
                  </div>
                </div>
              ))}
              {result.issues_new.map((iss, i) => (
                <div key={`new-${i}`} className="flex items-center gap-3 px-3 py-2 bg-bg-elevated border border-line rounded-lg">
                  <span className="text-xs px-2 py-0.5 rounded-full font-medium bg-state-danger/15 text-state-danger flex-shrink-0">
                    Open
                  </span>
                  <p className="text-sm text-ink-primary flex-1 min-w-0 truncate">{iss.title}</p>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Scorecard */}
        {result.scorecard.length > 0 && (
          <div>
            <p className="text-xs font-semibold text-ink-muted uppercase tracking-wide mb-2">
              Scorecard ({result.scorecard.length} metrics)
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line">
                    <th className="text-left text-xs text-ink-muted font-medium pb-2 pr-4">Metric</th>
                    <th className="text-left text-xs text-ink-muted font-medium pb-2 pr-4">Owner</th>
                    <th className="text-left text-xs text-ink-muted font-medium pb-2 pr-4">Goal</th>
                    <th className="text-left text-xs text-ink-muted font-medium pb-2">Actual</th>
                  </tr>
                </thead>
                <tbody>
                  {result.scorecard.map((sc, i) => (
                    <tr key={i} className="border-b border-line last:border-0">
                      <td className="py-2 pr-4 text-ink-primary">{sc.title}</td>
                      <td className="py-2 pr-4 text-ink-muted">{sc.owner ?? '—'}</td>
                      <td className="py-2 pr-4 text-ink-muted">{sc.goal ?? '—'}</td>
                      <td className="py-2">
                        <span className={`inline-flex items-center gap-1.5 ${
                          sc.on_track === true ? 'text-state-success' :
                          sc.on_track === false ? 'text-state-danger' : 'text-ink-muted'
                        }`}>
                          {sc.on_track != null && (
                            <span className={`w-2 h-2 rounded-full flex-shrink-0 ${
                              sc.on_track ? 'bg-state-success' : 'bg-state-danger'
                            }`} />
                          )}
                          {sc.value ?? '—'}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <div className="flex items-center gap-3 pt-2">
          <p className="text-xs text-ink-muted flex-1">
            Data has been saved to this meeting. You can now draft minutes or upload another recap.
          </p>
          <button
            onClick={() => {
              setResult(null);
              setFileName('');
              setError('');
              setSaved(false);
            }}
            className="btn-secondary text-sm"
          >
            Upload another
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {error && (
        <div className="p-3 bg-state-danger/10 border border-state-danger/20 rounded-lg text-sm text-state-danger">
          {error}
        </div>
      )}

      <div
        className={`border-2 border-dashed rounded-xl p-10 text-center cursor-pointer transition-colors ${
          dragging
            ? 'border-accent bg-accent/5'
            : 'border-line hover:border-line-strong hover:bg-bg-elevated/50'
        }`}
        onClick={() => !analyzing && fileRef.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        <input
          ref={fileRef}
          type="file"
          accept="application/pdf,.pdf"
          className="hidden"
          onChange={onFileChange}
        />

        {analyzing ? (
          <div className="flex flex-col items-center gap-3">
            <svg className="animate-spin w-8 h-8 text-accent" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeDasharray="60 40" />
            </svg>
            <p className="text-sm font-medium text-ink-primary">Analyzing with Claude…</p>
            <p className="text-xs text-ink-muted">Extracting rocks, to-dos, issues, scorecard, and more</p>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-3">
            <div className="w-12 h-12 rounded-xl bg-bg-elevated border border-line flex items-center justify-center">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" className="text-ink-secondary">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" stroke="currentColor" strokeWidth="1.5"/>
                <path d="M14 2v6h6M12 18v-6M9 15l3-3 3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </div>
            <div>
              <p className="text-sm font-medium text-ink-primary">
                Drop your EOS Recap PDF here
              </p>
              <p className="text-xs text-ink-secondary mt-1">
                Ninety.io, TeamworkIQ, or any EOS L10 recap — Claude will extract all structured data
              </p>
            </div>
            <p className="text-xs text-ink-muted">Click to browse or drag and drop</p>
          </div>
        )}
      </div>

      <p className="text-xs text-ink-muted">
        Analyzes rocks (on/off track), to-dos, issues solved, scorecard metrics, headlines, and meeting rating.
      </p>
    </div>
  );
}
