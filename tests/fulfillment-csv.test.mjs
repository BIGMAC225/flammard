// Tests for src/lib/fulfillment-csv.ts (fulfillment step 8: the CSV
// fallback's pure parser, snapshot-date logic, resolver and insert builder)
// and the signing helpers of src/lib/fulfillment-csv-import.ts, driven by the
// synthetic R1 export tests/fixtures/fulfillment/r1-sample.csv.
//   node --test tests/fulfillment-csv.test.mjs
// Needs Node 22.18+ / 24 (runs the .ts modules directly via type stripping).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { zipSync, strToU8 } from 'fflate';
import {
  buildCsvInsert,
  chicagoMidnightIso,
  CsvValidationError,
  findHeaderRow,
  movedAtFromDays,
  parseCsv,
  parseR1,
  resolveRows,
  snapshotDateFromFileName,
  snapshotDateFromPreamble,
  splitCollectedText,
} from '../src/lib/fulfillment-csv.ts';
import {
  csvJobKeys,
  parseCsvJobMeta,
  parseCsvJobRequest,
  signFulfillmentCsvJob,
  verifyFulfillmentCsvJob,
} from '../src/lib/fulfillment-csv-import.ts';
import { signPollJob } from '../src/lib/fulfillment-poll-job.ts';
import { collectReportFiles } from '../src/lib/taxdome-files.ts';
import { firmDate } from '../src/lib/taxdome-date.ts';

const fixtureText = readFileSync(new URL('./fixtures/fulfillment/r1-sample.csv', import.meta.url), 'utf8');

test('parseCsv: quoted commas, doubled quotes, CRLF, BOM; empty trailing line ignored', () => {
  const csv = '﻿"a,b","c""d"\r\n"e",,f\r\n';
  assert.deepEqual(parseCsv(csv), [['a,b', 'c"d'], ['e', '', 'f']]);
  assert.deepEqual(parseCsv('plain\r\nrows\n'), [['plain'], ['rows']]);
});

test('findHeaderRow finds the header at the variable offset in the fixture; a header-less text gives -1', () => {
  assert.equal(findHeaderRow(parseCsv(fixtureText)), 4);
  assert.equal(findHeaderRow(parseCsv('"a","b"\n"1","2"\n')), -1);
});

test('parseR1 throws CsvValidationError naming the missing header row', () => {
  assert.throws(
    () => parseR1('"a","b"\n"1","2"\n'),
    (e) => e instanceof CsvValidationError && /header/i.test(e.message)
  );
});

const parsed = parseR1(fixtureText);

test('parseR1 on the fixture: 6 rows, columns, numbers and dates', () => {
  assert.equal(parsed.rows.length, 6);
  assert.equal(parsed.columns.includes('Job Is Archived'), false, 'Job Is Archived dropped from columns');
  assert.ok(parsed.columns.includes('Job Days In Current Stage'));
  // "1,234" -> 1234
  assert.equal(parsed.rows[1].days_in_stage, 1234);
  // both date formats -> ISO
  assert.equal(parsed.rows[0].intake_date, '2026-09-20');
  assert.equal(parsed.rows[1].intake_date, '2026-09-15');
  assert.equal(parsed.rows[1].due_date, '2026-11-15');
  assert.equal(parsed.rows[2].start_date, null);
  // the double-space pipeline name is preserved
  assert.equal(parsed.rows[0].pipeline, 'Tax Preparation  - No Deposit Requested');
  // a job name with a comma inside quotes survives
  assert.equal(parsed.rows[1].job_name, 'Amended 2023 Return, State + Federal');
  assert.equal(parsed.rows[1].job_assignee, 'Jane Example, John Sample');
  assert.equal(parsed.rows[2].job_assignee, null);
  assert.equal(parsed.rows[5].account_tag, null);
  assert.match(parsed.preamble, /Data extract produced by Test User \(1\) on 10\/22\/2026 23:30 UTC/);
});

