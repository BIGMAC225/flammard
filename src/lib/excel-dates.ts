// Excel dates, shared by the browser (Ninety import parsing) and the server.
//
// Excel stores dates as serial numbers in the 1900 date system: 25569 is
// 1970-01-01, and the fraction is the time of day. Ninety writes the firm's
// local wall-clock time, so the result is local time with no zone; the
// server converts it with `$ts::timestamp at time zone <settings timezone>`.
// UTC getters are used throughout so the browser's own timezone never
// shifts a value.

const EPOCH_SERIAL = 25569; // 1970-01-01
const MAX_SERIAL = 2958465; // 9999-12-31
const DAY_MS = 86400000;

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

function validYmd(y: number, m: number, d: number): string | null {
  if (!(y >= 1000 && y <= 9999) || !(m >= 1 && m <= 12) || !(d >= 1 && d <= 31)) return null;
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

function serialToDate(v: string): Date | null {
  if (!/^-?\d+(\.\d+)?(e[+-]?\d+)?$/i.test(v)) return null;
  const serial = Number(v);
  if (!Number.isFinite(serial) || serial < 1) return null;
  if (serial > MAX_SERIAL) {
    console.warn(`Excel date serial out of range: ${v}`);
    return null;
  }
  return new Date(Math.round((serial - EPOCH_SERIAL) * DAY_MS));
}

/**
 * A calendar date as 'YYYY-MM-DD', or null. Accepts an Excel serial
 * ('46287' → '2026-09-22'; any time fraction is ignored), 'YYYY-MM-DD'
 * (optionally followed by a time) and 'M/D/YYYY'.
 */
export function excelDate(v: string | null | undefined): string | null {
  const s = (v ?? '').trim();
  if (!s) return null;
  let m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/.exec(s);
  if (m) return validYmd(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (m) return validYmd(+m[3], +m[1], +m[2]);
  const d = serialToDate(s);
  if (!d) return null;
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/**
 * A local wall-clock timestamp as 'YYYY-MM-DD HH:MM:SS' (no zone), or null.
 * '46224.8743055556' → '2026-07-21 20:59:00'. Also accepts 'YYYY-MM-DD',
 * 'YYYY-MM-DD HH:MM[:SS]' (or with 'T') and 'M/D/YYYY' (midnight).
 */
export function excelDateTime(v: string | null | undefined): string | null {
  const s = (v ?? '').trim();
  if (!s) return null;
  let m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?)?$/.exec(s);
  if (m) {
    const day = validYmd(+m[1], +m[2], +m[3]);
    if (!day) return null;
    const [h, mi, se] = [+(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0)];
    if (h > 23 || mi > 59 || se > 59) return null;
    return `${day} ${pad(h)}:${pad(mi)}:${pad(se)}`;
  }
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (m) {
    const day = validYmd(+m[3], +m[1], +m[2]);
    return day ? `${day} 00:00:00` : null;
  }
  const d = serialToDate(s);
  if (!d) return null;
  const t = new Date(Math.round(d.getTime() / 1000) * 1000); // nearest second
  return (
    `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())} ` +
    `${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:${pad(t.getUTCSeconds())}`
  );
}

/** True for a 'YYYY-MM-DD HH:MM:SS' local timestamp as excelDateTime returns it. */
export function isLocalTimestamp(v: unknown): v is string {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(v) && excelDateTime(v) === v;
}
