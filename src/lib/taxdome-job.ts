import { createHmac, timingSafeEqual } from 'node:crypto';

// Webhook → background import hand-off for TaxDome reports. Pure (node:crypto
// only, secrets passed in) so it can be tested without the server.
//
// POST /api/integrations/taxdome?async=1 stores the prepared report in Netlify
// Blobs under a random job id and calls the background function
// (netlify/functions/taxdome-import-background.mts) with a small JSON body
// { job_id, team, file_name } signed with a key derived from SESSION_SECRET,
// the same scheme the meeting-analysis job uses (different derivation label,
// so one job's signature is never valid for the other).

export const JOB_HEADER = 'x-flammard-job';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isJobId(id: unknown): id is string {
  return typeof id === 'string' && UUID.test(id);
}

/** The request body sent to the background function. */
export interface TaxdomeJobRequest {
  job_id: string;
  team: string;
  file_name: string | null;
}

/** What is stored in the blob next to the (optional) PDF bytes. */
export interface TaxdomeJobMeta {
  team: string;
  fileName: string | null;
  text: string | null;
  hasPdf: boolean;
}

/** Blob keys for one job: the JSON meta and the PDF bytes (when there is one). */
export const jobKeys = (jobId: string) => ({ meta: `${jobId}/meta`, pdf: `${jobId}/pdf` });

function jobKey(sessionSecret: string | undefined): string {
  if (!sessionSecret) throw new Error('SESSION_SECRET is not configured');
  return createHmac('sha256', sessionSecret).update('flammard:taxdome-job').digest('hex');
}

const canonical = (r: TaxdomeJobRequest) => `${r.job_id}\n${r.team}\n${r.file_name ?? ''}`;

export function signTaxdomeJob(sessionSecret: string | undefined, req: TaxdomeJobRequest): string {
  return createHmac('sha256', jobKey(sessionSecret)).update(canonical(req)).digest('hex');
}

export function verifyTaxdomeJob(
  sessionSecret: string | undefined,
  req: TaxdomeJobRequest,
  signature: string | null | undefined
): boolean {
  if (!signature || !sessionSecret) return false;
  const expected = Buffer.from(signTaxdomeJob(sessionSecret, req));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** Parses the background function's body; null when it isn't a well-formed job request. */
export function parseJobRequest(raw: string): TaxdomeJobRequest | null {
  let body: unknown;
  try {
    body = JSON.parse(raw || '{}');
  } catch {
    return null;
  }
  if (!body || typeof body !== 'object') return null;
  const { job_id, team, file_name } = body as Record<string, unknown>;
  if (!isJobId(job_id) || typeof team !== 'string' || !team) return null;
  if (file_name != null && typeof file_name !== 'string') return null;
  return { job_id, team, file_name: (file_name as string | null | undefined) ?? null };
}

/** Validates the stored meta blob; null when it is missing or malformed. */
export function parseJobMeta(value: unknown): TaxdomeJobMeta | null {
  if (!value || typeof value !== 'object') return null;
  const { team, fileName, text, hasPdf } = value as Record<string, unknown>;
  if (typeof team !== 'string' || !team) return null;
  if (fileName != null && typeof fileName !== 'string') return null;
  if (text != null && typeof text !== 'string') return null;
  if (typeof hasPdf !== 'boolean') return null;
  if (!hasPdf && !text) return null;
  return { team, fileName: (fileName as string | null) ?? null, text: (text as string | null) ?? null, hasPdf };
}