test('parseR1 throws on a missing required column, zero data rows and a duplicate Job Id', () => {
  const missingColumn = fixtureText.replace(',"Pipeline Stage","Pipeline Stage Order"', ',"Pipeline Stage Order"');
  assert.throws(() => parseR1(missingColumn), (e) => e instanceof CsvValidationError && /Pipeline Stage/.test(e.message));
  const headerOnly = `${fixtureText.split('\r\n').slice(0, 5).join('\r\n')}\r\n`;
  assert.throws(() => parseR1(headerOnly), (e) => e instanceof CsvValidationError && /no data rows/i.test(e.message));
  const duplicated = `${fixtureText}${fixtureText.split('\r\n')[5]}\r\n`;
  assert.throws(() => parseR1(duplicated), (e) => e instanceof CsvValidationError && /duplicate job id 9001/i.test(e.message));
});

test('snapshot dates: the file-name stamp (UTC -> Chicago day), the zip variant, the preamble', () => {
  assert.equal(snapshotDateFromFileName('Fulfillment Snapshot (2026-10-23 03_15_00).csv'), '2026-10-22');
  assert.equal(snapshotDateFromFileName('Fulfillment Snapshot (2026-10-23 03_15_00).zip'), '2026-10-22');
  assert.equal(snapshotDateFromFileName('snapshot.zip'), null);
  assert.equal(snapshotDateFromPreamble(parsed.preamble), '2026-10-22');
});

test('chicagoMidnightIso knows CDT and CST; movedAtFromDays counts calendar days', () => {
  assert.equal(chicagoMidnightIso('2026-10-22'), '2026-10-22T05:00:00.000Z'); // CDT (UTC-5)
  assert.equal(chicagoMidnightIso('2026-12-15'), '2026-12-15T06:00:00.000Z'); // CST (UTC-6)
  assert.equal(movedAtFromDays('2026-10-22', 3), chicagoMidnightIso('2026-10-19'));
  const isoMinusDays = (ymd, n) => {
    const [y, m, d] = ymd.split('-').map(Number);
    const t = new Date(Date.UTC(y, m - 1, d - n));
    return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
  };
  for (const row of parsed.rows) {
    assert.equal(firmDate(new Date(movedAtFromDays('2026-10-22', row.days_in_stage))), isoMinusDays('2026-10-22', row.days_in_stage));
  }
});

const stageKey = (pipelineId, title) => `${pipelineId}\u0000${title}`;
const lookups = {
  pipelines: new Map([
    ['Tax Preparation  - No Deposit Requested', 7],
    ['Bookkeeping', 8],
  ]),
  stages: new Map([
    [stageKey(7, 'Awaiting Documents'), 301],
    [stageKey(7, 'In Preparation'), 302],
    [stageKey(7, 'Client Review'), 303],
    [stageKey(8, 'Monthly Review'), 304],
  ]),
  activeStatus: new Map([[7, 401], [8, 402]]),
  people: new Map([
    ['Jane Example', { actor_type: 'Employee', id: 12 }],
    ['John Sample', { actor_type: 'Employee', id: 13 }],
    ['Alex Sample', { actor_type: 'Owner', id: 3 }],
  ]),
  clients: new Map([
    ['acme test llc', 501],
    ['beta test llc', 502],
    ['gamma test llc', 503],
    ['delta test llc', 504],
    ['epsilon test llc', 505],
    ['zeta test llc', 506],
  ]),
};

const snapshotDate = '2026-10-22';
const capturedAt = new Date('2026-10-22T15:00:00Z');
const extraRows = [
  { ...parsed.rows[0], job_id: 9999, pipeline: 'Unknown Pipe', pipeline_stage: 'Unknown Stage' },
  { ...parsed.rows[0], job_id: 9996, pipeline: 'Unknown Pipe', pipeline_stage: 'Unknown Stage' },
  { ...parsed.rows[0], job_id: 9998, account_name: 'Nowhere LLC' },
  { ...parsed.rows[0], job_id: 9997, job_assignee: 'Nobody Real' },
];
const resolved = resolveRows([...parsed.rows, ...extraRows], lookups, snapshotDate, 9, capturedAt);

