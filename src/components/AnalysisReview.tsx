import { useMemo, useState } from 'react';
import type { MeetingAnalysis } from '../types';

interface Props {
  analysis: MeetingAnalysis;
  committing: boolean;
  onCommit: (selected: MeetingAnalysis) => void;
}

type ListKey =
  | 'decisions'
  | 'actions'
  | 'discussion'
  | 'headlines'
  | 'rocks'
  | 'todos_new'
  | 'todos_reviewed'
  | 'issues_new'
  | 'issues_solved';

const SECTIONS: Array<{ key: ListKey; label: string; hint: string }> = [
  { key: 'headlines', label: 'Headlines', hint: 'Customer and employee wins' },
  { key: 'rocks', label: 'Rock updates', hint: 'Status as reported in the meeting' },
  { key: 'todos_reviewed', label: 'Reviewed to-dos', hint: 'Previous to-dos that were closed out' },
  { key: 'todos_new', label: 'New to-dos', hint: '7-day action items' },
  { key: 'issues_solved', label: 'Solved issues', hint: 'IDS items resolved' },
  { key: 'issues_new', label: 'New issues', hint: 'Added to the issues list' },
  { key: 'decisions', label: 'Decisions', hint: 'Go into the minutes' },
  { key: 'actions', label: 'Action items', hint: 'Longer-running follow-ups in the minutes' },
  { key: 'discussion', label: 'Discussion', hint: 'Topics covered, for the minutes' },
];

const pretty = (s: string) => s.replace(/_/g, ' ');

function describe(key: ListKey, item: any): { title: string; meta: string[] } {
  switch (key) {
    case 'decisions':
      return { title: item.text, meta: [item.outcome, item.mover && `by ${item.mover}`] };
    case 'actions':
      return { title: item.text, meta: [item.owner, item.due_date && `due ${item.due_date}`] };
    case 'discussion':
      return { title: item.topic, meta: [item.notes] };
    case 'headlines':
      return { title: item.text, meta: [item.type, item.presenter] };
    case 'rocks':
      return { title: item.title, meta: [pretty(item.status), item.owner, item.notes] };
    case 'todos_new':
      return { title: item.title, meta: [item.owner] };
    case 'todos_reviewed':
      return { title: item.title, meta: [pretty(item.status)] };
    case 'issues_new':
      return { title: item.title, meta: [`${item.priority} priority`, item.description] };
    case 'issues_solved':
      return { title: item.title, meta: [item.resolution] };
  }
}

export default function AnalysisReview({ analysis, committing, onCommit }: Props) {
  // Everything starts checked; unchecking drops the item from the commit.
  const [checked, setChecked] = useState<Record<ListKey, boolean[]>>(() =>
    Object.fromEntries(SECTIONS.map((s) => [s.key, analysis[s.key].map(() => true)])) as Record<ListKey, boolean[]>
  );

  const toggle = (key: ListKey, i: number) =>
    setChecked((c) => ({ ...c, [key]: c[key].map((v, j) => (j === i ? !v : v)) }));

  const toggleAll = (key: ListKey, value: boolean) =>
    setChecked((c) => ({ ...c, [key]: c[key].map(() => value) }));

  const selectedCount = useMemo(
    () => Object.values(checked).reduce((n, list) => n + list.filter(Boolean).length, 0),
    [checked]
  );

  const commit = () => {
    const selected = { ...analysis } as MeetingAnalysis;
    for (const { key } of SECTIONS) {
      (selected as any)[key] = analysis[key].filter((_, i) => checked[key][i]);
    }
    onCommit(selected);
  };

  return (
    <div className="space-y-6">
      <div className="bg-bg-elevated border border-line rounded-xl p-4">
        <p className="text-xs font-semibold text-ink-muted uppercase tracking-wide mb-2">Summary</p>
        <p className="text-sm text-ink-primary leading-relaxed">{analysis.summary}</p>
        {(analysis.meeting_rating != null || analysis.conclude_notes) && (
          <p className="text-xs text-ink-muted mt-3">
            {analysis.meeting_rating != null && <>Rating {analysis.meeting_rating}/10</>}
            {analysis.meeting_rating != null && analysis.conclude_notes && ' · '}
            {analysis.conclude_notes}
          </p>
        )}
      </div>

      {SECTIONS.map(({ key, label, hint }) => {
        const items = analysis[key];
        if (!items.length) return null;
        const allOn = checked[key].every(Boolean);
        return (
          <div key={key}>
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs font-semibold text-ink-muted uppercase tracking-wide">
                {label}
                <span className="ml-1.5 font-normal normal-case tracking-normal">— {hint}</span>
              </p>
              <button
                onClick={() => toggleAll(key, !allOn)}
                className="text-xs text-ink-muted hover:text-ink-primary transition-colors"
              >
                {allOn ? 'Uncheck all' : 'Check all'}
              </button>
            </div>
            <div className="border border-line rounded-xl overflow-hidden">
              {items.map((item, i) => {
                const { title, meta } = describe(key, item);
                const on = checked[key][i];
                return (
                  <label
                    key={i}
                    className={`flex items-start gap-3 px-4 py-3 cursor-pointer ${
                      i < items.length - 1 ? 'border-b border-line' : ''
                    } ${on ? '' : 'opacity-50'}`}
                  >
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() => toggle(key, i)}
                      className="mt-1 accent-current"
                    />
                    <div className="min-w-0">
                      <p className="text-sm text-ink-primary">{title}</p>
                      {meta.filter(Boolean).length > 0 && (
                        <p className="text-xs text-ink-muted mt-0.5">{meta.filter(Boolean).join(' · ')}</p>
                      )}
                    </div>
                  </label>
                );
              })}
            </div>
          </div>
        );
      })}

      <div className="flex items-center gap-3 pt-2">
        <button onClick={commit} disabled={committing} className="btn-primary">
          {committing ? 'Saving…' : `Accept ${selectedCount} item${selectedCount === 1 ? '' : 's'}`}
        </button>
        <p className="text-xs text-ink-muted">
          Writes the checked items to headlines, rocks, to-dos, issues and the minutes draft. You can edit anything afterwards.
        </p>
      </div>
    </div>
  );
}
