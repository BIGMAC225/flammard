// Tests for src/lib/fulfillment-settings.ts (the fulfillment settings page's
// pure core: stage-title classifier, posted-form parser, page-model shaper)
// plus the threshold semantics it seeds: government stages are client-side,
// never firm-owned.   node --test tests/fulfillment-settings.test.mjs
// Needs Node 22.18+ / 24 (runs the .ts module directly via type stripping).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { classifyStage, parseSettingsForm, shapeSettings } from '../src/lib/fulfillment-settings.ts';
import { personWorkload, waitingOnClient } from '../src/lib/fulfillment-views.ts';

// The 2026-10-23 stages export the draft stage_type_map was seeded from; the
// tests that need it skip themselves when the file is not on this machine.
const EXPORT_PATH =
  'C:/Users/RussellHeath/OneDrive - J. Heath & Co., LLC/Documents/Documents/Projects/fulfillment/plans/stages-export-2026-10-23.json';
const MIGRATION_PATH = new URL('../db/upgrades/2026-10-24-fulfillment-settings.sql', import.meta.url);
const exportRows = existsSync(EXPORT_PATH) ? JSON.parse(readFileSync(EXPORT_PATH, 'utf8')) : null;

// ── classifyStage ──────────────────────────────────────────────────────────

test('classifyStage on real stage titles from the export', () => {
  assert.deepEqual(classifyStage('Waiting for organizer'), {
    stage_type: 'documents',
    warn_days: 14,
    stuck_days: 30,
    ball_with: 'client',
  });
  // a review stage
  assert.deepEqual(classifyStage('Manager Review'), { stage_type: 'review', warn_days: 5, stuck_days: 10, ball_with: 'firm' });
  // government wait: the agency holds the ball
  assert.deepEqual(classifyStage('Waiting for Government Response'), {
    stage_type: 'government_wait',
    warn_days: 30,
    stuck_days: 60,
    ball_with: 'government',
  });
  // first match wins: "missing info" outranks the "prep" in "Prep post missing info"
  assert.equal(classifyStage('Prep post missing info').stage_type, 'missing_info');
  // "signature" outranks the "review" in the ready-for-signature stage
  assert.equal(classifyStage('Review Updated Return - Is it ready for signature?').stage_type, 'client_review_sign');
  // an unmatched title
  assert.equal(classifyStage('Welcome emails + Proposal/EL'), null);
  assert.equal(classifyStage('Needs extension'), null);
  // case-insensitive
  assert.equal(classifyStage('WAITING FOR ORGANIZER').stage_type, 'documents');
});

test('classifyStage runs over every title in the export without throwing', { skip: !exportRows }, () => {
  const mapped = exportRows.filter((r) => classifyStage(r.stage) != null);
  // 117 of the 195 export stages classify; the rest stay unmapped
  assert.equal(mapped.length, 117);
  assert.equal(exportRows.length, 195);
});

// ── parseSettingsForm ──────────────────────────────────────────────────────

const ALLOWED = [
  'intake', 'documents', 'ready_to_prepare', 'preparation', 'missing_info', 'review',
  'client_review_sign', 'filing', 'delivery', 'government_wait', 'on_hold', 'unmapped',
];

function validForm() {
  const form = new FormData();
  form.append('pipeline', '101');
  form.append('pipeline', '202');
  form.append('hide', '202'); // 101 visible, 202 hidden
  form.append('stage', '101:5');
  form.append('type_101_5', 'review');
  form.append('warn_101_5', '4');
  form.append('stuck_101_5', '9');
  form.append('ball_101_5', 'firm');
  form.append('stage', '101:6'); // blank type = unmapped, all blanks
  return form;
}

test('parseSettingsForm accepts a valid form', () => {
  const parsed = parseSettingsForm(validForm(), ALLOWED);
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(parsed.hidden, { '101': false, '202': true });
  assert.deepEqual(parsed.stages, [
    { pipeline_id: '101', stage_id: '5', stage_type: 'review', warn_days: 4, stuck_days: 9, ball_with: 'firm' },
    { pipeline_id: '101', stage_id: '6', stage_type: null, warn_days: null, stuck_days: null, ball_with: null },
  ]);
});

test('parseSettingsForm rejects bad ids', () => {
  const form = new FormData();
  form.append('pipeline', 'not-an-id');
  form.append('stage', '101:five');
  const parsed = parseSettingsForm(form, ALLOWED);
  assert.equal(parsed.errors.length, 2);
  assert.deepEqual(parsed.hidden, {});
  assert.deepEqual(parsed.stages, []);
});

test('parseSettingsForm rejects days of 0 and 400 (outside 1..365)', () => {
  const zero = new FormData();
  zero.append('stage', '1:1');
  zero.append('warn_1_1', '0');
  assert.equal(parseSettingsForm(zero, ALLOWED).errors.length, 1);
  const fourHundred = new FormData();
  fourHundred.append('stage', '1:1');
  fourHundred.append('stuck_1_1', '400');
  assert.equal(parseSettingsForm(fourHundred, ALLOWED).errors.length, 1);
  // a non-number day is rejected too
  const word = new FormData();
  word.append('stage', '1:1');
  word.append('warn_1_1', 'soon');
  assert.equal(parseSettingsForm(word, ALLOWED).errors.length, 1);
});

