import { neon, type NeonQueryFunction } from '@neondatabase/serverless';
import { env } from './env';

// Netlify DB injects NETLIFY_DATABASE_URL; DATABASE_URL is the fallback for
// local development against any Postgres.
const url = () => env('NETLIFY_DATABASE_URL') || env('DATABASE_URL');

let _sql: NeonQueryFunction<false, false> | null = null;

/** Rows as plain objects — what every query here returns. */
export type Rows = Promise<Record<string, any>[]>;

/**
 * Tagged-template SQL over Neon's HTTP driver (one request per query, no
 * connection pool to manage — right for serverless).
 *
 *   const rows = await sql()`select * from meetings where id = ${id}`;
 *   await sql().query('update todos set status = $1 where id = $2', [status, id]);
 *   await sql().transaction([q1, q2]);   // all-or-nothing, statements sent together
 */
export function sql(): NeonQueryFunction<false, false> {
  const u = url();
  if (!u) throw new Error('NETLIFY_DATABASE_URL is not configured');
  return (_sql ??= neon<false, false>(u));
}

/** First row of a query result, typed by the caller. */
export async function one<T>(query: Rows): Promise<T | null> {
  const rows = await query;
  return (rows[0] as T) ?? null;
}

/** All rows of a query result, typed by the caller. */
export async function many<T>(query: Rows): Promise<T[]> {
  return (await query) as T[];
}

/**
 * Builds a parameterised `update … set` for a whitelist of columns present in
 * `body`. Returns null when nothing updatable was sent.
 */
export function buildUpdate(
  table: string,
  id: string,
  body: Record<string, unknown>,
  allowed: string[],
  extra: Record<string, unknown> = {}
): { text: string; params: unknown[] } | null {
  const sets: string[] = [];
  const params: unknown[] = [];
  const push = (col: string, val: unknown) => {
    params.push(val);
    sets.push(`${col} = $${params.length}`);
  };
  for (const col of allowed) if (col in body) push(col, body[col]);
  if (!sets.length) return null;
  for (const [col, val] of Object.entries(extra)) push(col, val);
  params.push(id);
  return { text: `update ${table} set ${sets.join(', ')} where id = $${params.length} returning *`, params };
}
