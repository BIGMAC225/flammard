// Tests for src/lib/fulfillment-poll.ts and src/lib/fulfillment-poll-job.ts
// (fulfillment step 6: the pure mapping helpers and the trigger route ->
// background function hand-off signing).
//   node --test tests/fulfillment-poll.test.mjs
// Needs Node 22.18+ / 24 (runs the .ts modules directly via type stripping).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  buildSnapshotUpsert,
  displayName,
  groupAssignments,
  knownClientsMap,
  mapJobSnapshot,
  presentClientIds,
  staleClientIds,
} from '../src/lib/fulfillment-poll.ts';
import { parsePollRequest, signPollJob, verifyPollJob } from '../src/lib/fulfillment-poll-job.ts';
import { signTaxdomeJob } from '../src/lib/taxdome-job.ts';

const fixture = (name) =>
  JSON.parse(readFileSync(new URL(`./fixtures/fulfillment/${name}.json`, import.meta.url), 'utf8'));

const jobs = fixture('td-jobs-page1').data; // 1001 (full), 1002 (nulls), 1003

const ctx = {
  stages: new Map([
    [301, { pipeline_id: 7 }],
    [302, { pipeline_id: 8 }],
  ]),
  statuses: new Set([401, 402]),
  assignments: groupAssignments([{ job_id: 1001, actor_type: 'Employee', actor_id: 12 }]),
  snapshotDate: '2026-10-22',
  capturedAt: new Date('2026-10-22T15:00:00Z'),
  runId: 9,
};

test('displayName joins trimmed parts and drops empty ones', () => {
  assert.equal(displayName(' Ada ', ' Lovelace '), 'Ada Lovelace');
  assert.equal(displayName(null, ' Lovelace '), 'Lovelace');
  assert.equal(displayName('Ada', null), 'Ada');
  assert.equal(displayName(null, null), '');
  assert.equal(displayName('   ', ''), '');
});

test('groupAssignments: two jobs, ids sorted and deduplicated, actors aligned, null rows skipped', () => {
  const grouped = groupAssignments([
    { job_id: 1001, actor_type: 'Employee', actor_id: 12 },
    { job_id: 1001, actor_type: 'Owner', actor_id: 3 },
    { job_id: 1002, actor_type: 'Employee', actor_id: 12 },
    { job_id: 1001, actor_type: 'Owner', actor_id: 3 }, // duplicate id
    { job_id: 1001, actor_type: 'Employee', actor_id: 5 }, // out of order
    { job_id: null, actor_type: 'Owner', actor_id: 9 }, // skipped
    { job_id: 1003, actor_type: 'Employee', actor_id: null }, // skipped
  ]);
  assert.deepEqual(grouped.get(1001), { ids: [3, 5, 12], actors: ['Owner:3', 'Employee:5', 'Employee:12'] });
  assert.deepEqual(grouped.get(1002), { ids: [12], actors: ['Employee:12'] });
  assert.equal(grouped.has(1003), false);
  assert.equal(grouped.size, 2);
});

test('mapJobSnapshot maps a full job, pipeline_id taken from the stage', () => {
  assert.deepEqual(mapJobSnapshot(jobs[0], ctx), {
    snapshot_date: '2026-10-22',
    job_id: 1001,
    job_name: '1040 Test Return',
    pipeline_id: 7,
    stage_id: 301,
    status_id: 401,
    moved_at: '2026-10-20T09:15:00Z',
    status_changed_at: '2026-10-20T09:15:00Z',
    intake_date: '2026-10-01',
    start_date: '2026-10-05',
    due_date: '2026-11-15',
    internal_deadline: null,
    completed_at: null,
    created_at: '2026-10-01T14:00:00Z',
    time_budget: 5,
    time_tracked: 2,
    priority: 'high',
    assignee_ids: [12],
    assignee_actors: ['Employee:12'],
    client_id: 501,
    source: 'api',
    import_run_id: 9,
    captured_at: ctx.capturedAt,
  });
});

test('mapJobSnapshot returns the skipped marker for an unknown stage', () => {
  assert.deepEqual(mapJobSnapshot({ ...jobs[0], pipeline_stage_id: 999 }, ctx), { skipped: 'unknown_stage', stage_id: 999 });
});

test('mapJobSnapshot: unknown status gives status_id null, missing assignments empty arrays', () => {
  const row = mapJobSnapshot({ ...jobs[1], pipeline_job_status_id: 404 }, ctx);
  assert.equal(row.status_id, null);
  assert.deepEqual(row.assignee_ids, []);
  assert.deepEqual(row.assignee_actors, []);
  assert.equal(row.job_name, null);
  assert.equal(row.priority, null);
});

test('buildSnapshotUpsert: multi-row insert with the plan-E conflict clause and $1..$46 in order', () => {
  const rows = [mapJobSnapshot(jobs[0], ctx), mapJobSnapshot(jobs[1], ctx)];
  const { text, params } = buildSnapshotUpsert(rows);
  const lower = text.toLowerCase();
  assert.match(lower, /on conflict \(snapshot_date, job_id\) do update set/);
  assert.match(lower, /where excluded\.captured_at >= job_snapshots\.captured_at/);
  assert.match(lower, /::bigint\[/);
  assert.match(lower, /::text\[/);
  assert.match(lower, /::fulfillment_source/);
  assert.equal(params.length, 2 * 23);
  assert.deepEqual(
    [...text.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])),
    Array.from({ length: 46 }, (_, i) => i + 1)
  );
  // params follow the column order of each row (snapshot_date first, source 21st)
  assert.equal(params[0], '2026-10-22');
  assert.deepEqual(params[17], [12]); // assignee_ids
  assert.deepEqual(params[18], ['Employee:12']); // assignee_actors
  assert.equal(params[20], 'api'); // source
});

