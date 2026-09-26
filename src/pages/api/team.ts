import type { APIRoute } from 'astro';
import { requireAuth } from '../../lib/api';
import { isTeam, setTeam } from '../../lib/teams';

// Header team switcher: GET /api/team?set=management&next=/dashboard/todos
export const GET: APIRoute = async ({ url, cookies, redirect }) => {
  const denied = requireAuth(cookies);
  if (denied) return denied;

  const team = url.searchParams.get('set');
  if (isTeam(team)) setTeam(cookies, team);

  const next = url.searchParams.get('next') ?? '/dashboard';
  return redirect(next.startsWith('/') && !next.startsWith('//') ? next : '/dashboard');
};
