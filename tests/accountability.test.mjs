// Tests for src/lib/accountability.ts: the pure accountability-chart helpers
// (role sanitising, ';'-joined people text, re-parent validation, layout
// plumbing and edge styling).
//   node --test tests/accountability.test.mjs
// Needs Node 22.18+ / 24 (runs the .ts module directly via type stripping).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_ROLES,
  buildLayout,
  edgesFromSeats,
  normalizePeople,
  sanitizeRoles,
  validateReparent,
} from '../src/lib/accountability.ts';

// ── sanitizeRoles ───────────────────────────────────────────────────────────

test('sanitizeRoles trims, drops blanks and non-strings', () => {
  assert.deepEqual(sanitizeRoles(['  Tax prep ', '', 'Payroll', null, 42, '   ']), [
    'Tax prep',
    'Payroll',
  ]);
});

test('sanitizeRoles keeps at most five roles (the seed moves the rest to notes)', () => {
  assert.equal(MAX_ROLES, 5);
  assert.deepEqual(sanitizeRoles(['a', 'b', 'c', 'd', 'e', 'f', 'g']), ['a', 'b', 'c', 'd', 'e']);
});

test('sanitizeRoles: anything that is not an array gives an empty list', () => {
  assert.deepEqual(sanitizeRoles(undefined), []);
  assert.deepEqual(sanitizeRoles('Tax prep'), []);
  assert.deepEqual(sanitizeRoles(null), []);
});

// ── normalizePeople ─────────────────────────────────────────────────────────

test('normalizePeople splits on ";", trims and drops blanks', () => {
  assert.deepEqual(normalizePeople('Russell Heath; Jude Heath ;'), ['Russell Heath', 'Jude Heath']);
  assert.deepEqual(normalizePeople(''), []);
  assert.deepEqual(normalizePeople(null), []);
});

test('normalizePeople dedupes, keeping the first occurrence and order (sort_order)', () => {
  assert.deepEqual(
    normalizePeople('Kayla Virgil; Kayla Virgil; Debra Mengel; Kayla Virgil'),
    ['Kayla Virgil', 'Debra Mengel']
  );
});

test('normalizePeople accepts an array, splitting ";" inside each element', () => {
  assert.deepEqual(normalizePeople(['Russell Heath; Jude Heath', 'Nicole Mano']), [
    'Russell Heath',
    'Jude Heath',
    'Nicole Mano',
  ]);
});

// ── validateReparent ────────────────────────────────────────────────────────
// visionary -> integrator -> operations -> tax-team

const TREE = [
  { id: 'visionary', parent_id: null },
  { id: 'integrator', parent_id: 'visionary' },
  { id: 'operations', parent_id: 'integrator' },
  { id: 'tax-team', parent_id: 'operations' },
];

test('validateReparent rejects a seat parenting itself', () => {
  const r = validateReparent(TREE, 'integrator', 'integrator');
  assert.ok('error' in r && typeof r.error === 'string');
});

test('validateReparent rejects a descendant as the new parent (would loop the tree)', () => {
  assert.ok('error' in validateReparent(TREE, 'visionary', 'operations'));
  assert.ok('error' in validateReparent(TREE, 'visionary', 'tax-team'));
  assert.ok('error' in validateReparent(TREE, 'integrator', 'tax-team'));
});

test('validateReparent rejects a parent outside the chart and an unknown seat', () => {
  assert.ok('error' in validateReparent(TREE, 'tax-team', 'seat-from-another-chart'));
  assert.ok('error' in validateReparent(TREE, 'no-such-seat', 'integrator'));
});

test('validateReparent rejects making a non-root seat a second root', () => {
  assert.ok('error' in validateReparent(TREE, 'tax-team', null));
  assert.ok('error' in validateReparent(TREE, 'integrator', null));
});

test('validateReparent allows the root staying root and valid moves up the tree', () => {
  assert.deepEqual(validateReparent(TREE, 'visionary', null), { ok: true });
  assert.deepEqual(validateReparent(TREE, 'tax-team', 'integrator'), { ok: true });
  assert.deepEqual(validateReparent(TREE, 'operations', 'visionary'), { ok: true });
});

// ── buildLayout ─────────────────────────────────────────────────────────────
// The layout function is injected (dagre in the UI); buildLayout normalises
// what it sees. ghost-child's parent is outside the set and must be dropped.

const LAYOUT_SEATS = [
  { id: 'ops', parent_id: 'integrator', title: 'Operations', sort_order: 1 },
  { id: 'visionary', parent_id: null, title: 'Visionary', sort_order: 0 },
  { id: 'integrator', parent_id: 'visionary', title: 'Integrator', sort_order: 0 },
  { id: 'ghost-child', parent_id: 'not-in-chart', title: 'Dangling', sort_order: 0 },
];

test('buildLayout hands the layout function every seat and parent link, in a stable order', () => {
  const calls = [];
  const positions = buildLayout(LAYOUT_SEATS, (nodes, edges) => {
    calls.push({ nodes: nodes.map((n) => n.id), edges });
    return Object.fromEntries(nodes.map((n, i) => [n.id, { x: i * 240, y: 0 }]));
  });
  assert.equal(calls.length, 1);
  // sort_order first, then title: Dangling, Integrator, Visionary, Operations
  assert.deepEqual(calls[0].nodes, ['ghost-child', 'integrator', 'visionary', 'ops']);
  assert.deepEqual(calls[0].edges, [
    { source: 'visionary', target: 'integrator' },
    { source: 'integrator', target: 'ops' },
  ]);
  assert.deepEqual(positions.integrator, { x: 240, y: 0 });
});

test('buildLayout is deterministic: the same seats give the same nodes and edges', () => {
  const seen = [];
  buildLayout(LAYOUT_SEATS, (nodes, edges) => {
    seen.push({ nodes, edges });
    return {};
  });
  buildLayout(LAYOUT_SEATS, (nodes, edges) => {
    seen.push({ nodes, edges });
    return {};
  });
  assert.deepEqual(seen[0], seen[1]);
});

test('buildLayout returns the layout function positions keyed by seat id', () => {
  const positions = buildLayout(LAYOUT_SEATS, () => ({
    visionary: { x: 0, y: 0 },
    integrator: { x: 0, y: 110 },
  }));
  assert.deepEqual(Object.keys(positions).sort(), ['integrator', 'visionary']);
});

// ── edgesFromSeats ──────────────────────────────────────────────────────────

test('edgesFromSeats: visionary to integrator dashed, the rest solid, all smoothstep', () => {
  const seats = [
    { id: 'v', parent_id: null, title: 'Visionary' },
    { id: 'i', parent_id: 'v', title: 'Integrator' },
    { id: 'o', parent_id: 'i', title: 'Operations' },
    { id: 'f', parent_id: 'v', title: 'Finance/Administration' },
  ];
  assert.deepEqual(edgesFromSeats(seats), [
    { id: 'v-i', source: 'v', target: 'i', type: 'smoothstep', dashed: true },
    { id: 'i-o', source: 'i', target: 'o', type: 'smoothstep', dashed: false },
    { id: 'v-f', source: 'v', target: 'f', type: 'smoothstep', dashed: false },
  ]);
});

test('edgesFromSeats matches titles after trimming and case, and skips dangling parents', () => {
  const seats = [
    { id: 'v', parent_id: null, title: ' visionary ' },
    { id: 'i', parent_id: 'v', title: 'INTEGRATOR' },
    { id: 'x', parent_id: 'missing', title: 'Elsewhere' },
  ];
  const edges = edgesFromSeats(seats);
  assert.equal(edges.length, 1);
  assert.equal(edges[0].dashed, true);
});
