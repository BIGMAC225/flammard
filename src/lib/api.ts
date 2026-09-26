import type { AstroCookies } from 'astro';
import { isAuthenticated } from './auth';
import { one, sql } from './db';
import { can, type Permission } from './permissions';
import type { Principal } from '../types';

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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);

/** 400 response when a route param isn't a UUID (Postgres would 500 on it). */
export function requireUuid(id: string | undefined): Response | null {
  return isUuid(id) ? null : json({ error: 'Invalid id' }, 400);
}

/** Parses a JSON body, treating anything that isn't an object as empty. */
export async function readBody(request: Request): Promise<Record<string, any>> {
  try {
    const body = await request.json();
    return body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  } catch {
    return {};
  }
}

/** 400 response when `body[field]` is set to something outside `allowed`. */
export function requireEnum(body: Record<string, unknown>, field: string, allowed: readonly string[]): Response | null {
  if (!(field in body) || body[field] === undefined) return null;
  return allowed.includes(body[field] as string) ? null : json({ error: `Invalid ${field}` }, 400);
}

/** Loads a meeting row (or the requested columns), or null if it doesn't exist. */
export async function getMeeting<T = Record<string, any>>(
  id: string | undefined,
  columns = '*'
): Promise<T | null> {
  if (!isUuid(id)) return null;
  return one<T>(sql().query(`select ${columns} from meetings where id = $1`, [id]));
}

/** Response for a request whose meeting id doesn't resolve. */
export const notFound = (what = 'Meeting') => json({ error: `${what} not found` }, 404);

// ── Principal and permissions (P0) ──────────────────────────────────────────

/** The signed-in principal the middleware put on locals. Throws if it's missing. */
export function principal(locals: App.Locals): Principal {
  if (!locals.principal) throw new Error('No principal: the route is not behind the auth middleware');
  return locals.principal;
}

/** 403 response when the principal lacks `perm` (401 if there's none), else null. */
export function requirePermission(locals: App.Locals, perm: Permission): Response | null {
  if (!locals.principal) return json({ error: 'Unauthorized' }, 401);
  return can(locals.principal, perm) ? null : json({ error: "You don't have permission to do that" }, 403);
}
