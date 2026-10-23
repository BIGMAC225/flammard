// Tests for src/lib/fulfillment-rules.ts (fulfillment step 9: the rules
// runner's pure core — thresholds, per-job evaluation, data health, alert
// reconciliation and digest building, driven by
// tests/fixtures/fulfillment/rules-scenarios.json).
//   node --test tests/fulfillment-rules.test.mjs
// Needs Node 22.18+ / 24 (runs the .ts module directly via type stripping).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  buildDigests,
  effectiveThresholds,
  evaluateDataHealth,
  evaluateJob,
  reconcileAlerts,
  snoozeAlert,
  unsnoozeAlert,
} from '../src/lib/fulfillment-rules.ts';

const scenarios = JSON.parse(
  readFileSync(new URL('./fixtures/fulfillment/rules-scenarios.json', import.meta.url), 'utf8')
);

const TODAY = '2026-10-22';
const NOW = new Date('2026-10-22T13:00:00Z');

test('the module exports snoozeAlert and unsnoozeAlert as functions', () => {
  assert.equal(typeof snoozeAlert, 'function');
  assert.equal(typeof unsnoozeAlert, 'function');
});

test('effectiveThresholds: limit wins, rule used without one, critical never at or below stuck', () => {
  // critical = max(critical_days ?? stuck + 3, stuck + 1). The brief's test
  // list says critical 13 for the first case, but the specified formula gives
  // max(10, 11) = 11 — flagged in the work item's summary.
  assert.deepEqual(
    effectiveThresholds({ stage_limit_days: 10, stuck_days: 5, critical_days: 10 }),
    { stuck: 10, critical: 11 }
  );
  assert.deepEqual(
    effectiveThresholds({ stage_limit_days: null, stuck_days: 5, critical_days: 10 }),
    { stuck: 5, critical: 10 }
  );
  assert.deepEqual(
    effectiveThresholds({ stage_limit_days: 12, stuck_days: 5, critical_days: 10 }),
    { stuck: 12, critical: 13 }
  );
  assert.deepEqual(
    effectiveThresholds({ stage_limit_days: null, stuck_days: null, critical_days: null }),
    { stuck: 7, critical: 10 }
  );
});

for (const [name, scenario] of Object.entries(scenarios.evaluateJob)) {
  test(`evaluateJob ${name}`, () => {
    assert.deepEqual(evaluateJob(scenario.row, TODAY), scenario.expect);
  });
}

test('evaluateJob at_critical_is_critical_only has no stuck alert alongside', () => {
  const alerts = evaluateJob(scenarios.evaluateJob.at_critical_is_critical_only.row, TODAY);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].alert_type, 'critical');
});

test('evaluateDataHealth: no ok run today -> no_snapshot', () => {
  assert.deepEqual(
    evaluateDataHealth({ today: TODAY, yesterday: '2026-10-21', todayOk: null, yesterdayOk: null, latestRun: null }),
    [{ job_id: null, alert_type: 'no_snapshot', level: 'critical', detail: { today: TODAY } }]
  );
});

test('evaluateDataHealth: 70 rows today vs 100 yesterday -> row_count_drop; 85 vs 100 -> none', () => {
  const input = (todayJobs) => ({
    today: TODAY,
    yesterday: '2026-10-21',
    todayOk: { snapshot_date: TODAY, jobs_written: todayJobs, detail: null },
    yesterdayOk: { snapshot_date: '2026-10-21', jobs_written: 100, detail: null },
    latestRun: null,
  });
  assert.deepEqual(evaluateDataHealth(input(70)), [
    { job_id: null, alert_type: 'row_count_drop', level: 'critical', detail: { today_jobs_written: 70, yesterday_jobs_written: 100 } },
  ]);
  assert.deepEqual(evaluateDataHealth(input(85)), []);
});

test('evaluateDataHealth: unknown stage ids in the latest run -> unknown_stage; empty detail -> none', () => {
  const todayOk = { snapshot_date: TODAY, jobs_written: 90, detail: null };
  const yesterdayOk = { snapshot_date: '2026-10-21', jobs_written: 100, detail: null };
  const latestRun = (detail) => ({ snapshot_date: TODAY, jobs_written: 90, detail });
  assert.deepEqual(
    evaluateDataHealth({ today: TODAY, yesterday: '2026-10-21', todayOk, yesterdayOk, latestRun: latestRun({ unknown_stage_ids: [55] }) }),
    [{ job_id: null, alert_type: 'unknown_stage', level: 'critical', detail: { unknown_stage_ids: [55], unknown_stages: [] } }]
  );
  assert.deepEqual(
    evaluateDataHealth({ today: TODAY, yesterday: '2026-10-21', todayOk, yesterdayOk, latestRun: latestRun({}) }),
    []
  );
});

