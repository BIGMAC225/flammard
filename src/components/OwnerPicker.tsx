import { useEffect, useState } from 'react';
import type { PersonOption, TeamId } from '../types';

// Owner picker shared by every owner-bearing form (spec §5.2). A native
// <select>: accessible, fine on phones, and right for 10–30 people.
//
//   <OwnerPicker value={{ owner_id, owner }} onChange={setOwner} team={team} />
//
// Emits { owner_id, owner: name } for a person and { null, null } for
// Unassigned. A legacy text-only owner shows as "<text> (not matched)" and an
// inactive owner as "<name> (inactive)"; both stay selected until changed.

export interface OwnerValue {
  owner_id: string | null;
  owner: string | null;
}

// One request per page load however many pickers render
let cached: Promise<PersonOption[]> | null = null;
let primed: PersonOption[] | null = null;

function loadPeople(): Promise<PersonOption[]> {
  if (primed) return Promise.resolve(primed);
  cached ??= fetch('/api/people/options?include_inactive=1', { credentials: 'same-origin' })
    .then(async (res) => {
      if (!res.ok) throw new Error(res.status === 401 ? 'Signed out' : 'Could not load people');
      const data = (await res.json()) as { people?: PersonOption[] };
      return data.people ?? [];
    })
    .catch((err) => {
      cached = null; // let a later picker retry
      throw err;
    });
  return cached;
}

/**
 * Seeds the shared list from server-rendered data so no picker fetches.
 * Pass the list including inactive people (listPeopleOptions(true)). Call it
 * in the browser only (module state would otherwise be shared across requests).
 */
export function primePeople(people: PersonOption[]): void {
  primed = people;
}

/** The people list for pickers (includes inactive people, flagged `active: false`). */
export function usePeople(initialPeople?: PersonOption[]): {
  people: PersonOption[];
  loading: boolean;
  error: string | null;
} {
  // Initial state matches the server render (hydration); the shared list arrives in the effect
  const [people, setPeople] = useState<PersonOption[]>(initialPeople ?? []);
  const [loading, setLoading] = useState(!initialPeople);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (initialPeople) {
      primed ??= initialPeople;
      return;
    }
    if (primed) {
      setPeople(primed);
      setLoading(false);
      return;
    }
    let live = true;
    loadPeople()
      .then((list) => live && (setPeople(list), setError(null)))
      .catch((err: Error) => live && setError(err.message))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [initialPeople]);

  return { people, loading, error };
}

interface OwnerPickerProps {
  value: OwnerValue;
  onChange: (v: OwnerValue) => void;
  /** People on this team are listed first, everyone else under "Other people". */
  team?: TeamId;
  /** Shown while nothing is chosen; also the default aria-label. Default "Owner". */
  placeholder?: string;
  /** Offer "Unassigned". Default true. */
  allowUnassigned?: boolean;
  /** 'sm' is pill-sized for inline row controls. Default 'md'. */
  size?: 'sm' | 'md';
  disabled?: boolean;
  id?: string;
  'aria-label'?: string;
  /** Server-rendered people list; skips the fetch. */
  initialPeople?: PersonOption[];
  className?: string;
}

const TEXT_VALUE = '__text__';
const personValue = (id: string) => `p:${id}`;

export default function OwnerPicker({
  value,
  onChange,
  team,
  placeholder = 'Owner',
  allowUnassigned = true,
  size = 'md',
  disabled,
  id,
  'aria-label': ariaLabel,
  initialPeople,
  className,
}: OwnerPickerProps) {
  const { people, loading, error } = usePeople(initialPeople);

  const ownerId = value.owner_id || null;
  const ownerText = value.owner?.trim() || null;
  const current = ownerId ? people.find((p) => p.id === ownerId) : undefined;
  const selected = ownerId ? personValue(ownerId) : ownerText ? TEXT_VALUE : '';
  const empty = selected === '';

  const active = people.filter((p) => p.active);
  const primary = team ? active.filter((p) => p.teams.includes(team)) : active;
  const others = team ? active.filter((p) => !p.teams.includes(team)) : [];

  const handle = (v: string) => {
    if (v === '') return onChange({ owner_id: null, owner: null });
    if (v === TEXT_VALUE) return; // re-selecting the legacy text: nothing changes
    const person = people.find((p) => personValue(p.id) === v);
    if (person) onChange({ owner_id: person.id, owner: person.name });
  };

  const sizeClass =
    size === 'sm'
      ? 'text-xs px-2.5 py-1 rounded-full border border-line bg-transparent font-medium cursor-pointer max-w-[11rem] truncate'
      : 'input';
  const tone = empty ? ' text-ink-muted' : '';

  return (
    <select
      id={id}
      value={selected}
      onChange={(e) => handle(e.target.value)}
      disabled={disabled}
      aria-label={ariaLabel ?? placeholder}
      aria-busy={loading || undefined}
      title={error ? `${placeholder}: ${error}` : undefined}
      className={`${sizeClass}${tone}${className ? ` ${className}` : ''}`}
    >
      {allowUnassigned ? (
        <option value="">{empty ? placeholder : 'Unassigned'}</option>
      ) : (
        empty && (
          <option value="" disabled>
            {placeholder}
          </option>
        )
      )}

      {/* The current value when it isn't an active person in the list */}
      {ownerId && current && !current.active && (
        <option value={personValue(ownerId)}>{`${current.name} (inactive)`}</option>
      )}
      {ownerId && !current && (
        <option value={personValue(ownerId)}>{ownerText ?? (loading ? 'Loading…' : 'Unknown person')}</option>
      )}
      {!ownerId && ownerText && <option value={TEXT_VALUE}>{`${ownerText} (not matched)`}</option>}

      {primary.map((p) => (
        <option key={p.id} value={personValue(p.id)}>
          {p.name}
        </option>
      ))}
      {others.length > 0 && (
        <optgroup label="Other people">
          {others.map((p) => (
            <option key={p.id} value={personValue(p.id)}>
              {p.name}
            </option>
          ))}
        </optgroup>
      )}
    </select>
  );
}
