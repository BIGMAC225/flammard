// Tests for src/lib/td-api.ts (TaxDome v4 API client: envelopes, cursor walk,
// ids batches, 500 ms pacing and 429 backoff). Every response body comes from
// the synthetic fixtures in tests/fixtures/fulfillment, and fetch, sleep and
// the clock are fakes, so nothing here touches the network or real timers.
//   node --test tests/td-api.test.mjs
// Needs Node 22.18+ / 24 (runs the .ts module directly via type stripping).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  createTdApi,
  tdApiFromEnv,
  TdApiError,
  TdApiRateLimitError,
  JOB_FIELDS,
} from '../src/lib/td-api.ts';

const fixture = (name) =>
  JSON.parse(readFileSync(new URL(`./fixtures/fulfillment/${name}.json`, import.meta.url), 'utf8'));

const jsonResponse = (body, init = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init });

/** Fake fetch/sleep/now: records request URLs and headers, sleep durations and
 *  a clock that advances by `advance` ms inside every fetch (never mid-request). */
function fakeTransport(responses, advance = 1000) {
  const calls = [];
  const sleeps = [];
  const clock = { now: 0 };
  const transport = {
    clock,
    calls,
    sleeps,
    fetchImpl: async (url, opts) => {
      calls.push({ url: String(url), headers: opts.headers });
      clock.now += advance;
      const next = responses.shift();
      if (typeof next === 'function') return next();
      return next;
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    now: () => clock.now,
  };
  return transport;
}

const makeApi = (t, opts = {}) =>
  createTdApi({
    base: 'https://example.taxdome.com/api/v4',
    key: 'tdk_test_key',
    fetchImpl: t.fetchImpl,
    sleep: t.sleep,
    now: t.now,
    ...opts,
  });

test('get(/me) sends Bearer auth and Accept, and returns the envelope', async () => {
  const t = fakeTransport([jsonResponse(fixture('td-me'))]);
  const api = makeApi(t);
  const env = await api.get('/me');
  assert.equal(t.calls.length, 1);
  assert.equal(t.calls[0].url, 'https://example.taxdome.com/api/v4/me');
  assert.equal(t.calls[0].headers.Authorization, 'Bearer tdk_test_key');
  assert.equal(t.calls[0].headers.Accept, 'application/json');
  assert.equal(env.data.firm_name, 'Example Firm');
  assert.equal(env.data.subdomain, 'example');
  assert.equal(env.data.timezone, 'America/Chicago');
  assert.deepEqual(env.meta, {});
  assert.equal(api.requestsMade, 1);
});

test('walk(/jobs) pages through cursors: count on the first page only, other params identical', async () => {
  const t = fakeTransport([jsonResponse(fixture('td-jobs-page1')), jsonResponse(fixture('td-jobs-page2'))]);
  const api = makeApi(t);
  const result = await api.walk('/jobs', { fields: JOB_FIELDS, sort: 'created_at', limit: 200 });
  assert.equal(t.calls.length, 2);

  const first = new URL(t.calls[0].url);
  assert.equal(first.pathname, '/api/v4/jobs');
  assert.equal(first.searchParams.get('count'), 'true');
  assert.equal(first.searchParams.get('limit'), '200');
  assert.equal(first.searchParams.get('sort'), 'created_at');
  assert.equal(first.searchParams.get('fields'), JOB_FIELDS.join(','));
  assert.equal(first.searchParams.get('cursor'), null);

  const second = new URL(t.calls[1].url);
  assert.equal(second.searchParams.get('cursor'), 'c2');
  assert.equal(second.searchParams.has('count'), false);
  assert.equal(second.searchParams.get('limit'), '200');
  assert.equal(second.searchParams.get('sort'), 'created_at');
  assert.equal(second.searchParams.get('fields'), JOB_FIELDS.join(','));

  assert.equal(result.pages, 2);
  assert.equal(result.totalFound, 5);
  assert.deepEqual(result.rows.map((r) => r.id), [1001, 1002, 1003, 1004, 1005]);
  for (const row of result.rows) {
    for (const field of JOB_FIELDS) assert.ok(field in row, `job ${row.id} is missing ${field}`);
  }
  assert.equal(result.rows[1].name, null);
  assert.equal(result.rows[1].priority, null);
  assert.equal(typeof result.rows[2].completed_at, 'string');
});

test('a 429 with Retry-After sleeps it out and retries the same request', async () => {
  const page = fixture('td-jobs-page2');
  const t = fakeTransport([
    jsonResponse(fixture('td-error-429'), { status: 429, headers: { 'Retry-After': '3' } }),
    jsonResponse(page),
  ]);
  const api = makeApi(t);
  const env = await api.get('/jobs', { limit: 200 });
  assert.equal(api.requestsMade, 2);
  assert.ok(t.sleeps.includes(3000), `expected a 3000 ms sleep, got [${t.sleeps.join(', ')}]`);
  assert.equal(t.calls.length, 2);
  assert.equal(t.calls[0].url, t.calls[1].url);
  assert.deepEqual(env.data, page.data);
});

test('a 429 without Retry-After uses the 5 s default', async () => {
  const t = fakeTransport([jsonResponse(fixture('td-error-429'), { status: 429 }), jsonResponse(fixture('td-me'))]);
  const api = makeApi(t);
  const env = await api.get('/me');
  assert.ok(t.sleeps.includes(5000), `expected a 5000 ms sleep, got [${t.sleeps.join(', ')}]`);
  assert.equal(env.data.firm_name, 'Example Firm');
});

test('five consecutive 429s throw TdApiRateLimitError after five requests', async () => {
  const t = fakeTransport(
    Array.from({ length: 5 }, () => jsonResponse(fixture('td-error-429'), { status: 429, headers: { 'Retry-After': '1' } }))
  );
  const api = makeApi(t);
  await assert.rejects(
    () => api.get('/jobs'),
    (err) => {
      assert.ok(err instanceof TdApiRateLimitError);
      assert.ok(err instanceof TdApiError);
      assert.equal(err.status, 429);
      assert.equal(err.message, 'TaxDome API rate limited 5 times in a row');
      return true;
    }
  );
  assert.equal(api.requestsMade, 5);
});

test('a 403 with an error body throws TdApiError and is not retried', async () => {
  const t = fakeTransport([jsonResponse(fixture('td-error-403'), { status: 403 })]);
  const api = makeApi(t);
  await assert.rejects(
    () => api.get('/jobs'),
    (err) => {
      assert.ok(err instanceof TdApiError);
      assert.ok(!(err instanceof TdApiRateLimitError));
      assert.equal(err.status, 403);
      assert.equal(err.code, 'insufficient_scope');
      assert.equal(err.message, 'The key lacks the jobs:read scope');
      assert.deepEqual(err.details, { required: 'jobs:read' });
      return true;
    }
  );
  assert.equal(api.requestsMade, 1);
  assert.deepEqual(t.sleeps, []);
});

test('a 200 whose body has no data key is a bad_envelope error', async () => {
  const t = fakeTransport([jsonResponse({ meta: {} })]);
  const api = makeApi(t);
  await assert.rejects(() => api.get('/me'), (err) => err instanceof TdApiError && err.code === 'bad_envelope');
  assert.equal(api.requestsMade, 1);
});

test('byIds deduplicates, batches up to 200 ids, and skips empty input', async () => {
  const t = fakeTransport([jsonResponse(fixture('td-clients-ids'))]);
  const api = makeApi(t);
  const clients = await api.byIds('/clients', [501, 502, 501]);
  assert.equal(t.calls.length, 1);
  assert.equal(new URL(t.calls[0].url).searchParams.get('ids'), '501,502');
  assert.deepEqual(clients.map((c) => c.account_name), ['Acme Test LLC', 'Beta Example Inc']);

  const many = Array.from({ length: 250 }, (_, i) => 5000 + i);
  const t2 = fakeTransport([jsonResponse({ data: [], meta: {} }), jsonResponse({ data: [], meta: {} })]);
  await makeApi(t2).byIds('/clients', many);
  assert.equal(t2.calls.length, 2);
  assert.deepEqual(
    t2.calls.map((c) => new URL(c.url).searchParams.get('ids').split(',').length),
    [200, 50]
  );

  const t3 = fakeTransport([]);
  assert.deepEqual(await makeApi(t3).byIds('/clients', []), []);
  assert.equal(t3.calls.length, 0);
});

test('throttle sleeps out the remainder of the 500 ms interval', async () => {
  const t = fakeTransport([jsonResponse(fixture('td-me')), jsonResponse(fixture('td-me'))], 100);
  const api = makeApi(t);
  await api.get('/me'); // lastRequestAt = 0, clock advances to 100 inside fetch
  await api.get('/me'); // 100 ms elapsed -> sleep the remaining 400 ms
  assert.deepEqual(t.sleeps, [400]);
  assert.equal(api.requestsMade, 2);
});

test('no throttle sleep once the interval has fully elapsed', async () => {
  const t = fakeTransport([jsonResponse(fixture('td-me')), jsonResponse(fixture('td-me'))], 600);
  const api = makeApi(t);
  await api.get('/me');
  await api.get('/me');
  assert.deepEqual(t.sleeps, []);
  assert.equal(api.requestsMade, 2);
});

test('tdApiFromEnv throws without env vars and strips one trailing slash from the base', async () => {
  const savedKey = process.env.TAXDOME_API_KEY;
  const savedBase = process.env.TAXDOME_API_BASE;
  try {
    delete process.env.TAXDOME_API_KEY;
    delete process.env.TAXDOME_API_BASE;
    assert.throws(() => tdApiFromEnv(), /TAXDOME_API_KEY is not configured/);

    process.env.TAXDOME_API_KEY = 'tdk_test_key';
    assert.throws(() => tdApiFromEnv(), /TAXDOME_API_BASE is not configured/);

    process.env.TAXDOME_API_BASE = 'https://example.taxdome.com/api/v4/';
    const t = fakeTransport([jsonResponse(fixture('td-me'))]);
    const api = tdApiFromEnv({ fetchImpl: t.fetchImpl, sleep: t.sleep, now: t.now });
    await api.get('/me');
    assert.equal(t.calls.length, 1);
    assert.equal(t.calls[0].url, 'https://example.taxdome.com/api/v4/me'); // no double slash
    assert.equal(t.calls[0].headers.Authorization, 'Bearer tdk_test_key');
  } finally {
    if (savedKey === undefined) delete process.env.TAXDOME_API_KEY;
    else process.env.TAXDOME_API_KEY = savedKey;
    if (savedBase === undefined) delete process.env.TAXDOME_API_BASE;
    else process.env.TAXDOME_API_BASE = savedBase;
  }
});
