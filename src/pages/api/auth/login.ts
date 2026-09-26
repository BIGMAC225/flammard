import type { APIRoute } from 'astro';
import { json, readBody } from '../../../lib/api';
import { passwordMatches, sharedLoginEnabled, startPersonSession, startSharedSession } from '../../../lib/auth';
import { one, sql } from '../../../lib/db';
import { hashPassword, verifyPassword } from '../../../lib/password';
import {
  clearAttempts,
  emailKey,
  failDelay,
  ipKey,
  safeClientAddress,
  tooManyAttempts,
} from '../../../lib/throttle';

// Sign-in (spec §3.2, §3.9).
//   { email, password, next? }  person sign-in (email is case-insensitive)
//   { password, next? }         the shared team password, while SHARED_PASSWORD_LOGIN isn't 'off'
//
// Every attempt is reserved against the client IP (and, for a person sign-in,
// the email) before the password is checked; see src/lib/throttle.ts. A wrong
// password, an unknown email, an inactive person and a person with no password
// all get the same message after the same work (a scrypt check against a
// dummy hash) and the same delay.

const WRONG = 'Email or password is incorrect';

/** Only ever redirect within this site. */
function safeNext(next: unknown, origin: string): string {
  if (typeof next !== 'string' || !next) return '/dashboard';
  try {
    const target = new URL(next, origin);
    if (target.origin === origin && target.pathname.startsWith('/') && target.pathname !== '/login') {
      return target.pathname + target.search;
    }
  } catch {
    /* keep default */
  }
  return '/dashboard';
}

export const POST: APIRoute = async (ctx) => {
  const { request, cookies, url } = ctx;
  const { email, password, next } = await readBody(request);
  if (typeof password !== 'string' || !password) return json({ error: 'Password is required' }, 400);

  const personal = typeof email === 'string' && email.trim() !== '';
  if (!personal && !sharedLoginEnabled()) {
    return json({ error: 'The team password is turned off. Sign in with your email and password.' }, 403);
  }

  const keys = [ipKey(request, safeClientAddress(ctx))];
  if (personal) keys.push(emailKey(email));

  if (await tooManyAttempts(keys)) {
    await failDelay();
    return json({ error: 'Too many attempts. Try again in a few minutes.' }, 429);
  }

  const redirectTo = safeNext(next, url.origin);

  if (!personal) {
    if (!passwordMatches(password)) {
      await failDelay();
      return json({ error: 'Incorrect password' }, 401);
    }
    await clearAttempts(keys);
    startSharedSession(cookies);
    return json({ next: redirectTo });
  }

  const person = await one<{ id: string; password_hash: string | null; session_version: number }>(
    sql().query('select id, password_hash, session_version from people where email = $1 and active', [
      email.trim().toLowerCase(),
    ])
  );
  // Always runs scrypt (against a dummy hash when there's no real one); an
  // over-long password is checked against the dummy too so it can't match.
  const check = await verifyPassword(password.length > 200 ? '' : password, person?.password_hash ?? null);
  if (!person || !check.ok || password.length > 200) {
    await failDelay();
    return json({ error: WRONG }, 401);
  }

  // Upgrade a hash made with older scrypt parameters
  const newHash = check.needsRehash ? await hashPassword(password) : null;
  await sql().query('update people set last_login_at = now(), password_hash = coalesce($2, password_hash) where id = $1', [
    person.id,
    newHash,
  ]);
  await clearAttempts(keys);

  try {
    startPersonSession(cookies, { id: person.id, session_version: person.session_version });
  } catch (err) {
    console.error('login: cannot start a person session', err);
    return json({ error: 'Personal sign-in is not set up on this site yet (SESSION_SECRET is missing).' }, 500);
  }
  return json({ next: redirectTo });
};
