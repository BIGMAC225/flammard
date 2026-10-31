// Tests for src/lib/accountability.ts: the pure accountability-chart helpers
// (role sanitising, ';'-joined people text, re-parent validation, layout
// plumbing and edge styling).
//   node --test tests/accountability.test.mjs
// Needs Node 22.18+ / 24 (runs the .ts module directly via type stripping).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_ROLES,
  allowedParentIds,
  buildLayout,
  descendantIds,
  edgesFromSeats,
  normalizePeople,
  pickDropTarget,
  sanitizeRoles,
  survivingExtraParent,
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

// ── descendantIds / allowedParentIds ─────────────────────────────────────────

test('descendantIds returns the seat and everything below it, nothing above or beside', () => {
  assert.deepEqual([...descendantIds(TREE, 'integrator')].sort(), ['integrator', 'operations', 'tax-team']);
  assert.deepEqual([...descendantIds(TREE, 'tax-team')], ['tax-team']);
  assert.deepEqual(
    [...descendantIds(TREE, 'visionary')].sort(),
    TREE.map((s) => s.id).sort()
  );
});

test('allowedParentIds excludes the seat and its descendants, keeps everyone else in order', () => {
  assert.deepEqual(allowedParentIds(TREE, 'operations'), ['visionary', 'integrator']);
  assert.deepEqual(allowedParentIds(TREE, 'tax-team'), ['visionary', 'integrator', 'operations']);
  // The root has every seat below it, so nothing may parent it
  assert.deepEqual(allowedParentIds(TREE, 'visionary'), []);
});

// ── pickDropTarget ───────────────────────────────────────────────────────────
// Cards 240 wide, ranks 260 apart (the dagre layout: 200-high slots + 60 gap).

const DRAG_RECTS = {
  visionary: { x: 0, y: 0, width: 240, height: 120 },
  integrator: { x: 0, y: 260, width: 240, height: 120 },
  operations: { x: -280, y: 520, width: 240, height: 120 },
  'tax-team': { x: -280, y: 780, width: 240, height: 120 },
};

test('pickDropTarget returns the card under the pointer', () => {
  assert.equal(pickDropTarget(TREE, 'operations', { x: 120, y: 300 }, DRAG_RECTS), 'integrator');
  assert.equal(pickDropTarget(TREE, 'operations', { x: 120, y: 30 }, DRAG_RECTS), 'visionary');
});

test('pickDropTarget never returns the dragged seat or one of its descendants', () => {
  // Pointer over the dragged seat's own card
  assert.equal(pickDropTarget(TREE, 'operations', { x: -160, y: 560 }, DRAG_RECTS), null);
  // Pointer over tax-team, a descendant of the dragged integrator
  assert.equal(pickDropTarget(TREE, 'integrator', { x: -160, y: 800 }, DRAG_RECTS), null);
});

test('pickDropTarget: pointer over empty canvas or a seat with no rect gives null', () => {
  // The gap between ranks
  assert.equal(pickDropTarget(TREE, 'operations', { x: 120, y: 460 }, DRAG_RECTS), null);
  // integrator's rect missing (not measured yet); visionary does not contain the pointer
  assert.equal(
    pickDropTarget(TREE, 'operations', { x: 120, y: 300 }, { ...DRAG_RECTS, integrator: undefined }),
    null
  );
});

