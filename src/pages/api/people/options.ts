import type { APIRoute } from 'astro';
import { json, requireAuth } from '../../../lib/api';
import { listPeopleOptions } from '../../../lib/people';

// People for owner pickers. ?include_inactive=1 adds inactive people (after
// the active ones) so existing items can show "Name (inactive)".
export const GET: APIRoute = async ({ url, cookies }) => {
  const denied = requireAuth(cookies);
  if (denied) return denied;

  const v = url.searchParams.get('include_inactive');
  const people = await listPeopleOptions(v === '1' || v === 'true');
  return json({ people });
};
