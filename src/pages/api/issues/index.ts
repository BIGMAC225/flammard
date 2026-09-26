import type { APIRoute } from 'astro';
import { json, readBody, requireAuth } from '../../../lib/api';
import { insertIssue } from '../../../lib/issues';
import { currentTeam } from '../../../lib/teams';

// An issue added from the Issues page, not tied to any meeting.
export const POST: APIRoute = async ({ request, cookies }) => {
  const denied = requireAuth(cookies);
  if (denied) return denied;

  const result = await insertIssue(await readBody(request), currentTeam(cookies), null);
  if ('error' in result) return json({ error: result.error }, 400);
  return json({ issue: result.issue });
};