test('resolveRows maps rows to snapshot values (pipeline, stage, status, client, assignees)', () => {
  const first = resolved.rows[0];
  assert.equal(first.job_id, 9001);
  assert.equal(first.pipeline_id, 7);
  assert.equal(first.stage_id, 301);
  assert.equal(first.status_id, 401);
  assert.equal(first.client_id, 501);
  assert.equal(first.source, 'csv');
  assert.equal(first.import_run_id, 9);
  assert.equal(first.captured_at, capturedAt);
  assert.deepEqual(first.assignee_ids, [12]);
  assert.deepEqual(first.assignee_actors, ['Employee:12']);
  assert.equal(first.priority, 'high');
  assert.equal(first.moved_at, movedAtFromDays('2026-10-22', 5));
  assert.equal(first.intake_date, '2026-09-20');
  // two assignees in one quoted cell split on the comma; the other pipeline's status
  assert.deepEqual(resolved.rows[1].assignee_ids.sort((a, b) => a - b), [12, 13]);
  assert.deepEqual(resolved.rows[1].assignee_actors.sort(), ['Employee:12', 'Employee:13']);
  assert.equal(resolved.rows[3].pipeline_id, 8);
  assert.equal(resolved.rows[3].status_id, 402);
  assert.equal(resolved.rows[3].moved_at, chicagoMidnightIso('2026-10-22')); // days 0
  // an empty assignee resolves to none, an unmatched one to none (but is listed)
  assert.deepEqual(resolved.rows[2].assignee_ids, []);
  assert.deepEqual(resolved.rows[6].assignee_ids, []);
  assert.equal(resolved.rows[6].job_id, 9997);
});

test('resolveRows skips unknown stages and clients (deduplicated) and lists unmatched assignees', () => {
  // 6 fixture rows + the unmatched-assignee row are written; the rest are skipped
  assert.equal(resolved.rows.length, 7);
  assert.deepEqual(resolved.unknown_stages, ['Unknown Pipe / Unknown Stage']); // two rows, one entry
  assert.deepEqual(resolved.unknown_clients, ['Nowhere LLC']);
  assert.deepEqual(resolved.unmatched_assignees, ['Nobody Real']);
});

test('buildCsvInsert: conflict clause, returning job_id, 22 params per row in order', () => {
  const { text, params } = buildCsvInsert(resolved.rows);
  const lower = text.toLowerCase();
  assert.match(lower, /on conflict \(snapshot_date, job_id\) do nothing/);
  assert.match(lower, /returning job_id/);
  assert.match(lower, /::bigint\[/);
  assert.match(lower, /::text\[/);
  assert.match(lower, /::fulfillment_source/);
  assert.equal(params.length, resolved.rows.length * 22);
  assert.deepEqual(
    [...text.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])),
    Array.from({ length: params.length }, (_, i) => i + 1)
  );
  // params follow the column order of each row (snapshot_date first, source 20th)
  assert.equal(params[0], '2026-10-22');
  assert.equal(params[19], 'csv');
});

test('splitCollectedText: two-file joined text and a plain CSV', () => {
  const joined = '=== File: a.csv ===\n1,2\n\n=== File: b (2026-10-23 03_15_00).csv ===\n3,4';
  assert.deepEqual(splitCollectedText(joined), [
    { name: 'a.csv', text: '1,2' },
    { name: 'b (2026-10-23 03_15_00).csv', text: '3,4' },
  ]);
  assert.deepEqual(splitCollectedText('1,2\n3,4'), [{ name: '', text: '1,2\n3,4' }]);
});

const secret = 'test-session-secret';
const jobReq = { job_id: '0b9f3c1e-5a2d-4c7b-9e1f-2a3b4c5d6e7f', file_name: 'Fulfillment Snapshot (2026-10-23 03_15_00).zip' };