test('staleClientIds: missing and old included, fresh skipped', () => {
  const now = new Date('2026-10-22T12:00:00Z');
  const known = new Map([
    [501, new Date(now.getTime() - 1 * 86_400_000)], // yesterday: fresh
    [502, new Date(now.getTime() - 40 * 86_400_000)], // 40 days ago: stale
  ]);
  assert.deepEqual(staleClientIds([501, 502, 503, 503], known, now), [502, 503]);
  assert.deepEqual(staleClientIds([501], known, now), []);
  assert.deepEqual(staleClientIds([502], known, now, 60), []); // older window: fresh again
});

const secret = 'test-session-secret';

test('signPollJob round-trips and is bound to the secret and the run id', () => {
  const sig = signPollJob(secret, { run_id: 7 });
  assert.match(sig, /^[0-9a-f]{64}$/);
  assert.ok(verifyPollJob(secret, { run_id: 7 }, sig));
  assert.ok(!verifyPollJob('other-secret', { run_id: 7 }, sig));
  assert.ok(!verifyPollJob(secret, { run_id: 8 }, sig));
  assert.ok(!verifyPollJob(secret, { run_id: 7 }, undefined));
  assert.ok(!verifyPollJob(secret, { run_id: 7 }, sig.slice(1)));
  assert.ok(!verifyPollJob(undefined, { run_id: 7 }, sig));
});

test('signing without SESSION_SECRET throws', () => {
  assert.throws(() => signPollJob(undefined, { run_id: 7 }), /SESSION_SECRET/);
});

test('a taxdome-job signature is not valid for the poll job (different derivation label)', () => {
  // Sign the poll job's own canonical string under the taxdome-job label
  const taxdomeLabelKey = createHmac('sha256', secret).update('flammard:taxdome-job').digest('hex');
  const withTaxdomeLabel = createHmac('sha256', taxdomeLabelKey).update('7').digest('hex');
  assert.notEqual(withTaxdomeLabel, signPollJob(secret, { run_id: 7 }));
  assert.ok(!verifyPollJob(secret, { run_id: 7 }, withTaxdomeLabel));
  // and the taxdome-job signer itself signs a different canonical string
  assert.ok(
    !verifyPollJob(secret, { run_id: 7 },
      signTaxdomeJob(secret, { job_id: '0b9f3c1e-5a2d-4c7b-9e1f-2a3b4c5d6e7f', team: 'leadership', file_name: null }))
  );
});

test('parsePollRequest accepts a positive integer run_id, digits-only string included', () => {
  assert.deepEqual(parsePollRequest(JSON.stringify({ run_id: 7 })), { run_id: 7 });
  assert.deepEqual(parsePollRequest(JSON.stringify({ run_id: 3 })), { run_id: 3 });
  // the Neon serverless driver returns bigint ids as strings ("3")
  assert.deepEqual(parsePollRequest(JSON.stringify({ run_id: '3' })), { run_id: 3 });
  assert.deepEqual(parsePollRequest(JSON.stringify({ run_id: '7' })), { run_id: 7 });
  assert.equal(parsePollRequest(''), null);
  assert.equal(parsePollRequest('not json'), null);
  assert.equal(parsePollRequest(JSON.stringify({})), null);
  assert.equal(parsePollRequest(JSON.stringify([7])), null);
  assert.equal(parsePollRequest(JSON.stringify({ run_id: 0 })), null);
  assert.equal(parsePollRequest(JSON.stringify({ run_id: -1 })), null);
  assert.equal(parsePollRequest(JSON.stringify({ run_id: 1.5 })), null);
  assert.equal(parsePollRequest(JSON.stringify({ run_id: 3.5 })), null);
  assert.equal(parsePollRequest(JSON.stringify({ run_id: 'abc' })), null);
  assert.equal(parsePollRequest(JSON.stringify({ run_id: '-1' })), null);
  assert.equal(parsePollRequest(JSON.stringify({ run_id: '0' })), null);
});

test('runToUse parsing: digit-string and numeric run ids reuse the existing run, missing/invalid get none', () => {
  // runToUse now decides through parsePollRequest (its insert path needs the
  // DB): a valid body yields the existing run id, anything else falls through
  // to a brand-new import_runs row.
  assert.deepEqual(parsePollRequest('{"run_id":"21"}'), { run_id: 21 });
  assert.deepEqual(parsePollRequest('{"run_id":21}'), { run_id: 21 });
  assert.equal(parsePollRequest(''), null); // missing run_id
  assert.equal(parsePollRequest('not json'), null);
  assert.equal(parsePollRequest('{"run_id":"abc"}'), null); // invalid
  assert.equal(parsePollRequest('{"run_id":-1}'), null);
  assert.equal(parsePollRequest('{"run_id":0}'), null);
});

test('client staleness: a DB bigint id "123" (string) is the same client as API id 123', () => {
  const now = new Date('2026-10-22T12:00:00Z');
  // td_clients rows as Neon returns them: bigint ids as strings
  const rows = [
    { id: '123', synced_at: now.toISOString() }, // yesterday: fresh
    { id: '124', synced_at: '2026-08-01T00:00:00Z' }, // 82 days ago: stale
  ];
  const known = knownClientsMap(rows);
  assert.deepEqual([...known.keys()], [123, 124]); // keys are numbers
  assert.deepEqual(staleClientIds([123], known, now), []); // matched: not refetched
  assert.deepEqual(staleClientIds([124], known, now), [124]); // stale by age
  assert.deepEqual(staleClientIds([125], known, now), [125]); // unknown
  const present = presentClientIds([{ id: '123' }]);
  assert.equal(present.has(123), true); // no placeholder for a known client
  assert.equal(present.has(125), false); // counted in placeholder_clients
});
