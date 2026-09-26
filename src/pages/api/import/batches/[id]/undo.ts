import type { APIRoute } from 'astro';
import { json, principal, readBody, requirePermission, requireUuid } from '../../../../../lib/api';
import { one, sql } from '../../../../../lib/db';

// Undoes an import batch in one transaction (spec §6.8): deletes its rows,
// the steps under its rocks, issues and to-dos, its scorecard values, the
// metrics and periods it created that nothing else uses, and the people it
// created who have since gained no email, password or other items. Aliases
// and "kept as text" names it added stay (they are harmless).

export const POST: APIRoute = async ({ params, request, locals }) => {
  const denied = requirePermission(locals, 'import.manage') ?? requireUuid(params.id);
  if (denied) return denied;
  const body = await readBody(request);
  if (body.confirm !== true) return json({ error: 'Send { confirm: true } to undo an import' }, 400);

  const id = params.id!;
  const db = sql();
  const batch = await one<{ status: string }>(db`select status from import_batches where id = ${id}`);
  if (!batch) return json({ error: 'Import not found' }, 404);
  if (batch.status !== 'committed') return json({ error: 'This import was already undone' }, 409);

  // Read-only pass with the same predicates as the deletes, for the result
  const counts = await one<Record<string, number>>(db`
    with b as (select ${id}::uuid as id),
    del_rocks  as (select x.id from rocks  x, b where x.import_batch_id = b.id),
    del_issues as (select x.id from issues x, b where x.import_batch_id = b.id),
    del_todos  as (select x.id from todos  x, b where x.import_batch_id = b.id),
    del_steps  as (
      select s.id from steps s, b where s.import_batch_id = b.id
      union select s.id from steps s where s.parent_type = 'rock'  and s.parent_id in (select id from del_rocks)
      union select s.id from steps s where s.parent_type = 'issue' and s.parent_id in (select id from del_issues)
      union select s.id from steps s where s.parent_type = 'todo'  and s.parent_id in (select id from del_todos)
    ),
    del_people as (
      select p.id from people p, b
      where p.import_batch_id = b.id and p.password_hash is null and p.email is null
        and not exists (select 1 from rocks x where x.owner_id = p.id and x.id not in (select id from del_rocks))
        and not exists (select 1 from todos x where x.owner_id = p.id and x.id not in (select id from del_todos))
        and not exists (select 1 from issues x where x.owner_id = p.id and x.id not in (select id from del_issues))
        and not exists (select 1 from meeting_rocks x where x.owner_id = p.id)
        and not exists (select 1 from scorecard_metrics x where x.owner_id = p.id and x.import_batch_id is distinct from b.id)
        and not exists (select 1 from headlines x where x.presenter_id = p.id and x.import_batch_id is distinct from b.id)
        and not exists (select 1 from steps x where x.owner_id = p.id and x.id not in (select id from del_steps))
    )
    select
      (select count(*) from del_issues)::int as issues,
      (select count(*) from del_todos)::int as todos,
      (select count(*) from del_rocks)::int as rocks,
      (select count(*) from del_steps)::int as steps,
      (select count(*) from headlines x, b where x.import_batch_id = b.id)::int as headlines,
      (select count(*) from scorecard_entries x, b where x.import_batch_id = b.id)::int as entries,
      (select count(*) from scorecard_metrics m, b where m.import_batch_id = b.id
         and not exists (select 1 from scorecard_entries e where e.metric_id = m.id and e.import_batch_id is distinct from b.id))::int as metrics,
      (select count(*) from periods p, b where p.import_batch_id = b.id
         and not exists (select 1 from rocks r where r.period_id = p.id and r.id not in (select id from del_rocks)))::int as periods,
      (select count(*) from del_people)::int as people,
      ((select count(*) from people p, b where p.import_batch_id = b.id) - (select count(*) from del_people))::int as people_kept
  `);

  const by = principal(locals);
  const results = await db.transaction([
    db`delete from steps where import_batch_id = ${id}`,
    db`delete from steps where parent_type = 'rock'  and parent_id in (select id from rocks  where import_batch_id = ${id})`,
    db`delete from steps where parent_type = 'issue' and parent_id in (select id from issues where import_batch_id = ${id})`,
    db`delete from steps where parent_type = 'todo'  and parent_id in (select id from todos  where import_batch_id = ${id})`,
    db`update meeting_rocks set rock_id = null where rock_id in (select id from rocks where import_batch_id = ${id})`,
    db`delete from scorecard_entries where import_batch_id = ${id}`,
    db`delete from scorecard_metrics where import_batch_id = ${id}
        and not exists (select 1 from scorecard_entries e where e.metric_id = scorecard_metrics.id)`,
    db`delete from headlines where import_batch_id = ${id}`,
    db`delete from issues    where import_batch_id = ${id}`,
    db`delete from todos     where import_batch_id = ${id}`,
    db`delete from rocks     where import_batch_id = ${id}`,
    db`delete from periods p where p.import_batch_id = ${id} and not exists (select 1 from rocks r where r.period_id = p.id)`,
    db`delete from people p where p.import_batch_id = ${id} and p.password_hash is null and p.email is null
        and not exists (select 1 from rocks where owner_id = p.id)
        and not exists (select 1 from todos where owner_id = p.id)
        and not exists (select 1 from issues where owner_id = p.id)
        and not exists (select 1 from meeting_rocks where owner_id = p.id)
        and not exists (select 1 from scorecard_metrics where owner_id = p.id)
        and not exists (select 1 from headlines where presenter_id = p.id)
        and not exists (select 1 from steps where owner_id = p.id)`,
    db`update import_batches set status = 'undone', undone_at = now(), undone_by = ${by.kind === 'person' ? by.id : null},
          undone_counts = ${JSON.stringify(counts ?? {})}::jsonb
        where id = ${id} and status = 'committed'
        returning id`,
  ]);

  // Two undos at once: the loser's deletes found nothing; report it as done already
  if (!(results[results.length - 1] as unknown[]).length) return json({ error: 'This import was already undone' }, 409);
  return json({ counts: counts ?? {} });
};
