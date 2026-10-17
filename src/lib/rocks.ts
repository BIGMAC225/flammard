import { todayLocal } from './dates';
import { one, sql } from './db';
import { quarterOf } from './quarters';
import { getSettings } from './settings';

// Rock rules shared by the rock routes: every rock has one owner and a due
// date (the end of the current firm quarter unless the team says otherwise),
// and a person with more than three rocks in a quarter gets a warning —
// never a block; the team decides.

export const ROCK_LIMIT_PER_QUARTER = 3;

/** The last day of the firm quarter `date` (default today) falls in. */
export async function quarterEndFor(date = todayLocal()): Promise<string> {
  return quarterOf(date, await getSettings()).end_date;
}

/**
 * Warning text when `ownerId` would own more than three rocks that are
 * active or planned in the quarter `dueDate` falls in (excluding `rockId`,
 * the rock being saved), or null when the load is fine.
 */
export async function rockLoadWarning(
  team: string,
  ownerId: string | null,
  dueDate: string | null,
  rockId: string | null = null
): Promise<string | null> {
  if (!ownerId || !dueDate) return null;
  const q = quarterOf(dueDate, await getSettings());
  const row = await one<{ n: number; name: string | null }>(sql()`
    select count(*)::int as n, min(owner) as name from rocks
    where team = ${team} and owner_id = ${ownerId} and id is distinct from ${rockId}
      and status in ('planned', 'on_track', 'off_track')
      and due_date between ${q.start_date}::date and ${q.end_date}::date
  `);
  const others = row?.n ?? 0;
  if (others + 1 <= ROCK_LIMIT_PER_QUARTER) return null;
  return `${row?.name ?? 'This person'} would own ${others + 1} rocks in ${q.label}; EOS suggests no more than ${ROCK_LIMIT_PER_QUARTER}.`;
}
