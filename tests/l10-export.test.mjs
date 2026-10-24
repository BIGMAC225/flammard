// Tests for the read-only L10 export: src/lib/l10-export.ts (token check,
// goal parsing, payload shaping) and the route src/pages/api/export/l10.ts
// (405 / 401 / 400 / 200 on a mocked data layer — handleL10Export takes the
// data function, so the route needs no database here).
//   node --test tests/l10-export.test.mjs
// Needs Node 22.18+ / 24 (runs the .ts modules directly via type stripping).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildL10Export,
  handleL10Export,
  parseGoal,
  toNumber,
  tokenMatches,
} from '../src/lib/l10-export.ts';
import * as route from '../src/pages/api/export/l10.ts';

// ── tokenMatches ────────────────────────────────────────────────────────────

test('tokenMatches: equal token, wrong token, wrong length, unset expected', () => {
  assert.ok(tokenMatches('secret-1', 'secret-1'));
  assert.ok(!tokenMatches('secret-2', 'secret-1'));
  assert.ok(!tokenMatches('short', 'a-much-longer-secret'));
  assert.ok(!tokenMatches('', 'secret-1'));
  assert.ok(!tokenMatches('secret-1', undefined));
  assert.ok(!tokenMatches('secret-1', ''));
});

// ── parseGoal / toNumber ────────────────────────────────────────────────────

test('parseGoal splits operator and number; plain numbers are "="', () => {
  assert.deepEqual(parseGoal('≥ 50000'), { goal: 50000, goal_type: '>=' });
  assert.deepEqual(parseGoal('>= 3'), { goal: 3, goal_type: '>=' });
  assert.deepEqual(parseGoal('≤ 5'), { goal: 5, goal_type: '<=' });
  assert.deepEqual(parseGoal('<= 5'), { goal: 5, goal_type: '<=' });
  assert.deepEqual(parseGoal('10'), { goal: 10, goal_type: '=' });
  assert.deepEqual(parseGoal('= 7'), { goal: 7, goal_type: '=' });
  assert.deepEqual(parseGoal('1,250'), { goal: 1250, goal_type: '=' });
  assert.deepEqual(parseGoal('12.5'), { goal: 12.5, goal_type: '=' });
  assert.deepEqual(parseGoal(null), { goal: null, goal_type: null });
  assert.deepEqual(parseGoal(''), { goal: null, goal_type: null });
  assert.deepEqual(parseGoal('under 10'), { goal: null, goal_type: null });
});

test('toNumber reads the first number, tolerating commas, % and padding', () => {
  assert.equal(toNumber('5,000'), 5000);
  assert.equal(toNumber('98%'), 98);
  assert.equal(toNumber(' 12.5 '), 12.5);
  assert.equal(toNumber('-3'), -3);
  assert.equal(toNumber(''), null);
  assert.equal(toNumber('abc'), null);
  assert.equal(toNumber(null), null);
});

// ── buildL10Export ──────────────────────────────────────────────────────────

const QUARTER = { label: 'Q4 FY 2026', start_date: '2026-11-01', end_date: '2027-01-31' };

