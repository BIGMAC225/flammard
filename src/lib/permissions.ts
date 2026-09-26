import type { Principal, Role, TeamId } from '../types';

// Roles → named permissions (spec §3.5), and the route-rule table the
// middleware enforces (§3.6). Pure: no database, safe to import anywhere.

export const ROLES: readonly Role[] = ['owner', 'admin', 'facilitator', 'manager', 'member', 'observer'];

export const ROLE_LABELS: Record<Role, string> = {
  owner: 'Owner',
  admin: 'Admin',
  facilitator: 'Facilitator',
  manager: 'Manager',
  member: 'Member',
  observer: 'Observer',
};

export const isRole = (v: unknown): v is Role => ROLES.includes(v as Role);

export type Permission =
  | 'app.view'
  | 'account.self'
  | 'items.edit'
  | 'meetings.run'
  | 'minutes.approve'
  | 'structure.manage'
  | 'teams.all'
  | 'people.manage'
  | 'people.grant_admin'
  | 'settings.manage'
  | 'import.manage';

const ALL_TEAMS: TeamId[] = ['leadership', 'management'];

// Each role's own permissions; a role also gets everything of the roles below it.
const MATRIX: Record<Role, Permission[]> = {
  observer: ['app.view', 'account.self'],
  member: ['items.edit'],
  manager: ['meetings.run', 'minutes.approve', 'structure.manage'],
  facilitator: ['teams.all'],
  admin: ['people.manage', 'settings.manage', 'import.manage'],
  owner: ['people.grant_admin'],
};

const GRANTS: Record<Role, Set<Permission>> = (() => {
  const out = {} as Record<Role, Set<Permission>>;
  const acc: Permission[] = [];
  for (const role of [...ROLES].reverse()) {
    acc.push(...MATRIX[role]);
    out[role] = new Set(acc);
  }
  return out;
})();

// Never available to the shared team password, whatever SHARED_LOGIN_ROLE says
const NEVER_SHARED = new Set<Permission>([
  'account.self',
  'people.manage',
  'people.grant_admin',
  'settings.manage',
  'import.manage',
]);

export function can(p: Principal | null | undefined, perm: Permission): boolean {
  if (!p) return false;
  if (p.kind === 'shared' && NEVER_SHARED.has(perm)) return false;
  return GRANTS[p.role]?.has(perm) ?? false;
}

/** Teams the principal may see and switch to (a person with none falls back to Leadership). */
export function allowedTeams(p: Principal): TeamId[] {
  if (can(p, 'teams.all')) return [...ALL_TEAMS];
  const teams = ALL_TEAMS.filter((t) => p.teams.includes(t));
  return teams.length ? teams : ['leadership'];
}

export function canAccessTeam(p: Principal, team: TeamId): boolean {
  return allowedTeams(p).includes(team);
}

/**
 * Whether `actor` may create/edit/link/deactivate someone with `target.role`,
 * optionally giving them `newRole`. Owner and admin roles need
 * people.grant_admin. Self-edits and the last-owner rule are checked by the
 * people handlers, which have the ids and the database.
 */
export function canManagePerson(actor: Principal, target: { role: Role }, newRole?: Role): boolean {
  if (!can(actor, 'people.manage')) return false;
  const privileged = (r: Role | undefined) => r === 'owner' || r === 'admin';
  if (privileged(target.role) || privileged(newRole)) return can(actor, 'people.grant_admin');
  return true;
}

// ── Route rules (§3.6), first match wins ─────────────────────────────────────

type Method = 'any' | 'GET' | 'non-GET' | 'POST' | 'PATCH';
type Need = Permission | 'bootstrap';

const MEETING_RUN_ACTIONS = new Set(['recording', 'recording/chunk', 'transcript', 'analyze', 'commit-analysis', 'save']);

