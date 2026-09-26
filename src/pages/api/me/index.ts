import type { APIRoute } from 'astro';
import { json, principal } from '../../../lib/api';
import { one, sql } from '../../../lib/db';
import type { Person } from '../../../types';

// The signed-in person's own record (no password hash). account.self only,
// which the shared login never has (enforced by the middleware).
export const GET: APIRoute = async ({ locals }) => {
  const p = principal(locals);
  if (p.kind !== 'person') return json({ error: 'Sign in with your own account to see this' }, 403);
  const person = await one<Person>(
    sql().query(
      `select id, name, email, title, role, teams, aliases, active,
              (password_hash is not null) as has_password, last_login_at, created_at, updated_at
       from people where id = $1`,
      [p.id]
    )
  );
  return person ? json({ person }) : json({ error: 'Not found' }, 404);
};
