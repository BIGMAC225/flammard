import type { APIRoute } from 'astro';
import { timingSafeEqual } from 'node:crypto';
import { json } from '../../../lib/api';
import { one, sql } from '../../../lib/db';
import { env } from '../../../lib/env';
import { parsePollRequest, POLL_JOB_HEADER, signPollJob } from '../../../lib/fulfillment-poll-job';

// Trigger for the fulfillment poller (implementation plan, section J step 6).
// The scheduled function netlify/functions/fulfillment-poll.mts posts here
// every hour to enqueue a background run, and curl works too (no body needed:
// a new import_runs row is created). Auth: `Authorization: Bearer
// <TAXDOME_WEBHOOK_SECRET>` — reused from the report webhook on purpose, so
// there is no new secret to set. See docs/AUTOMATION.md section 4.

const BACKGROUND_PATH = '/.netlify/functions/fulfillment-poll-background';

function secretMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

const bearer = (request: Request): string => (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim();

/** A positive integer run_id from an optional JSON body, else a brand-new 'running' run. */
async function runToUse(request: Request): Promise<{ id: number } | { error: Response }> {
  let raw = '';
  try {
    raw = await request.text();
  } catch {
    /* no body is fine: curl with no -d */
  }
  // parsePollRequest accepts the Neon driver's bigint ids as digit strings
  // ("21") as well as numbers, so the scheduler's run row is reused instead of
  // a second one being inserted and the first left 'running' forever.
  const parsed = parsePollRequest(raw);
  if (parsed) return { id: parsed.run_id };
  const run = await one<{ id: number | string }>(
    sql()`insert into import_runs (source, status, started_at) values ('api', 'running', now()) returning id`
  );
  // import_runs.id is a bigint, which the Neon serverless driver returns as a
  // string ("3"); coerce it so the hand-off below carries a numeric run_id.
  return run ? { id: Number(run.id) } : { error: json({ error: 'Could not create an import run' }, 500) };
}

export const POST: APIRoute = async ({ request, url }) => {
  const secret = env('TAXDOME_WEBHOOK_SECRET');
  if (!secret) return json({ error: 'TAXDOME_WEBHOOK_SECRET is not configured' }, 500);
  const token = bearer(request);
  // One line per call so a run can be debugged from the function log (no secrets logged)
  console.log(`[fulfillment-poll-run] auth=${secretMatches(token, secret) ? 'ok' : token ? 'wrong' : 'missing'}`);
  if (!secretMatches(token, secret)) return json({ error: 'Unauthorized' }, 401);

  const run = await runToUse(request);
  if ('error' in run) return run.error;
  const runId = run.id;

  // Hand the run to the background function (same scheme as startTaxdomeImportJob)
  try {
    const signature = signPollJob(env('SESSION_SECRET'), { run_id: runId });
    const res = await fetch(new URL(BACKGROUND_PATH, url.origin), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [POLL_JOB_HEADER]: signature },
      body: JSON.stringify({ run_id: runId }),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status !== 202 && !res.ok) throw new Error(`background function answered HTTP ${res.status}`);
    console.log(`[fulfillment-poll-run] run ${runId} queued`);
    return json({ ok: true, accepted: true, run_id: runId }, 202);
  } catch (err) {
    const message = `Could not start the poll: ${err instanceof Error ? err.message : 'unknown'}`;
    await sql()`update import_runs set status = 'error', finished_at = now(), error = ${message} where id = ${runId}`;
    console.log(`[fulfillment-poll-run] run ${runId} not started: ${message}`);
    return json({ error: message, run_id: runId }, 502);
  }
};

// Latest API poll run, for checking on a manual trigger.
export const GET: APIRoute = async ({ request }) => {
  const secret = env('TAXDOME_WEBHOOK_SECRET');
  if (!secret) return json({ error: 'TAXDOME_WEBHOOK_SECRET is not configured' }, 500);
  if (!secretMatches(bearer(request), secret)) return json({ error: 'Unauthorized' }, 401);
  const latest = await one<Record<string, unknown>>(
    sql()`select id, status, started_at, finished_at, snapshot_date, requests_made, jobs_written, error, detail
         from import_runs where source = 'api' order by id desc limit 1`
  );
  return json({ latest: latest ?? null });
};
