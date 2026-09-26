import type { TeamId } from '../types';
import { excelDate, excelDateTime, isLocalTimestamp } from './excel-dates';
import type { Sheet, Workbook } from './xlsx';

// Ninety XLSX exports → normalized rows (spec §6.3–6.4). Pure and shared:
// the browser classifies and normalizes each workbook, and the server
// re-validates the rows it is sent (sanitizeRow) and uses the same mapping
// helpers when it writes them.
//
// Open items only: issue, to-do, rock and headline rows with Completed On or
// Archived Date set are dropped here and counted as skipped. Milestones
// follow their rock: a completed milestone is kept (done = true), an
// archived one is dropped.

export type NinetyKind = 'issue' | 'todo' | 'rock' | 'milestone' | 'headline' | 'measurable';

export const NINETY_KINDS: readonly NinetyKind[] = ['issue', 'todo', 'rock', 'milestone', 'headline', 'measurable'];

export const KIND_LABELS: Record<NinetyKind, string> = {
  issue: 'Issues',
  todo: 'To-dos',
  rock: 'Rocks',
  milestone: 'Milestones',
  headline: 'Headlines',
  measurable: 'Measurables',
};

/** Kinds whose format hasn't been checked against a real Ninety export. */
export const UNVERIFIED_KINDS: readonly NinetyKind[] = ['headline', 'measurable'];

/** Kinds that are dropped when completed or archived (open items only). */
export const CLOSABLE_KINDS: readonly NinetyKind[] = ['issue', 'todo', 'rock', 'headline'];

/** The table each kind is imported into (and deduped against). */
export const TABLE_FOR_KIND: Record<NinetyKind, string> = {
  issue: 'issues',
  todo: 'todos',
  rock: 'rocks',
  milestone: 'steps',
  headline: 'headlines',
  measurable: 'scorecard_metrics',
};

export const MAX_ROWS = 3000;
export const MAX_TITLE = 500;
const MAX_TEXT = 20000;

export interface NinetyRow {
  /** `${kind}:${externalId ?? file|sheet|rowNumber}`, stable within a session */
  key: string;
  kind: NinetyKind;
  file: string;
  sheet: string;
  rowNumber: number;
  externalId: string | null;
  team: TeamId | null;
  teamRaw: string | null;
  /** trimmed Owner cell */
  ownerName: string | null;
  title: string;
  description: string | null;
  /** local wall time 'YYYY-MM-DD HH:MM:SS' (excelDateTime) */
  createdAt: string | null;
  completedOn: string | null;
  archivedOn: string | null;
  /** 'YYYY-MM-DD' (excelDate) */
  dueDate: string | null;
  /** completedOn || archivedOn */
  closed: boolean;
  // kind-specific
  horizon?: 'short' | 'long';
  priorityNumber?: number | null;
  who?: string | null;
  repeat?: string | null;
  statusRaw?: string | null;
  level?: 'company' | 'individual' | null;
  quarter?: string | null;
  /** milestone → parent rock title */
  rockName?: string | null;
  headlineType?: 'customer' | 'employee' | 'general';
  goal?: string | null;
  unit?: string | null;
  values?: Array<{ date: string; value: string }>;
  attachmentNames?: string | null;
  warnings: string[];
}

export interface ParsedSheet {
  name: string;
  kind: NinetyKind | null;
  headers: string[];
  /** data rows with a title */
  total: number;
  /** rows kept (open items) */
  open: number;
  /** completed or archived rows dropped */
  skipped: number;
}

export interface ParsedFile {
  file: string;
  recognised: boolean;
  kinds: NinetyKind[];
  sheets: ParsedSheet[];
  /** the kept rows (open items, plus milestones of rocks) */
  rows: NinetyRow[];
  /** completed or archived rows dropped (open items only) */
  skipped: number;
  /** team detected from the rows' Team column, sheet or file name */
  team: TeamId | null;
  warnings: string[];
}

// ── Small helpers ─────────────────────────────────────────────────────────

