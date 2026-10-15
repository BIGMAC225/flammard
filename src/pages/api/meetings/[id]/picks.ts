import type { APIRoute } from 'astro';
import { getMeeting, isUuid, json, notFound, readBody, requireAuth } from '../../../../lib/api';
import { sql } from '../../../../lib/db';
import { loadPicks } from '../../../../lib/l10';

// The top three: the issues the team picked to work in this meeting, in
// order 1, 2, 3. PUT replaces the set; an empty list clears it.
export const GET: APIRoute = async ({ params, cookies }) => {
  const denied = requireAuth(cookies);
  if (denied) return denied;
  const meeting = await getMeeting<{ id: string }>(params.id, 'id');
  if (!meeting) return notFound();
  return json({ picks: await loadPicks(meeting.id) });
};

export const PUT: APIRoute = async ({ params, request, cookies }) => {
  const denied = requireAuth(cookies);
  if (denied) return denied;
  const meeting = await getMeeting<{ id: string; team: string }>(params.id, 'id, team');
  if (!meeting) return notFound();

  const body = await readBody(request);
  const ids: unknown[] = Array.isArray(body.issue_ids) ? body.issue_ids : [];
  if (ids.length > 3 || !ids.every(isUuid) || new Set(ids).size !== ids.length) {
    return json({ error: 'issue_ids must be up to three distinct issue ids' }, 400);
  }
  const db = sql();
  await db.transaction([
    db`delete from meeting_issues where meeting_id = ${meeting.id}`,
    ...(ids as string[]).map(
      (id, i) => db`
        insert into meeting_issues (meeting_id, issue_id, position)
        select ${meeting.id}, i.id, ${i + 1} from issues i where i.id = ${id} and i.team = ${meeting.team}`
    ),
  ]);
  return json({ picks: await loadPicks(meeting.id) });
};