/** n weekly dates, newest first, ending at `latest`. */
const weeks = (n, latest = '2026-10-19') =>
  Array.from({ length: n }, (_, i) => {
    const d = new Date(`${latest}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - i * 7);
    return d.toISOString().slice(0, 10);
  });

function fixtureRows() {
  return {
    quarter: { ...QUARTER },
    metrics: [
      { id: 'm1', title: 'Revenue invoiced', owner: 'Jennifer', goal: '≥ 50000', unit: 'USD' },
      { id: 'm2', title: 'AR outstanding', owner: null, goal: null, unit: 'USD' },
    ],
    entries: [
      ...weeks(15).map((w, i) => ({ metric_id: 'm1', period_date: w, value: String(40000 + i), on_track: i < 3 })),
      { metric_id: 'm2', period_date: '2026-10-19', value: '98%', on_track: true },
      { metric_id: 'gone', period_date: '2026-10-19', value: '1', on_track: null }, // metric no longer active
    ],
    rocks: [
      {
        title: 'Rock A',
        owner: 'Russell',
        status: 'on_track',
        quarter: null,
        due_date: '2026-12-31',
        level: 'company',
        created_at: '2026-11-02 10:00:00+00',
        updated_at: '2026-12-15 09:00:00+00',
      },
      {
        title: 'Rock B',
        owner: null,
        status: 'off_track',
        quarter: 'Q4',
        due_date: null,
        level: null,
        created_at: '2026-11-05 10:00:00+00',
        updated_at: '2026-12-16 11:30:00+00',
      },
      {
        title: 'Old rock',
        owner: 'Russell',
        status: 'complete',
        quarter: null,
        due_date: '2026-08-15',
        level: null,
        created_at: '2026-05-01 10:00:00+00',
        updated_at: '2026-08-15 09:00:00+00',
      },
    ],
    issues: [
      { title: 'Hiring bottleneck', owner: 'Russell', priority: 'high', created_at: '2026-12-01 09:00:00+00' },
      { title: 'Unassigned follow-ups', owner: null, priority: null, created_at: '2026-12-10 09:00:00+00' },
    ],
    todos: [
      { title: 'Send AR list', owner: 'Jennifer', due_date: '2026-12-22', created_at: '2026-12-15 10:00:00+00', meeting_date: '2026-12-15' },
      { title: 'Old to-do', owner: null, due_date: null, created_at: '2026-11-30 10:00:00+00', meeting_date: null },
    ],
    last_meeting: {
      date: '2026-12-15',
      meeting_rating: '8.3',
      ratings: [{ rating: 8 }, { rating: 9 }],
      messages: [
        { message: 'Great quarter ahead', to_whom: 'All staff', by_whom: 'Russell', how: 'Friday huddle' },
        { message: 'AR push', to_whom: null, by_whom: null, how: null },
      ],
    },
  };
}

/** The route's contract, checked against any 200 payload. */
function assertContractShape(body) {
  assert.deepEqual(Object.keys(body), ['generated_at', 'team', 'scorecard', 'rocks', 'issues', 'todos', 'last_meeting']);
  assert.ok(!Number.isNaN(Date.parse(body.generated_at)));

  const [revenue, ar] = body.scorecard;
  assert.equal(revenue.measurable, 'Revenue invoiced');
  assert.equal(revenue.owner, 'Jennifer');
  assert.equal(revenue.goal, 50000);
  assert.equal(revenue.goal_type, '>=');
  assert.equal(revenue.unit, 'USD');
  assert.equal(revenue.entries.length, 13); // 15 weeks fetched, 13 kept
  assert.deepEqual(
    revenue.entries.map((e) => e.week),
    weeks(15).slice(0, 13)
  );
  assert.deepEqual(revenue.entries[0], { week: '2026-10-19', value: 40000, met: true });
  assert.deepEqual(ar, { measurable: 'AR outstanding', owner: null, goal: null, goal_type: null, unit: 'USD', entries: [{ week: '2026-10-19', value: 98, met: true }] });

  // Only the two current-quarter rocks; the August one is filtered out
  assert.deepEqual(
    body.rocks.map((r) => r.title),
    ['Rock A', 'Rock B']
  );
  assert.deepEqual(body.rocks[0], {
    title: 'Rock A',
    owner: 'Russell',
    status: 'on_track',
    due: '2026-12-31',
    quarter: 'Q4 FY 2026', // no own label, so the firm quarter's
    updated_at: '2026-12-15T09:00:00.000Z',
  });
  assert.equal(body.rocks[1].quarter, 'Q4'); // its own label wins

  assert.deepEqual(body.issues, [
    { title: 'Hiring bottleneck', owner: 'Russell', priority: 'high', status: 'open', created_at: '2026-12-01T09:00:00.000Z' },
    { title: 'Unassigned follow-ups', owner: null, priority: null, status: 'open', created_at: '2026-12-10T09:00:00.000Z' },
  ]);

  assert.deepEqual(body.todos, [
    { title: 'Send AR list', owner: 'Jennifer', due: '2026-12-22', status: 'open', created_at: '2026-12-15T10:00:00.000Z', meeting_date: '2026-12-15' },
    { title: 'Old to-do', owner: null, due: null, status: 'open', created_at: '2026-11-30T10:00:00.000Z', meeting_date: null },
  ]);

  assert.deepEqual(body.last_meeting, {
    date: '2026-12-15',
    rating: 8.5, // per-attendee average (8 and 9), not the stored 8.3
    cascading_messages: ['Great quarter ahead, to All staff, by Russell, via Friday huddle', 'AR push'],
  });
}

test('buildL10Export shapes the rows into the contract', () => {
  assertContractShape(buildL10Export('leadership', fixtureRows()));
});

test('buildL10Export: last_meeting is null without meetings, ratings fall back to the stored one', () => {
  const rows = fixtureRows();
  rows.last_meeting.ratings = [];
  let body = buildL10Export('leadership', rows);
  assert.equal(body.last_meeting.rating, 8.3); // stored average when nobody rated

  rows.last_meeting = null;
  body = buildL10Export('leadership', rows);
  assert.equal(body.last_meeting, null);
});

test('buildL10Export caps every list at 500 rows and flags truncated', () => {
  const rows = fixtureRows();
  rows.rocks = Array.from({ length: 501 }, (_, i) => ({
    title: `Rock ${i}`,
    owner: null,
    status: 'on_track',
    quarter: null,
    due_date: '2026-12-01',
    level: null,
    created_at: '2026-11-05 10:00:00+00',
    updated_at: '2026-12-16 10:00:00+00',
  }));
  const body = buildL10Export('leadership', rows);
  assert.equal(body.rocks.length, 500);
  assert.equal(body.truncated, true);
});

// ── The route ───────────────────────────────────────────────────────────────

const TOKEN = 'test-l10-export-token';
const hadToken = 'L10_EXPORT_TOKEN' in process.env;
const prevToken = process.env.L10_EXPORT_TOKEN;
const withEnvToken = async (value, fn) => {
  if (value === undefined) delete process.env.L10_EXPORT_TOKEN;
  else process.env.L10_EXPORT_TOKEN = value;
  try {
    await fn();
  } finally {
    if (hadToken) process.env.L10_EXPORT_TOKEN = prevToken;
    else delete process.env.L10_EXPORT_TOKEN;
  }
};

// No `team` default: `team: undefined` must reach the route as a missing
// query parameter, not fall back to 'leadership' through a default param.
const makeCtx = ({ token, team, method = 'GET' } = {}) => {
  const url = new URL(`https://flammard.example/api/export/l10${team === undefined ? '' : `?team=${team}`}`);
  const headers = {};
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  return { request: new Request(url, { method, headers }), url };
};

test('non-GET methods get 405 (ALL handles what GET does not)', async () => {
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    const res = await route.ALL(makeCtx({ token: TOKEN, method }));
    assert.equal(res.status, 405, method);
    assert.deepEqual(JSON.parse(await res.text()), { error: 'method not allowed' });
  }
});

test('GET without a token: 401, no detail beyond unauthorized', async () => {
  await withEnvToken(TOKEN, async () => {
    const res = await route.GET(makeCtx({}));
    assert.equal(res.status, 401);
    assert.deepEqual(JSON.parse(await res.text()), { error: 'unauthorized' });
  });
});

test('GET with the wrong token: 401', async () => {
  await withEnvToken(TOKEN, async () => {
    const res = await route.GET(makeCtx({ token: 'wrong-token' }));
    assert.equal(res.status, 401);
    assert.deepEqual(JSON.parse(await res.text()), { error: 'unauthorized' });
  });
});

test('GET with no L10_EXPORT_TOKEN configured: 401', async () => {
  await withEnvToken(undefined, async () => {
    const res = await route.GET(makeCtx({ token: TOKEN }));
    assert.equal(res.status, 401);
    assert.deepEqual(JSON.parse(await res.text()), { error: 'unauthorized' });
  });
});

test('GET with an unknown or missing team: 400 unknown team', async () => {
  await withEnvToken(TOKEN, async () => {
    for (const team of ['xyz', undefined]) {
      const res = await route.GET(makeCtx({ token: TOKEN, team }));
      assert.equal(res.status, 400, String(team));
      assert.deepEqual(JSON.parse(await res.text()), { error: 'unknown team' });
    }
  });
});

test('GET with the right token and team: 200, no-store, the contract shape', async () => {
  await withEnvToken(TOKEN, async () => {
    // Mocked data layer: the route's data function returns fixture rows
    // shaped by the real buildL10Export.
    const res = await handleL10Export(
      makeCtx({ token: TOKEN, team: 'leadership' }),
      async (team) => buildL10Export(team, fixtureRows())
    );
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(res.headers.get('content-type'), 'application/json');
    const body = JSON.parse(await res.text());
    assert.equal(body.team, 'leadership');
    assertContractShape(body);
  });
});
