import type { APIRoute } from 'astro';
import { randomUUID } from 'node:crypto';
import type { NeonQueryPromise } from '@neondatabase/serverless';
import { isUuid, json, principal, requirePermission } from '../../../../lib/api';
import { isIsoDate } from '../../../../lib/dates';
import { many, sql } from '../../../../lib/db';
import {
  MAX_ROWS,
  TABLE_FOR_KIND,
  composeDescription,
  frequencyFrom,
  isClosedRow,
  issueOrder,
  periodKey,
  rockStatusFrom,
  rockTitleKey,
  sanitizeRow,
  type NinetyKind,
  type NinetyRow,
} from '../../../../lib/ninety';
import { nameKey } from '../../../../lib/people';
import { getSettings } from '../../../../lib/settings';
import type { TeamId } from '../../../../types';

// Commits a reviewed Ninety import (spec §6.6). Everything is validated
// again, rows already imported (same Ninety id) are skipped, and every write
// runs in ONE transaction together with its import_batches row, so a failure
// writes nothing and a success can be undone as a batch. Ids are generated
// here so rocks and their milestones, metrics and their values, and new
// people and periods can reference each other inside the batch.

type OwnerChoice =
  | { person_id: string; add_alias?: boolean }
  | { create: { name: string; teams: TeamId[] } }
  | { text_only: true };
type PeriodChoice =
  | { period_id: string }
  | { create: { name: string; start_date: string; end_date: string } }
  | { none: true };

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const TEAMS: TeamId[] = ['leadership', 'management'];
const CONFLICT = 'on conflict (external_source, external_id) where external_id is not null do nothing';

type Query = NeonQueryPromise<false, false, Record<string, any>[]>;

