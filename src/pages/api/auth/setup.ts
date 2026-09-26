import type { APIRoute } from 'astro';
import { json, readBody } from '../../../lib/api';
import { startPersonSession } from '../../../lib/auth';
import { one, sql } from '../../../lib/db';
import { hashPassword, hashToken, passwordProblem } from '../../../lib/password';
import { clearAttempts, failDelay, ipKey, safeClientAddress, tooManyAttempts } from '../../../lib/throttle';

// One-time setup and reset links (spec §3.4). Only sha256(token) is stored.
//   GET  ?token=            → { name, email, purpose, expires_at } or 410
//   POST { token, password } → sets the password, uses the link, signs the person in
// The POST shares the per-IP sign-in throttle.

const GONE = 'This link has expired or was already used. Ask an admin for a new one.';
const TOKEN = /^[A-Za-z0-9_-]{20,100}$/;

const noStore = (res: Response) => {
  res.headers.set('Cache-Control', 'no-store');
  res.headers.set('Referrer-Policy', 'no-referrer');
  return res;
};

interface LinkInfo {
  name: string;
  email: string | null;
  purpose: 'setup' | 'reset';
  expires_at: string;
}

async function lookup(token: string): Promise<LinkInfo | null> {
  return one<LinkInfo>(
    sql().query(
      `select p.name, p.email, t.purpose, t.expires_at
       from person_tokens t join people p on p.id = t.person_id
       where t.token_hash = $1 and t.used_at is null and t.expires_at > now() and p.active`,
      [hashToken(token)]
    )
  );
}

export const GET: APIRoute = async ({ url }) => {
  const token = url.searchParams.get('token') ?? '';
  const info = TOKEN.test(token) ? await lookup(token) : null;
  return noStore(info ? json(info) : json({ error: GONE }, 410));
};

export const POST: APIRoute = async (ctx) => {
  const { request, cookies } = ctx;
  const { token, password } = await readBody(request);
  if (typeof token !== 'string' || typeof password !== 'string' || !password) {
    return noStore(json({ error: 'Token and password are required' }, 400));
  }

  const keys = [ipKey(request, safeClientAddress(ctx))];
  if (await tooManyAttempts(keys)) {
    await failDelay();
    return noStore(json({ error: 'Too many attempts. Try again in a few minutes.' }, 429));
  }

  const info = TOKEN.test(token) ? await lookup(token) : null;
  if (!info) {
    await failDelay();
    return noStore(json({ error: GONE }, 410));
  }
  const problem = passwordProblem(password, info.email);
  if (problem) return noStore(json({ error: problem }, 400));

  const hash = await hashPassword(password);
  // One statement: the token is used and the password set together, and only
  // if the token is still unused, unexpired and the person active. Two
  // submissions of the same link can't both succeed (the second waits on the
  // row lock and then sees used_at set).
  const row = await one<{ id: string; session_version: number }>(
    sql().query(
      `with t as (
         update person_tokens set used_at = now()
         where token_hash = $1 and used_at is null and expires_at > now()
           and person_id in (select id from people where active)
         returning person_id
       )
       update people p
       set password_hash = $2, password_updated_at = now(), session_version = p.session_version + 1,
           last_login_at = now(), updated_at = now()
       from t where p.id = t.person_id
       returning p.id, p.session_version`,
      [hashToken(token), hash]
    )
  );
  if (!row) return noStore(json({ error: GONE }, 410));

  await clearAttempts(keys);
  try {
    startPersonSession(cookies, row);
  } catch (err) {
    console.error('setup: cannot start a person session', err);
    return noStore(json({ error: 'Your password is set, but sign-in is not configured on this site yet (SESSION_SECRET is missing).' }, 500));
  }
  return noStore(json({ next: '/dashboard' }));
};
