import type { APIRoute } from 'astro';
import { json, requireAuth } from '../../../lib/api';
import { sql } from '../../../lib/db';

export const DELETE: APIRoute = async ({ params, cookies }) => {
  const denied = requireAuth(cookies);
  if (denied) return denied;
  await sql()`delete from headlines where id = ${params.id!}`;
  return json({ ok: true });
};
