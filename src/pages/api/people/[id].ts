import type { APIRoute } from 'astro';
import { isUuid, json, principal, readBody } from '../../../lib/api';
import { startPersonSession } from '../../../lib/auth';
import { one, sql } from '../../../lib/db';
import { syncOwnerNameQueries } from '../../../lib/people';
import { canManagePerson, isRole } from '../../../lib/permissions';
import { isTeam } from '../../../lib/teams';
import type { Person, Role, TeamId } from '../../../types';

// PATCH /api/people/[id]: any of { name, email, title, role, teams, aliases, active }.
// Invariants (spec §3.5):
//   - only an owner may edit, promote to, or demote from owner/admin
//   - nobody changes their own role or deactivates themselves
//   - there is always at least one active owner
// A rename rewrites the owner text on every item the person owns (same
// transaction). A role, teams or active change bumps session_version, which
// signs the person out everywhere. People are never hard-deleted.

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const RETURNING = `returning id, name, email, title, role, teams, aliases, active,
  (password_hash is not null) as has_password, last_login_at, created_at, updated_at`;

interface Target {
  id: string;
  name: string;
  email: string | null;
  role: Role;
  teams: TeamId[];
  aliases: string[];
  active: boolean;
}

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

function cleanList(list: string[], max = 20): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    const a = raw.trim().slice(0, 120);
    if (!a || seen.has(a.toLowerCase())) continue;
    seen.add(a.toLowerCase());
    out.push(a);
  }
  return out.slice(0, max);
}

export const PATCH: APIRoute = async ({ params, request, locals, cookies }) => {
  const id = params.id;
  if (!isUuid(id)) return json({ error: 'Invalid id' }, 400);
  const actor = principal(locals);
  const isSelf = actor.kind === 'person' && actor.id === id;

  const target = await one<Target>(
    sql().query('select id, name, email, role, teams, aliases, active from people where id = $1', [id])
  );
  if (!target) return json({ error: 'Person not found' }, 404);
  if (!canManagePerson(actor, target)) {
    return json({ error: 'Only an owner can change an owner or admin' }, 403);
  }

  const body = await readBody(request);
  const sets: string[] = [];
  const values: unknown[] = [];
  const set = (col: string, val: unknown, cast = '') => {
    values.push(val);
    sets.push(`${col} = $${values.length}${cast}`);
  };

  let newName: string | null = null;
  if ('name' in body) {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > 120) return json({ error: 'Enter a name (up to 120 characters)' }, 400);
    if (name !== target.name) {
      newName = name;
      set('name', name);
    }
  }

  if ('email' in body) {
    let email: string | null = null;
    if (body.email !== null && body.email !== '') {
      if (typeof body.email !== 'string') return json({ error: 'Invalid email' }, 400);
      email = body.email.trim().toLowerCase() || null;
      if (email && (!EMAIL.test(email) || email.length > 254)) return json({ error: 'That email address looks wrong' }, 400);
    }
    if (email !== target.email) {
      if (email) {
        const taken = await one(sql().query('select 1 from people where email = $1 and id <> $2', [email, id]));
        if (taken) return json({ error: 'Someone already has that email' }, 409);
      }
      set('email', email);
    }
  }

  if ('title' in body) {
    if (body.title !== null && typeof body.title !== 'string') return json({ error: 'Invalid title' }, 400);
    set('title', typeof body.title === 'string' && body.title.trim() ? body.title.trim().slice(0, 120) : null);
  }

  let newRole: Role = target.role;
  if ('role' in body && body.role !== target.role) {
    if (!isRole(body.role)) return json({ error: 'Invalid role' }, 400);
    if (isSelf) return json({ error: "You can't change your own role" }, 403);
    if (!canManagePerson(actor, target, body.role)) {
      return json({ error: 'Only an owner can give or remove the owner or admin role' }, 403);
    }
    newRole = body.role;
    set('role', newRole);
  }

  let teamsChanged = false;
  if ('teams' in body) {
    if (!Array.isArray(body.teams) || !body.teams.every(isTeam)) return json({ error: 'Invalid teams' }, 400);
    const teams = [...new Set(body.teams as TeamId[])];
    if (!sameSet(teams, target.teams ?? [])) {
      teamsChanged = true;
      set('teams', teams, '::text[]');
    }
  }

  if ('aliases' in body) {
    if (!Array.isArray(body.aliases) || !body.aliases.every((a: unknown) => typeof a === 'string')) {
      return json({ error: 'Invalid aliases' }, 400);
    }
    const name = (newName ?? target.name).toLowerCase();
    set('aliases', cleanList(body.aliases).filter((a) => a.toLowerCase() !== name), '::text[]');
  }

  let newActive = target.active;
  if ('active' in body && body.active !== target.active) {
    if (typeof body.active !== 'boolean') return json({ error: 'Invalid active flag' }, 400);
    if (isSelf && !body.active) return json({ error: "You can't deactivate yourself" }, 403);
    newActive = body.active;
    set('active', newActive);
  }

  if (!sets.length) {
    const person = await one<Person>(sql().query(`update people set updated_at = updated_at where id = $1 ${RETURNING}`, [id]));
    return json({ person });
  }

  const bump = newRole !== target.role || teamsChanged || newActive !== target.active;
  if (bump) sets.push('session_version = session_version + 1');
  sets.push('updated_at = now()');

  // Losing an active owner: another active owner must remain. Checked here for
  // a clear message and again in the update itself for concurrent edits.
  const losesOwner = target.role === 'owner' && target.active && (newRole !== 'owner' || !newActive);
  const LAST_OWNER = 'There must always be at least one active owner. Make someone else an owner first.';
  if (losesOwner) {
    const other = await one(
      sql().query("select 1 from people where role = 'owner' and active and id <> $1 limit 1", [id])
    );
    if (!other) return json({ error: LAST_OWNER }, 409);
  }

  values.push(id);
  const idParam = `$${values.length}`;
  const guard = losesOwner
    ? ` and exists (select 1 from people o where o.role = 'owner' and o.active and o.id <> ${idParam})`
    : '';
  const update = sql().query(
    `update people set ${sets.join(', ')} where id = ${idParam}${guard} ${RETURNING}, session_version`,
    values
  );

  let rows: Record<string, any>[];
  try {
    const extra = [
      ...(newName ? syncOwnerNameQueries(id, newName) : []),
      // A deactivated person's open links die with the account
      ...(!newActive && target.active
        ? [sql().query('update person_tokens set used_at = now() where person_id = $1 and used_at is null', [id])]
        : []),
    ];
    if (extra.length) {
      const results = await sql().transaction([update, ...extra]);
      rows = results[0] as Record<string, any>[];
    } else {
      rows = await update;
    }
  } catch (err) {
    if ((err as { code?: string })?.code === '23505') return json({ error: 'Someone already has that email' }, 409);
    throw err;
  }
  const row = rows[0];
  if (!row) return json({ error: LAST_OWNER }, 409);

  const { session_version, ...person } = row;
  // Changing your own teams signs you out everywhere; keep this browser signed in
  if (isSelf && bump) startPersonSession(cookies, { id, session_version });
  return json({ person: person as Person });
};
