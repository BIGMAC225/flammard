import type { APIRoute } from 'astro';
import { json, principal, readBody } from '../../../lib/api';
import { startPersonSession } from '../../../lib/auth';
import { many, one, sql } from '../../../lib/db';
import { hashPassword, passwordProblem } from '../../../lib/password';
import { bootstrapOpen } from '../../../lib/people';
import { getSettings } from '../../../lib/settings';

// First-owner bootstrap (spec §3.7). Only the shared team login may use it,
// and only while no active owner has a password. Once an owner can sign in,
// both methods return 409.
//   GET  → { claimable: [{ id, name, email }], email_domain }
//   POST { person_id, email, password }  claims a seeded owner row
//   POST { name, email, password }       creates the first owner (only when no active owner row exists)
// The write is one conditional statement, so two tabs can't both succeed.

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLOSED = 'An owner account is already set up. Sign in with your email and password.';
const NO_OWNER_WITH_PASSWORD =
  "not exists (select 1 from people o where o.role = 'owner' and o.active and o.password_hash is not null)";

function sharedOnly(locals: App.Locals): Response | null {
  return principal(locals).kind === 'shared'
    ? null
    : json({ error: 'Owner setup is done from the team password sign-in' }, 403);
}

export const GET: APIRoute = async ({ locals }) => {
  const denied = sharedOnly(locals);
  if (denied) return denied;
  if (!(await bootstrapOpen())) return json({ error: CLOSED }, 409);

  const [claimable, settings] = await Promise.all([
    many<{ id: string; name: string; email: string | null }>(
      sql()`select id, name, email from people
            where role = 'owner' and active and password_hash is null order by lower(name)`
    ),
    getSettings(),
  ]);
  return json({ claimable, email_domain: settings.email_domain });
};

export const POST: APIRoute = async ({ request, locals, cookies }) => {
  const denied = sharedOnly(locals);
  if (denied) return denied;
  if (!(await bootstrapOpen())) return json({ error: CLOSED }, 409);

  const body = await readBody(request);
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!EMAIL.test(email) || email.length > 254) return json({ error: 'Enter your work email' }, 400);
  if (typeof body.password !== 'string') return json({ error: 'Enter a password' }, 400);
  const problem = passwordProblem(body.password, email);
  if (problem) return json({ error: problem }, 400);

  const claiming = body.person_id !== undefined && body.person_id !== null && body.person_id !== '';
  if (claiming && (typeof body.person_id !== 'string' || !UUID.test(body.person_id))) {
    return json({ error: 'Invalid person_id' }, 400);
  }
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!claiming && (!name || name.length > 120)) return json({ error: 'Enter your name' }, 400);

  const taken = await one(
    sql().query('select 1 from people where email = $1 and id is distinct from $2::uuid', [
      email,
      claiming ? body.person_id : null,
    ])
  );
  if (taken) return json({ error: 'That email belongs to someone else in People' }, 409);

  const hash = await hashPassword(body.password);
  let row: { id: string; session_version: number } | null;
  try {
    row = claiming
      ? await one(
          sql().query(
            `update people set email = $2, password_hash = $3, password_updated_at = now(),
               session_version = session_version + 1, last_login_at = now(), updated_at = now(),
               teams = case when cardinality(teams) = 0 then array['leadership', 'management']::text[] else teams end
             where id = $1 and role = 'owner' and active and password_hash is null and ${NO_OWNER_WITH_PASSWORD}
             returning id, session_version`,
            [body.person_id, email, hash]
          )
        )
      : await one(
          sql().query(
            `insert into people (name, email, role, teams, password_hash, password_updated_at, last_login_at)
             select $1, $2, 'owner', array['leadership', 'management']::text[], $3, now(), now()
             where not exists (select 1 from people o where o.role = 'owner' and o.active)
             returning id, session_version`,
            [name, email, hash]
          )
        );
  } catch (err) {
    if ((err as { code?: string })?.code === '23505') return json({ error: 'That email belongs to someone else in People' }, 409);
    throw err;
  }

  if (!row) {
    return (await bootstrapOpen())
      ? json({ error: 'That owner account was already claimed or is not available. Reload the page.' }, 409)
      : json({ error: CLOSED }, 409);
  }

  // Swap the shared cookie for this person's
  startPersonSession(cookies, row);
  return json({ next: '/dashboard/people' });
};
