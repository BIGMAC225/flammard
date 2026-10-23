// Tests for src/lib/fulfillment-views.ts (fulfillment step 11: the data
// layer for the eight fulfillment dashboard views, plan section I V1 to V8),
// driven by tests/fixtures/fulfillment/views-fixture.json.
//   node --test tests/fulfillment-views.test.mjs
// Needs Node 22.18+ / 24 (runs the .ts module directly via type stripping).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  agingPoints,
  axisStride,
  board,
  cumulativeFlow,
  cycleStats,
  daysBetween,
  displayName,
  enrich,
  eventsFromLatestSnapshots,
  loadCompletionDates,
  loadCumulativeFlow,
  loadCycleRows,
  loadJobDetail,
  loadPeople,
  loadPipelineJobCounts,
  loadPipelines,
  loadStageDwell,
  loadStages,
  loadViewRows,
  loadWeeklyEvents,
  overview,
  overviewTotals,
  personWorkload,
  pipelineLabel,
  ragFor,
  stageDwell,
  stuckList,
  truncateLabel,
  visiblePipelines,
  waitingOnClient,
  weeklyFlow,
} from '../src/lib/fulfillment-views.ts';

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/fulfillment/views-fixture.json', import.meta.url), 'utf8')
);

const TODAY = fixture.today;
const enriched = enrich(fixture.rows);
const job = (id) => enriched.find((row) => String(row.job_id) === String(id));
const pipelineStages = (id) => fixture.stages.filter((s) => String(s.pipeline_id) === String(id));

test('the module exports every loader as a function', () => {
  for (const fn of [
    loadViewRows,
    loadPipelines,
    loadStages,
    loadPeople,
    loadPipelineJobCounts,
    loadWeeklyEvents,
    loadCompletionDates,
    loadCumulativeFlow,
    loadCycleRows,
    loadStageDwell,
    loadJobDetail,
  ]) {
    assert.equal(typeof fn, 'function');
  }
});

// A db stub that records every query's SQL text; the loaders take a Db
// argument, so their hidden-pipeline filtering is testable without Postgres.
const stubDb = (calls) => ({ query: async (text, params) => { calls.push({ text, params }); return []; } });

test('visiblePipelines drops hidden pipelines and keeps order', () => {
  const list = [
    { id: 3, title: 'DO NOT USE', hidden: true },
    { id: 1, title: 'Tax Prep 2026', hidden: false },
    { id: 2, title: 'Advisory 2026', hidden: false },
  ];
  assert.deepEqual(visiblePipelines(list), [
    { id: 1, title: 'Tax Prep 2026', hidden: false },
    { id: 2, title: 'Advisory 2026', hidden: false },
  ]);
  assert.deepEqual(visiblePipelines([]), []);
});

test('pipelineLabel: title with the active count, bare title when the count is unknown', () => {
  const counts = new Map([
    ['312', 42],
    ['7', 0],
  ]);
  assert.equal(pipelineLabel({ id: 312, title: 'Tax Preparation', hidden: false }, counts), 'Tax Preparation (42)');
  assert.equal(pipelineLabel({ id: 7, title: 'Empty', hidden: true }, counts), 'Empty (0)');
  assert.equal(pipelineLabel({ id: 9, title: 'No snapshots', hidden: false }, counts), 'No snapshots');
  // ids compare as strings (the bigint driver may return them as strings)
  assert.equal(pipelineLabel({ id: '312', title: 'Tax Preparation', hidden: false }, counts), 'Tax Preparation (42)');
});

test('loadPipelineJobCounts: one grouped query over latest snapshots, keyed by String(pipeline_id)', async () => {
  const calls = [];
  const db = { query: async (text, params) => { calls.push({ text, params }); return [{ pipeline_id: 312, n: 42 }, { pipeline_id: '7', n: 0 }]; } };
  const counts = await loadPipelineJobCounts(db);
  assert.match(calls[0].text, /group by l\.pipeline_id/);
  assert.match(calls[0].text, /filter \(where st\.kind = 'active'\)/);
  assert.equal(counts.get('312'), 42);
  assert.equal(counts.get('7'), 0);
  assert.equal(counts.size, 2);
});

