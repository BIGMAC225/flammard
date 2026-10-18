// Which scorecard day a TaxDome report's values belong to. Pure (no I/O) so it
// can be tested directly: node --test tests/taxdome-date.test.mjs
//
// Imports are dated by the day the report was produced/sent, read from the
// report itself rather than asked of the model (which mixed up week starts,
// week ends and export dates). TaxDome starts every CSV with a line like
//   "Data extract produced by Jane Doe (123) on 10/14/2026 15:10 UTC"
// and the liveboard PDF carries a stamp like 10/17/2026 15:26:16 UTC.

/** The firm's time zone (Louisiana): a report sent Monday evening is Monday's. */
export const FIRM_TIME_ZONE = 'America/Chicago';

// MM/DD/YYYY HH:MM[:SS] UTC
const STAMP = String.raw`(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*UTC\b`;
const PRODUCED = new RegExp(String.raw`Data extract produced by[^\n]*?\bon\s+` + STAMP, 'gi');
const ANY_STAMP = new RegExp(STAMP, 'gi');

function toDate(m: RegExpMatchArray): Date | null {
  const [mo, d, y, h, mi, s] = m.slice(1, 7).map((x) => Number(x ?? 0));
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
  const date = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  // Rejects dates like 02/31 that Date.UTC would roll over
  if (date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
  return date;
}

function latest(text: string, re: RegExp): Date | null {
  let best: Date | null = null;
  for (const m of text.matchAll(re)) {
    const date = toDate(m);
    if (date && (!best || date > best)) best = date;
  }
  return best;
}

/**
 * When the report was produced, from its "Data extract produced by … on …"
 * header lines (the latest one if several files were sent). When there is no
 * such line (a PDF), the latest plain "MM/DD/YYYY HH:MM[:SS] UTC" stamp.
 * Null when the text has neither.
 */
export function reportProducedAt(text: string | null | undefined): Date | null {
  if (!text) return null;
  return latest(text, PRODUCED) ?? latest(text, ANY_STAMP);
}

/** The calendar date (YYYY-MM-DD) of an instant in the firm's time zone. */
export function firmDate(at: Date): string {
  // en-CA formats as YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', { timeZone: FIRM_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}

/**
 * The scorecard date for an import: the firm-local day the report was
 * produced, or today (firm-local) when the report doesn't say.
 */
export function taxdomeReportDate(text: string | null | undefined, now: Date = new Date()): string {
  return firmDate(reportProducedAt(text) ?? now);
}
