import { useEffect, useState } from 'react';
import type { ImportBatch } from '../types';

// Import history with Undo (spec §6.8). Before undoing it asks the server how
// many imported rows were edited since, and warns that undo deletes them too.

const LABELS: Array<[string, string]> = [
  ['issues', 'issues'],
  ['todos', 'to-dos'],
  ['rocks', 'rocks'],
  ['steps', 'milestones'],
  ['headlines', 'headlines'],
  ['metrics', 'metrics'],
  ['entries', 'values'],
  ['people', 'people'],
  ['periods', 'periods'],
];

const summary = (counts: Record<string, number> | null | undefined) => {
  const parts = LABELS.filter(([k]) => counts?.[k]).map(([k, label]) => `${counts![k]} ${label}`);
  return parts.length ? parts.join(', ') : 'nothing new';
};

export default function ImportHistory({ initial }: { initial: ImportBatch[] }) {
  const [batches, setBatches] = useState(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ id: string; text: string; error?: boolean } | null>(null);

  const refresh = async () => {
    try {
      const res = await fetch('/api/import/batches');
      if (res.ok) setBatches(((await res.json()) as { batches: ImportBatch[] }).batches);
    } catch {
      /* keep the current list */
    }
  };

  useEffect(() => {
    const on = () => void refresh();
    window.addEventListener('ninety-import:changed', on);
    return () => window.removeEventListener('ninety-import:changed', on);
  }, []);

  const undo = async (b: ImportBatch) => {
    setBusy(b.id);
    setMessage(null);
    try {
      const info = await fetch(`/api/import/batches/${b.id}`).then((r) => r.json());
      const edited = Number(info?.edited_since) || 0;
      const warning = edited
        ? `\n\n${edited} imported item${edited === 1 ? ' was' : 's were'} changed after the import; undo deletes ${edited === 1 ? 'it' : 'them'} anyway, including those edits and any steps added to them.`
        : '';
      if (!confirm(`Undo this import? It deletes ${summary(b.counts)} it added.${warning}`)) return;
      const res = await fetch(`/api/import/batches/${b.id}/undo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: true }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? `Undo failed (${res.status})`);
      const c = json.counts as Record<string, number>;
      const kept = c?.people_kept ? ` Kept ${c.people_kept} ${c.people_kept === 1 ? 'person' : 'people'} who now have an email, a password or other items.` : '';
      setMessage({ id: b.id, text: `Removed ${summary(c)}.${kept} Aliases added by the import were kept.` });
      await refresh();
      window.dispatchEvent(new CustomEvent('ninety-import:changed'));
    } catch (err) {
      setMessage({ id: b.id, text: err instanceof Error ? err.message : 'Undo failed', error: true });
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="mt-12">
      <h2 className="section-title mb-4">Import history</h2>
      {batches.length === 0 ? (
        <p className="text-sm text-ink-muted">No imports yet.</p>
      ) : (
        <div className="card p-0 overflow-hidden">
          {batches.map((b, i) => (
            <div key={b.id} className={`px-5 py-4 ${i ? 'border-t border-line' : ''}`}>
              <div className="flex flex-wrap items-center gap-3">
                <span className={b.status === 'committed' ? 'badge bg-state-success/15 text-state-success' : 'badge bg-bg-elevated text-ink-muted'}>
                  {b.status === 'committed' ? 'Imported' : 'Undone'}
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-ink-primary">{summary(b.counts)}</p>
                  <p className="text-xs text-ink-muted">
                    {new Date(b.created_at).toLocaleString()}
                    {b.created_by_name && ` · ${b.created_by_name}`}
                    {b.counts?.skipped_duplicates ? ` · ${b.counts.skipped_duplicates} already imported skipped` : ''}
                    {b.undone_at && ` · undone ${new Date(b.undone_at).toLocaleString()}`}
                  </p>
                  {b.file_names?.length > 0 && <p className="text-xs text-ink-muted truncate">{b.file_names.join(', ')}</p>}
                </div>
                {b.status === 'committed' && (
                  <button type="button" className="btn-secondary text-sm" disabled={busy !== null} onClick={() => void undo(b)}>
                    {busy === b.id ? 'Undoing…' : 'Undo'}
                  </button>
                )}
              </div>
              {message?.id === b.id && (
                <p className={`text-xs mt-2 ${message.error ? 'text-state-danger' : 'text-state-success'}`}>{message.text}</p>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