for (const [name, scenario] of Object.entries(scenarios.reconcile)) {
  test(`reconcileAlerts ${name}`, () => {
    const plan = reconcileAlerts(scenario.desired, scenario.existing, NOW, TODAY);
    assert.deepEqual(plan.open, scenario.expect.open);
    assert.deepEqual(plan.resolve, scenario.expect.resolve);
    assert.deepEqual(plan.relevel, scenario.expect.relevel);
    assert.deepEqual(plan.unsnooze, scenario.expect.unsnooze);
  });
}

test('buildDigests: sections, snooze exclusion, unassigned, leadership, summary, no empty digests', () => {
  const summary = { stuck_count: 3, critical_count: 2, wip_in_review: 1, oldest_in_review_days: 9 };
  const people = new Map([
    ['Employee:12', { display_name: 'Dana Prep', email: 'dana@acmetest.example' }],
    ['Employee:14', { display_name: 'Sam Review', email: 'sam@acmetest.example' }],
    ['Employee:99', { display_name: 'Nobody Person', email: 'nobody@acmetest.example' }],
  ]);
  const alert = (over = {}) => ({
    id: 0,
    job_id: 2001,
    job_name: 'Acme Test 1040',
    account_name: 'Acme Test LLC',
    pipeline_title: 'Tax Prep 2026',
    stage_title: 'Preparation',
    alert_type: 'stuck',
    level: 'stuck',
    status: 'open',
    opened_at: '2026-10-22T13:00:00Z',
    last_notified_at: null,
    snoozed_until: null,
    days_in_stage: 8,
    days_over: 3,
    due_date: null,
    ball_with: 'firm',
    assignee_actors: ['Employee:12'],
    ...over,
  });
  const alerts = [
    alert({ id: 1, job_id: 2001 }), // opened today -> newly_stuck for Dana
    alert({ id: 2, job_id: 2002, job_name: 'Beta Test LLC 1120S', account_name: 'Beta Test LLC', opened_at: '2026-10-15T13:00:00Z', assignee_actors: ['Employee:14'] }),
    alert({ id: 3, job_id: 2003, job_name: 'Gamma Test LLC 1065', account_name: 'Gamma Test LLC', alert_type: 'critical', level: 'critical', assignee_actors: [] }),
    alert({ id: 4, job_id: 2004, ball_with: 'client', status: 'snoozed', snoozed_until: '2026-10-25', assignee_actors: ['Employee:12'] }),
    {
      id: 5,
      job_id: null,
      job_name: null,
      account_name: null,
      pipeline_title: null,
      stage_title: null,
      alert_type: 'no_snapshot',
      level: 'critical',
      status: 'open',
      opened_at: '2026-10-22T13:00:00Z',
      last_notified_at: null,
      snoozed_until: null,
      days_in_stage: null,
      days_over: null,
      due_date: null,
      ball_with: null,
      assignee_actors: [],
    },
  ];
  const digests = buildDigests({ today: TODAY, alerts, people, summary });

  // one digest per actor with a section, plus unassigned and leadership; the person with nothing gets none
  assert.deepEqual(
    digests.map((d) => d.to).sort(),
    ['Employee:12', 'Employee:14', 'leadership', 'unassigned']
  );

  const dana = digests.find((d) => d.to === 'Employee:12');
  assert.deepEqual(dana.newly_stuck.map((a) => a.id), [1]);
  assert.deepEqual(dana.still_stuck, []);
  assert.deepEqual(dana.critical, []);
  assert.deepEqual(dana.client_chases, []); // the snoozed client alert is excluded
  assert.deepEqual(dana.data_health, []);

  const sam = digests.find((d) => d.to === 'Employee:14');
  assert.deepEqual(sam.newly_stuck, []);
  assert.deepEqual(sam.still_stuck.map((a) => a.id), [2]);

  const unassigned = digests.find((d) => d.to === 'unassigned');
  assert.deepEqual(unassigned.critical.map((a) => a.id), [3]);
  assert.deepEqual(unassigned.newly_stuck, []);
  assert.deepEqual(unassigned.display_name, null);

  const leadership = digests.find((d) => d.to === 'leadership');
  assert.deepEqual(leadership.data_health.map((a) => a.id), [5]);
  assert.deepEqual(leadership.critical, []);
  assert.deepEqual(leadership.newly_stuck, []);
  assert.deepEqual(leadership.still_stuck, []);
  assert.deepEqual(leadership.client_chases, []);

  // every digest carries the summary numbers (snoozed alerts still count there)
  for (const digest of digests) assert.deepEqual(digest.summary, summary);

  // the digest names come from td_people
  assert.equal(dana.display_name, 'Dana Prep');
  assert.equal(dana.email, 'dana@acmetest.example');
});
