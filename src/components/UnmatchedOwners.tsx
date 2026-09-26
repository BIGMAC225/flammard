import { useCallback, useEffect, useState } from 'react';
import OwnerPicker, { type OwnerValue } from './OwnerPicker';
import type { PersonOption } from '../types';

// "Unmatched owner names" on the People page (spec §2.4, §5.1): owner text on
// rocks, to-dos, issues and so on that isn't linked to a person. Each name can
// be matched to a person (optionally remembered as an alias) or left as text,
// e.g. a consultant with no account, which moves it to "Kept as text".

interface Item {
  text: string;
  key: string;
  counts: Record<string, number>;
  total: number;
  kept: boolean;
}

const TABLE_LABELS: Record<string, [string, string]> = {
  rocks: ['rock', 'rocks'],
  todos: ['to-do', 'to-dos'],
  issues: ['issue', 'issues'],
  meeting_rocks: ['meeting rock', 'meeting rocks'],
  scorecard_metrics: ['measurable', 'measurables'],
  steps: ['milestone', 'milestones'],
  headlines: ['headline', 'headlines'],
};

function describeCounts(counts: Record<string, number>): string {
  return Object.entries(counts)
    .filter(([, n]) => n > 0)
    .map(([t, n]) => {
      const [one, many] = TABLE_LABELS[t] ?? [t, t];
      return `${n} ${n === 1 ? one : many}`;
    })
    .join(', ');
}

async function send(url: string, method: string, body?: unknown): Promise<Record<string, any>> {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? 'Something went wrong');
  return data;
}

function Row({
  item,
  people,
  onApplied,
  onKeep,
  busy,
}: {
  item: Item;
  people: PersonOption[];
  onApplied: (item: Item, personId: string, alias: boolean) => Promise<void>;
  onKeep: (item: Item) => Promise<void>;
  busy: boolean;
}) {
  const [value, setValue] = useState<OwnerValue>({ owner_id: null, owner: null });
  const [alias, setAlias] = useState(false);
  return (
    <li className="flex flex-col lg:flex-row lg:items-center gap-3 px-4 py-3">
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-ink-primary truncate">{item.text}</p>
        <p className="text-xs text-ink-muted mt-0.5">{describeCounts(item.counts)}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <div className="w-48">
          <OwnerPicker
            value={value}
            onChange={setValue}
            allowUnassigned={false}
            placeholder="Choose a person"
            aria-label={`Person for ${item.text}`}
            initialPeople={people}
            disabled={busy}
          />
        </div>
        <label className="flex items-center gap-1.5 text-xs text-ink-secondary">
          <input type="checkbox" checked={alias} onChange={(e) => setAlias(e.target.checked)} disabled={busy} />
          Remember as alias
        </label>
        <button
          type="button"
          className="btn-primary px-3 py-1.5 text-xs"
          disabled={busy || !value.owner_id}
          onClick={() => value.owner_id && onApplied(item, value.owner_id, alias)}
        >
          Apply
        </button>
        <button type="button" className="btn-ghost px-3 py-1.5 text-xs" disabled={busy} onClick={() => onKeep(item)}>
          Leave as text (no account)
        </button>
      </div>
    </li>
  );
}

