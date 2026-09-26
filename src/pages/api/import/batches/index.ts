import type { APIRoute } from 'astro';
import { json, requirePermission } from '../../../../lib/api';
import { many, sql } from '../../../../lib/db';
import type { ImportBatch } from '../../../../types';

// Import history: the latest 50 batches, newest first.
export const GET: APIRoute = async ({ locals }) => {
  const denied = requirePermission(locals, 'import.manage');
  if (denied) return denied;
  const batches = await many<ImportBatch>(sql()`
    select id, source, file_names, counts, status, created_by_name, created_at, undone_at
    from import_batches order by created_at desc limit 50
  `);
  return json({ batches });
};
