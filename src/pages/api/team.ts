import type { APIRoute } from 'astro';
import { json, principal, requireAuth } from '../../lib/api';
import { canAccessTeam } from '../../lib/permissions';
import { isTeam, setTeam } from '../../lib/teams';

// Header team switcher: GET /api/team?set=management&next=/dashboard/todos
// Only teams the principal may see can be chosen (the middleware also
// coerces the cookie on every request).
export const GET: APIRoute = async ({ url, cookies, locals, redirect }) => {
  const denied = requireAuth(cookies);
  if (denied) return denied;

  const team = url.searchParams.get('set');
  if (team !== null) {
    if (!isTeam(team)) return json({ error: 'Unknown team' }, 400);
    if (!canAccessTeam(principal(locals), team)) return json({ error: "You aren't on that team" }, 403);
    setTeam(cookies, team);
  }

  // Only ever redirect within this site
  let to = '/dashboard';
  try {
    const target = new URL(url.searchParams.get('next') ?? '/dashboard', url.origin);
    if (target.origin === url.origin) to = target.pathname + target.search;
  } catch {
    /* keep default */
  }
  return redirect(to);
};