test('loadViewRows excludes hidden pipelines by default; includeHidden does not', async () => {
  const calls = [];
  await loadViewRows(stubDb(calls));
  await loadViewRows(stubDb(calls), { includeHidden: true });
  assert.match(calls[0].text, /not p\.hidden/);
  assert.doesNotMatch(calls[1].text, /not p\.hidden/);
});

test('loadJobDetail may still show a hidden pipeline\'s job (direct link)', async () => {
  const calls = [];
  await loadJobDetail(stubDb(calls), 101);
  assert.doesNotMatch(calls[0].text, /not p\.hidden/);
});

test('the cross-pipeline loaders exclude hidden pipelines in their SQL', async () => {
  const calls = [];
  const db = stubDb(calls);
  await loadWeeklyEvents(db, '2026-07-22');
  await loadCumulativeFlow(db, '2026-07-24');
  await loadCompletionDates(db);
  await loadCycleRows(db);
  await loadStageDwell(db);
  for (const call of calls) assert.match(call.text, /not p\.hidden/);
});

test('enrich computes stuck, critical, days_over, rag, past_internal_deadline, days_to_due', () => {
  // green unmapped job: thresholds 7 / 10
  assert.deepEqual(
    {
      stuck: job(101).stuck,
      critical: job(101).critical,
      days_over: job(101).days_over,
      rag: job(101).rag,
      past_internal_deadline: job(101).past_internal_deadline,
      days_to_due: job(101).days_to_due,
    },
    { stuck: 7, critical: 10, days_over: -5, rag: 'green', past_internal_deadline: false, days_to_due: null }
  );
  assert.equal(job(102).rag, 'amber');
  assert.equal(job(102).days_over, 1);
  // the stage limit wins over the unmapped rule: stuck 3, critical 10 (9 days is amber, not red)
  assert.deepEqual(
    { stuck: job(103).stuck, critical: job(103).critical, days_over: job(103).days_over, rag: job(103).rag },
    { stuck: 3, critical: 10, days_over: 6, rag: 'amber' }
  );
  assert.equal(job(103).past_internal_deadline, true);
  // mapped review rule: 5 / 10
  assert.deepEqual(
    { stuck: job(104).stuck, critical: job(104).critical, days_over: job(104).days_over, rag: job(104).rag },
    { stuck: 5, critical: 10, days_over: 7, rag: 'red' }
  );
  // green job due in 5 days
  assert.equal(job(105).days_to_due, 5);
  assert.equal(job(105).rag, 'green');
  // red and past deadline, and a green job that is only past its internal deadline
  assert.equal(job(107).rag, 'red');
  assert.equal(job(107).days_over, 8);
  assert.equal(job(107).past_internal_deadline, true);
  assert.equal(job(108).rag, 'green');
  assert.equal(job(108).past_internal_deadline, true);
  // mapped documents rule on the client stage: 14 / 30
  assert.deepEqual(
    { stuck: job(201).stuck, critical: job(201).critical, rag: job(201).rag, days_over: job(201).days_over },
    { stuck: 14, critical: 30, rag: 'green', days_over: -8 }
  );
  // enrich keeps every ViewRow field
  assert.equal(job(101).job_name, 'Acme 1040');
  assert.equal(job(101).account_name, 'Acme LLC');
  assert.equal(job(101).ball_with, 'firm');
});

test('ragFor boundaries: days equal to stuck is amber, equal to critical is red', () => {
  assert.equal(ragFor(2, 3, 10), 'green');
  assert.equal(ragFor(3, 3, 10), 'amber');
  assert.equal(ragFor(9, 3, 10), 'amber');
  assert.equal(ragFor(10, 3, 10), 'red');
  assert.equal(ragFor(11, 7, 10), 'red');
});

