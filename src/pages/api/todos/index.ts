import type { APIRoute } from 'astro';
import { json, readBody, requireAuth } from '../../../lib/api';
import { isIsoDate } from '../../../lib/dates';
import { one, sql } from '../../../lib/db';
import { resolveOwner } from '../../../lib/people';
import { currentTeam } from '../../../lib/teams';

// A to-do added from the To-Dos page, not tied to any meeting.
export const POST: APIRoute = async ({ request, cookies }) => {
  const denied = requireAuth(cookies);
  if (denied) return denied;

  const body = await readBody(request);
  const { title, description, due_date } = body;
  if (typeof title !== 'string' || !title.trim()) return json({ error: 'Title required' }, 400);
  if (due_date != null && due_date !== '' && !isIsoDate(due_date)) return json({ error: 'Invalid due date' }, 400);
  if (description != null && typeof description !== 'string') return json({ error: 'Invalid description' }, 400);
  const owner = await resolveOwner(body);
  if ('error' in owner) return json({ error: owner.error }, 400);

  const todo = await one(sql()`
    insert into todos (team, title, owner, owner_id, status, due_date, description)
    values (${currentTeam(cookies)}, ${title.trim().slice(0, 500)}, ${owner.owner}, ${owner.owner_id}, 'open',
            ${due_date || null}, ${description?.trim() || null})
    returning *, due_date::text as due_date
  `);
  return json({ todo });
};
