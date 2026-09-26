import type { APIRoute } from 'astro';
import { isUuid, json, readBody, requireAuth } from '../../../lib/api';
import { one, sql } from '../../../lib/db';
import { STEP_PARENTS, loadStepParent, stepsFor } from '../../../lib/steps';
import type { StepParentType } from '../../../types';

// Adds steps (with optional sub-steps) under an item and returns the full list.
//   POST { type, id, steps: [{ title, substeps?: string[] }], source?: 'manual'|'ai' }
//   POST { type, id, steps: [{ title }], under: <step id> }   — sub-steps of an existing step
export const POST: APIRoute = async ({ request, cookies }) => {
  const denied = requireAuth(cookies);
  if (denied) return denied;

  const { type, id, steps, source, under } = await readBody(request);
  if (under !== undefined && !isUuid(under)) return json({ error: 'Invalid step' }, 400);
  if (!STEP_PARENTS.includes(type) || !isUuid(id)) return json({ error: 'Invalid item' }, 400);
  if (!Array.isArray(steps) || !steps.length) return json({ error: 'No steps' }, 400);
  const src = source === 'ai' ? 'ai' : 'manual';

  const parent = await loadStepParent(type as StepParentType, id);
  if (!parent) return json({ error: 'Item not found' }, 404);

  const clean = steps
    .map((s: any): { title: string; substeps: string[] } => ({
      title: typeof s?.title === 'string' ? s.title.trim().slice(0, 500) : '',
      substeps: Array.isArray(s?.substeps)
        ? s.substeps.filter((x: unknown) => typeof x === 'string' && x.trim()).map((x: string) => x.trim().slice(0, 500))
        : [],
    }))
    .filter((s) => s.title)
    .slice(0, 50);
  if (!clean.length) return json({ error: 'No steps' }, 400);

  const db = sql();

  if (under) {
    const target = await one<{ id: string }>(
      db`select id from steps where id = ${under} and parent_type = ${type} and parent_id = ${id} and parent_step_id is null`
    );
    if (!target) return json({ error: 'Step not found' }, 404);
    const sub = await one<{ n: number }>(db`select coalesce(max(sort_order), -1) + 1 as n from steps where parent_step_id = ${under}`);
    let order = sub?.n ?? 0;
    await db.transaction(
      clean.map(
        (s) => db`
          insert into steps (parent_type, parent_id, parent_step_id, title, sort_order, source)
          values (${type}, ${id}, ${under}, ${s.title}, ${order++}, ${src})`
      )
    );
    return json({ steps: await stepsFor(type as StepParentType, id) });
  }

  const start = await one<{ n: number }>(
    db`select coalesce(max(sort_order), -1) + 1 as n from steps where parent_type = ${type} and parent_id = ${id} and parent_step_id is null`
  );
  let order = start?.n ?? 0;

  // Sub-steps need their parent's id, so this is two rounds rather than one
  // transaction; a failure part-way leaves a partial list the user can see.
  for (const s of clean) {
    const row = await one<{ id: string }>(db`
      insert into steps (parent_type, parent_id, title, sort_order, source)
      values (${type}, ${id}, ${s.title}, ${order++}, ${src}) returning id
    `);
    if (row && s.substeps.length) {
      await db.transaction(
        s.substeps.map(
          (sub: string, i: number) => db`
            insert into steps (parent_type, parent_id, parent_step_id, title, sort_order, source)
            values (${type}, ${id}, ${row.id}, ${sub}, ${i}, ${src})`
        )
      );
    }
  }

  return json({ steps: await stepsFor(type as StepParentType, id) });
};
