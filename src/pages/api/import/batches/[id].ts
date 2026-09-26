import type { APIRoute } from 'astro';
import { json, requirePermission, requireUuid } from '../../../../lib/api';
import { one, sql } from '../../../../lib/db';
import type { ImportBatch } from '../../../../types';

// One import batch, plus how many of its rows were edited after the import
// (shown as a warning before an undo, which deletes them anyway).
export const GET: APIRoute = async ({ params, locals }) => {
  const denied = requirePermission(locals, 'import.manage') ?? requireUuid(params.id);
  if (denied) return denied;

  const batch = await one<ImportBatch>(sql()`
    select id, source, file_names, counts, status, created_by_name, created_at, undone_at
    from import_batches where id = ${params.id}
  `);
  if (!batch) return json({ error: 'Import not found' }, 404);

  const row = await one<{ n: number }>(sql()`
    select (
      (select count(*) from issues            x where x.import_batch_id = b.id and x.updated_at > b.created_at) +
      (select count(*) from todos             x where x.import_batch_id = b.id and x.updated_at > b.created_at) +
      (select count(*) from rocks             x where x.import_batch_id = b.id and x.updated_at > b.created_at) +
      (select count(*) from steps             x where x.import_batch_id = b.id and x.updated_at > b.created_at) +
      (select count(*) from scorecard_metrics x where x.import_batch_id = b.id and x.updated_at > b.created_at)
    )::int as n
    from import_batches b where b.id = ${params.id}
  `);
  return json({ batch, edited_since: row?.n ?? 0 });
};