test('overview counts per pipeline (sorted by title) and overviewTotals sums them', () => {
  assert.deepEqual(overview(enriched), [
    { pipeline_id: 2, title: 'Advisory 2026', wip: 2, stuck: 1, critical: 0, wip_in_review: 0, oldest_days: 7 },
    { pipeline_id: 1, title: 'Tax Prep 2026', wip: 10, stuck: 6, critical: 2, wip_in_review: 2, oldest_days: 15 },
  ]);
  assert.deepEqual(overviewTotals(overview(enriched)), {
    wip: 12,
    stuck: 7,
    critical: 2,
    wip_in_review: 2,
    oldest_days: 15,
  });
});

test('board: column order follows stage_order, not insertion or title order', () => {
  // the fixture lists pipeline 1's stages as Review(3), Intake(1), Delivery(4), Preparation(2)
  const columns = board(pipelineStages(1), enriched);
  assert.deepEqual(
    columns.map((c) => c.stage.title),
    ['Intake', 'Preparation', 'Review', 'Delivery']
  );
});

test('board: counts, oldest, card order and client shading', () => {
  const columns = board(fixture.stages, enriched);
  // stage_order ascending across both pipelines, ties by title: Intake(1), Monthly Close(1), Client Documents(2), Preparation(2), Onboarding(3), Review(3), Delivery(4)
  assert.deepEqual(
    columns.map((c) => c.stage.title),
    ['Intake', 'Monthly Close', 'Client Documents', 'Preparation', 'Onboarding', 'Review', 'Delivery']
  );
  const intake = columns.find((c) => c.stage.id === 11);
  assert.equal(intake.count, 4);
  assert.equal(intake.oldest, 15);
  assert.equal(intake.client_typed, false);
  assert.deepEqual(
    intake.cards.map((card) => card.job_id),
    [107, 102, 108, 101]
  );
  const clientDocs = columns.find((c) => c.stage.id === 22);
  assert.equal(clientDocs.client_typed, true);
  assert.equal(clientDocs.count, 1);
  const monthlyClose = columns.find((c) => c.stage.id === 21);
  assert.equal(monthlyClose.client_typed, false);
});

test('board: a stage with no rows is present as an empty column', () => {
  const onboarding = board(fixture.stages, enriched).find((c) => c.stage.id === 23);
  assert.deepEqual(onboarding, { stage: fixture.stages.find((s) => s.id === 23), count: 0, oldest: 0, client_typed: false, cards: [] });
});

test('stuckList: membership and ordering (red, then past deadline, then amber, by days_over desc)', () => {
  assert.deepEqual(
    stuckList(enriched).map((row) => row.job_id),
    [107, 104, 103, 108, 102, 109, 110, 202]
  );
  // 105 and 106 (green, no deadline trouble) and 101 and 201 are left out
  assert.equal(stuckList(enriched).length, 8);
});

test('waitingOnClient: ball_with client rows, days_in_stage descending', () => {
  assert.deepEqual(
    waitingOnClient(enriched).map((row) => row.job_id),
    [201]
  );
});

test('personWorkload: two-assignee job counted for both, unassigned bucket, name fallbacks, ordering', () => {
  assert.deepEqual(personWorkload(enriched, fixture.people), [
    { person: 'Employee:12', name: 'Dana Prep', active_jobs: 6, firm_jobs: 6, client_jobs: 0, stuck: 5, critical: 1, past_internal_deadline: 2 },
    { person: 'Employee:14', name: 'Sam Reviewer', active_jobs: 5, firm_jobs: 4, client_jobs: 1, stuck: 2, critical: 1, past_internal_deadline: 2 },
    { person: 'Owner:3', name: 'Owner:3', active_jobs: 1, firm_jobs: 1, client_jobs: 0, stuck: 1, critical: 0, past_internal_deadline: 0 },
    { person: 'unassigned', name: 'unassigned', active_jobs: 1, firm_jobs: 1, client_jobs: 0, stuck: 0, critical: 0, past_internal_deadline: 0 },
  ]);
});