/** Header match key: case- and space-insensitive. */
export const normalizeHeader = (h: string) => (h ?? '').toLowerCase().replace(/\s+/g, '');

/** The Ninety id: the last 24-hex path segment of the Link. */
export function externalId(link: string | null | undefined): { id: string | null; warning?: string } {
  const s = (link ?? '').trim();
  if (!s) return { id: null };
  const m = /\/([0-9a-f]{24})(?:[/?#]|$)/i.exec(s);
  if (m) return { id: m[1].toLowerCase() };
  return { id: s.slice(0, 500), warning: 'The Ninety link has no recognisable id; the whole link is used for dedupe' };
}

export function teamFromText(s: string | null | undefined): TeamId | null {
  if (!s) return null;
  if (/leadership/i.test(s)) return 'leadership';
  if (/management/i.test(s)) return 'management';
  return null;
}

const text = (v: string | undefined | null): string | null => {
  const t = (v ?? '').trim();
  return t ? t : null;
};

/** Verbatim multi-line text (line breaks kept), or null when blank. */
const verbatim = (v: string | undefined | null): string | null => {
  const s = (v ?? '').replace(/\r\n?/g, '\n');
  return s.trim() ? s.replace(/^\n+|\s+$/g, '') : null;
};

function sheetHeaders(sheet: Sheet): { headerRow: number; headers: string[] } | null {
  const i = sheet.rows.findIndex((r) => r.some((c) => (c ?? '').trim()));
  return i < 0 ? null : { headerRow: i, headers: sheet.rows[i].map((h) => (h ?? '').trim()) };
}

// ── Classification ────────────────────────────────────────────────────────

function linkKind(sheet: Sheet, headerRow: number, linkCol: number): NinetyKind | null {
  if (linkCol < 0) return null;
  for (let i = headerRow + 1; i < sheet.rows.length; i++) {
    const link = (sheet.rows[i]?.[linkCol] ?? '').toLowerCase();
    if (!link.trim()) continue;
    if (link.includes('/issues/')) return 'issue';
    if (link.includes('/todos/')) return 'todo';
    if (link.includes('/rocks/')) return 'rock';
    if (link.includes('/milestones/')) return 'milestone';
    if (link.includes('/headlines/')) return 'headline';
    if (link.includes('/scorecard') || link.includes('/measurables/') || link.includes('/kpis/')) return 'measurable';
    return null;
  }
  return null;
}

const isDateHeader = (h: string) => !!h.trim() && excelDate(h) !== null;

function classifySheet(fileName: string, wb: Workbook, sheet: Sheet): NinetyKind | null {
  const hs = sheetHeaders(sheet);
  if (!hs) return null;
  const keys = hs.headers.map(normalizeHeader);
  const has = (h: string) => keys.includes(h);
  const name = normalizeHeader(sheet.name);
  const fname = normalizeHeader(fileName);
  const byLink = linkKind(sheet, hs.headerRow, keys.indexOf('link'));
  const hasTitle = has('title');
  if (!hasTitle) return null;

  if (name === 'short-term' || name === 'long-term' || byLink === 'issue') return 'issue';
  if (has('type') && has('priority') && !byLink) return 'issue';
  if ((has('duedate') && has('repeat')) || byLink === 'todo') return 'todo';
  const workbookHasRocks = wb.sheets.some((s) => normalizeHeader(s.name) === 'rocks');
  if (name === 'milestones' && (workbookHasRocks || has('rockname'))) return 'milestone';
  if (byLink === 'milestone' || (has('rockname') && !has('quarter'))) return 'milestone';
  if ((name === 'rocks' && (has('level') || has('quarter'))) || byLink === 'rock') return 'rock';
  if (byLink === 'headline' || name.includes('headline') || fname.includes('headline')) return 'headline';
  const dateHeaders = hs.headers.filter(isDateHeader).length;
  if (byLink === 'measurable' || dateHeaders >= 2 || name.includes('scorecard') || fname.includes('scorecard')) return 'measurable';
  return null;
}

// ── Row mapping helpers (used by the server too) ──────────────────────────

/** Rock status from Ninety's Status text (spec §6.4). */
export function rockStatusFrom(raw: string | null | undefined): {
  status: 'on_track' | 'off_track' | 'complete' | 'dropped';
  warning?: string;
} {
  const k = (raw ?? '').toLowerCase().replace(/[\s_-]+/g, '');
  if (!k || k === 'ontrack') return { status: 'on_track' };
  if (k === 'offtrack') return { status: 'off_track' };
  if (k === 'done' || k === 'complete' || k === 'completed') return { status: 'complete' };
  if (k === 'dropped' || k === 'cancelled' || k === 'canceled') return { status: 'dropped' };
  return { status: 'on_track', warning: `Unknown rock status "${raw}"; imported as on track` };
}

export function levelFrom(raw: string | null | undefined): 'company' | 'individual' | null {
  const k = (raw ?? '').trim().toLowerCase();
  if (k.startsWith('company')) return 'company';
  if (k.startsWith('individual')) return 'individual';
  return null;
}

export function headlineTypeFrom(raw: string | null | undefined): 'customer' | 'employee' | 'general' {
  const k = (raw ?? '').toLowerCase();
  if (k.includes('customer')) return 'customer';
  if (k.includes('employee')) return 'employee';
  return 'general';
}

const isRepeating = (repeat: string | null | undefined) => {
  const k = (repeat ?? '').toLowerCase().replace(/[’']/g, '').replace(/\s+/g, ' ').trim();
  return !!k && k !== 'dont repeat' && k !== 'do not repeat' && k !== 'none' && k !== 'never';
};

/**
 * The description (or rock notes) to store: the Ninety description, plus the
 * notes the importer appends — Who for issues (when it differs from the
 * owner), Repeat for to-dos, and attachment names.
 */
export function composeDescription(row: NinetyRow): string | null {
  const parts: string[] = [];
  if (row.description) parts.push(row.description);
  if (row.kind === 'issue' && row.who && row.who.trim().toLowerCase() !== (row.ownerName ?? '').trim().toLowerCase()) {
    parts.push(`Who (Ninety): ${row.who.trim()}`);
  }
  if (row.kind === 'todo' && isRepeating(row.repeat)) parts.push(`Repeats in Ninety: ${row.repeat!.trim()}`);
  if (row.attachmentNames) parts.push(`Attachments in Ninety (not imported): ${row.attachmentNames}`);
  return parts.length ? parts.join('\n\n').slice(0, MAX_TEXT) : null;
}

/** Scorecard frequency from the gaps between its date columns. */
export function frequencyFrom(dates: string[]): 'weekly' | 'monthly' | 'quarterly' {
  const ts = [...new Set(dates)].map((d) => Date.parse(`${d}T00:00:00Z`)).sort((a, b) => a - b);
  if (ts.length < 2) return 'weekly';
  const gaps = ts.slice(1).map((t, i) => (t - ts[i]) / 86400000).sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)];
  if (median < 15) return 'weekly';
  if (median < 60) return 'monthly';
  return 'quarterly';
}

/** Issues in the order they get ranks: Priority ascending (blanks last), then Created Date. */
export function issueOrder(a: NinetyRow, b: NinetyRow): number {
  const pa = a.priorityNumber ?? Number.POSITIVE_INFINITY;
  const pb = b.priorityNumber ?? Number.POSITIVE_INFINITY;
  if (pa !== pb) return pa - pb;
  const ca = a.createdAt ?? '9999';
  const cb = b.createdAt ?? '9999';
  if (ca !== cb) return ca < cb ? -1 : 1;
  return a.rowNumber - b.rowNumber;
}

/** Key for a rock's quarter → period choice. */
export const periodKey = (team: TeamId, quarter: string) => `${team}|${quarter.trim()}`;

/** Key for matching a milestone's Rock Name to a rock title in a team. */
export const rockTitleKey = (team: TeamId | null, title: string) => `${team ?? ''}|${title.trim().toLowerCase()}`;

// ── Normalization ─────────────────────────────────────────────────────────

function normalizeSheet(fileName: string, sheet: Sheet, kind: NinetyKind): { rows: NinetyRow[]; sheetInfo: ParsedSheet; warnings: string[] } {
  const hs = sheetHeaders(sheet)!;
  const keys = hs.headers.map(normalizeHeader);
  const idx = (...names: string[]) => {
    for (const n of names) {
      const i = keys.indexOf(n);
      if (i >= 0) return i;
    }
    return -1;
  };
  const col = {
    owner: idx('owner'),
    title: idx('title'),
    description: idx('description'),
    type: idx('type'),
    priority: idx('priority'),
    team: idx('team'),
    who: idx('who'),
    attachments: idx('attachmentnames', 'attachments'),
    completed: idx('completedon', 'completeddate'),
    link: idx('link'),
    created: idx('createddate', 'createdon'),
    archived: idx('archiveddate', 'archivedon'),
    due: idx('duedate'),
    repeat: idx('repeat'),
    status: idx('status'),
    level: idx('level'),
    quarter: idx('quarter'),
    rockName: idx('rockname', 'rock'),
    category: idx('category', 'type'),
    goal: idx('goal'),
    unit: idx('units', 'unit'),
  };
  const dateCols =
    kind === 'measurable'
      ? hs.headers.map((h, i) => ({ i, date: isDateHeader(h) ? excelDate(h) : null })).filter((d): d is { i: number; date: string } => !!d.date)
      : [];

  const warnings: string[] = [];
  const rows: NinetyRow[] = [];
  let total = 0;
  let skipped = 0;
  let untitled = 0;

  for (let r = hs.headerRow + 1; r < sheet.rows.length; r++) {
    const cells = sheet.rows[r] ?? [];
    if (!cells.some((c) => (c ?? '').trim())) continue;
    const get = (i: number) => (i >= 0 ? (cells[i] ?? '') : '');
    const rowNumber = r + 1;
    const title = (get(col.title) ?? '').trim();
    if (!title) {
      untitled++;
      continue;
    }
    total++;
    const rowWarnings: string[] = [];
    const link = externalId(get(col.link));
    if (link.warning) rowWarnings.push(link.warning);
    if (!link.id) rowWarnings.push('No Ninety id: may duplicate if imported twice');
    const teamRaw = text(get(col.team));
    const team = teamFromText(teamRaw) ?? teamFromText(sheet.name) ?? teamFromText(fileName);
    const completedRaw = text(get(col.completed));
    const archivedRaw = text(get(col.archived));
    const completedOn = completedRaw ? excelDateTime(completedRaw) : null;
    const archivedOn = archivedRaw ? excelDateTime(archivedRaw) : null;
    const closed = !!(completedRaw || archivedRaw);

    // Open items only; a milestone is dropped only when archived
    if (kind === 'milestone' ? !!archivedRaw : closed && CLOSABLE_KINDS.includes(kind)) {
      skipped++;
      continue;
    }

    const dueRaw = text(get(col.due));
    const dueDate = dueRaw ? excelDate(dueRaw) : null;
    if (dueRaw && !dueDate) rowWarnings.push(`Due date "${dueRaw}" could not be read`);
    const createdRaw = text(get(col.created));
    const createdAt = createdRaw ? excelDateTime(createdRaw) : null;
    if (title.length > MAX_TITLE) rowWarnings.push(`Title shortened to ${MAX_TITLE} characters`);

    const row: NinetyRow = {
      key: `${kind}:${link.id ?? `${fileName}|${sheet.name}|${rowNumber}`}`,
      kind,
      file: fileName,
      sheet: sheet.name,
      rowNumber,
      externalId: link.id,
      team,
      teamRaw,
      ownerName: text(get(col.owner)),
      title: title.slice(0, MAX_TITLE),
      description: verbatim(get(col.description)),
      createdAt,
      completedOn,
      archivedOn,
      dueDate,
      closed,
      attachmentNames: text(get(col.attachments)),
      warnings: rowWarnings,
    };

    if (kind === 'issue') {
      const type = normalizeHeader(get(col.type));
      const sheetName = normalizeHeader(sheet.name);
      row.horizon = type.startsWith('long') ? 'long' : type.startsWith('short') ? 'short' : sheetName.startsWith('long') ? 'long' : 'short';
      const p = text(get(col.priority));
      const n = p === null ? null : Number(p);
      row.priorityNumber = n !== null && Number.isFinite(n) ? n : null;
      if (p !== null && row.priorityNumber === null) rowWarnings.push(`Priority "${p}" is not a number; ranked last`);
      row.who = text(get(col.who));
    } else if (kind === 'todo') {
      row.repeat = text(get(col.repeat));
      if (isRepeating(row.repeat)) rowWarnings.push(`Repeats in Ninety (${row.repeat}); imported once`);
    } else if (kind === 'rock') {
      row.statusRaw = text(get(col.status));
      const st = rockStatusFrom(row.statusRaw);
      if (st.warning) rowWarnings.push(st.warning);
      row.level = levelFrom(get(col.level));
      row.quarter = text(get(col.quarter));
    } else if (kind === 'milestone') {
      row.rockName = text(get(col.rockName));
      if (!row.rockName) rowWarnings.push('No Rock Name: cannot be placed under a rock');
      if (row.description) rowWarnings.push('Milestone descriptions are not stored yet');
    } else if (kind === 'headline') {
      row.headlineType = headlineTypeFrom(get(col.category));
    } else if (kind === 'measurable') {
      row.goal = text(get(col.goal));
      row.unit = text(get(col.unit));
      row.values = dateCols
        .map((d) => ({ date: d.date, value: (cells[d.i] ?? '').trim() }))
        .filter((v) => v.value !== '');
      row.closed = false;
    }
    rows.push(row);
  }

  if (untitled) warnings.push(`${sheet.name}: ${untitled} row${untitled === 1 ? '' : 's'} with no Title ignored`);
  return {
    rows,
    warnings,
    sheetInfo: { name: sheet.name, kind, headers: hs.headers, total, open: rows.length, skipped },
  };
}

/** Classifies each sheet of a workbook and normalizes the rows of the ones recognised. */
export function parseNinetyWorkbook(fileName: string, wb: Workbook): ParsedFile {
  const sheets: ParsedSheet[] = [];
  const rows: NinetyRow[] = [];
  const warnings: string[] = [];
  for (const sheet of wb.sheets) {
    const kind = classifySheet(fileName, wb, sheet);
    if (!kind) {
      const hs = sheetHeaders(sheet);
      sheets.push({ name: sheet.name, kind: null, headers: hs?.headers ?? [], total: 0, open: 0, skipped: 0 });
      continue;
    }
    const out = normalizeSheet(fileName, sheet, kind);
    sheets.push(out.sheetInfo);
    rows.push(...out.rows);
    warnings.push(...out.warnings);
  }
  const kinds = [...new Set(sheets.map((s) => s.kind).filter((k): k is NinetyKind => !!k))];

  // The file's team: the most common row team, else the file name
  const tally = new Map<TeamId, number>();
  for (const r of rows) if (r.team) tally.set(r.team, (tally.get(r.team) ?? 0) + 1);
  const team = [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? teamFromText(fileName);

  return {
    file: fileName,
    recognised: kinds.length > 0,
    kinds,
    sheets,
    rows,
    skipped: sheets.reduce((n, s) => n + s.skipped, 0),
    team,
    warnings,
  };
}

// ── Server-side validation ────────────────────────────────────────────────

const str = (v: unknown, max: number): string | null => {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string') throw new Error('expected text');
  const t = v.trim();
  return t ? t.slice(0, max) : null;
};
const dateOrNull = (v: unknown, what: string): string | null => {
  if (v === null || v === undefined || v === '') return null;
  const d = typeof v === 'string' ? excelDate(v) : null;
  if (!d || d !== v) throw new Error(`invalid ${what}`);
  return d;
};
const tsOrNull = (v: unknown, what: string): string | null => {
  if (v === null || v === undefined || v === '') return null;
  if (!isLocalTimestamp(v)) throw new Error(`invalid ${what}`);
  return v;
};

/**
 * Re-validates a row sent by the browser. Returns a clean NinetyRow (only
 * known fields, trimmed and capped) or an error message. Does not apply the
 * open-items rule; the caller rejects closed rows.
 */
export function sanitizeRow(x: unknown): NinetyRow | string {
  if (!x || typeof x !== 'object') return 'row is not an object';
  const r = x as Record<string, unknown>;
  try {
    if (!NINETY_KINDS.includes(r.kind as NinetyKind)) return 'invalid kind';
    const kind = r.kind as NinetyKind;
    const title = str(r.title, MAX_TITLE);
    if (!title) return 'title is required';
    if (r.team !== 'leadership' && r.team !== 'management') return `"${title}" has no team`;
    const ext = str(r.externalId, 500);
    const row: NinetyRow = {
      key: str(r.key, 1200) ?? `${kind}:${ext}`,
      kind,
      file: str(r.file, 300) ?? '',
      sheet: str(r.sheet, 200) ?? '',
      rowNumber: Number.isInteger(r.rowNumber) ? (r.rowNumber as number) : 0,
      externalId: ext,
      team: r.team,
      teamRaw: str(r.teamRaw, 200),
      ownerName: str(r.ownerName, 200),
      title,
      description: typeof r.description === 'string' && r.description.trim() ? r.description.slice(0, MAX_TEXT) : null,
      createdAt: tsOrNull(r.createdAt, 'created date'),
      completedOn: tsOrNull(r.completedOn, 'completed date'),
      archivedOn: tsOrNull(r.archivedOn, 'archived date'),
      dueDate: dateOrNull(r.dueDate, 'due date'),
      closed: r.closed === true,
      attachmentNames: str(r.attachmentNames, 2000),
      warnings: [],
    };
    if (kind === 'issue') {
      if (r.horizon !== 'short' && r.horizon !== 'long') return 'invalid horizon';
      row.horizon = r.horizon;
      const p = r.priorityNumber;
      if (p !== null && p !== undefined && (typeof p !== 'number' || !Number.isFinite(p))) return 'invalid priority';
      row.priorityNumber = (p as number | null | undefined) ?? null;
      row.who = str(r.who, 200);
    } else if (kind === 'todo') {
      row.repeat = str(r.repeat, 200);
    } else if (kind === 'rock') {
      row.statusRaw = str(r.statusRaw, 100);
      if (r.level !== null && r.level !== undefined && r.level !== 'company' && r.level !== 'individual') return 'invalid level';
      row.level = (r.level as 'company' | 'individual' | null | undefined) ?? null;
      row.quarter = str(r.quarter, 120);
    } else if (kind === 'milestone') {
      row.rockName = str(r.rockName, MAX_TITLE);
    } else if (kind === 'headline') {
      if (r.headlineType !== undefined && !['customer', 'employee', 'general'].includes(r.headlineType as string)) return 'invalid headline type';
      row.headlineType = (r.headlineType as NinetyRow['headlineType']) ?? 'general';
    } else if (kind === 'measurable') {
      row.goal = str(r.goal, 200);
      row.unit = str(r.unit, 50);
      const values = Array.isArray(r.values) ? r.values : [];
      if (values.length > 520) return 'too many scorecard values';
      row.values = values.map((v) => {
        const date = dateOrNull((v as { date?: unknown })?.date, 'scorecard date');
        const value = str((v as { value?: unknown })?.value, 200);
        if (!date || value === null) throw new Error('invalid scorecard value');
        return { date, value };
      });
    }
    return row;
  } catch (err) {
    return err instanceof Error ? err.message : 'invalid row';
  }
}

/** True when the open-items rule rejects this row on commit. */
export function isClosedRow(row: NinetyRow): boolean {
  if (row.kind === 'milestone') return !!row.archivedOn;
  if (!CLOSABLE_KINDS.includes(row.kind)) return false;
  return !!(row.completedOn || row.archivedOn || row.closed);
}
