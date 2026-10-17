import type { APIRoute } from 'astro';
import { getMeeting, isUuid, json, notFound, readBody, requireAuth } from '../../../../lib/api';
import { isIsoDate } from '../../../../lib/dates';
import { plusDays } from '../../../../lib/todos';
import { one, sql } from '../../../../lib/db';
import { loadMeetingTodos } from '../../../../lib/l10';
import { resolveOwner } from '../../../../lib/people';

/**
 * The meeting's To-do review list: every open to-do of the team, plus the
 * ones created or closed in this meeting (not only this meeting's own).
 */
export const GET: APIRoute = async ({ params, cookies }) => {
  const denied = requireAuth(cookies);
  if (denied) return denied;
  const meeting = await getMeeting<{ id: string; team: string }>(params.id, 'id, team');
  if (!meeting) return notFound();
  return json({ todos: await loadMeetingTodos(meeting.id, meeting.team) });
};

export const POST: APIRoute = async ({ params, request, cookies }) => {
  const denied = requireAuth(cookies);
  if (denied) return denied;

  const body = await readBody(request);
  const { title } = body;
  if (typeof title !== 'string' || !title.trim()) return json({ error: 'Title required' }, 400);
  if (body.due_date != null && body.due_date !== '' && !isIsoDate(body.due_date)) return json({ error: 'Invalid due date' }, 400);
  if (body.issue_id != null && !isUuid(body.issue_id)) return json({ error: 'Invalid issue_id' }, 400);
  const owner = await resolveOwner(body);
  if ('error' in owner) return json({ error: owner.error }, 400);

  const meeting = await getMeeting<{ id: string; team: string; date: string }>(params.id, 'id, team, date::text as date');
  if (!meeting) return notFound();

  // A 7-day to-do: due at the next meeting unless the team says otherwise
  const todo = await one(sql()`
    insert into todos (meeting_id, team, title, owner, owner_id, status, due_date, issue_id)
    values (${meeting.id}, ${meeting.team}, ${title.trim().slice(0, 500)}, ${owner.owner}, ${owner.owner_id}, 'open',
            ${body.due_date || plusDays(meeting.date, 7)}, ${body.issue_id ?? null})
    returning *, created_at::text as created_at, updated_at::text as updated_at, due_date::text as due_date
  `);
  return json({ todo });
};
