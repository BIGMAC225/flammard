import { useRef, useState } from 'react';
import { readStreamedJSON } from '../lib/stream-json';
import type { ProposedRoadmap } from '../types';

// Upload the plan (PowerPoint, Word, text) or paste it; Claude lays it out as
// periods → rocks → steps; tick what to keep; save.

type RockKey = string; // `${periodIndex}:${rockIndex}` or `u:${rockIndex}`

export default function RoadmapImport() {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'file' | 'paste'>('file');
  const [pasted, setPasted] = useState('');
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [proposal, setProposal] = useState<ProposedRoadmap | null>(null);
  const [keep, setKeep] = useState<Record<RockKey, boolean>>({});
  const fileRef = useRef<HTMLInputElement>(null);

  const propose = async (init: RequestInit) => {
    setWorking('Reading the plan…');
    setError('');
    setProposal(null);
    try {
      const res = await fetch('/api/roadmap/import', init);
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? `Import failed (${res.status})`);
      }
      setWorking('Laying out periods and rocks…');
      const json = await readStreamedJSON<{ roadmap: ProposedRoadmap }>(res);
      if (json.truncated) throw new Error('That took too long to lay out. Try a smaller part of the plan, or paste the text for one year at a time.');
      if (json.error || !json.roadmap) throw new Error(json.error ?? 'Import failed');
      setProposal(json.roadmap);
      const k: Record<RockKey, boolean> = {};
      json.roadmap.periods.forEach((p, pi) => p.rocks.forEach((_, ri) => (k[`${pi}:${ri}`] = true)));
      json.roadmap.unplaced.forEach((_, ri) => (k[`u:${ri}`] = true));
      setKeep(k);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import failed');
    } finally {
      setWorking(null);
    }
  };

  const fromFile = (file: File) => {
    const form = new FormData();
    form.append('file', file);
    void propose({ method: 'POST', body: form });
  };

  const fromText = () =>
    void propose({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: pasted }) });

  const commit = async () => {
    if (!proposal) return;
    const periods = proposal.periods
      .map((p, pi) => ({ ...p, rocks: p.rocks.filter((_, ri) => keep[`${pi}:${ri}`]) }))
      .filter((p) => p.rocks.length);
    const unplaced = proposal.unplaced.filter((_, ri) => keep[`u:${ri}`]);
    setWorking('Saving…');
    setError('');
    try {
      const res = await fetch('/api/roadmap/commit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ periods, unplaced }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Could not save');
      window.location.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save');
      setWorking(null);
    }
  };

  const kept = Object.values(keep).filter(Boolean).length;

  const rockRow = (key: RockKey, r: ProposedRoadmap['unplaced'][number]) => (
    <label key={key} className={`block px-4 py-3 border-b border-line last:border-0 cursor-pointer ${keep[key] ? '' : 'opacity-50'}`}>
      <div className="flex items-start gap-3">
        <input type="checkbox" checked={!!keep[key]} onChange={() => setKeep((k) => ({ ...k, [key]: !k[key] }))} className="mt-1 accent-current" />
        <div className="min-w-0">
          <p className="text-sm font-medium text-ink-primary">{r.title}</p>
          {(r.owner || r.notes) && <p className="text-xs text-ink-muted mt-0.5">{[r.owner, r.notes].filter(Boolean).join(' · ')}</p>}
          {r.steps.length > 0 && (
            <ul className="mt-1.5 space-y-0.5">
              {r.steps.map((s, i) => (
                <li key={i} className="text-xs text-ink-secondary">
                  • {s.title}
                  {s.substeps.length > 0 && <span className="text-ink-muted"> — {s.substeps.length} sub-step{s.substeps.length === 1 ? '' : 's'}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </label>
  );

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="btn-secondary text-sm">
        Import a plan
      </button>
    );
  }

  return (
    <section className="card">
      <div className="flex items-start justify-between gap-4 mb-4">
        <div>
          <h2 className="section-title">Import a plan</h2>
          <p className="text-sm text-ink-secondary mt-0.5">
            Upload the deck or document your roadmap lives in. Claude lays it out as periods, rocks and steps; you review before anything is saved.
          </p>
        </div>
        <button onClick={() => { setOpen(false); setProposal(null); }} className="btn-ghost text-xs">Close</button>
      </div>

      {error && <div className="p-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-800 mb-4">{error}</div>}

      {!proposal && !working && (
        <>
          <div className="flex gap-1 p-1 bg-bg-elevated rounded-full w-fit mb-4">
            {(['file', 'paste'] as const).map((m) => (
              <button key={m} onClick={() => setMode(m)} className={`px-4 py-1.5 rounded-full text-sm font-semibold transition-all ${mode === m ? 'bg-bg-surface text-accent shadow-soft' : 'text-ink-secondary hover:text-ink-primary'}`}>
                {m === 'file' ? 'Upload a file' : 'Paste text'}
              </button>
            ))}
          </div>
          {mode === 'file' ? (
            <div
              className="border-2 border-dashed border-line rounded-xl p-8 text-center cursor-pointer hover:border-line-strong hover:bg-bg-elevated/50 transition-colors"
              onClick={() => fileRef.current?.click()}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f) fromFile(f); }}
            >
              <input ref={fileRef} type="file" className="hidden" accept=".pptx,.docx,.txt,.md,.csv" onChange={(e) => { const f = e.target.files?.[0]; if (f) fromFile(f); e.target.value = ''; }} />
              <p className="text-sm font-medium text-ink-primary">Drop the plan here or click to browse</p>
              <p className="text-xs text-ink-secondary mt-1">.pptx · .docx · .txt · .md · .csv</p>
            </div>
          ) : (
            <div className="space-y-2">
              <textarea className="input min-h-[220px] resize-y text-sm leading-relaxed" placeholder="Paste the plan — periods, rocks, and the tasks under each" value={pasted} onChange={(e) => setPasted(e.target.value)} />
              <button onClick={fromText} disabled={pasted.trim().length < 40} className="btn-primary text-sm">Lay it out</button>
            </div>
          )}
        </>
      )}

      {working && (
        <p className="text-sm text-ink-secondary">
          <svg className="animate-spin w-4 h-4 inline mr-2 align-[-2px]" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeDasharray="60 40" /></svg>
          {working}
        </p>
      )}

      {proposal && !working && (
        <div className="space-y-5">
          {proposal.periods.map((p, pi) => (
            <div key={pi}>
              <p className="text-xs font-semibold text-ink-muted uppercase tracking-wide mb-2">
                {p.name} <span className="font-normal normal-case tracking-normal">· {p.start_date} → {p.end_date} · {p.rocks.length} rock{p.rocks.length === 1 ? '' : 's'}</span>
              </p>
              <div className="border border-line rounded-xl overflow-hidden bg-bg-surface">
                {p.rocks.map((r, ri) => rockRow(`${pi}:${ri}`, r))}
                {!p.rocks.length && <p className="px-4 py-3 text-xs text-ink-muted">No rocks found for this period.</p>}
              </div>
            </div>
          ))}
          {proposal.unplaced.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-ink-muted uppercase tracking-wide mb-2">Not tied to a period</p>
              <div className="border border-line rounded-xl overflow-hidden bg-bg-surface">{proposal.unplaced.map((r, ri) => rockRow(`u:${ri}`, r))}</div>
            </div>
          )}
          {!proposal.periods.length && !proposal.unplaced.length && (
            <p className="text-sm text-ink-muted">Claude couldn't find periods or rocks in that. Try pasting the text and adding a line like “Aug–Nov 2026:” before each period.</p>
          )}
          <div className="flex items-center gap-3 pt-1">
            <button onClick={commit} disabled={!kept} className="btn-primary text-sm">Add {kept} rock{kept === 1 ? '' : 's'} to the roadmap</button>
            <button onClick={() => setProposal(null)} className="btn-ghost text-sm">Start over</button>
          </div>
        </div>
      )}
    </section>
  );
}
