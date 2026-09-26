import type { APIRoute } from 'astro';
import { randomUUID } from 'node:crypto';
import type { NeonQueryPromise } from '@neondatabase/serverless';
import { json, readBody, requireAuth } from '../../../lib/api';
import { isIsoDate, todayLocal } from '../../../lib/dates';
import { many, one, sql } from '../../../lib/db';
import { currentTeam } from '../../../lib/teams';
import type { ProposedRoadmap } from '../../../types';

type ProposedRock = ProposedRoadmap['unplaced'][number];

// Saves a reviewed roadmap proposal in one transaction. Periods are matched
// by name (existing ones reused); rocks are matched by title within the team
// (an existing rock is moved onto the period instead of duplicated); steps
// go under new rocks. Ids are generated here so everything can be sent as
// a single batch — a big deck is one round trip, and a failure saves nothing.
export const POST: APIRoute = async ({ request, cookies }) => {
  const denied = requireAuth(cookies);
  if (denied) return denied;

  const body = (await readBody(request)) as Partial<ProposedRoadmap>;
  const periods = (Array.isArray(body.periods) ? body.periods : []).filter(
    (p) => typeof p?.name === 'string' && p.name.trim() && isIsoDate(p.start_date) && isIsoDate(p.end_date) && p.end_date >= p.start_date
  );
  const unplaced = (Array.isArray(body.unplaced) ? body.unplaced : []).filter((r) => typeof r?.title === 'string' && r.title.trim());
  if (!periods.length && !unplaced.length) return json({ error: 'Nothing to import' }, 400);

  const team = currentTeam(cookies);
  const db = sql();
  const today = todayLocal();

  // ── Resolve periods (few; create the missing ones) ──────────────────────
  const existingPeriods = await many<{ id: string; name: string; start_date: string; end_date: string }>(
    db`select id, name, start_date::text as start_date, end_date::text as end_date from periods where team = ${team}`
  );
  const periodByName = new Map(existingPeriods.map((p) => [p.name.toLowerCase(), p]));
  let periodsCreated = 0;
  for (const p of periods) {
    const name = p.name.trim().slice(0, 120);
    if (periodByName.has(name.toLowerCase())) continue;
    const created = await one<{ id: string; name: string; start_date: string; end_date: string }>(db`
      insert into periods (team, name, start_date, end_date) values (${team}, ${name}, ${p.start_date}, ${p.end_date})
      returning id, name, start_date::text as start_date, end_date::text as end_date
    `);
    if (created) {
      periodByName.set(name.toLowerCase(), created);
      periodsCreated++;
    }
  }

  // ── Rocks + steps as one batch ──────────────────────────────────────────
  const existingRocks = await many<{ id: string; title: string; status: string }>(db`select id, title, status from rocks where team = ${team}`);
  const rockByTitle = new Map(existingRocks.map((r) => [r.title.trim().toLowerCase(), r]));
  const queries: NeonQueryPromise<false, false, Record<string, any>[]>[] = [];
  let rocksCreated = 0;
  let rocksLinked = 0;

  const addRock = (r: ProposedRock, periodId: string | null, status: string) => {
    const title = r.title.trim().slice(0, 300);
    const found = rockByTitle.get(title.toLowerCase());
    if (found) {
      // Already on the books: place it on the period; only nudge a planned status
      queries.push(db`
        update rocks set period_id = coalesce(${periodId}, period_id),
          status = case when status = 'planned' then ${status} else status end,
          owner = coalesce(owner, ${r.owner?.trim() || null}), notes = coalesce(notes, ${r.notes?.trim() || null}),
          updated_at = now()
        where id = ${found.id}`);
      rocksLinked++;
      return;
    }
    const rockId = randomUUID();
    rockByTitle.set(title.toLowerCase(), { id: rockId, title, status });
    queries.push(db`
      insert into rocks (id, team, period_id, title, owner, notes, status)
      values (${rockId}, ${team}, ${periodId}, ${title}, ${r.owner?.trim() || null}, ${r.notes?.trim() || null}, ${status})`);
    rocksCreated++;

    const steps = (Array.isArray(r.steps) ? r.steps : []).filter((s) => typeof s?.title === 'string' && s.title.trim()).slice(0, 50);
    steps.forEach((s, i) => {
      const stepId = randomUUID();
      queries.push(db`
        insert into steps (id, parent_type, parent_id, title, sort_order, source)
        values (${stepId}, 'rock', ${rockId}, ${s.title.trim().slice(0, 500)}, ${i}, 'ai')`);
      const subs = (Array.isArray(s.substeps) ? s.substeps : []).filter((x) => typeof x === 'string' && x.trim()).slice(0, 30);
      subs.forEach((sub, j) => {
        queries.push(db`
          insert into steps (parent_type, parent_id, parent_step_id, title, sort_order, source)
          values ('rock', ${rockId}, ${stepId}, ${sub.trim().slice(0, 500)}, ${j}, 'ai')`);
      });
    });
  };

  for (const p of periods) {
    const period = periodByName.get(p.name.trim().slice(0, 120).toLowerCase());
    if (!period) continue;
    // Status from the period as stored (it may predate this import)
    const status = period.end_date < today ? 'complete' : period.start_date > today ? 'planned' : 'on_track';
    for (const r of (Array.isArray(p.rocks) ? p.rocks : []).filter((x) => typeof x?.title === 'string' && x.title.trim())) {
      addRock(r, period.id, status);
    }
  }
  for (const r of unplaced) addRock(r, null, 'planned');

  if (queries.length) {
    try {
      await db.transaction(queries);
    } catch (err) {
      return json({ error: `Nothing was saved: ${err instanceof Error ? err.message : 'unknown error'}` }, 500);
    }
  }

  return json({ ok: true, periods: periodsCreated, rocks: rocksCreated, linked: rocksLinked });
};
