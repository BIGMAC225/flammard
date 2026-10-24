// .ts extension: this module is also imported directly by tests under
// node --test (type stripping), which resolves relative imports literally.
import { env } from './env.ts';

// TaxDome REST client (api/v4) for the fulfillment pipeline: envelope parsing,
// cursor-paged walks, ids batch fetches and the firm's rate etiquette (at most
// one request per 500 ms; on 429 sleep Retry-After and retry the same page,
// fail the run after five in a row). Pure (fetch, sleep and the clock are
// injected) so it can be tested without the network or real timers. The API
// key travels only in the Authorization header and is never logged.

/** Query params for a TaxDome endpoint; arrays are joined with commas. */
export type TdParams = Record<string, string | number | boolean | Array<string | number> | undefined>;

/** The meta half of a response body (total_found only on a count=true page). */
export interface TdMeta {
  limit?: number;
  next_cursor?: string | null;
  total_found?: number;
  [key: string]: unknown;
}

/** One API response body: a record or a row list plus meta, returned as is. */
export interface TdEnvelope<T> {
  data: T;
  meta: TdMeta;
}

/** Result of walking every cursor page of a list endpoint. */
export interface TdWalk<T> {
  rows: T[];
  totalFound: number | null;
  pages: number;
}

export interface TdApiOptions {
  base: string;
  key: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** One request per interval at most (default 500 ms = two per second). */
  minIntervalMs?: number;
  maxConsecutive429?: number;
  /** Used when a 429 has no parsable Retry-After header. */
  defaultRetryAfterSec?: number;
}

export class TdApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details: unknown = {}) {
    super(message);
    this.name = 'TdApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export class TdApiRateLimitError extends TdApiError {
  constructor(maxConsecutive: number) {
    super(429, 'rate_limited', `TaxDome API rate limited ${maxConsecutive} times in a row`);
    this.name = 'TdApiRateLimitError';
  }
}

/** Fields the jobs walk asks for (plan section E); id is always included anyway. */
export const JOB_FIELDS: string[] = [
  'id',
  'client_id',
  'name',
  'pipeline_stage_id',
  'pipeline_job_status_id',
  'moved_at',
  'status_changed_at',
  'intake_date',
  'start_date',
  'due_date',
  'internal_deadline',
  'completed_at',
  'created_at',
  'time_budget',
  'time_tracked',
  'priority',
];

export interface TdApi {
  /** One (429-backing-off) request; the envelope is returned as is. */
  get<T>(path: string, params?: TdParams): Promise<TdEnvelope<T>>;
  /** Full cursor walk: first page with count=true, then cursor pages without it. */
  walk<T>(path: string, params?: TdParams): Promise<TdWalk<T>>;
  /** Fetches exactly these ids in batches of 200 (ids param, no paging). */
  byIds<T>(path: string, ids: Array<number | string>, params?: TdParams): Promise<T[]>;
  /** Total HTTP requests sent, including retried 429s. */
  readonly requestsMade: number;
}

const sleepReal = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** base + path + params into one URL (arrays comma-joined, undefined skipped). */
function buildUrl(base: string, path: string, params?: TdParams): string {
  const search = new URLSearchParams();
  for (const [name, value] of Object.entries(params ?? {})) {
    if (value === undefined) continue;
    search.set(name, Array.isArray(value) ? value.join(',') : String(value));
  }
  const qs = search.toString();
  return qs ? `${base}${path}?${qs}` : `${base}${path}`;
}

/** Maps a non-2xx body to TdApiError; http_error when it isn't the error shape. */
function httpError(res: Response, body: unknown): TdApiError {
  const statusText = res.statusText || `HTTP ${res.status}`;
  const err = body != null && typeof body === 'object' ? (body as { error?: Record<string, unknown> }).error : undefined;
  if (err != null && typeof err === 'object') {
    const code = typeof err.code === 'string' ? err.code : 'http_error';
    const message = typeof err.message === 'string' ? err.message : statusText;
    return new TdApiError(res.status, code, message, err.details);
  }
  return new TdApiError(res.status, 'http_error', statusText);
}

