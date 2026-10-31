// Loads the accountability-chart seed JSON into the Netlify DB (Neon Postgres).
//
//   NETLIFY_DATABASE_URL=postgres://... node scripts/accountability-seed.mjs db/seeds/accountability-chart-2026-10-31.json
//
// Every chart in the file lands in accountability_charts, accountability_seats
// (parents inserted before children) and accountability_seat_people, in one
// transaction. A seat's "person" string joined by ";" is several people; each
// name is matched against active people's names and aliases case-insensitively
// to set person_id (and store the canonical name), and kept as written text
// when nothing matches. Refuses when a chart with the same title and status
// already exists, unless --replace deletes and reloads that chart.

import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { neon } from '@neondatabase/serverless';
import { normalizePeople, sanitizeRoles } from '../src/lib/accountability.ts';

// ── Pure helpers (tested in tests/accountability-seed.test.mjs, no DB) ──────

const nameKey = (text) => text.trim().toLowerCase();

/**
 * Name-key index over active people: full names plus aliases, lower-cased and
 * trimmed. A key two different people share is dropped (the person_name_keys
 * rule), so it matches nobody rather than the wrong person.
 */
export function buildNameIndex(people) {
  const index = new Map();
  const ambiguous = new Set();
  for (const p of people ?? []) {
    const keys = [p.name, ...(p.aliases ?? [])]
      .filter((s) => typeof s === 'string' && s.trim() !== '')
      .map(nameKey);
    for (const k of keys) {
      if (index.get(k)?.id === p.id) continue; // same person twice
      if (index.has(k)) ambiguous.add(k);
      else index.set(k, p);
    }
  }
  for (const k of ambiguous) index.delete(k);
  return index;
}

/**
 * Resolves one seat-person name: a unique name/alias key becomes the person's
 * id and canonical name; anything else stays as written with no id.
 */
export function matchName(text, index) {
  const hit = index.get(nameKey(text));
  return hit ? { person_id: hit.id, person: hit.name } : { person_id: null, person: text };
}

/**
 * Turns one seed chart into insert rows: the chart, its seats (parents before
 * children, seed order among siblings, sort_order counted per parent) and the
 * seat people. Throws a plain Error on a broken chart (no name, bad status,
 * duplicate seat id, not exactly one root, unknown or cyclic parent).
 */