test('pickDropTarget treats the card bounds as inclusive', () => {
  const seats = [
    { id: 'a', parent_id: null },
    { id: 'b', parent_id: 'a' },
  ];
  const rects = { a: { x: 0, y: 0, width: 240, height: 120 } };
  assert.equal(pickDropTarget(seats, 'b', { x: 0, y: 0 }, rects), 'a');
  assert.equal(pickDropTarget(seats, 'b', { x: 240, y: 120 }, rects), 'a');
  assert.equal(pickDropTarget(seats, 'b', { x: 241, y: 120 }, rects), null);
  assert.equal(pickDropTarget(seats, 'b', { x: 240, y: 121 }, rects), null);
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
    { id: 'v-i', source: 'v', target: 'i', type: 'smoothstep', dashed: true, extra: false },
    { id: 'i-o', source: 'i', target: 'o', type: 'smoothstep', dashed: false, extra: false },
    { id: 'v-f', source: 'v', target: 'f', type: 'smoothstep', dashed: false, extra: false },
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

// ── extra-parent links (accountability_seat_links) ──────────────────────────
// tax-team as an extra parent of operations: pooled staff under two seats.

const LINKS = [{ seat_id: 'operations', parent_id: 'tax-team' }];

test('descendantIds follows extra-parent links as well as the primary tree', () => {
  assert.deepEqual([...descendantIds(TREE, 'tax-team', LINKS)].sort(), ['operations', 'tax-team']);
  // Without the link, the primary tree only
  assert.deepEqual([...descendantIds(TREE, 'tax-team')], ['tax-team']);
});

test('allowedParentIds bans a seat reached through a link', () => {
  assert.deepEqual(allowedParentIds(TREE, 'tax-team', LINKS), ['visionary', 'integrator']);
  assert.deepEqual(allowedParentIds(TREE, 'tax-team'), ['visionary', 'integrator', 'operations']);
});

test('validateReparent rejects a cycle that only exists through a link', () => {
  const r = validateReparent(TREE, 'tax-team', 'operations', LINKS);
  assert.ok('error' in r && typeof r.error === 'string');
  // the same move without the link is fine
  assert.deepEqual(validateReparent(TREE, 'tax-team', 'operations'), { ok: true });
});

test('pickDropTarget never offers a seat reached only through a link', () => {
  // Pointer over operations while dragging tax-team: operations is tax-team's
  // extra child, so it can never become tax-team's primary parent.
  assert.equal(pickDropTarget(TREE, 'tax-team', { x: -160, y: 560 }, DRAG_RECTS, LINKS), null);
});

test('buildLayout feeds the layout both edge sets, deduped, in a stable order', () => {
  const calls = [];
  buildLayout(LAYOUT_SEATS, (_nodes, edges) => {
    calls.push(edges);
    return {};
  }, [{ seat_id: 'ops', parent_id: 'visionary' }]);
  assert.deepEqual(calls[0], [
    { source: 'visionary', target: 'integrator' },
    { source: 'integrator', target: 'ops' },
    { source: 'visionary', target: 'ops' },
  ]);
  // a link that duplicates a primary edge is dropped, not drawn twice
  buildLayout(LAYOUT_SEATS, (_nodes, edges) => {
    calls.push(edges);
    return {};
  }, [{ seat_id: 'integrator', parent_id: 'visionary' }]);
  assert.equal(
    calls[1].filter((e) => e.source === 'visionary' && e.target === 'integrator').length,
    1
  );
});

test('edgesFromSeats marks extra-parent connectors and gives them their own ids', () => {
  const seats = [
    { id: 'v', parent_id: null, title: 'Visionary' },
    { id: 'a', parent_id: 'v', title: 'Division A' },
    { id: 'b', parent_id: 'v', title: 'Division B' },
    { id: 's', parent_id: 'a', title: 'Tax Staff 1' },
  ];
  const edges = edgesFromSeats(seats, [{ seat_id: 's', parent_id: 'b' }]);
  assert.deepEqual(edges.find((e) => e.extra), {
    id: 'link-b-s',
    source: 'b',
    target: 's',
    type: 'smoothstep',
    dashed: false,
    extra: true,
  });
  assert.equal(edges.filter((e) => !e.extra).length, 3);
});

test('survivingExtraParent picks the earliest link whose parent outlives the delete', () => {
  const links = [
    { seat_id: 'staff', parent_id: 'tax-jude' },
    { seat_id: 'staff', parent_id: 'kayla' },
    { seat_id: 'other', parent_id: 'tax-jude' },
  ]; // ordered by created_at
  // every extra parent dies with the delete: the child goes with the subtree
  assert.equal(survivingExtraParent(links, 'staff', new Set(['kayla', 'tax-jude'])), null);
  // the first link's parent is doomed, the second survives: skip to it
  assert.equal(survivingExtraParent(links, 'staff', new Set(['tax-jude'])), 'kayla');
  assert.equal(survivingExtraParent(links, 'staff', new Set(['kayla'])), 'tax-jude');
  assert.equal(survivingExtraParent(links, 'nobody', new Set()), null);
});