const RULES: Array<{ method: Method; test: (path: string) => boolean; need: Need }> = [
  { method: 'any', test: (p) => p === '/api/people/options', need: 'app.view' },
  { method: 'any', test: (p) => p === '/api/people/bootstrap', need: 'bootstrap' },
  { method: 'any', test: (p) => p === '/api/people' || p.startsWith('/api/people/'), need: 'people.manage' },
  { method: 'any', test: (p) => p === '/api/me' || p.startsWith('/api/me/'), need: 'account.self' },
  { method: 'GET', test: (p) => p === '/api/settings', need: 'app.view' },
  { method: 'non-GET', test: (p) => p === '/api/settings', need: 'settings.manage' },
  { method: 'any', test: (p) => p === '/api/import' || p.startsWith('/api/import/'), need: 'import.manage' },
  { method: 'POST', test: (p) => /^\/api\/meetings\/[^/]+\/approve$/.test(p), need: 'minutes.approve' },
  {
    method: 'non-GET',
    test: (p) => {
      if (p === '/api/meetings/create') return true;
      const m = /^\/api\/meetings\/[^/]+\/(.+)$/.exec(p);
      return !!m && MEETING_RUN_ACTIONS.has(m[1]);
    },
    need: 'meetings.run',
  },
  {
    method: 'non-GET',
    test: (p) =>
      /^\/api\/scorecard\/metrics(\/[^/]+)?$/.test(p) ||
      /^\/api\/periods(\/[^/]+)?$/.test(p) ||
      p === '/api/roadmap' ||
      p.startsWith('/api/roadmap/'),
    need: 'structure.manage',
  },
  { method: 'GET', test: (p) => p === '/api/team', need: 'app.view' },
  { method: 'non-GET', test: (p) => p.startsWith('/api/'), need: 'items.edit' },
  { method: 'GET', test: (p) => p.startsWith('/api/'), need: 'app.view' },
  { method: 'any', test: (p) => p === '/dashboard/people', need: 'people.manage' },
  { method: 'any', test: (p) => p === '/dashboard/settings', need: 'settings.manage' },
  { method: 'any', test: (p) => p === '/dashboard/import', need: 'import.manage' },
  { method: 'any', test: (p) => p === '/dashboard/account', need: 'account.self' },
  { method: 'any', test: (p) => p === '/dashboard' || p.startsWith('/dashboard/'), need: 'app.view' },
];

function methodMatches(rule: Method, method: string): boolean {
  if (rule === 'any') return true;
  const safe = method === 'GET' || method === 'HEAD' || method === 'OPTIONS';
  if (rule === 'GET') return safe;
  if (rule === 'non-GET') return !safe;
  return method === rule;
}

/**
 * Checks a request against the route rules. `ctx.bootstrapOpen` must be
 * supplied (by the middleware) for the bootstrap endpoints and for a shared
 * principal on /dashboard/people; otherwise those are refused.
 */
export function checkRoute(
  method: string,
  pathname: string,
  p: Principal,
  ctx: { bootstrapOpen?: boolean } = {}
): { ok: true } | { ok: false; status: 403 } {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  const m = method.toUpperCase();
  const rule = RULES.find((r) => methodMatches(r.method, m) && r.test(path));
  if (!rule) return { ok: false, status: 403 };
  let ok: boolean;
  if (rule.need === 'bootstrap') {
    // The handler answers 409 once bootstrap has closed, so only the principal kind is checked here
    ok = p.kind === 'shared';
  } else {
    ok = can(p, rule.need);
    // The owner-bootstrap form lives on the People page for the shared login
    if (!ok && path === '/dashboard/people' && p.kind === 'shared' && ctx.bootstrapOpen === true) ok = true;
  }
  return ok ? { ok: true } : { ok: false, status: 403 };
}

/** Whether checkRoute needs `bootstrapOpen` for this request (saves a query otherwise). */
export function routeNeedsBootstrapCheck(pathname: string, p: Principal): boolean {
  const path = pathname.replace(/\/+$/, '');
  return p.kind === 'shared' && (path === '/api/people/bootstrap' || path === '/dashboard/people');
}