export function planChart(chart, nameIndex, makeId = randomUUID) {
  const title = typeof chart?.name === 'string' ? chart.name.trim() : '';
  if (!title) throw new Error('A chart in the seed has no name.');
  if (chart.status !== 'current' && chart.status !== 'proposal') {
    throw new Error(`Chart "${title}": status must be 'current' or 'proposal'.`);
  }
  const seatsIn = Array.isArray(chart.seats) ? chart.seats : [];

  const bySeedId = new Map();
  for (const s of seatsIn) {
    const id = typeof s?.id === 'string' ? s.id.trim() : '';
    if (!id) throw new Error(`Chart "${title}": a seat has no id.`);
    if (bySeedId.has(id)) throw new Error(`Chart "${title}": duplicate seat id "${id}".`);
    bySeedId.set(id, s);
  }
  const roots = seatsIn.filter((s) => s.parentId === null || s.parentId === undefined);
  if (roots.length !== 1) {
    throw new Error(`Chart "${title}": a chart has one root seat (found ${roots.length}).`);
  }

  const chartId = makeId();
  const newIds = new Map(); // seed id -> new uuid; placed seats only
  const siblingCount = new Map(); // parent seed id (null = root) -> next sort_order
  const seats = [];
  const people = [];
  const unmatched = [];
  let matched = 0;

  let pending = seatsIn.slice();
  while (pending.length) {
    // Seats whose parent is the root or already placed go next, in seed order.
    const ready = pending.filter(
      (s) => s.parentId === null || s.parentId === undefined || newIds.has(s.parentId)
    );
    if (!ready.length) {
      const stuck = pending.map((s) => `"${s.id}" (parent "${s.parentId}")`).join(', ');
      throw new Error(`Chart "${title}": seats with an unknown or cyclic parent: ${stuck}.`);
    }
    for (const s of ready) {
      pending = pending.filter((x) => x !== s);
      const parentId = s.parentId === null || s.parentId === undefined ? null : s.parentId;
      const seatTitle = typeof s.title === 'string' ? s.title.trim() : '';
      if (!seatTitle) throw new Error(`Chart "${title}": seat "${s.id}" has no title.`);
      const id = makeId();
      newIds.set(s.id, id);
      const sort_order = siblingCount.get(parentId) ?? 0;
      siblingCount.set(parentId, sort_order + 1);
      seats.push({
        id,
        chart_id: chartId,
        parent_id: parentId === null ? null : newIds.get(parentId),
        title: seatTitle,
        roles: sanitizeRoles(s.roles),
        notes: typeof s.notes === 'string' && s.notes.trim() ? s.notes.trim() : null,
        sort_order,
      });
      for (const [i, name] of normalizePeople(s.person).entries()) {
        const { person_id, person } = matchName(name, nameIndex);
        if (person_id) matched++;
        else unmatched.push(name);
        people.push({ seat_id: id, person_id, person, sort_order: i });
      }
    }
  }

  return {
    key: chart.key,
    title,
    status: chart.status,
    chartId,
    seats,
    people,
    matched,
    unmatched: [...new Set(unmatched)],
  };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

const USAGE = `Usage: node scripts/accountability-seed.mjs <path-to-seed.json> [--replace]

Loads every chart in the seed file into accountability_charts, accountability_seats
and accountability_seat_people in one transaction, matching seat names against
active people (name + aliases, case-insensitive). Refuses when a chart with the
same title and status already exists, unless --replace deletes and reloads it.

Needs NETLIFY_DATABASE_URL (or DATABASE_URL) set to the Postgres connection string.`;

const fail = (msg) => {
  console.error(msg);
  process.exit(1);
};

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { replace: { type: 'boolean', default: false } },
  });
  const path = positionals[0];
  if (!path) fail(USAGE);

  const url = process.env.NETLIFY_DATABASE_URL || process.env.DATABASE_URL;
  if (!url) fail('Set NETLIFY_DATABASE_URL (or DATABASE_URL) to the Postgres connection string.');

  let seed;
  try {
    seed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    fail(`Could not read the seed file ${path}: ${err.message}`);
  }
  const chartsIn = Array.isArray(seed?.charts) ? seed.charts : [];
  if (!chartsIn.length) fail('The seed file has no charts.');

  const sql = neon(url);
  const peopleRows = await sql`select id, name, aliases from people where active order by name`;
  const nameIndex = buildNameIndex(peopleRows);

  const plans = chartsIn.map((c) => planChart(c, nameIndex));
  if (plans.filter((p) => p.status === 'current').length > 1) {
    fail('The seed has more than one current chart; only one current chart may exist.');
  }

  const queries = [];
  const replaced = [];
  for (const plan of plans) {
    const [existing] = await sql`
      select id from accountability_charts where title = ${plan.title} and status = ${plan.status}`;
    if (existing && !values.replace) {
      fail(`Chart "${plan.title}" with status ${plan.status} already exists. Pass --replace to delete and reload it.`);
    }
    if (existing) {
      queries.push(sql`delete from accountability_charts where id = ${existing.id}`); // cascades to seats and people
      replaced.push(plan.title);
    }
    if (plan.status === 'current') {
      const [clash] = await sql`
        select title from accountability_charts where status = 'current' and title <> ${plan.title}`;
      if (clash) {
        fail(`"${clash.title}" is already the current chart. Promote or demote it first, or --replace it.`);
      }
    }
  }

  for (const plan of plans) {
    queries.push(sql`
      insert into accountability_charts (id, title, status) values (${plan.chartId}, ${plan.title}, ${plan.status})`);
    for (const s of plan.seats) {
      queries.push(sql`
        insert into accountability_seats (id, chart_id, parent_id, title, roles, notes, sort_order)
        values (${s.id}, ${s.chart_id}, ${s.parent_id}, ${s.title}, ${s.roles}::text[], ${s.notes}, ${s.sort_order})`);
    }
    for (const p of plan.people) {
      queries.push(sql`
        insert into accountability_seat_people (seat_id, person_id, person, sort_order)
        values (${p.seat_id}, ${p.person_id}, ${p.person}, ${p.sort_order})`);
    }
  }
  if (queries.length) await sql.transaction(queries);

  const seats = plans.reduce((n, p) => n + p.seats.length, 0);
  const peopleCount = plans.reduce((n, p) => n + p.people.length, 0);
  const matched = plans.reduce((n, p) => n + p.matched, 0);
  console.log(
    `Loaded ${plans.length} chart(s), ${seats} seats, ${peopleCount} seat people (${matched} matched, ${peopleCount - matched} unmatched).`
  );
  if (replaced.length) console.log(`Replaced: ${replaced.map((t) => `"${t}"`).join(', ')}`);
  for (const p of plans) {
    console.log(
      `  ${p.title} [${p.status}] — ${p.seats.length} seats, ${p.people.length} people (${p.matched} matched, ${p.people.length - p.matched} unmatched)`
    );
  }
  const unmatchedNames = [...new Set(plans.flatMap((p) => p.unmatched))];
  if (unmatchedNames.length) console.log(`Unmatched names kept as text: ${unmatchedNames.join(', ')}`);
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err?.message ?? err);
    process.exit(1);
  });
}
