import type { APIRoute } from 'astro';
import { json } from '../../../lib/api';
import { sql } from '../../../lib/db';
import { backfillOwnerQueries, OWNER_COLUMNS } from '../../../lib/people';

// POST /api/people/backfill-owners → { updated: { rocks, todos, … }, total }
// "Match owner names automatically": the same updates as
// db/upgrades/p0-backfill-owners.sql, in one transaction.
export const POST: APIRoute = async () => {
  const results = await sql().transaction(backfillOwnerQueries());
  const updated: Record<string, number> = {};
  let total = 0;
  OWNER_COLUMNS.forEach((c, i) => {
    const n = (results[i] as unknown[]).length;
    updated[c.table] = n;
    total += n;
  });
  return json({ updated, total });
};
