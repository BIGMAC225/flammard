import type { CompanySettings } from '../types';

// Fiscal quarters from company settings. Quarter starts are month-days
// ('MM-DD') that repeat every year; Q1's start begins the fiscal year. When
// Q1 starts after January 1 the fiscal year spans two calendar years, and
// fiscal_year_named_by says whether "FY 2026" is the year it starts in
// ('start': Feb 2026 – Jan 2027) or ends in ('end': Feb 2025 – Jan 2026).
// Pure: used by the settings page preview, the importer UI and the server.

export type QuarterSettings = Pick<
  CompanySettings,
  'q1_start' | 'q2_start' | 'q3_start' | 'q4_start' | 'fiscal_year_named_by'
>;

export interface QuarterStart {
  q: 1 | 2 | 3 | 4;
  month: number; // 1–12
  day: number; // 1–31
  md: string; // 'MM-DD'
}

const MD = /^(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/;
const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]; // Feb 29 allowed

const pad = (n: number) => String(n).padStart(2, '0');

/** True for a real month-day ('02-29' allowed, '02-30' not). */
export function isMonthDay(v: unknown): v is string {
  if (typeof v !== 'string' || !MD.test(v)) return false;
  const [m, d] = v.split('-').map(Number);
  return d <= DAYS_IN_MONTH[m - 1];
}

export function quarterStarts(s: QuarterSettings): QuarterStart[] {
  return ([s.q1_start, s.q2_start, s.q3_start, s.q4_start] as string[]).map((md, i) => {
    const [month, day] = md.split('-').map(Number);
    return { q: (i + 1) as 1 | 2 | 3 | 4, month, day, md };
  });
}

/** Calendar date of a month-day in a year; Feb 29 in a non-leap year becomes Feb 28. */
function dateIn(year: number, month: number, day: number): Date {
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return new Date(Date.UTC(year, month - 1, Math.min(day, last)));
}

const iso = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

/** The calendar year in which fiscal year `fy`'s Q1 starts. */
function fyStartYear(fy: number, s: QuarterSettings): number {
  if (s.fiscal_year_named_by === 'start' || s.q1_start === '01-01') return fy;
  return fy - 1;
}

/** Start dates of Q1–Q4 of fiscal year `fy`, plus Q1 of the next year. */
function fyStarts(fy: number, s: QuarterSettings): Date[] {
  const starts = quarterStarts(s);
  const y = fyStartYear(fy, s);
  const q1 = starts[0].md;
  const out = starts.map((st) => dateIn(st.md < q1 ? y + 1 : y, st.month, st.day));
  out.push(dateIn(y + 1, starts[0].month, starts[0].day));
  return out;
}

/** Date range of quarter q (1–4) of fiscal year fy: start to the day before the next quarter. */
export function quarterDates(q: 1 | 2 | 3 | 4, fy: number, s: QuarterSettings): { start_date: string; end_date: string } {
  const starts = fyStarts(fy, s);
  const end = new Date(starts[q].getTime() - 86400000);
  return { start_date: iso(starts[q - 1]), end_date: iso(end) };
}

/** Parses a label such as "Q1 FY 2026" or "Q3 2026"; null when it isn't one. */
export function parseQuarterLabel(label: string): { q: 1 | 2 | 3 | 4; fy: number } | null {
  const m = /Q([1-4])\s*(?:FY)?\s*(\d{4})/i.exec(label ?? '');
  return m ? { q: Number(m[1]) as 1 | 2 | 3 | 4, fy: Number(m[2]) } : null;
}

/** "Q1 FY 2026" → its date range under these settings, or null if the label can't be parsed. */
export function quarterRange(label: string, s: QuarterSettings): { start_date: string; end_date: string } | null {
  const p = parseQuarterLabel(label);
  return p ? quarterDates(p.q, p.fy, s) : null;
}

/** The fiscal quarter a 'YYYY-MM-DD' date falls in. */
export function quarterForDate(date: string, s: QuarterSettings): { q: 1 | 2 | 3 | 4; fy: number } {
  const t = Date.parse(`${date.slice(0, 10)}T00:00:00Z`);
  const year = new Date(t).getUTCFullYear();
  // The date's fiscal year is within one of its calendar year either way
  for (const fy of [year + 1, year, year - 1]) {
    const starts = fyStarts(fy, s);
    if (t < starts[0].getTime() || t >= starts[4].getTime()) continue;
    for (let q = 4; q >= 1; q--) {
      if (t >= starts[q - 1].getTime()) return { q: q as 1 | 2 | 3 | 4, fy };
    }
  }
  return { q: 1, fy: year }; // unreachable for valid settings
}

/** "Q3 FY 2026" */
export const quarterLabel = (q: number, fy: number) => `Q${q} FY ${fy}`;

/**
 * Soft checks on the four quarter starts (the settings API returns these as
 * warnings, not errors): all distinct, in cyclic order Q1→Q4, each about three
 * months after the previous one (91 days, give or take 7).
 */
export function quarterWarnings(s: QuarterSettings): string[] {
  const starts = quarterStarts(s);
  if (!starts.every((st) => isMonthDay(st.md))) return ['Each quarter start must be a valid month and day'];
  if (new Set(starts.map((st) => st.md)).size !== 4) return ['The four quarter starts must be different days'];
  const doy = starts.map((st) => Math.round((dateIn(2025, st.month, st.day).getTime() - Date.UTC(2025, 0, 1)) / 86400000));
  const warnings: string[] = [];
  for (let i = 0; i < 4; i++) {
    const gap = (doy[(i + 1) % 4] - doy[i] + 365) % 365;
    if (gap < 84 || gap > 99) {
      warnings.push(`Q${(i % 4) + 1} to Q${((i + 1) % 4) + 1} is ${gap} days; quarters are usually about 91 days apart`);
    }
  }
  return warnings;
}
