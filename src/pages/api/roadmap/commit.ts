import type { APIRoute } from 'astro';
import { json, readBody, requireAuth } from '../../../lib/api';
import { one, sql } from '../../../lib/db';
import { currentTeam } from '../../../lib/teams';
import type { ProposedRoadmap } from '../../../types';

const ISO = /^\d{4}-\d{2}-\d{2}$/;

// Saves a reviewed roadmap proposal: periods are matched by name (existing
// ones reused), rocks created under them, steps under the rocks.
export const POST: APIRoute = async ({ request, cookies }) => {
  const denied = requireAuth(cookies);
  if (denied) return denied;

  const body = (await readBody(request)) as Partial<ProposedRoadmap>;
  const periods = Array.isArray(body.periods) ? body.periods : [];
  const unplaced = Array.isArray(body.unplaced) ? body.unplaced : [];
  if (!periods.length && !unplaced.length) return json({ error: 'Nothing to import' }, 400);

  const team = currentTeam(cookies);
  const db = sql();
  const today = new Date().toISOString().slice(0, 10);
  let rocksCreated = 0;
  let periodsCreated = 0;

  const createRock = async (r: ProposedRoadmap['unplaced'][number], periodId: string | null, status: string) => {
    if (typeof r?.title !== 'string' || !r.title.trim()) return;
    const rock = await one<{ id: string }>(db`
      insert into rocks (team, period_id, title, owner, notes, status)
      values (${team}, ${periodId}, ${r.title.trim().slice(0, 300)}, ${r.owner?.trim() || null}, ${r.notes?.trim() || null}, ${status})
      returning id
    `);
    rocksCreated++;
    const steps = Array.isArray(r.steps) ? r.steps.filter((s) => typeof s?.title === 'string' && s.title.trim()).slice(0, 50) : [];
    for (const [i, s] of steps.entries()) {
      const step = await one<{ id: string }>(db`
        insert into steps (parent_type, parent_id, title, sort_order, source)
        values ('rock', ${rock!.id}, ${s.title.trim().slice(0, 500)}, ${i}, 'ai') returning id
      `);
      const subs = Array.isArray(s.substeps) ? s.substeps.filter((x) => typeof x === 'string' && x.trim()).slice(0, 30) : [];
      if (step && subs.length) {
        await db.transaction(
          subs.map(
            (sub, j) => db`
              insert into steps (parent_type, parent_id, parent_step_id, title, sort_order, source)
              values ('rock', ${rock!.id}, ${step.id}, ${sub.trim().slice(0, 500)}, ${j}, 'ai')`
          )
        );
      }
    }
  };

  try {
    for (const p of periods) {
      if (typeof p?.name !== 'string' || !p.name.trim() || !ISO.test(p.start_date) || !ISO.test(p.end_date) || p.end_date < p.start_date) continue;
      const name = p.name.trim().slice(0, 120);
      let period = await one<{ id: string }>(db`select id from periods where team = ${team} and name = ${name}`);
      if (!period) {
        period = await one<{ id: string }>(db`
          insert into periods (team, name, start_date, end_date) values (${team}, ${name}, ${p.start_date}, ${p.end_date}) returning id
        `);
        periodsCreated++;
      }
      const status = p.end_date < today ? 'complete' : p.start_date > today ? 'planned' : 'on_track';
      for (const r of Array.isArray(p.rocks) ? p.rocks : []) await createRock(r, period!.id, status);
    }
    for (const r of unplaced) await createRock(r, null, 'planned');
  } catch (err) {
    return json(
      { error: `Import stopped part-way (${rocksCreated} rocks saved): ${err instanceof Error ? err.message : 'unknown error'}` },
      500
    );
  }

  return json({ ok: true, periods: periodsCreated, rocks: rocksCreated });
};
