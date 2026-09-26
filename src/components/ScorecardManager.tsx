import { useState } from 'react';
import type { ScorecardEntry, ScorecardMetric } from '../types';

interface Props {
  metrics: ScorecardMetric[];
  entries: ScorecardEntry[];
  periods: string[]; // newest first
}

const FREQ_LABEL: Record<ScorecardMetric['frequency'], string> = {
  weekly: 'Weekly',
  monthly: 'Monthly',
  quarterly: 'Quarterly',
};

const EMPTY_METRIC = { title: '', owner: '', goal: '', unit: '', frequency: 'weekly', description: '' };

export default function ScorecardManager({ metrics, entries, periods }: Props) {
  const [addingMetric, setAddingMetric] = useState(false);
  const [metricForm, setMetricForm] = useState(EMPTY_METRIC);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [addingEntry, setAddingEntry] = useState(false);
  const [entryForm, setEntryForm] = useState({
    metric_id: metrics[0]?.id ?? '',
    period_date: new Date().toISOString().slice(0, 10),
    value: '',
    on_track: '' as '' | 'true' | 'false',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const entryFor = (metricId: string, period: string) =>
    entries.find((e) => e.metric_id === metricId && e.period_date === period);

  const post = async (url: string, method: string, body: unknown) => {
    setSaving(true);
    setError('');
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    setSaving(false);
    if (!res.ok) {
      setError(json.error ?? 'Request failed');
      return false;
    }
    return true;
  };

  const saveMetric = async () => {
    if (!metricForm.title.trim()) return;
    const ok = editingId
      ? await post(`/api/scorecard/metrics/${editingId}`, 'PATCH', metricForm)
      : await post('/api/scorecard/metrics', 'POST', metricForm);
    if (ok) window.location.reload();
  };

  const archiveMetric = async (m: ScorecardMetric) => {
    if (!confirm(`Archive "${m.title}"? Its history is kept but it stops being tracked.`)) return;
    if (await post(`/api/scorecard/metrics/${m.id}`, 'PATCH', { active: false })) window.location.reload();
  };

  const startEdit = (m: ScorecardMetric) => {
    setEditingId(m.id);
    setMetricForm({
      title: m.title,
      owner: m.owner ?? '',
      goal: m.goal ?? '',
      unit: m.unit ?? '',
      frequency: m.frequency,
      description: m.description ?? '',
    });
    setAddingMetric(true);
  };

  const saveEntry = async () => {
    const ok = await post('/api/scorecard/entries', 'POST', {
      ...entryForm,
      on_track: entryForm.on_track === '' ? null : entryForm.on_track === 'true',
    });
    if (ok) window.location.reload();
  };

  const metricFormUI = (
    <div className="border border-line rounded-xl p-4 space-y-3 bg-bg-elevated">
      <div className="grid sm:grid-cols-2 gap-3">
        <input
          autoFocus
          className="input text-sm sm:col-span-2"
          placeholder="Metric name (e.g. Revenue invoiced)"
          value={metricForm.title}
          onChange={(e) => setMetricForm({ ...metricForm, title: e.target.value })}
        />
        <input className="input text-sm" placeholder="Owner" value={metricForm.owner} onChange={(e) => setMetricForm({ ...metricForm, owner: e.target.value })} />
        <select className="input text-sm" value={metricForm.frequency} onChange={(e) => setMetricForm({ ...metricForm, frequency: e.target.value })}>
          {Object.entries(FREQ_LABEL).map(([v, l]) => (
            <option key={v} value={v}>{l}</option>
          ))}
        </select>
        <input className="input text-sm" placeholder="Goal (e.g. ≥ 50000)" value={metricForm.goal} onChange={(e) => setMetricForm({ ...metricForm, goal: e.target.value })} />
        <input className="input text-sm" placeholder="Unit (e.g. $, %, hours)" value={metricForm.unit} onChange={(e) => setMetricForm({ ...metricForm, unit: e.target.value })} />
        <textarea
          className="input text-sm sm:col-span-2 min-h-[64px] resize-y"
          placeholder="Where to find it in the TaxDome report — e.g. “Total invoiced in the Revenue by month table, current month column”. This is what the importer uses to match the number."
          value={metricForm.description}
          onChange={(e) => setMetricForm({ ...metricForm, description: e.target.value })}
        />
      </div>
      <div className="flex gap-2">
        <button onClick={saveMetric} disabled={saving} className="btn-primary text-sm">
          {saving ? 'Saving…' : editingId ? 'Save changes' : 'Add metric'}
        </button>
        <button onClick={() => { setAddingMetric(false); setEditingId(null); setMetricForm(EMPTY_METRIC); }} className="btn-secondary text-sm">
          Cancel
        </button>
      </div>
    </div>
  );

  return (
    <div className="space-y-6">
      {error && (
        <div className="p-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-800">{error}</div>
      )}

      {/* ── Grid ───────────────────────────────────────── */}
      {metrics.length === 0 ? (
        <div className="card text-center py-12">
          <p className="text-sm text-ink-secondary mb-2">No metrics yet.</p>
          <p className="text-xs text-ink-muted">Add the numbers you review every week. TaxDome imports fill them in automatically.</p>
        </div>
      ) : (
        <div className="card p-0 overflow-x-auto">
          <table className="table-brand">
            <thead>
              <tr>
                <th className="min-w-[220px]">Metric</th>
                <th>Goal</th>
                {periods.map((p) => (
                  <th key={p} className="text-right whitespace-nowrap">{p}</th>
                ))}
                <th></th>
              </tr>
            </thead>
            <tbody>
              {metrics.map((m) => (
                <tr key={m.id}>
                  <td className="px-4 py-3">
                    <p className="font-medium text-ink-primary">{m.title}</p>
                    <p className="text-xs text-ink-muted">
                      {[m.owner, FREQ_LABEL[m.frequency]].filter(Boolean).join(' · ')}
                    </p>
                  </td>
                  <td className="px-3 py-3 text-ink-secondary whitespace-nowrap">
                    {m.goal ? `${m.goal}${m.unit && !m.goal.includes(m.unit) ? ` ${m.unit}` : ''}` : '—'}
                  </td>
                  {periods.map((p) => {
                    const e = entryFor(m.id, p);
                    const cls =
                      e?.on_track === true
                        ? 'text-state-success'
                        : e?.on_track === false
                          ? 'text-state-danger'
                          : 'text-ink-primary';
                    return (
                      <td key={p} className={`text-right font-semibold tabular-nums whitespace-nowrap ${cls}`} title={e?.notes ?? (e?.source === 'taxdome' ? 'Imported from TaxDome' : '')}>
                        {e?.value ?? <span className="text-ink-muted">·</span>}
                        {e?.source === 'taxdome' && <span className="ml-1 text-[10px] text-ink-muted align-top">TD</span>}
                      </td>
                    );
                  })}
                  <td className="px-3 py-3 text-right whitespace-nowrap">
                    <button onClick={() => startEdit(m)} className="text-xs text-ink-muted hover:text-ink-primary mr-3">Edit</button>
                    <button onClick={() => archiveMetric(m)} className="text-xs text-ink-muted hover:text-state-danger">Archive</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Actions ────────────────────────────────────── */}
      {addingMetric && metricFormUI}

      {addingEntry && (
        <div className="border border-line rounded-xl p-4 space-y-3 bg-bg-elevated">
          <div className="grid sm:grid-cols-4 gap-3">
            <select className="input text-sm sm:col-span-2" value={entryForm.metric_id} onChange={(e) => setEntryForm({ ...entryForm, metric_id: e.target.value })}>
              {metrics.map((m) => (
                <option key={m.id} value={m.id}>{m.title}</option>
              ))}
            </select>
            <input type="date" className="input text-sm" value={entryForm.period_date} onChange={(e) => setEntryForm({ ...entryForm, period_date: e.target.value })} />
            <input className="input text-sm" placeholder="Value" value={entryForm.value} onChange={(e) => setEntryForm({ ...entryForm, value: e.target.value })} />
            <select className="input text-sm" value={entryForm.on_track} onChange={(e) => setEntryForm({ ...entryForm, on_track: e.target.value as '' | 'true' | 'false' })}>
              <option value="">On track: unknown</option>
              <option value="true">On track</option>
              <option value="false">Off track</option>
            </select>
          </div>
          <div className="flex gap-2">
            <button onClick={saveEntry} disabled={saving || !entryForm.metric_id} className="btn-primary text-sm">
              {saving ? 'Saving…' : 'Save value'}
            </button>
            <button onClick={() => setAddingEntry(false)} className="btn-secondary text-sm">Cancel</button>
          </div>
        </div>
      )}

      {!addingMetric && !addingEntry && (
        <div className="flex gap-4">
          <button onClick={() => setAddingMetric(true)} className="flex items-center gap-1.5 text-sm text-ink-secondary hover:text-ink-primary transition-colors">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
            Add metric
          </button>
          {metrics.length > 0 && (
            <button onClick={() => setAddingEntry(true)} className="flex items-center gap-1.5 text-sm text-ink-secondary hover:text-ink-primary transition-colors">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
              Enter a value manually
            </button>
          )}
        </div>
      )}
    </div>
  );
}
