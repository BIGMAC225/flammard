// Netlify scheduled function (v2): enqueues one fulfillment poll run every
// hour. Scheduled functions are hard-capped at 30 seconds and run only on
// published deploys, so this creates the import_runs row and asks
// /api/integrations/fulfillment-poll-run to hand the actual walk to the
// background function netlify/functions/fulfillment-poll-background.mts (up
// to 15 minutes). The walk itself is src/lib/fulfillment-poll.ts.
//
// Inside Netlify functions the site origin is env('URL'), set by Netlify at
// build and runtime; DEPLOY_PRIME_URL is the fallback.

import { env } from '../../src/lib/env';
import { one, sql } from '../../src/lib/db';

// Hourly, UTC time
export const config = { schedule: '0 * * * *' };

export default async (_req: Request): Promise<void> => {
  try {
    const db = sql();
    const run = await one<{ id: number }>(
      db`insert into import_runs (source, status, started_at) values ('api', 'running', now()) returning id`
    );
    if (!run) {
      console.log('[fulfillment-poll] could not create the import run');
      return;
    }
    const runId = run.id;

    const secret = env('TAXDOME_WEBHOOK_SECRET');
    const origin = env('URL') || env('DEPLOY_PRIME_URL');
    try {
      if (!secret) throw new Error('TAXDOME_WEBHOOK_SECRET is not configured');
      if (!origin) throw new Error('site URL is not configured (neither URL nor DEPLOY_PRIME_URL)');
      const res = await fetch(new URL('/api/integrations/fulfillment-poll-run', origin), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
        body: JSON.stringify({ run_id: runId }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!(res.status >= 200 && res.status < 300)) throw new Error(`trigger route answered HTTP ${res.status}`);
      console.log(`[fulfillment-poll] run ${runId} enqueued`);
    } catch (err) {
      const message = `Could not enqueue the poll: ${err instanceof Error ? err.message : 'unknown'}`;
      await db`update import_runs set status = 'error', finished_at = now(), error = ${message} where id = ${runId}`;
      console.log(`[fulfillment-poll] run ${runId}: ${message}`);
    }
  } catch (err) {
    // Never throw: a failed schedule is visible only in the function log
    console.log(`[fulfillment-poll] failed: ${err instanceof Error ? err.message : 'unknown'}`);
  }
};