export default function UnmatchedOwners({ people }: { people: PersonOption[] }) {
  const [items, setItems] = useState<Item[] | null>(null);
  const [keptNames, setKeptNames] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    try {
      const data = await send('/api/people/unmatched-owners', 'GET');
      setItems(data.items ?? []);
      setKeptNames(data.text_only_owner_names ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load owner names');
      setItems([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (fn: () => Promise<string | void>) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const msg = await fn();
      if (msg) setNotice(msg);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  };

  const backfill = () =>
    run(async () => {
      const data = await send('/api/people/backfill-owners', 'POST');
      const detail = describeCounts(data.updated ?? {});
      return data.total ? `Linked ${data.total} item${data.total === 1 ? '' : 's'}: ${detail}.` : 'Nothing new to match.';
    });

  const apply = (item: Item, personId: string, alias: boolean) =>
    run(async () => {
      const data = await send('/api/people/match-owners', 'POST', { text: item.text, person_id: personId, add_alias: alias });
      const name = people.find((p) => p.id === personId)?.name ?? 'the person';
      return `"${item.text}" → ${name}: ${data.updated} item${data.updated === 1 ? '' : 's'} linked${alias ? ', alias saved' : ''}.`;
    });

  const setKept = (text: string, keep: boolean) =>
    run(async () => {
      await send('/api/people/text-only-owners', 'POST', { text, keep });
      return keep ? `"${text}" will stay as text.` : `"${text}" is back in the list to match.`;
    });

  const open = (items ?? []).filter((i) => !i.kept);
  const keptItems = (items ?? []).filter((i) => i.kept);
  // Kept names that no longer have any unlinked items still show, so they can be removed
  const keptOnly = keptNames.filter((n) => !keptItems.some((i) => i.key === n.trim().toLowerCase()));

  return (
    <section className="mt-12">
      <div className="flex flex-wrap items-start justify-between gap-4 mb-4">
        <div>
          <h2 className="section-title">Unmatched owner names</h2>
          <p className="text-sm text-ink-secondary mt-0.5 max-w-2xl">
            Owner names on rocks, to-dos, issues and other items that aren't linked to a person yet. Link them to a
            person, or leave a name as text for someone without an account, such as a consultant.
          </p>
        </div>
        <button type="button" className="btn-secondary" onClick={backfill} disabled={busy}>
          Match owner names automatically
        </button>
      </div>

      {error && (
        <div role="alert" className="mb-3 p-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-800">
          {error}
        </div>
      )}
      {notice && (
        <div role="status" className="mb-3 p-3 bg-mint-50 border border-mint-200 rounded-xl text-sm text-ink-primary">
          {notice}
        </div>
      )}

      {items === null ? (
        <p className="text-sm text-ink-muted">Loading…</p>
      ) : open.length === 0 ? (
        <p className="text-sm text-ink-muted border border-dashed border-line rounded-xl px-4 py-6 text-center">
          Every owner name is linked to a person{keptItems.length ? ' or kept as text' : ''}.
        </p>
      ) : (
        <ul className="border border-line rounded-xl divide-y divide-line bg-bg-surface">
          {open.map((item) => (
            <Row
              key={item.key}
              item={item}
              people={people}
              busy={busy}
              onApplied={apply}
              onKeep={(i) => setKept(i.text, true)}
            />
          ))}
        </ul>
      )}

      {(keptItems.length > 0 || keptOnly.length > 0) && (
        <details className="mt-4">
          <summary className="text-xs font-semibold text-ink-muted uppercase tracking-wide cursor-pointer select-none">
            Kept as text <span className="font-normal ml-1">({keptItems.length + keptOnly.length})</span>
          </summary>
          <ul className="border border-line rounded-xl divide-y divide-line mt-2">
            {keptItems.map((item) => (
              <li key={item.key} className="flex items-center gap-3 px-4 py-2.5">
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-ink-primary truncate">{item.text}</p>
                  <p className="text-xs text-ink-muted">{describeCounts(item.counts)}</p>
                </div>
                <button type="button" className="btn-ghost px-3 py-1 text-xs" disabled={busy} onClick={() => setKept(item.text, false)}>
                  Match instead
                </button>
              </li>
            ))}
            {keptOnly.map((name) => (
              <li key={name} className="flex items-center gap-3 px-4 py-2.5">
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-ink-primary truncate">{name}</p>
                  <p className="text-xs text-ink-muted">No items at the moment</p>
                </div>
                <button type="button" className="btn-ghost px-3 py-1 text-xs" disabled={busy} onClick={() => setKept(name, false)}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
