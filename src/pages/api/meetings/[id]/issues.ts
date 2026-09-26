import type { APIRoute } from 'astro';
import { getMeeting, json, notFound, readBody, requireAuth } from '../../../../lib/api';
import { insertIssue } from '../../../../lib/issues';

export const POST: APIRoute = async ({ params, request, cookies }) => {
  const denied = requireAuth(cookies);
  if (denied) return denied;

  const meeting = await getMeeting<{ id: string; team: string }>(params.id, 'id, team');
  if (!meeting) return notFound();

  const result = await insertIssue(await readBody(request), meeting.team, meeting.id);
  if ('error' in result) return json({ error: result.error }, 400);
  return json({ issue: result.issue });
};