test('displayName: display_name, then first and last, then the actor string; ids compare as strings', () => {
  assert.equal(displayName('Employee:12', fixture.people), 'Dana Prep');
  assert.equal(displayName('Employee:14', fixture.people), 'Sam Reviewer');
  assert.equal(displayName('Owner:3', fixture.people), 'Owner:3');
  assert.equal(displayName('unassigned', fixture.people), 'unassigned');
  assert.equal(displayName('Employee:12', []), 'Employee:12');
  // a driver that returned the bigint id as a string still matches
  const stringIds = [{ actor_type: 'Employee', id: '12', display_name: null, first_name: 'Dana', last_name: 'Prep' }];
  assert.equal(displayName('Employee:12', stringIds), 'Dana Prep');
});

test('agingPoints: thresholds per stage, fallback for empty stages, points carry rag', () => {
  const series = agingPoints(enriched, fixture.stages);
  assert.deepEqual(
    series.map((s) => [s.stage_title, s.stuck, s.critical]),
    [
      ['Intake', 7, 10],
      ['Monthly Close', 7, 10],
      ['Client Documents', 14, 30],
      ['Preparation', 3, 10],
      ['Onboarding', 7, 10],
      ['Review', 5, 10],
      ['Delivery', 3, 7],
    ]
  );
  assert.deepEqual(
    series.find((s) => s.stage_id === 11).points,
    [
      { job_id: 101, job_name: 'Acme 1040', days_in_stage: 2, rag: 'green' },
      { job_id: 102, job_name: 'Beta 1120S', days_in_stage: 8, rag: 'amber' },
      { job_id: 107, job_name: 'Eta 1040', days_in_stage: 15, rag: 'red' },
      { job_id: 108, job_name: 'Theta 990', days_in_stage: 3, rag: 'green' },
    ]
  );
  assert.deepEqual(series.find((s) => s.stage_id === 23).points, []);
});

test('weeklyFlow: 13 Monday weeks ending in today\'s week, zero weeks, counts, moved ignored', () => {
  const rows = weeklyFlow(fixture.events, TODAY);
  assert.equal(rows.length, 13);
  assert.equal(rows[0].week_start, '2026-07-27');
  assert.equal(rows[12].week_start, '2026-10-19');
  const week = (start) => rows.find((r) => r.week_start === start);
  assert.deepEqual(week('2026-08-10'), { week_start: '2026-08-10', arrivals: 1, completions: 2 });
  // the Saturday and Sunday events land in the week starting Monday 10-12
  assert.deepEqual(week('2026-10-12'), { week_start: '2026-10-12', arrivals: 2, completions: 0 });
  assert.deepEqual(week('2026-10-19'), { week_start: '2026-10-19', arrivals: 1, completions: 1 });
  assert.deepEqual(week('2026-08-03'), { week_start: '2026-08-03', arrivals: 0, completions: 0 });
  // 'moved' and events outside the 13-week window (May) are ignored
  assert.equal(rows.reduce((n, r) => n + r.arrivals, 0), 5);
  assert.equal(rows.reduce((n, r) => n + r.completions, 0), 3);
});

test('weeklyFlow: the weeks parameter shrinks the window', () => {
  const rows = weeklyFlow(fixture.events, TODAY, 8);
  assert.equal(rows.length, 8);
  assert.equal(rows[0].week_start, '2026-08-31');
  assert.equal(rows[7].week_start, '2026-10-19');
  assert.equal(rows.reduce((n, r) => n + r.arrivals, 0), 3);
  assert.equal(rows.reduce((n, r) => n + r.completions, 0), 1);
});

