import type { AstroCookies } from 'astro';

// Two EOS teams share one login. The active team is a cookie set by the
// switcher in the header; every list page and every "current context" query
// (rocks, open to-dos, open issues, scorecard) is scoped to it. A meeting is
// stamped with its team on creation and keeps it.

export type TeamId = 'leadership' | 'management';

export const TEAMS: Array<{ id: TeamId; label: string; short: string }> = [
  { id: 'leadership', label: 'Leadership team', short: 'Leadership' },
  { id: 'management', label: 'Management team', short: 'Management' },
];

export const TEAM_COOKIE = 'flammard_team';

export const isTeam = (v: unknown): v is TeamId => TEAMS.some((t) => t.id === v);

export function currentTeam(cookies: AstroCookies): TeamId {
  const v = cookies.get(TEAM_COOKIE)?.value;
  return isTeam(v) ? v : 'leadership';
}

export function setTeam(cookies: AstroCookies, team: TeamId): void {
  cookies.set(TEAM_COOKIE, team, { path: '/', sameSite: 'lax', maxAge: 60 * 60 * 24 * 365 });
}

export const teamLabel = (id: string) => TEAMS.find((t) => t.id === id)?.label ?? id;