export const POST: APIRoute = async ({ request, locals }) => {
  const denied = requirePermission(locals, 'import.manage');
  if (denied) return denied;
  const actor = principal(locals);
  const bad = (error: string, status = 400) => json({ error }, status);

  // ── 1. Parse and validate ───────────────────────────────────────────────
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return bad('Too much data: an import is limited to 4 MB', 413);
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw);
  } catch {
    return bad('Invalid JSON');
  }
  if (!body || typeof body !== 'object') return bad('Invalid request');

  const files = (Array.isArray(body.files) ? body.files : [])
    .filter((f): f is string => typeof f === 'string' && !!f.trim())
    .map((f) => f.trim().slice(0, 300))
    .slice(0, 50);

  const inputRows = Array.isArray(body.rows) ? body.rows : null;
  if (!inputRows || !inputRows.length) return bad('Nothing to import');
  if (inputRows.length > MAX_ROWS) return bad(`Too many rows: at most ${MAX_ROWS} per import`);

  const rows: NinetyRow[] = [];
  let skippedDuplicates = 0;
  const seen = new Set<string>();
  for (let i = 0; i < inputRows.length; i++) {
    const r = sanitizeRow(inputRows[i]);
    if (typeof r === 'string') return bad(`Row ${i + 1}: ${r}`);
    if (isClosedRow(r)) return bad(`Only open items can be imported: "${r.title}" is completed or archived`);
    if (r.externalId) {
      const k = `${r.kind}:${r.externalId}`;
      if (seen.has(k)) {
        skippedDuplicates++;
        continue;
      }
      seen.add(k);
    }
    rows.push(r);
  }

  const ownersIn = (body.owners && typeof body.owners === 'object' ? body.owners : {}) as Record<string, unknown>;
  const owners = new Map<string, OwnerChoice>();
  for (const name of new Set(rows.map((r) => r.ownerName).filter((n): n is string => !!n))) {
    const c = ownersIn[name] as Record<string, any> | undefined;
    if (!c || typeof c !== 'object') return bad(`Choose what to do with the Ninety owner "${name}"`);
    if ('person_id' in c) {
      if (!isUuid(c.person_id)) return bad(`Invalid person for "${name}"`);
      owners.set(name, { person_id: c.person_id, add_alias: c.add_alias === true });
    } else if ('create' in c) {
      const n = typeof c.create?.name === 'string' ? c.create.name.trim() : '';
      const teams: unknown[] = Array.isArray(c.create?.teams) ? c.create.teams : [];
      if (!n || n.length > 120) return bad(`A name is required to create a person for "${name}"`);
      if (!teams.every((t) => TEAMS.includes(t as TeamId))) return bad(`Invalid teams for "${name}"`);
      owners.set(name, { create: { name: n, teams: [...new Set(teams as TeamId[])] } });
    } else if (c.text_only === true) {
      owners.set(name, { text_only: true });
    } else {
      return bad(`Choose what to do with the Ninety owner "${name}"`);
    }
  }

  const periodsIn = (body.periods && typeof body.periods === 'object' ? body.periods : {}) as Record<string, unknown>;
  const periodChoices = new Map<string, PeriodChoice>();
  for (const r of rows) {
    if (r.kind !== 'rock' || !r.quarter) continue;
    const key = periodKey(r.team!, r.quarter);
    if (periodChoices.has(key)) continue;
    const c = periodsIn[key] as Record<string, any> | undefined;
    if (!c || typeof c !== 'object') return bad(`Choose a period for ${r.quarter}`);
    if ('period_id' in c) {
      if (!isUuid(c.period_id)) return bad(`Invalid period for ${r.quarter}`);
      periodChoices.set(key, { period_id: c.period_id });
    } else if ('create' in c) {
      const name = typeof c.create?.name === 'string' ? c.create.name.trim().slice(0, 120) : '';
      const { start_date, end_date } = c.create ?? {};
      if (!name) return bad(`A period name is required for ${r.quarter}`);
      if (!isIsoDate(start_date) || !isIsoDate(end_date) || end_date < start_date) {
        return bad(`Valid start and end dates are required for the period "${name}"`);
      }
      periodChoices.set(key, { create: { name, start_date, end_date } });
    } else if (c.none === true) {
      periodChoices.set(key, { none: true });
    } else {
      return bad(`Choose a period for ${r.quarter}`);
    }
  }

  // ── 2. Read state ───────────────────────────────────────────────────────
  const db = sql();
  const personIds = [...new Set([...owners.values()].flatMap((c) => ('person_id' in c ? [c.person_id] : [])))];
  const idsByKind = new Map<NinetyKind, string[]>();
  for (const r of rows) if (r.externalId) idsByKind.set(r.kind, [...(idsByKind.get(r.kind) ?? []), r.externalId]);

  const [settings, people, periods, existingLists, ranks, rocks, stepOrders, metrics] = await Promise.all([
    getSettings(),
    many<{ id: string; name: string; aliases: string[] }>(
      db.query('select id, name, aliases from people where id = any($1::uuid[]) and active', [personIds])
    ),
    many<{ id: string; team: TeamId; name: string; start_date: string; end_date: string }>(
      db`select id, team, name, start_date::text as start_date, end_date::text as end_date from periods`
    ),
    Promise.all(
      [...idsByKind.entries()].map(([kind, ids]) =>
        many<{ id: string; external_id: string; kind: NinetyKind }>(
          db.query(
            `select id, external_id, $1::text as kind from ${TABLE_FOR_KIND[kind]}
             where external_source = 'ninety' and external_id = any($2::text[])`,
            [kind, ids]
          )
        )
      )
    ),
    many<{ team: TeamId; horizon: 'short' | 'long'; max: number }>(
      db`select team, horizon, coalesce(max(rank), 0)::int as max from issues group by team, horizon`
    ),
    many<{ id: string; team: TeamId; title: string }>(db`select id, team, title from rocks order by created_at`),
    many<{ parent_id: string; max: number }>(
      db`select parent_id, max(sort_order)::int as max from steps where parent_type = 'rock' and parent_step_id is null group by parent_id`
    ),
    many<{ id: string; team: TeamId; title: string; sort_order: number }>(
      db`select id, team, title, sort_order from scorecard_metrics`
    ),
  ]);

  const personById = new Map(people.map((p) => [p.id, p]));
  for (const id of personIds) if (!personById.has(id)) return bad('A chosen person no longer exists or is inactive; reload and try again', 409);
  const periodById = new Map(periods.map((p) => [p.id, p]));
  for (const [key, c] of periodChoices) {
    if (!('period_id' in c)) continue;
    const p = periodById.get(c.period_id);
    if (!p) return bad('A chosen period no longer exists; reload and try again', 409);
    if (p.team !== key.split('|')[0]) return bad(`The period "${p.name}" belongs to the other team`);
  }

  const existing = new Map<string, string>(); // `${kind}:${external_id}` → row id
  for (const e of existingLists.flat()) existing.set(`${e.kind}:${e.external_id}`, e.id);

  const tz = settings.timezone;
  const today = new Date().toLocaleDateString('en-CA', { timeZone: tz });
  const batchId = randomUUID();
  const createdBy = actor.kind === 'person' ? actor.id : null;
  const queries: Query[] = [];
  const warnings: string[] = [];

  // ── 3. Owners: people to create, aliases, names kept as text ────────────
  const ownerCols = new Map<string, { owner_id: string | null; owner: string }>();
  const newPeople = new Map<string, { id: string; name: string; teams: Set<TeamId> }>(); // by name key
  const aliasAdds: Array<{ id: string; alias: string }> = [];
  const textOnly: string[] = [];
  const knownTextOnly = new Set(settings.text_only_owner_names.map(nameKey));
  const activeNameKeys = new Set((await many<{ name: string }>(db`select name from people where active`)).map((p) => nameKey(p.name)));
  for (const [ninetyName, c] of owners) {
    if ('person_id' in c) {
      const p = personById.get(c.person_id)!;
      ownerCols.set(ninetyName, { owner_id: p.id, owner: p.name });
      const aliasKnown = nameKey(p.name) === nameKey(ninetyName) || (p.aliases ?? []).some((a) => nameKey(a) === nameKey(ninetyName));
      if (c.add_alias && !aliasKnown && !aliasAdds.some((a) => a.id === p.id && nameKey(a.alias) === nameKey(ninetyName))) {
        aliasAdds.push({ id: p.id, alias: ninetyName });
      }
    } else if ('create' in c) {
      const k = nameKey(c.create.name);
      // Same guard as POST /api/people: a duplicate active name breaks owner matching
      if (activeNameKeys.has(k)) {
        return json({ error: `"${c.create.name}" is already in People. Map ${ninetyName} to that person instead of creating a new one.` }, 409);
      }
      const teamsOfName = rows.filter((r) => r.ownerName === ninetyName).map((r) => r.team!);
      let np = newPeople.get(k);
      if (!np) {
        np = { id: randomUUID(), name: c.create.name, teams: new Set() };
        newPeople.set(k, np);
      }
      for (const t of c.create.teams.length ? c.create.teams : teamsOfName) np.teams.add(t);
      ownerCols.set(ninetyName, { owner_id: np.id, owner: np.name });
    } else {
      ownerCols.set(ninetyName, { owner_id: null, owner: ninetyName });
      if (!knownTextOnly.has(nameKey(ninetyName))) {
        textOnly.push(ninetyName);
        knownTextOnly.add(nameKey(ninetyName));
      }
    }
  }
  const ownerOf = (r: NinetyRow) =>
    r.ownerName ? ownerCols.get(r.ownerName)! : { owner_id: null as string | null, owner: null as string | null };

  // ── 4. Periods ──────────────────────────────────────────────────────────
  const periodNames = new Set(periods.map((p) => `${p.team}|${p.name.toLowerCase()}`));
  const periodFor = new Map<string, { id: string | null; start_date: string | null }>();
  const newPeriods: Array<{ id: string; team: TeamId; name: string; start_date: string; end_date: string }> = [];
  for (const [key, c] of periodChoices) {
    const team = key.split('|')[0] as TeamId;
    if ('period_id' in c) {
      const p = periodById.get(c.period_id)!;
      periodFor.set(key, { id: p.id, start_date: p.start_date });
    } else if ('create' in c) {
      const same = newPeriods.find((p) => p.team === team && p.name.toLowerCase() === c.create.name.toLowerCase());
      if (same) {
        periodFor.set(key, { id: same.id, start_date: same.start_date });
        continue;
      }
      if (periodNames.has(`${team}|${c.create.name.toLowerCase()}`)) {
        return bad(`A period named "${c.create.name}" already exists; choose it instead`, 409);
      }
      const p = { id: randomUUID(), team, ...c.create };
      newPeriods.push(p);
      periodFor.set(key, { id: p.id, start_date: p.start_date });
    } else {
      periodFor.set(key, { id: null, start_date: null });
    }
  }

  // ── 5. Items ────────────────────────────────────────────────────────────
  const fresh = rows.filter((r) => {
    if (r.externalId && existing.has(`${r.kind}:${r.externalId}`) && r.kind !== 'measurable') {
      skippedDuplicates++;
      return false;
    }
    return true;
  });
  const ofKind = (k: NinetyKind) => fresh.filter((r) => r.kind === k);
  const common = (r: NinetyRow) => ({ external_id: r.externalId, created_at: r.createdAt, ...ownerOf(r) });

  // Rocks
  const rockRecords = ofKind('rock').map((r) => {
    const period = r.quarter ? periodFor.get(periodKey(r.team!, r.quarter))! : { id: null, start_date: null };
    let { status } = rockStatusFrom(r.statusRaw) as { status: string };
    if (status === 'on_track' && period.start_date && period.start_date > today) status = 'planned';
    return {
      id: randomUUID(),
      team: r.team,
      period_id: period.id,
      title: r.title,
      status,
      quarter: r.quarter ?? null,
      due_date: r.dueDate,
      notes: composeDescription(r),
      level: r.level ?? null,
      ...common(r),
    };
  });

  // Milestones: under a rock of this import (same team and title), else an existing rock
  const importedRock = new Map<string, string>();
  for (const rec of rockRecords) importedRock.set(rockTitleKey(rec.team, rec.title), rec.id);
  const existingRock = new Map<string, string>();
  for (const r of rocks) if (!existingRock.has(rockTitleKey(r.team, r.title))) existingRock.set(rockTitleKey(r.team, r.title), r.id);
  const nextOrder = new Map<string, number>(stepOrders.map((s) => [s.parent_id, s.max + 1]));
  let skippedMilestones = 0;
  const milestones = ofKind('milestone')
    .map((r) => {
      const k = r.rockName ? rockTitleKey(r.team, r.rockName) : null;
      const parent = k ? (importedRock.get(k) ?? existingRock.get(k)) : undefined;
      if (!parent) {
        skippedMilestones++;
        warnings.push(`Milestone "${r.title}" skipped: no rock named "${r.rockName ?? ''}" in that team`);
      }
      return { r, parent };
    })
    .filter((m): m is { r: NinetyRow; parent: string } => !!m.parent)
    .sort((a, b) => (a.r.dueDate ?? '9999').localeCompare(b.r.dueDate ?? '9999') || a.r.rowNumber - b.r.rowNumber);
  const stepRecords = milestones.map(({ r, parent }) => {
    const order = nextOrder.get(parent) ?? 0;
    nextOrder.set(parent, order + 1);
    return {
      id: randomUUID(),
      parent_id: parent,
      title: r.title,
      done: !!r.completedOn || r.closed,
      sort_order: order,
      due_date: r.dueDate,
      ...common(r),
    };
  });

  // Issues: Ninety priority order, appended after the current bottom of each list
  const maxRank = new Map(ranks.map((x) => [`${x.team}|${x.horizon}`, Number(x.max) || 0]));
  const issueGroups = new Map<string, NinetyRow[]>();
  for (const r of ofKind('issue')) {
    const k = `${r.team}|${r.horizon}`;
    issueGroups.set(k, [...(issueGroups.get(k) ?? []), r]);
  }
  const issueRecords = [...issueGroups.entries()].flatMap(([k, list]) =>
    [...list].sort(issueOrder).map((r, i) => ({
      id: randomUUID(),
      team: r.team,
      horizon: r.horizon,
      rank: (maxRank.get(k) ?? 0) + i + 1,
      title: r.title,
      description: composeDescription(r),
      ...common(r),
    }))
  );

  const todoRecords = ofKind('todo').map((r) => ({
    id: randomUUID(),
    team: r.team,
    title: r.title,
    description: composeDescription(r),
    due_date: r.dueDate,
    ...common(r),
  }));

  const headlineRecords = ofKind('headline').map((r) => {
    const o = ownerOf(r);
    return {
      id: randomUUID(),
      team: r.team,
      type: r.headlineType ?? 'general',
      text: r.title,
      description: composeDescription(r),
      presenter: o.owner,
      presenter_id: o.owner_id,
      external_id: r.externalId,
      created_at: r.createdAt,
    };
  });

  // Measurables: reuse a metric with the same Ninety id or the same title in the team
  const metricByTitle = new Map(metrics.map((m) => [`${m.team}|${m.title.trim().toLowerCase()}`, m.id]));
  const maxSort = new Map<TeamId, number>();
  for (const m of metrics) maxSort.set(m.team, Math.max(maxSort.get(m.team) ?? 0, m.sort_order ?? 0));
  const metricRecords: Array<Record<string, unknown>> = [];
  const entryRecords: Array<{ metric_id: string; period_date: string; value: string }> = [];
  let metricsReused = 0;
  for (const r of ofKind('measurable')) {
    const titleKey = `${r.team}|${r.title.trim().toLowerCase()}`;
    let id = (r.externalId && existing.get(`measurable:${r.externalId}`)) || metricByTitle.get(titleKey);
    if (id) metricsReused++;
    else {
      id = randomUUID();
      const sort = (maxSort.get(r.team!) ?? 0) + 1;
      maxSort.set(r.team!, sort);
      metricByTitle.set(titleKey, id);
      metricRecords.push({
        id,
        team: r.team,
        title: r.title,
        goal: r.goal ?? null,
        unit: r.unit ?? null,
        frequency: frequencyFrom((r.values ?? []).map((v) => v.date)),
        sort_order: sort,
        description: composeDescription(r),
        ...common(r),
      });
    }
    for (const v of r.values ?? []) entryRecords.push({ metric_id: id, period_date: v.date, value: v.value });
  }

  // ── 6. One transaction ──────────────────────────────────────────────────
  const ownerSummary = Object.fromEntries(
    [...owners.entries()].map(([n, c]) => [n, 'person_id' in c ? 'person' : 'create' in c ? 'create' : 'text_only'])
  );
  queries.push(
    db.query(
      `insert into import_batches (id, source, file_names, options, counts, created_by, created_by_name)
       values ($1, 'ninety', $2::jsonb, $3::jsonb, '{}'::jsonb, $4, $5)`,
      [batchId, JSON.stringify(files), JSON.stringify({ owners: ownerSummary, periods: Object.fromEntries(periodChoices) }), createdBy, actor.name]
    )
  );
  if (newPeople.size) {
    const list = [...newPeople.values()].map((p) => ({ id: p.id, name: p.name, teams: [...p.teams] }));
    queries.push(
      db.query(
        `insert into people (id, name, role, teams, import_batch_id, created_by)
         select r.id, r.name, 'member', array(select jsonb_array_elements_text(r.teams)), $2, $3
         from jsonb_to_recordset($1::jsonb) as r(id uuid, name text, teams jsonb)`,
        [JSON.stringify(list), batchId, createdBy]
      )
    );
  }
  for (const a of aliasAdds) {
    queries.push(
      db.query(
        `update people set aliases = array_append(aliases, $2::text), updated_at = now()
         where id = $1 and not (lower($2::text) = any(select lower(x) from unnest(aliases) as x))`,
        [a.id, a.alias]
      )
    );
  }
  if (textOnly.length) {
    queries.push(
      db.query(
        `update company_settings
         set text_only_owner_names = text_only_owner_names ||
           array(select n from unnest($1::text[]) as n
                 where not (lower(n) = any(select lower(x) from unnest(text_only_owner_names) as x)))
         where id`,
        [textOnly]
      )
    );
  }
  if (newPeriods.length) {
    queries.push(
      db.query(
        `insert into periods (id, team, name, start_date, end_date, import_batch_id)
         select r.id, r.team, r.name, r.start_date, r.end_date, $2
         from jsonb_to_recordset($1::jsonb) as r(id uuid, team text, name text, start_date date, end_date date)`,
        [JSON.stringify(newPeriods), batchId]
      )
    );
  }
  const insert = (text: string, records: unknown[]) => {
    if (records.length) queries.push(db.query(text, [JSON.stringify(records), tz, batchId]));
  };
  const created = `coalesce(r.created_at at time zone $2::text, now())`;
  insert(
    `insert into rocks (id, team, period_id, title, owner, owner_id, status, quarter, due_date, notes, level,
                        created_at, external_source, external_id, import_batch_id)
     select r.id, r.team, r.period_id, r.title, r.owner, r.owner_id, r.status, r.quarter, r.due_date, r.notes, r.level,
            ${created}, 'ninety', r.external_id, $3
     from jsonb_to_recordset($1::jsonb) as r(id uuid, team text, period_id uuid, title text, owner text, owner_id uuid,
          status text, quarter text, due_date date, notes text, level text, created_at timestamp, external_id text)
     ${CONFLICT}`,
    rockRecords
  );
  insert(
    `insert into steps (id, parent_type, parent_id, title, done, sort_order, source, owner, owner_id, due_date,
                        created_at, external_source, external_id, import_batch_id)
     select r.id, 'rock', r.parent_id, r.title, r.done, r.sort_order, 'manual', r.owner, r.owner_id, r.due_date,
            ${created}, 'ninety', r.external_id, $3
     from jsonb_to_recordset($1::jsonb) as r(id uuid, parent_id uuid, title text, done boolean, sort_order int,
          owner text, owner_id uuid, due_date date, created_at timestamp, external_id text)
     where exists (select 1 from rocks x where x.id = r.parent_id)
     ${CONFLICT}`,
    stepRecords
  );
  insert(
    `insert into issues (id, team, horizon, rank, title, description, owner, owner_id, priority, status, source,
                         created_at, external_source, external_id, import_batch_id)
     select r.id, r.team, r.horizon, r.rank, r.title, r.description, r.owner, r.owner_id, 'medium', 'open', 'manual',
            ${created}, 'ninety', r.external_id, $3
     from jsonb_to_recordset($1::jsonb) as r(id uuid, team text, horizon text, rank int, title text, description text,
          owner text, owner_id uuid, created_at timestamp, external_id text)
     ${CONFLICT}`,
    issueRecords
  );
  insert(
    `insert into todos (id, team, title, description, due_date, owner, owner_id, status, source,
                        created_at, external_source, external_id, import_batch_id)
     select r.id, r.team, r.title, r.description, r.due_date, r.owner, r.owner_id, 'open', 'manual',
            ${created}, 'ninety', r.external_id, $3
     from jsonb_to_recordset($1::jsonb) as r(id uuid, team text, title text, description text, due_date date,
          owner text, owner_id uuid, created_at timestamp, external_id text)
     ${CONFLICT}`,
    todoRecords
  );
  insert(
    `insert into headlines (id, team, type, text, description, presenter, presenter_id, source,
                            created_at, external_source, external_id, import_batch_id)
     select r.id, r.team, r.type, r.text, r.description, r.presenter, r.presenter_id, 'manual',
            ${created}, 'ninety', r.external_id, $3
     from jsonb_to_recordset($1::jsonb) as r(id uuid, team text, type text, text text, description text,
          presenter text, presenter_id uuid, created_at timestamp, external_id text)
     ${CONFLICT}`,
    headlineRecords
  );
  insert(
    `insert into scorecard_metrics (id, team, title, owner, owner_id, goal, unit, frequency, description, sort_order,
                                    created_at, external_source, external_id, import_batch_id)
     select r.id, r.team, r.title, r.owner, r.owner_id, r.goal, r.unit, r.frequency, r.description, r.sort_order,
            ${created}, 'ninety', r.external_id, $3
     from jsonb_to_recordset($1::jsonb) as r(id uuid, team text, title text, owner text, owner_id uuid, goal text,
          unit text, frequency text, description text, sort_order int, created_at timestamp, external_id text)
     ${CONFLICT}`,
    metricRecords
  );
  if (entryRecords.length) {
    queries.push(
      db.query(
        `insert into scorecard_entries (metric_id, period_date, value, source, import_batch_id)
         select r.metric_id, r.period_date, r.value, 'import', $2
         from jsonb_to_recordset($1::jsonb) as r(metric_id uuid, period_date date, value text)
         where exists (select 1 from scorecard_metrics m where m.id = r.metric_id)
         on conflict (metric_id, period_date) do nothing`,
        [JSON.stringify(entryRecords), batchId]
      )
    );
  }

  // The counts are what actually landed in this batch, stored on the batch
  const extra = {
    aliases: aliasAdds.length,
    text_only_names: textOnly.length,
    skipped_duplicates: skippedDuplicates,
    skipped_milestones: skippedMilestones,
    metrics_reused: metricsReused,
  };
  queries.push(
    db.query(
      `update import_batches set counts = jsonb_build_object(
         'issues',    (select count(*) from issues            where import_batch_id = $1),
         'todos',     (select count(*) from todos             where import_batch_id = $1),
         'rocks',     (select count(*) from rocks             where import_batch_id = $1),
         'steps',     (select count(*) from steps             where import_batch_id = $1),
         'headlines', (select count(*) from headlines         where import_batch_id = $1),
         'metrics',   (select count(*) from scorecard_metrics where import_batch_id = $1),
         'entries',   (select count(*) from scorecard_entries where import_batch_id = $1),
         'people',    (select count(*) from people            where import_batch_id = $1),
         'periods',   (select count(*) from periods           where import_batch_id = $1)
       ) || $2::jsonb
       where id = $1
       returning counts`,
      [batchId, JSON.stringify(extra)]
    )
  );

  let results: Record<string, any>[][];
  try {
    results = (await db.transaction(queries)) as Record<string, any>[][];
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown error';
    if (/periods_team_name_key/.test(message)) {
      return bad('Nothing was imported: a period with one of those names already exists; choose it instead', 409);
    }
    return bad(`Nothing was imported: ${message}`, 500);
  }
  const counts = (results[results.length - 1]?.[0]?.counts ?? {}) as Record<string, number>;
  return json({ batch_id: batchId, counts, warnings });
};
