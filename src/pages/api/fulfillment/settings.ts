import type { APIRoute } from 'astro';
import type { NeonQueryInTransaction } from '@neondatabase/serverless';
import { requirePermission } from '../../../lib/api';
import { many, sql } from '../../../lib/db';
import { parseSettingsForm } from '../../../lib/fulfillment-settings';

// The fulfillment settings page's save: POST only, the same fulfillment.view
// gate (Manager and above) the fulfillment pages sit behind — the middleware
// also keeps non-GET /api same-origin (this repo's CSRF protection). The form
// is parsed and validated by parseSettingsForm; hidden flags move in one
// update, mapped stages upsert and blank (unmapped) stages delete their
// stage_type_map row, all in one transaction. The browser lands back on the
// page with ?saved=1 or ?error=… (303, so a refresh never re-posts).

export const POST: APIRoute = async ({ request, locals, redirect }) => {
  const denied = requirePermission(locals, 'fulfillment.view');
  if (denied) return denied;

  const db = sql();
  const rules = await many<{ stage_type: string }>(db.query('select stage_type from stall_rules'));
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return redirect(`/fulfillment/settings?error=${encodeURIComponent('Could not read the posted form')}`, 303);
  }
  const parsed = parseSettingsForm(form, rules.map((r) => r.stage_type));
  if (parsed.errors.length) {
    return redirect(`/fulfillment/settings?error=${encodeURIComponent(parsed.errors.join('; '))}`, 303);
  }

  const statements: { text: string; params: unknown[] }[] = [];

  // Every posted pipeline's hidden flag in one update (ids arrive as digit strings)
  const pipelineIds = Object.keys(parsed.hidden);
  if (pipelineIds.length) {
    const params: unknown[] = [];
    const values = pipelineIds.map((id) => {
      params.push(id, parsed.hidden[id]);
      return `($${params.length - 1}::bigint, $${params.length}::boolean)`;
    });
    statements.push({
      text: `update td_pipelines as p set hidden = v.hidden from (values ${values.join(', ')}) as v(id, hidden) where p.id = v.id`,
      params,
    });
  }

  // Stages with a stage type: upsert the map row (all four settings at once)
  const mapped = parsed.stages.filter((s) => s.stage_type != null);
  if (mapped.length) {
    const params: unknown[] = [];
    const values = mapped.map((s) => {
      params.push(s.pipeline_id, s.stage_id, s.stage_type, s.warn_days, s.stuck_days, s.ball_with);
      const n = params.length;
      return `($${n - 5}::bigint, $${n - 4}::bigint, $${n - 3}, $${n - 2}::int, $${n - 1}::int, $${n})`;
    });
    statements.push({
      text: `insert into stage_type_map (pipeline_id, stage_id, stage_type, warn_days, stuck_days, ball_with)
         values ${values.join(', ')}
         on conflict (pipeline_id, stage_id) do update set
           stage_type = excluded.stage_type,
           warn_days = excluded.warn_days,
           stuck_days = excluded.stuck_days,
           ball_with = excluded.ball_with`,
      params,
    });
  }

  // A stage posted blank (unmapped) loses its map row
  const unmapped = parsed.stages.filter((s) => s.stage_type == null);
  if (unmapped.length) {
    const params: unknown[] = [];
    const values = unmapped.map((s) => {
      params.push(s.pipeline_id, s.stage_id);
      return `($${params.length - 1}::bigint, $${params.length}::bigint)`;
    });
    statements.push({
      text: `delete from stage_type_map m using (values ${values.join(', ')}) as v(pid, sid) where m.pipeline_id = v.pid and m.stage_id = v.sid`,
      params,
    });
  }

  try {
    // The d.ts wants NeonQueryInTransaction[]; tx.query's promises carry the
    // query data at runtime and are all sent as one transaction
    await db.transaction((tx) =>
      statements.map(({ text, params }) => tx.query(text, params)) as unknown as NeonQueryInTransaction[]
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown error';
    return redirect(`/fulfillment/settings?error=${encodeURIComponent(`Settings were not saved: ${message}`)}`, 303);
  }
  return redirect('/fulfillment/settings?saved=1', 303);
};
