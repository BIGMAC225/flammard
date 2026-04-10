import { useState } from 'react';
import type { Decision, ActionItem } from '../types';

interface RegisterEntry {
  id: string;
  meeting_id: string;
  meeting_title: string;
  meeting_date: string;
  type: 'decision' | 'action';
  text: string;
  outcome?: string;
  owner?: string;
  due_date?: string;
  status?: string;
}

interface Props {
  entries: RegisterEntry[];
}

type FilterType = 'all' | 'decision' | 'action';
type FilterStatus = 'all' | 'open' | 'completed' | 'overdue' | 'approved' | 'deferred';

export default function DecisionRegister({ entries }: Props) {
  const [typeFilter, setTypeFilter] = useState<FilterType>('all');
  const [statusFilter, setStatusFilter] = useState<FilterStatus>('all');
  const [search, setSearch] = useState('');

  const filtered = entries.filter((e) => {
    if (typeFilter !== 'all' && e.type !== typeFilter) return false;
    if (statusFilter !== 'all') {
      const s = e.outcome ?? e.status ?? '';
      if (s !== statusFilter) return false;
    }
    if (search) {
      const q = search.toLowerCase();
      return (
        e.text.toLowerCase().includes(q) ||
        e.meeting_title.toLowerCase().includes(q) ||
        (e.owner?.toLowerCase().includes(q) ?? false)
      );
    }
    return true;
  });

  const badgeClass = (entry: RegisterEntry) => {
    const val = entry.outcome ?? entry.status ?? '';
    const map: Record<string, string> = {
      approved: 'badge-approved',
      rejected: 'badge-rejected',
      deferred: 'badge-deferred',
      noted: 'badge-noted',
      open: 'badge-open',
      completed: 'badge-completed',
      overdue: 'badge-overdue',
    };
    return map[val] ?? 'badge-draft';
  };

  return (
    <div className="space-y-5">
      {/* Filters */}
      <div className="flex flex-wrap gap-3">
        <input
          type="text"
          className="input flex-1 min-w-48 py-2 text-sm"
          placeholder="Search decisions & actions…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="flex gap-1 p-1 bg-bg-elevated rounded-lg">
          {(['all', 'decision', 'action'] as FilterType[]).map((t) => (
            <button
              key={t}
              onClick={() => setTypeFilter(t)}
              className={`px-3 py-1 rounded-md text-xs font-medium transition-colors capitalize ${
                typeFilter === t ? 'bg-bg-surface text-ink-primary' : 'text-ink-secondary hover:text-ink-primary'
              }`}
            >
              {t === 'all' ? 'All' : t === 'decision' ? 'Decisions' : 'Actions'}
            </button>
          ))}
        </div>
        <select
          className="input py-1.5 text-sm w-auto"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as FilterStatus)}
        >
          <option value="all">All statuses</option>
          <option value="approved">Approved</option>
          <option value="deferred">Deferred</option>
          <option value="noted">Noted</option>
          <option value="rejected">Rejected</option>
          <option value="open">Open</option>
          <option value="completed">Completed</option>
          <option value="overdue">Overdue</option>
        </select>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: 'Total', val: entries.length },
          { label: 'Open actions', val: entries.filter((e) => e.status === 'open').length },
          { label: 'Overdue', val: entries.filter((e) => e.status === 'overdue').length },
          { label: 'Completed', val: entries.filter((e) => e.status === 'completed').length },
        ].map(({ label, val }) => (
          <div key={label} className="bg-bg-surface border border-line rounded-xl p-4">
            <div className="text-2xl font-semibold text-ink-primary">{val}</div>
            <div className="text-xs text-ink-secondary mt-1">{label}</div>
          </div>
        ))}
      </div>

      {/* Table */}
      {filtered.length === 0 ? (
        <div className="text-center py-12 text-ink-muted text-sm">
          {entries.length === 0
            ? 'No decisions or actions recorded yet. They will appear here after meetings are approved.'
            : 'No entries match your filters.'}
        </div>
      ) : (
        <div className="border border-line rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line bg-bg-elevated">
                <th className="text-left px-4 py-3 text-xs font-medium text-ink-muted uppercase tracking-wide">Item</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-ink-muted uppercase tracking-wide hidden sm:table-cell">Meeting</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-ink-muted uppercase tracking-wide hidden md:table-cell">Owner / Date</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-ink-muted uppercase tracking-wide">Status</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((e) => (
                <tr key={`${e.type}-${e.id}`} className="border-b border-line last:border-0 hover:bg-bg-elevated/50 transition-colors">
                  <td className="px-4 py-3">
                    <div className="flex items-start gap-2">
                      <span className={`mt-0.5 badge text-[10px] flex-shrink-0 ${e.type === 'decision' ? 'bg-bg-elevated text-ink-muted' : 'bg-accent-muted text-accent'}`}>
                        {e.type === 'decision' ? 'Decision' : 'Action'}
                      </span>
                      <span className="text-ink-primary text-sm leading-snug">{e.text}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3 hidden sm:table-cell">
                    <a href={`/dashboard/meetings/${e.meeting_id}`} className="text-ink-secondary hover:text-accent transition-colors text-xs">
                      {e.meeting_title}
                    </a>
                    <div className="text-xs text-ink-muted">{e.meeting_date}</div>
                  </td>
                  <td className="px-4 py-3 hidden md:table-cell text-xs text-ink-secondary">
                    {e.owner && <div>{e.owner}</div>}
                    {e.due_date && <div className="text-ink-muted">{e.due_date}</div>}
                  </td>
                  <td className="px-4 py-3">
                    {(e.outcome || e.status) && (
                      <span className={badgeClass(e)}>
                        {e.outcome ?? e.status}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
