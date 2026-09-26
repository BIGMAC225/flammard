import type { APIRoute } from 'astro';
import { json, principal, readBody, requirePermission } from '../../../lib/api';
import { many, one, sql } from '../../../lib/db';
import { canManagePerson, isRole } from '../../../lib/permissions';
import { isTeam } from '../../../lib/teams';
import type { Person, TeamId } from '../../../types';

// People admin (spec §4.2). people.manage is checked by the middleware; the
// owner/admin rule (people.grant_admin) is checked here via canManagePerson.
//   GET  → { people: PersonRow[] } (no hashes; link_expires_at = a live unused link)
//   POST { name, email?, title?, role, teams, aliases? } → { person }

type PersonRow = Person & { link_expires_at: string | null; link_purpose: 'setup' | 'reset' | null };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const GET: APIRoute = async ({ locals }) => {
  const denied = requirePermission(locals, 'people.manage');
  if (denied) return denied;
  const people = await many<PersonRow>(sql()`
    select p.id, p.name, p.email, p.title, p.role, p.teams, p.aliases, p.active,
           (p.password_hash is not null) as has_password, p.last_login_at, p.created_at, p.updated_at,
           l.expires_at as link_expires_at, l.purpose as link_purpose
    from people p
    left join lateral (
      select t.expires_at, t.purpose from person_tokens t
      where t.person_id = p.id and t.used_at is null and t.expires_at > now()
      order by t.created_at desc limit 1
    ) l on true
    order by p.active desc, lower(p.name), p.id
  `);
  return json({ people });
};

export const POST: APIRoute = async ({ request, locals }) => {
  const deniedPost = requirePermission(locals, 'people.manage');
  if (deniedPost) return deniedPost;
  const actor = principal(locals);
  const body = await readBody(request);

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name || name.length > 120) return json({ error: 'Enter a name (up to 120 characters)' }, 400);

  let email: string | null = null;
  if (body.email !== undefined && body.email !== null && body.email !== '') {
    if (typeof body.email !== 'string') return json({ error: 'Invalid email' }, 400);
    email = body.email.trim().toLowerCase();
    if (email && (!EMAIL.test(email) || email.length > 254)) return json({ error: 'That email address looks wrong' }, 400);
    if (!email) email = null;
  }

  const title = typeof body.title === 'string' && body.title.trim() ? body.title.trim().slice(0, 120) : null;

  const role = body.role ?? 'member';
  if (!isRole(role)) return json({ error: 'Invalid role' }, 400);
  if (!canManagePerson(actor, { role }, role)) {
    return json({ error: 'Only an owner can add an owner or admin' }, 403);
  }

  const teamsIn = body.teams ?? [];
  if (!Array.isArray(teamsIn) || !teamsIn.every(isTeam)) return json({ error: 'Invalid teams' }, 400);
  const teams = [...new Set(teamsIn as TeamId[])];

  const aliasesIn = body.aliases ?? [];
  if (!Array.isArray(aliasesIn) || !aliasesIn.every((a) => typeof a === 'string')) {
    return json({ error: 'Invalid aliases' }, 400);
  }
  const aliases = dedupe(aliasesIn as string[]).filter((a) => a.toLowerCase() !== name.toLowerCase());

  // Two active people with the same name would make that name ambiguous, and
  // person_name_keys drops ambiguous keys, so auto-matching would stop working
  const sameName = await one(sql().query('select 1 from people where active and lower(btrim(name)) = lower(btrim($1))', [name]));
  if (sameName) return json({ error: 'Someone active already has that name. Edit that person, or add a middle initial to tell them apart.' }, 409);

  if (email) {
    const taken = await one(sql().query('select 1 from people where email = $1', [email]));
    if (taken) return json({ error: 'Someone already has that email' }, 409);
  }

  try {
    const person = await one<Person>(
      sql().query(
        `insert into people (name, email, title, role, teams, aliases, created_by)
         values ($1, $2, $3, $4, $5::text[], $6::text[], $7)
         returning id, name, email, title, role, teams, aliases, active,
                   (password_hash is not null) as has_password, last_login_at, created_at, updated_at`,
        [name, email, title, role, teams, aliases, actor.id]
      )
    );
    return json({ person: { ...person, link_expires_at: null, link_purpose: null } });
  } catch (err) {
    if (isUniqueViolation(err)) return json({ error: 'Someone already has that email' }, 409);
    throw err;
  }
};

/** Trimmed, non-empty, case-insensitively unique; at most 20, each up to 120 characters. */
function dedupe(list: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    const a = raw.trim().slice(0, 120);
    if (!a || seen.has(a.toLowerCase())) continue;
    seen.add(a.toLowerCase());
    out.push(a);
  }
  return out.slice(0, 20);
}

function isUniqueViolation(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { code?: string }).code === '23505';
}
