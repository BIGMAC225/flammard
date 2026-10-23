// Tests for src/lib/fulfillment-diff.ts (fulfillment step 7: the snapshot
// diff engine's pure core — every branch of plan section G, driven by
// tests/fixtures/fulfillment/diff-scenarios.json).
//   node --test tests/fulfillment-diff.test.mjs
// Needs Node 22.18+ / 24 (runs the .ts module directly via type stripping).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { diffSnapshots, loadLatestSnapshots, runFulfillmentDiff } from '../src/lib/fulfillment-diff.ts';

const scenarios = JSON.parse(
  readFileSync(new URL('./fixtures/fulfillment/diff-scenarios.json', import.meta.url), 'utf8')
);

const rowsByJob = (rows) => new Map((rows ?? []).map((row) => [row.job_id, row]));
const numMap = (obj) => new Map(Object.entries(obj ?? {}).map(([k, v]) => [Number(k), v]));

function run(name) {
  const { input } = scenarios[name];
  return diffSnapshots({
    current: input.current,
    previous: rowsByJob(input.previous),
    openIntervals: rowsByJob(input.openIntervals),
    statusKind: numMap(input.statusKind),
    stageOrder: numMap(input.stageOrder),
    firstRunEver: input.firstRunEver,
    fullWalk: input.fullWalk,
    runAt: new Date(input.runAt),
    runId: input.runId,
  });
}

test('the module exports loadLatestSnapshots and runFulfillmentDiff as functions', () => {
  assert.equal(typeof loadLatestSnapshots, 'function');
  assert.equal(typeof runFulfillmentDiff, 'function');
});

for (const [name, scenario] of Object.entries(scenarios)) {
  test(`scenario ${name}: counts, events and interval days`, () => {
    const plan = run(name);
    assert.deepEqual(plan.counts, scenario.expect.counts);
    assert.deepEqual(
      plan.events.map(({ job_id, event_type, from_stage_id, to_stage_id }) => ({
        job_id,
        event_type,
        from_stage_id,
        to_stage_id,
      })),
      scenario.expect.events
    );
    assert.deepEqual(
      Object.fromEntries(plan.closeIntervals.map((c) => [`${c.job_id}|${c.stage_id}`, c.days])),
      scenario.expect.closedDays
    );
  });

  test(`scenario ${name}: no duplicate opens for one job`, () => {
    const plan = run(name);
    const { input } = scenarios[name];
    const opensPerJob = new Map();
    for (const o of plan.openIntervals) opensPerJob.set(o.job_id, (opensPerJob.get(o.job_id) ?? 0) + 1);
    for (const count of opensPerJob.values()) assert.ok(count <= 1, `${name}: a job is opened twice`);
    // a job whose existing interval was not closed must not gain a second one
    const closedKeys = new Set(plan.closeIntervals.map((c) => `${c.job_id}|${c.stage_id}|${c.entered_at}`));
    for (const row of input.openIntervals) {
      const enteredIso = new Date(row.entered_at).toISOString();
      const kept = !closedKeys.has(`${row.job_id}|${row.stage_id}|${enteredIso}`);
      if (kept) {
        assert.equal(opensPerJob.get(row.job_id) ?? 0, 0, `${name}: job ${row.job_id} keeps its open interval and must not get another`);
      }
    }
  });
}

test('first run backfill: one interval and one backfill-flagged new event per job, at the intake date', () => {
  const plan = run('first_run_backfill');
  assert.deepEqual(plan.openIntervals, [
    { job_id: 1001, pipeline_id: 7, stage_id: 20, entered_at: '2026-10-10T14:00:00.000Z' },
    { job_id: 1002, pipeline_id: 7, stage_id: 10, entered_at: '2026-10-15T15:00:00.000Z' },
  ]);
  assert.equal(plan.events[0].job_id, 1001);
  assert.equal(plan.events[0].at, '2026-10-01T00:00:00.000Z'); // intake_date
  assert.deepEqual(plan.events[0].detail, { backfill: true });
  assert.equal(plan.events[1].job_id, 1002);
  assert.equal(plan.events[1].at, '2026-10-15T15:00:00.000Z'); // no intake: moved_at
  assert.deepEqual(plan.events[1].detail, { backfill: true });
});

