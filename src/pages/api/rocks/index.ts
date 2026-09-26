import type { APIRoute } from 'astro';
import { isUuid, json, readBody, requireAuth, requireEnum } from '../../../lib/api';
import { one, sql } from '../../../lib/db';
import { currentTeam } from '../../../lib/teams';

const STATUSES = ['planned', 'on_track', 'off_track', 'complete', 'dropped'];

// Creates a master rock directly (roadmap / rocks page), outside any meeting.
export const POST: APIRoute = async ({ request, cookies }) => {
  const denied = requireAuth(cookies);
  if (denied) return denied;

  const body = await readBody(request);
  const { title, owner, notes, period_id, status } = body;
  if (typeof title !== 'string' || !title.trim()) return json({ error: 'Title required' }, 400);
  if (period_id != null && !isUuid(period_id)) return json({ error: 'Invalid period' }, 400);
  const invalid = requireEnum(body, 'status', STATUSES);
  if (invalid) return invalid;

  const team = currentTeam(cookies);
  const rock = await one(sql()`
    insert into rocks (team, period_id, title, owner, notes, status)
    values (${team}, ${period_id ?? null}, ${title.trim()}, ${typeof owner === 'string' && owner.trim() ? owner.trim() : null},
            ${typeof notes === 'string' && notes.trim() ? notes.trim() : null}, ${status ?? 'planned'})
    returning *, due_date::text as due_date
  `);
  return json({ rock });
};