test('parseSettingsForm rejects warn days after stuck days', () => {
  const form = new FormData();
  form.append('stage', '1:1');
  form.append('warn_1_1', '10');
  form.append('stuck_1_1', '5');
  const parsed = parseSettingsForm(form, ALLOWED);
  assert.equal(parsed.errors.length, 1);
});

test('parseSettingsForm rejects unknown stage types and ball_with values', () => {
  const form = new FormData();
  form.append('stage', '1:1');
  form.append('type_1_1', 'bogus');
  form.append('ball_1_1', 'space');
  const parsed = parseSettingsForm(form, ALLOWED);
  assert.equal(parsed.errors.length, 2);
  assert.equal(parsed.stages[0].stage_type, null);
  assert.equal(parsed.stages[0].ball_with, null);
});

test('parseSettingsForm never throws on junk input', () => {
  assert.deepEqual(parseSettingsForm(null, ALLOWED), { hidden: {}, stages: [], errors: [] });
  assert.equal(parseSettingsForm('nope', ALLOWED).errors.length, 0);
});

// ── shapeSettings ──────────────────────────────────────────────────────────

test('shapeSettings: visible pipelines first then by title, stages by stage_order, map values attached', () => {
  const model = shapeSettings(
    [
      { id: 2, title: 'B hidden', hidden: true },
      { id: 1, title: 'A visible', hidden: false },
      { id: 3, title: 'C default', hidden: null },
    ],
    [
      { id: 12, pipeline_id: 1, title: 'Second', stage_order: 2 },
      { id: 11, pipeline_id: 1, title: 'First', stage_order: 1 },
      { id: 13, pipeline_id: 1, title: 'No order yet', stage_order: null },
      { id: 21, pipeline_id: 2, title: 'Only', stage_order: 0 },
    ],
    // pipeline_id as a string on purpose: ids compare via String()
    [{ pipeline_id: '1', stage_id: 11, stage_type: 'documents', warn_days: 10, stuck_days: 20, ball_with: 'client' }],
    [
      { pipeline_id: 1, n: 4 },
      { pipeline_id: 2, n: 7 },
    ]
  );
  assert.deepEqual(
    model.map((p) => [String(p.id), p.title, p.hidden, p.active_jobs]),
    [
      ['1', 'A visible', false, 4],
      ['3', 'C default', false, 0],
      ['2', 'B hidden', true, 7],
    ]
  );
  assert.deepEqual(
    model[0].stages.map((s) => [s.title, s.stage_type, s.warn_days, s.stuck_days, s.ball_with]),
    [
      ['First', 'documents', 10, 20, 'client'],
      ['Second', null, null, null, null],
      ['No order yet', null, null, null, null],
    ]
  );
  assert.equal(model[2].stages.length, 1);
});

// ── The seeded draft map ───────────────────────────────────────────────────

// one 6-column values row of the migration's stage_type_map seed
const SEED_ROW = /\('((?:[^']|'')*)',\s*'((?:[^']|'')*)',\s*'(\w+)',\s*(\d+),\s*(\d+),\s*'(firm|client|government|none)'\)/g;

test('every seeded VALUES row names a pipeline/stage pair present in the export', { skip: !exportRows }, () => {
  const sql = readFileSync(MIGRATION_PATH, 'utf8');
  const rows = [...sql.matchAll(SEED_ROW)].map((m) => [
    m[1].replace(/''/g, "'"),
    m[2].replace(/''/g, "'"),
    m[3],
    Number(m[4]),
    Number(m[5]),
    m[6],
  ]);
  assert.ok(rows.length >= 100, `expected the draft stage map seed, found ${rows.length} rows`);
  const pairs = new Set(exportRows.map((r) => `${r.pipeline}\u0000${r.stage}`));
  for (const [pipeline, stage, type, warn, stuck, ball] of rows) {
    assert.ok(pairs.has(`${pipeline}\u0000${stage}`), `no such pipeline/stage pair in the export: ${pipeline} / ${stage}`);
    assert.deepEqual(
      classifyStage(stage),
      { stage_type: type, warn_days: warn, stuck_days: stuck, ball_with: ball },
      `the seed for ${pipeline} / ${stage} matches the classifier`
    );
  }
});

// ── government ball_with is client-side, not firm-owned ────────────────────

const GOV_ROWS = [
  { job_id: 1, job_name: 'Gov job', days_in_stage: 20, ball_with: 'government', rag: 'amber', past_internal_deadline: false, assignee_actors: ['Employee:12'] },
  { job_id: 2, job_name: 'Client job', days_in_stage: 8, ball_with: 'client', rag: 'amber', past_internal_deadline: false, assignee_actors: ['Employee:12'] },
  { job_id: 3, job_name: 'Firm job', days_in_stage: 5, ball_with: 'firm', rag: 'green', past_internal_deadline: false, assignee_actors: ['Employee:12'] },
];

test('a government ball_with is not counted as firm-owned (waiting list and workload)', () => {
  // the waiting-on-client list includes government rows, oldest first
  assert.deepEqual(
    waitingOnClient(GOV_ROWS).map((r) => r.job_id),
    [1, 2]
  );
  // the workload buckets government with client, not firm
  const [workload] = personWorkload(GOV_ROWS, []);
  assert.equal(workload.active_jobs, 3);
  assert.equal(workload.firm_jobs, 1);
  assert.equal(workload.client_jobs, 2);
});
