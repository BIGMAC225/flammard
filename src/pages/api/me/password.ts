import type { APIRoute } from 'astro';
import { json, principal, readBody } from '../../../lib/api';
import { startPersonSession } from '../../../lib/auth';
import { one, sql } from '../../../lib/db';
import { hashPassword, passwordProblem, verifyPassword } from '../../../lib/password';
import { clearAttempts, failDelay, tooManyAttempts } from '../../../lib/throttle';

// Change your own password, or just sign out every other device.
//   { current_password, new_password }
//   { current_password, sign_out_only: true }
// Either way session_version is bumped (every other browser is signed out)
// and this browser gets a fresh cookie for the new version.
// Wrong current passwords are throttled per person.

export const POST: APIRoute = async ({ request, cookies, locals }) => {
  const p = principal(locals);
  if (p.kind !== 'person') return json({ error: 'Sign in with your own account first' }, 403);

  const { current_password, new_password, sign_out_only } = await readBody(request);
  if (typeof current_password !== 'string' || !current_password) {
    return json({ error: 'Enter your current password' }, 400);
  }
  const signOutOnly = sign_out_only === true;
  if (!signOutOnly) {
    if (typeof new_password !== 'string') return json({ error: 'Enter a new password' }, 400);
    const problem = passwordProblem(new_password, p.email);
    if (problem) return json({ error: problem }, 400);
    if (new_password === current_password) return json({ error: 'The new password is the same as the current one.' }, 400);
  }

  const keys = [`login-attempts/account/${p.id}`];
  if (await tooManyAttempts(keys)) {
    await failDelay();
    return json({ error: 'Too many attempts. Try again in a few minutes.' }, 429);
  }

  const row = await one<{ password_hash: string | null }>(
    sql().query('select password_hash from people where id = $1 and active', [p.id])
  );
  const check = await verifyPassword(current_password.slice(0, 200), row?.password_hash ?? null);
  if (!check.ok) {
    await failDelay();
    return json({ error: 'Your current password is incorrect' }, 400);
  }

  const hash = signOutOnly ? null : await hashPassword(new_password as string);
  const updated = await one<{ id: string; session_version: number }>(
    signOutOnly
      ? sql().query(
          'update people set session_version = session_version + 1, updated_at = now() where id = $1 and active returning id, session_version',
          [p.id]
        )
      : sql().query(
          `update people set password_hash = $2, password_updated_at = now(),
             session_version = session_version + 1, updated_at = now()
           where id = $1 and active returning id, session_version`,
          [p.id, hash]
        )
  );
  if (!updated) return json({ error: 'Your account is no longer active' }, 403);

  await clearAttempts(keys);
  startPersonSession(cookies, updated);
  return json({ ok: true });
};
