import type { APIRoute } from 'astro';
import { isUuid, json, readBody, requireAuth, requireEnum } from '../../../lib/api';
import { one, sql } from '../../../lib/db';
import { currentTeam } from '../../../lib/teams';
import { todayLocal } from '../../../lib/dates';
import { resolveOwner } from '../../../lib/people';

const STATUSES = ['planned', 'on_track', 'off_track', 'complete', 'dropped'];
const LEVELS = ['company', 'individual'];

// Creates a master rock directly (roadmap / rocks page), outside any meeting.
export const POST: APIRoute = async ({ request, cookies }) => {
  const denied = requireAuth(cookies);
  if (denied) return denied;

  const body = await readBody(request);
  const { title, notes, period_id, status } = body;
  if (typeof title !== 'string' || !title.trim()) return json({ error: 'Title required' }, 400);
  if (period_id != null && !isUuid(period_id)) return json({ error: 'Invalid period' }, 400);
  const invalid = requireEnum(body, 'status', STATUSES);
  if (invalid) return invalid;
  if (body.level != null && !LEVELS.includes(body.level)) return json({ error: 'Invalid level' }, 400);
  const owner = await resolveOwner(body);
  if ('error' in owner) return json({ error: owner.error }, 400);

  const team = currentTeam(cookies);
  const db = sql();

  // Without an explicit status: planned if the period is ahead, on track if
  // it's underway or the rock has no period (it's being worked now)
  let rockStatus = status ?? 'on_track';
  if (period_id) {
    const period = await one<{ start_date: string; end_date: string }>(
      db`select start_date::text as start_date, end_date::text as end_date from periods where id = ${period_id} and team = ${team}`
    );
    if (!period) return json({ error: 'Period not found' }, 404);
    if (!status) {
      const today = todayLocal();
      rockStatus = period.end_date < today ? 'complete' : period.start_date > today ? 'planned' : 'on_track';
    }
  }

  const rock = await one(db`
    insert into rocks (team, period_id, title, owner, owner_id, notes, status, level)
    values (${team}, ${period_id ?? null}, ${title.trim()}, ${owner.owner}, ${owner.owner_id},
            ${typeof notes === 'string' && notes.trim() ? notes.trim() : null}, ${rockStatus}, ${body.level ?? null})
    returning *, due_date::text as due_date
  `);
  return json({ rock });
};
