import { createHmac, timingSafeEqual } from 'node:crypto';

// Trigger route -> background poll hand-off for the fulfillment poller.
// Pure (node:crypto only, secrets passed in) so it can be tested without the
// server, copied from src/lib/taxdome-job.ts with its own derivation label
// ('flammard:fulfillment-poll'), so one job's signature is never valid for
// the other.
//
// POST /api/integrations/fulfillment-poll-run calls the background function
// (netlify/functions/fulfillment-poll-background.mts) with the small JSON
// body { run_id } signed with a key derived from SESSION_SECRET.

export const POLL_JOB_HEADER = 'x-flammard-job';

/** The request body sent to the background function. */
export interface PollJobRequest {
  run_id: number;
}

function jobKey(sessionSecret: string | undefined): string {
  if (!sessionSecret) throw new Error('SESSION_SECRET is not configured');
  return createHmac('sha256', sessionSecret).update('flammard:fulfillment-poll').digest('hex');
}

const canonical = (r: PollJobRequest) => String(r.run_id);

export function signPollJob(sessionSecret: string | undefined, req: PollJobRequest): string {
  return createHmac('sha256', jobKey(sessionSecret)).update(canonical(req)).digest('hex');
}

export function verifyPollJob(
  sessionSecret: string | undefined,
  req: PollJobRequest,
  signature: string | null | undefined
): boolean {
  if (!signature || !sessionSecret) return false;
  const expected = Buffer.from(signPollJob(sessionSecret, req));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** Parses the background function's body; null when it isn't a valid run id. */
export function parsePollRequest(raw: string): PollJobRequest | null {
  let body: unknown;
  try {
    body = JSON.parse(raw || '{}');
  } catch {
    return null;
  }
  if (!body || typeof body !== 'object') return null;
  const { run_id } = body as Record<string, unknown>;
  if (typeof run_id !== 'number' || !Number.isInteger(run_id) || run_id <= 0 || run_id > Number.MAX_SAFE_INTEGER) {
    return null;
  }
  return { run_id };
}
