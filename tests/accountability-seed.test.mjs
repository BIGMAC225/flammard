// Tests for scripts/accountability-seed.mjs: the pure seed-to-rows planning
// (name matching against an in-memory people list, seat-tree ordering) run
// against the copied seed file. No database.
//   node --test tests/accountability-seed.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildNameIndex, matchName, planChart } from '../scripts/accountability-seed.mjs';

const seed = JSON.parse(
  readFileSync(new URL('../db/seeds/accountability-chart-2026-10-31.json', import.meta.url), 'utf8')
);

// The roster as far as spelling matches: Ashley (not the seed's export
// misspelling "Ashely"), Sierra (not "Sieara"), Jennifer with her export
// alias. Two people share the key "alexis landry", so it matches nobody.
const PEOPLE = [
  { id: 'jude', name: 'Jude Heath', aliases: [] },
  { id: 'jennifer', name: 'Jennifer Heath', aliases: ['Jennifer Louise'] },
  { id: 'russell', name: 'Russell Heath', aliases: [] },
  { id: 'nicole', name: 'Nicole Mano', aliases: [] },
  { id: 'kayla', name: 'Kayla Virgil', aliases: [] },
  { id: 'ashley', name: 'Ashley Cabeceiras', aliases: [] },
  { id: 'sierra', name: 'Sierra Williams', aliases: [] },
  { id: 'xixi', name: 'Xixi Ma', aliases: ['Shishi'] },
  { id: 'alexis', name: 'Alexis Landry', aliases: [] },
  { id: 'other', name: 'Someone Else', aliases: ['Alexis Landry'] },
];

// ── buildNameIndex / matchName ──────────────────────────────────────────────

test('buildNameIndex keys full names and aliases case-insensitively, dropping keys two people share', () => {
  const index = buildNameIndex(PEOPLE);
  assert.equal(index.get('jude heath')?.id, 'jude');
  assert.equal(index.get('jennifer louise')?.id, 'jennifer');
  assert.equal(index.get('xixi ma')?.id, 'xixi');
  assert.equal(index.get('alexis landry'), undefined); // held by two people
  assert.equal(buildNameIndex(null).size, 0);
});

test('matchName gives matched names the id and canonical spelling, unmatched ones stay as written', () => {
  const index = buildNameIndex(PEOPLE);
  assert.deepEqual(matchName('  JENNIFER LOUISE ', index), { person_id: 'jennifer', person: 'Jennifer Heath' });
  assert.deepEqual(matchName('Shishi', index), { person_id: 'xixi', person: 'Xixi Ma' });
  assert.deepEqual(matchName('Ashely Cabeceiras', index), { person_id: null, person: 'Ashely Cabeceiras' });
  assert.deepEqual(matchName('Alexis Landry', index), { person_id: null, person: 'Alexis Landry' });
});

// ── planChart against the copied seed file ──────────────────────────────────

test('planChart: the seed loads as 2 charts, the root first and every parent before its children', () => {
  const index = buildNameIndex(PEOPLE);
  const plans = seed.charts.map((c) => planChart(c, index));
  assert.equal(plans.length, 2);
  for (const plan of plans) {
    assert.equal(plan.seats.filter((s) => s.parent_id === null).length, 1);
    assert.equal(plan.seats[0].parent_id, null); // the root goes in first
    const seen = new Set([plan.seats[0].id]);
    for (const s of plan.seats.slice(1)) {
      assert.ok(s.parent_id && seen.has(s.parent_id), `parent of "${s.title}" is inserted earlier`);
      seen.add(s.id);
    }
  }
});

test('planChart: counts, roles and the open Operations seat match the seed', () => {
  const index = buildNameIndex(PEOPLE);
  const current = planChart(seed.charts[0], index);
  assert.equal(current.title, 'J. Heath & Co. Accountability Chart (current)');
  assert.equal(current.status, 'current');
  assert.equal(current.seats.length, 15);
  assert.equal(current.seats.find((s) => s.title === 'Visionary').roles.length, 5);
  const proposal = planChart(seed.charts[1], index);
  assert.equal(proposal.seats.length, 15);
  const operations = proposal.seats.find((s) => s.title === 'Operations');
  assert.equal(proposal.people.filter((p) => p.seat_id === operations.id).length, 0); // open seat
});