test('eventsFromLatestSnapshots: a job completed 5 weeks ago lands in that week\'s completions', () => {
  const rows = [
    // arrived and completed the week of 2026-09-14, five weeks before TODAY's week (2026-10-19)
    { job_id: 901, created_at: '2026-09-15T14:00:00Z', intake_date: null, start_date: null, completed_at: '2026-09-17T20:00:00Z' },
    // created_at missing (row captured before the column existed): arrival falls back to intake_date, week of 2026-10-05
    { job_id: 902, created_at: null, intake_date: '2026-10-07', start_date: '2026-10-09', completed_at: null },
    // arrived and completed before sinceDate: neither event
    { job_id: 903, created_at: '2026-05-01T09:00:00Z', intake_date: null, start_date: null, completed_at: '2026-06-01T09:00:00Z' },
  ];
  const weeks = weeklyFlow(eventsFromLatestSnapshots(rows, '2026-07-22'), TODAY, 13);
  const week = (start) => weeks.find((r) => r.week_start === start);
  assert.deepEqual(week('2026-09-14'), { week_start: '2026-09-14', arrivals: 1, completions: 1 });
  assert.deepEqual(week('2026-10-05'), { week_start: '2026-10-05', arrivals: 1, completions: 0 });
  assert.equal(weeks.reduce((n, r) => n + r.arrivals, 0), 2);
  assert.equal(weeks.reduce((n, r) => n + r.completions, 0), 1);
});

test('eventsFromLatestSnapshots: each job_id counts once given duplicates; start_date is the last arrival fallback', () => {
  // two snapshots of job 904: the first row per job wins, so the arrival comes
  // from start_date (created_at and intake_date are null there)
  const events = eventsFromLatestSnapshots([
    { job_id: 904, created_at: null, intake_date: null, start_date: '2026-10-20', completed_at: '2026-10-21T12:00:00Z' },
    { job_id: 904, created_at: '2026-10-19T08:00:00Z', intake_date: null, start_date: null, completed_at: '2026-10-21T12:00:00Z' },
  ], '2026-07-22');
  assert.deepEqual(events, [
    { event_type: 'completed', at: '2026-10-21T12:00:00Z' },
    { event_type: 'new', at: '2026-10-20' },
  ]);
  // a job with no dates at all produces nothing
  assert.deepEqual(
    eventsFromLatestSnapshots([{ job_id: 905, created_at: null, intake_date: null, start_date: null, completed_at: null }], '2026-07-22'),
    []
  );
});

test('cumulativeFlow with completions: the Completed series is cumulative and non-decreasing', () => {
  const rows = [
    { snapshot_date: '2026-10-20', stage_title: 'Intake', stage_order: 1, n: 5 },
    { snapshot_date: '2026-10-21', stage_title: 'Intake', stage_order: 1, n: 4 },
    { snapshot_date: '2026-10-22', stage_title: 'Intake', stage_order: 1, n: 6 },
  ];
  const completions = [
    { completed_at: '2026-09-01 15:00:00+00' }, // before the window: still counted
    { completed_at: '2026-10-20 15:00:00+00' },
    { completed_at: '2026-10-20 16:00:00+00' },
    { completed_at: '2026-10-22 15:00:00+00' },
    { completed_at: null },
  ];
  const cfd = cumulativeFlow(rows, completions);
  assert.deepEqual(cfd.stages, ['Intake', 'Completed']);
  assert.deepEqual(cfd.series.Intake, [5, 4, 6]);
  assert.deepEqual(cfd.series.Completed, [3, 3, 4]);
  for (let i = 1; i < cfd.series.Completed.length; i++) {
    assert.ok(cfd.series.Completed[i] >= cfd.series.Completed[i - 1], 'Completed is non-decreasing');
  }
});

