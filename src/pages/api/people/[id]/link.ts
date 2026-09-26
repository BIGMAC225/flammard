import type { APIRoute } from 'astro';
import { isUuid, json, principal, readBody } from '../../../../lib/api';
import { one, sql } from '../../../../lib/db';
import { newToken } from '../../../../lib/password';
import { canManagePerson } from '../../../../lib/permissions';
import type { Role } from '../../../../types';

// POST /api/people/[id]/link { purpose?: 'setup' | 'reset' } → { url, expires_at, purpose }
// Creates a one-time sign-in link (spec §3.4): 7 days for setup, 24 hours for
// reset; default setup when the person has no password yet, else reset. Every
// earlier unused link for the person is voided, and rows older than 30 days
// are cleared out. Only the SHA-256 of the token is stored; the URL is
// returned once and never logged.

const LIFETIME = { setup: '7 days', reset: '24 hours' } as const;

export const POST: APIRoute = async ({ params, request, locals, url }) => {
  const id = params.id;
  if (!isUuid(id)) return json({ error: 'Invalid id' }, 400);
  const actor = principal(locals);

  const person = await one<{ id: string; name: string; email: string | null; role: Role; active: boolean; has_password: boolean }>(
    sql().query(
      'select id, name, email, role, active, (password_hash is not null) as has_password from people where id = $1',
      [id]
    )
  );
  if (!person) return json({ error: 'Person not found' }, 404);
  if (!canManagePerson(actor, person)) {
    return json({ error: 'Only an owner can create links for an owner or admin' }, 403);
  }
  if (!person.active) return json({ error: 'Reactivate this person first' }, 400);
  if (!person.email) return json({ error: 'Add a work email first' }, 400);

  const body = await readBody(request);
  const purpose: 'setup' | 'reset' =
    body.purpose === undefined || body.purpose === null ? (person.has_password ? 'reset' : 'setup') : body.purpose;
  if (purpose !== 'setup' && purpose !== 'reset') return json({ error: 'Invalid purpose' }, 400);

  const { token, hash } = newToken();
  const [, , inserted] = await sql().transaction([
    sql().query("delete from person_tokens where person_id = $1 and created_at < now() - interval '30 days'", [id]),
    sql().query('update person_tokens set used_at = now() where person_id = $1 and used_at is null', [id]),
    sql().query(
      `insert into person_tokens (person_id, purpose, token_hash, expires_at, created_by)
       values ($1, $2, $3, now() + $4::interval, $5)
       returning expires_at`,
      [id, purpose, hash, LIFETIME[purpose], actor.id]
    ),
  ]);
  const expires_at = (inserted as Array<{ expires_at: string | Date }>)[0]?.expires_at;

  const res = json({
    url: `${url.origin}/setup/${token}`,
    expires_at: expires_at instanceof Date ? expires_at.toISOString() : expires_at,
    purpose,
  });
  res.headers.set('Cache-Control', 'no-store');
  return res;
};