test('planChart: sort_order counts seats within each parent, in seed order', () => {
  const plan = planChart(seed.charts[0], buildNameIndex(PEOPLE));
  const perParent = new Map();
  for (const s of plan.seats) {
    const k = s.parent_id ?? 'root';
    assert.equal(s.sort_order, perParent.get(k) ?? 0);
    perParent.set(k, (perParent.get(k) ?? 0) + 1);
  }
});

test('planChart: matched rows carry the id and canonical name, misspellings stay text and are reported', () => {
  const index = buildNameIndex(PEOPLE);
  const plan = planChart(seed.charts[0], index);
  assert.ok(plan.people.some((p) => p.person_id === 'jennifer' && p.person === 'Jennifer Heath'));
  assert.ok(plan.unmatched.includes('Ashely Cabeceiras'));
  assert.ok(plan.unmatched.includes('Sieara Williams'));
  assert.equal(plan.people.filter((p) => p.person_id === null).length, plan.people.length - plan.matched);
  assert.ok(plan.unmatched.every((n) => plan.people.some((p) => p.person === n && p.person_id === null)));
});

test('planChart throws on a second root, a missing parent and a bad status', () => {
  const index = buildNameIndex(PEOPLE);
  const twoRoots = {
    name: 'Broken', status: 'proposal',
    seats: [
      { id: 'a', parentId: null, title: 'A' },
      { id: 'b', parentId: null, title: 'B' },
    ],
  };
  assert.throws(() => planChart(twoRoots, index), /one root seat/);
  const orphan = {
    name: 'Broken', status: 'proposal',
    seats: [
      { id: 'a', parentId: null, title: 'A' },
      { id: 'b', parentId: 'ghost', title: 'B' },
    ],
  };
  assert.throws(() => planChart(orphan, index), /unknown or cyclic parent/);
  assert.throws(() => planChart({ name: 'Broken', status: 'archived', seats: [] }, index), /status/);
});

// ── parentIds: the first entry is the primary parent, the rest are links ────

test('planChart: parentIds makes the first entry the primary parent and the rest links', () => {
  const pooled = {
    name: 'Pooled', status: 'proposal',
    seats: [
      { id: 'root', parentId: null, title: 'Root' },
      { id: 'tax-jude', parentId: 'root', title: 'Tax-Jude' },
      { id: 'tax-jen', parentId: 'root', title: 'Tax-Jen' },
      { id: 'staff', parentIds: ['tax-jude', 'tax-jen'], title: 'Tax Staff 1' },
    ],
  };
  const plan = planChart(pooled, buildNameIndex(PEOPLE));
  const byTitle = new Map(plan.seats.map((s) => [s.title, s]));
  assert.equal(byTitle.get('Tax Staff 1').parent_id, byTitle.get('Tax-Jude').id);
  assert.deepEqual(plan.links, [
    { seat_id: byTitle.get('Tax Staff 1').id, parent_id: byTitle.get('Tax-Jen').id },
  ]);
  // the shipped seed JSON has no parentIds: no links
  const plans = seed.charts.map((c) => planChart(c, buildNameIndex(PEOPLE)));
  assert.ok(plans.every((p) => p.links.length === 0));
});

test('planChart throws on a bad extra parent: unknown, the seat itself, inside its subtree', () => {
  const index = buildNameIndex(PEOPLE);
  const unknown = {
    name: 'Broken', status: 'proposal',
    seats: [
      { id: 'root', parentId: null, title: 'Root' },
      { id: 'a', parentIds: ['root', 'ghost'], title: 'A' },
    ],
  };
  assert.throws(() => planChart(unknown, index), /unknown extra parent/);
  const self = {
    name: 'Broken', status: 'proposal',
    seats: [
      { id: 'root', parentId: null, title: 'Root' },
      { id: 'a', parentIds: ['root', 'a'], title: 'A' },
    ],
  };
  assert.throws(() => planChart(self, index), /inside its subtree/);
  // b sits below a in the primary tree: a cannot also report to b
  const cycle = {
    name: 'Broken', status: 'proposal',
    seats: [
      { id: 'root', parentId: null, title: 'Root' },
      { id: 'a', parentIds: ['root', 'b'], title: 'A' },
      { id: 'b', parentId: 'a', title: 'B' },
    ],
  };
  assert.throws(() => planChart(cycle, index), /inside its subtree/);
});
