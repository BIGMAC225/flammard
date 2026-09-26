import type { AstroCookies } from 'astro';
import { isAuthenticated } from './auth';
import { one, sql } from './db';

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** 401 response when the session cookie is missing or invalid, else null. */
export function requireAuth(cookies: AstroCookies): Response | null {
  return isAuthenticated(cookies) ? null : json({ error: 'Unauthorized' }, 401);
}

/** Loads a meeting row (or the requested columns), or null if it doesn't exist. */
export async function getMeeting<T = Record<string, any>>(
  id: string | undefined,
  columns = '*'
): Promise<T | null> {
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) return null;
  return one<T>(sql().query(`select ${columns} from meetings where id = $1`, [id]));
}

/** Response for a request whose meeting id doesn't resolve. */
export const notFound = (what = 'Meeting') => json({ error: `${what} not found` }, 404);
