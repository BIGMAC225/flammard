import type { APIRoute } from 'astro';
import { json, readBody, requireAuth } from '../../../lib/api';
import { one, sql } from '../../../lib/db';
import { currentTeam } from '../../../lib/teams';

// A to-do added from the To-Dos page, not tied to any meeting.
export const POST: APIRoute = async ({ request, cookies }) => {
  const denied = requireAuth(cookies);
  if (denied) return denied;

  const { title, owner } = await readBody(request);
  if (typeof title !== 'string' || !title.trim()) return json({ error: 'Title required' }, 400);

  const todo = await one(sql()`
    insert into todos (team, title, owner, status)
    values (${currentTeam(cookies)}, ${title.trim().slice(0, 500)}, ${typeof owner === 'string' && owner.trim() ? owner.trim() : null}, 'open')
    returning *
  `);
  return json({ todo });
};