export function createTdApi(opts: TdApiOptions): TdApi {
  const {
    base,
    key,
    fetchImpl = fetch,
    sleep = sleepReal,
    now = () => Date.now(),
    minIntervalMs = 500,
    maxConsecutive429 = 5,
    defaultRetryAfterSec = 5,
  } = opts;

  let lastRequestAt = -Infinity;
  let requestsMade = 0;

  async function request<T>(path: string, params?: TdParams): Promise<TdEnvelope<T>> {
    const url = buildUrl(base, path, params);
    const headers = { Authorization: `Bearer ${key}`, Accept: 'application/json' };
    let consecutive429 = 0;
    for (;;) {
      // pace: never two requests within minIntervalMs of each other
      const wait = minIntervalMs - (now() - lastRequestAt);
      if (wait > 0) await sleep(wait);
      lastRequestAt = now();
      requestsMade++;

      let res: Response;
      try {
        res = await fetchImpl(url, { headers });
      } catch (err) {
        throw new Error(`TaxDome API request to ${path} failed: ${err instanceof Error ? err.message : String(err)}`);
      }

      if (res.status === 429) {
        if (++consecutive429 >= maxConsecutive429) throw new TdApiRateLimitError(maxConsecutive429);
        const retryAfter = res.headers.get('retry-after');
        const seconds = retryAfter != null && retryAfter.trim() !== '' ? Number(retryAfter) : NaN;
        await sleep((Number.isFinite(seconds) && seconds >= 0 ? seconds : defaultRetryAfterSec) * 1000);
        continue; // same page again
      }

      const body: unknown = await res.json().catch(() => null);
      if (!res.ok) throw httpError(res, body);
      if (body == null || typeof body !== 'object' || !('data' in body)) {
        throw new TdApiError(res.status, 'bad_envelope', 'TaxDome API response is not a data envelope');
      }
      const { data, meta } = body as { data: unknown; meta?: unknown };
      return { data: data as T, meta: (meta ?? {}) as TdMeta };
    }
  }

  const api: TdApi = {
    get: <T>(path: string, params?: TdParams) => request<T>(path, params),

    async walk<T>(path: string, params?: TdParams): Promise<TdWalk<T>> {
      const rows: T[] = [];
      let totalFound: number | null = null;
      let pages = 0;
      let cursor: string | undefined;
      for (;;) {
        const page: TdParams = { ...params, cursor };
        // total_found only comes back on a first page asked with count=true
        if (pages === 0 && params?.count !== false) page.count = true;
        else delete page.count;
        const env = await request<T[]>(path, page);
        pages++;
        if (Array.isArray(env.data)) rows.push(...env.data);
        if (env.meta.total_found != null) totalFound = env.meta.total_found;
        cursor = env.meta.next_cursor ?? undefined;
        if (!cursor) return { rows, totalFound, pages };
      }
    },

    async byIds<T>(path: string, ids: Array<number | string>, params?: TdParams): Promise<T[]> {
      const unique = [...new Set(ids)];
      const rows: T[] = [];
      for (let i = 0; i < unique.length; i += 200) {
        const env = await request<T[]>(path, { ...params, ids: unique.slice(i, i + 200) });
        if (Array.isArray(env.data)) rows.push(...env.data);
      }
      return rows;
    },

    get requestsMade() {
      return requestsMade;
    },
  };
  return api;
}

/** Client from TAXDOME_API_KEY / TAXDOME_API_BASE (one trailing slash stripped). */
export function tdApiFromEnv(overrides: Partial<TdApiOptions> = {}): TdApi {
  const key = env('TAXDOME_API_KEY');
  if (!key) throw new Error('TAXDOME_API_KEY is not configured');
  let base = env('TAXDOME_API_BASE');
  if (!base) throw new Error('TAXDOME_API_BASE is not configured');
  if (base.endsWith('/')) base = base.slice(0, -1);
  return createTdApi({ base, key, ...overrides });
}