test('cumulativeFlow: ascending dates, stages by stage_order then title, zeros filled', () => {
  assert.deepEqual(cumulativeFlow(fixture.cfd), {
    dates: ['2026-10-20', '2026-10-21', '2026-10-22'],
    stages: ['Intake', 'Preparation', 'Review', 'Delivery'],
    series: {
      Intake: [5, 0, 6],
      Preparation: [4, 3, 0],
      Review: [0, 2, 0],
      Delivery: [0, 0, 1],
    },
  });
});

test('cycleStats: nearest-rank median and p85, 7-day histogram buckets', () => {
  assert.deepEqual(cycleStats([...fixture.cycle_days].reverse()), {
    count: 9,
    median: 14,
    p85: 30,
    histogram: [
      { from: 0, to: 6, n: 1 },
      { from: 7, to: 13, n: 3 },
      { from: 14, to: 20, n: 2 },
      { from: 21, to: 27, n: 1 },
      { from: 28, to: 34, n: 1 },
      { from: 35, to: 41, n: 0 },
      { from: 42, to: 48, n: 1 },
    ],
  });
});

test('cycleStats: empty input', () => {
  assert.deepEqual(cycleStats([]), { count: 0, median: null, p85: null, histogram: [] });
});

test('axisStride: every bucket to 12, every other to 24, every Nth beyond; label count stays capped', () => {
  assert.equal(axisStride(0), 1);
  assert.equal(axisStride(7), 1);
  assert.equal(axisStride(12), 1);
  assert.equal(axisStride(13), 2);
  assert.equal(axisStride(24), 2);
  assert.equal(axisStride(25), 3);
  assert.equal(axisStride(30), 3);
  assert.equal(axisStride(40), 4);
  for (let buckets = 1; buckets <= 60; buckets++) {
    assert.ok(Math.ceil(buckets / axisStride(buckets)) <= 12, `${buckets} buckets keep at most 12 labels`);
  }
});

test('truncateLabel: short text unchanged, long text cut to maxChars with an ellipsis', () => {
  assert.equal(truncateLabel('Intake', 10), 'Intake');
  assert.equal(truncateLabel('abcdefghij', 10), 'abcdefghij');
  assert.equal(truncateLabel('abcdefghijk', 10), 'abcdefghi…');
  assert.equal(truncateLabel('Client Documents', 10), 'Client Do…');
  assert.equal(truncateLabel('Onboarding & KYC', 8), 'Onboard…');
});

test('stageDwell: sorted by stage_order nulls last, then title', () => {
  assert.deepEqual(
    stageDwell(fixture.stageDwell).map((row) => row.stage_title),
    ['Intake', 'Preparation', 'Delivery', 'Legacy']
  );
});

test('daysBetween: whole days between YYYY-MM-DD strings, negative backwards', () => {
  assert.equal(daysBetween('2026-10-22', '2026-10-27'), 5);
  assert.equal(daysBetween('2026-10-27', '2026-10-22'), -5);
  assert.equal(daysBetween('2026-01-01', '2026-12-31'), 364);
});

test('every pure function tolerates empty input without throwing', () => {
  assert.deepEqual(enrich([]), []);
  assert.deepEqual(overview([]), []);
  assert.deepEqual(overviewTotals([]), { wip: 0, stuck: 0, critical: 0, wip_in_review: 0, oldest_days: 0 });
  assert.deepEqual(board([], []), []);
  assert.deepEqual(stuckList([]), []);
  assert.deepEqual(waitingOnClient([]), []);
  assert.deepEqual(personWorkload([], fixture.people), []);
  assert.deepEqual(agingPoints([], []), []);
  assert.deepEqual(cumulativeFlow([]), { dates: [], stages: [], series: {} });
  assert.deepEqual(stageDwell([]), []);
  const weeks = weeklyFlow([], TODAY);
  assert.equal(weeks.length, 13);
  assert.ok(weeks.every((w) => w.arrivals === 0 && w.completions === 0));
});