test('csv job signatures round-trip and are bound to secret, job id and file name', () => {
  const sig = signFulfillmentCsvJob(secret, jobReq);
  assert.match(sig, /^[0-9a-f]{64}$/);
  assert.ok(verifyFulfillmentCsvJob(secret, jobReq, sig));
  assert.ok(!verifyFulfillmentCsvJob('other-secret', jobReq, sig));
  assert.ok(!verifyFulfillmentCsvJob(secret, { ...jobReq, file_name: 'x.csv' }, sig));
  assert.ok(!verifyFulfillmentCsvJob(secret, { ...jobReq, file_name: null }, sig));
  assert.ok(!verifyFulfillmentCsvJob(secret, { ...jobReq, job_id: '1b9f3c1e-5a2d-4c7b-9e1f-2a3b4c5d6e7f' }, sig));
  assert.ok(!verifyFulfillmentCsvJob(secret, jobReq, undefined));
  assert.ok(!verifyFulfillmentCsvJob(secret, jobReq, sig.slice(1)));
  assert.ok(!verifyFulfillmentCsvJob(undefined, jobReq, sig));
  assert.throws(() => signFulfillmentCsvJob(undefined, jobReq), /SESSION_SECRET/);
});

test('a poll-job signature is not valid for the import job (different derivation label)', () => {
  // a genuine poll signature, and the import canonical string under the poll label
  assert.ok(!verifyFulfillmentCsvJob(secret, jobReq, signPollJob(secret, { run_id: 7 })));
  const pollLabelKey = createHmac('sha256', secret).update('flammard:fulfillment-poll').digest('hex');
  const withPollLabel = createHmac('sha256', pollLabelKey).update(`${jobReq.job_id}\n${jobReq.file_name ?? ''}`).digest('hex');
  assert.notEqual(withPollLabel, signFulfillmentCsvJob(secret, jobReq));
  assert.ok(!verifyFulfillmentCsvJob(secret, jobReq, withPollLabel));
});

test('parseCsvJobRequest and parseCsvJobMeta validate the hand-off payload', () => {
  assert.deepEqual(parseCsvJobRequest(JSON.stringify(jobReq)), jobReq);
  assert.deepEqual(parseCsvJobRequest(JSON.stringify({ job_id: jobReq.job_id })), { job_id: jobReq.job_id, file_name: null });
  assert.equal(parseCsvJobRequest(''), null);
  assert.equal(parseCsvJobRequest('not json'), null);
  assert.equal(parseCsvJobRequest(JSON.stringify({ ...jobReq, job_id: '../etc/passwd' })), null);
  assert.equal(parseCsvJobRequest(JSON.stringify({ ...jobReq, file_name: 5 })), null);
  const meta = { fileName: 'a.zip', text: '=== File: a.csv ===\n"Job Id",…' };
  assert.deepEqual(parseCsvJobMeta(meta), meta);
  assert.deepEqual(parseCsvJobMeta({ fileName: null, text: 'x' }), { fileName: null, text: 'x' });
  assert.equal(parseCsvJobMeta(null), null);
  assert.equal(parseCsvJobMeta({ fileName: 'a.zip', text: '' }), null, 'no text');
  assert.equal(parseCsvJobMeta({ fileName: 'a.zip', text: 7 }), null);
  assert.equal(parseCsvJobMeta({ fileName: 7, text: 'x' }), null);
  assert.deepEqual(csvJobKeys(jobReq.job_id), { meta: `${jobReq.job_id}/meta` });
});

test('a zip built in-test reaches parseR1 through collectReportFiles and splitCollectedText', () => {
  const name = 'Fulfillment Snapshot (2026-10-23 03_15_00).zip';
  const zip = zipSync({ 'Fulfillment Snapshot (2026-10-23 03_15_00).csv': strToU8(fixtureText) });
  const collected = collectReportFiles([{ name, bytes: zip }]);
  assert.ok(collected.text);
  const entries = splitCollectedText(collected.text);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, 'Fulfillment Snapshot (2026-10-23 03_15_00).csv');
  const fromZip = parseR1(entries[0].text);
  assert.equal(fromZip.rows.length, 6);
  assert.equal(fromZip.rows[0].job_id, 9001);
  assert.deepEqual(fromZip.rows[1].job_name, parsed.rows[1].job_name);
  assert.equal(snapshotDateFromFileName(entries[0].name), '2026-10-22');
});
