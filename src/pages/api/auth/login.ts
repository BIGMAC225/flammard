import type { APIRoute } from 'astro';
import { json } from '../../../lib/api';
import { passwordMatches, startSession } from '../../../lib/auth';

// Single shared team password; see src/lib/auth.ts.
export const POST: APIRoute = async ({ request, cookies }) => {
  const { password, next } = (await request.json()) as { password?: string; next?: string };
  if (!password) return json({ error: 'Password is required' }, 400);

  if (!passwordMatches(password)) return json({ error: 'Incorrect password' }, 401);

  startSession(cookies);
  const redirectTo = next && next.startsWith('/') && !next.startsWith('//') ? next : '/dashboard';
  return json({ next: redirectTo });
};
