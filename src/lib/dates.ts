import { env } from './env';

// The firm's local calendar date, not UTC — periods start and end on local
// days, and a UTC rollover in the evening would misclassify them.
export const TIMEZONE = env('PUBLIC_TIMEZONE') || 'America/Chicago';

export function todayLocal(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: TIMEZONE }); // en-CA → YYYY-MM-DD
}

/** True for a real calendar date in YYYY-MM-DD form (rejects 2026-02-30). */
export function isIsoDate(v: unknown): v is string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const t = Date.parse(`${v}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === v;
}