test('new job on a later run: event at captured_at, no backfill flag', () => {
  const plan = run('new_job_later_run');
  assert.equal(plan.events[0].at, '2026-10-22T15:00:00.000Z');
  assert.equal(plan.events[0].detail, null);
});

test('moved forward: close exited at cur.moved_at, open at cur.moved_at', () => {
  const plan = run('moved_forward');
  assert.deepEqual(plan.closeIntervals, [
    { id: 501, job_id: 1001, stage_id: 10, entered_at: '2026-10-16T14:00:00.000Z', exited_at: '2026-10-19T19:30:00.000Z', days: 3 },
  ]);
  assert.deepEqual(plan.openIntervals, [
    { job_id: 1001, pipeline_id: 7, stage_id: 20, entered_at: '2026-10-19T19:30:00.000Z' },
  ]);
});

test('bounce: detail flags the out-and-back, from and to are the same stage', () => {
  const plan = run('bounce');
  assert.deepEqual(plan.events[0].detail, { bounce: true });
  assert.equal(plan.events[0].from_stage_id, 20);
  assert.equal(plan.events[0].to_stage_id, 20);
});

test('completed: interval closed and event at completed_at', () => {
  const plan = run('completed');
  assert.equal(plan.closeIntervals[0].exited_at, '2026-10-21T16:00:00.000Z');
  assert.equal(plan.events[0].at, '2026-10-21T16:00:00.000Z');
});

test('archived: interval closed and event at captured_at', () => {
  const plan = run('archived');
  assert.equal(plan.closeIntervals[0].exited_at, '2026-10-22T15:00:00.000Z');
  assert.equal(plan.events[0].at, '2026-10-22T15:00:00.000Z');
});

test('reopened (no interval open): one open at moved_at, event at status_changed_at', () => {
  const plan = run('reopened');
  assert.deepEqual(plan.openIntervals, [
    { job_id: 1001, pipeline_id: 7, stage_id: 20, entered_at: '2026-10-21T14:00:00.000Z' },
  ]);
  assert.equal(plan.events[0].at, '2026-10-21T14:00:00.000Z');
});

test('reopened with the interval still open: the open is skipped, the event kept', () => {
  const plan = run('reopened_with_open_interval');
  assert.equal(plan.openIntervals.length, 0);
  assert.equal(plan.closeIntervals.length, 0);
  assert.equal(plan.events[0].event_type, 'reopened');
});

test('status_changed: exactly one event, no interval churn, detail carries the status ids', () => {
  const plan = run('status_changed');
  assert.equal(plan.events.length, 1);
  assert.equal(plan.openIntervals.length, 0);
  assert.equal(plan.closeIntervals.length, 0);
  assert.deepEqual(plan.events[0].detail, { from_status_id: 1, to_status_id: 5 });
});

test('moved and completed in one run: completed closes the interval the pass just opened', () => {
  const plan = run('moved_and_completed');
  assert.deepEqual(plan.closeIntervals, [
    { id: 508, job_id: 1001, stage_id: 10, entered_at: '2026-10-15T14:00:00.000Z', exited_at: '2026-10-21T15:00:00.000Z', days: 6 },
    { id: null, job_id: 1001, stage_id: 20, entered_at: '2026-10-21T15:00:00.000Z', exited_at: '2026-10-22T14:30:00.000Z', days: 1 },
  ]);
  assert.equal(plan.openIntervals.length, 1); // opened by the move, closed by completed
});

test('absent job on an api walk: assumed_deleted archived event at runAt; csv run: nothing', () => {
  const api = run('absent_full_walk');
  assert.equal(api.events.length, 1);
  assert.equal(api.events[0].job_id, 1002);
  assert.equal(api.events[0].at, '2026-10-22T15:00:00.000Z');
  assert.deepEqual(api.events[0].detail, { assumed_deleted: true });
  assert.equal(api.counts.assumed_deleted, 1);
  const csv = run('absent_csv');
  assert.equal(csv.events.length, 0);
  assert.equal(csv.closeIntervals.length, 0);
  assert.equal(csv.openIntervals.length, 0);
});

test('unknown stage order counts as moved, not moved_back', () => {
  const plan = run('moved_unknown_order');
  assert.equal(plan.events[0].event_type, 'moved');
  assert.deepEqual(plan.events[0].from_stage_id, 20);
  assert.deepEqual(plan.events[0].to_stage_id, 40);
});
