import { unzipSync } from 'fflate';

// Turns the files a TaxDome report webhook receives into what the extractor
// needs: the CSV/text files joined under their names, or a PDF when there's no
// text. Zapier's Gmail "All Attachments" arrives as one .zip holding every
// attachment, so zips are expanded in memory first. Pure (no I/O) so it can
// be tested without the server.

export const MAX_REPORT_BYTES = 20 * 1024 * 1024;
export const MAX_ZIP_ENTRIES = 50;

export interface ReportFile {
  name: string;
  type?: string;
  bytes: Uint8Array;
}

export interface CollectedReport {
  /** Text files joined as "=== File: name ===\n<text>", or null when there are none. */
  text: string | null;
  /** The first PDF, used only when there's no text. */
  pdf: Buffer | null;
  /** Every file used, zip entries listed by their own names. */
  names: string[];
  /** Files left out, with the reason. */
  skipped: string[];
}

/** Thrown when the files (after unzipping) are over the limits; maps to HTTP 413. */
export class ReportTooLargeError extends Error {
  status = 413;
}

/** Postgres text can't hold NUL characters; strip them before any insert. */
export function stripNul(s: string): string;
export function stripNul(s: string | null): string | null;
export function stripNul(s: string | null): string | null {
  return s == null ? s : s.replace(/\u0000/g, '');
}

const tooLarge = () => new ReportTooLargeError('Files are too large (20 MB max)');

const startsWith = (b: Uint8Array, sig: number[]) => sig.every((v, i) => b[i] === v);
const isPdf = (f: ReportFile) =>
  /pdf/i.test(f.type ?? '') || /\.pdf$/i.test(f.name) || startsWith(f.bytes, [0x25, 0x50, 0x44, 0x46, 0x2d]); // %PDF-
const isZip = (f: ReportFile) =>
  startsWith(f.bytes, [0x50, 0x4b, 0x03, 0x04]) || // PK\x03\x04
  /\.zip$/i.test(f.name) ||
  /zip/i.test(f.type ?? '');

/** Decodes UTF-8 text, or returns null for binary (NUL bytes or many invalid sequences). */
function decodeText(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) return null;
  const s = new TextDecoder('utf-8').decode(bytes);
  const bad = (s.match(/�/g) ?? []).length;
  if (bad > Math.max(8, s.length * 0.01)) return null;
  return s.replace(/^﻿/, '').trim();
}

export function collectReportFiles(files: ReportFile[]): CollectedReport {
  const texts: string[] = [];
  const names: string[] = [];
  const skipped: string[] = [];
  let pdf: Buffer | null = null;
  let total = 0;
  let entries = 0;

  const add = (f: ReportFile) => {
    if (isPdf(f)) {
      names.push(f.name);
      if (!pdf) pdf = Buffer.from(f.bytes);
      return;
    }
    const text = decodeText(f.bytes);
    if (text == null) {
      skipped.push(`${f.name} (not a PDF or text file)`);
      return;
    }
    names.push(f.name);
    texts.push(`=== File: ${f.name} ===\n${text}`);
  };

  for (const f of files) {
    if (f.bytes.length > MAX_REPORT_BYTES) throw tooLarge();
    if (!isZip(f)) {
      total += f.bytes.length;
      if (total > MAX_REPORT_BYTES) throw tooLarge();
      add(f);
      continue;
    }

    // The limit applies to what comes out of the zip, checked from the
    // directory before anything is inflated (fflate also caps each entry's
    // output at its declared size, so a lying header can't grow past it).
    let unzipped: Record<string, Uint8Array>;
    try {
      unzipped = unzipSync(f.bytes, {
        filter: (e) => {
          if (++entries > MAX_ZIP_ENTRIES) throw new ReportTooLargeError(`Zip has too many files (${MAX_ZIP_ENTRIES} max)`);
          const base = e.name.split('/').pop() ?? '';
          if (e.name.endsWith('/') || e.name.startsWith('__MACOSX/') || base.startsWith('._') || base === '.DS_Store') return false;
          if (e.compression !== 0 && e.compression !== 8) {
            skipped.push(`${e.name} (unsupported zip compression)`);
            return false;
          }
          total += e.originalSize;
          if (total > MAX_REPORT_BYTES) throw tooLarge();
          return true;
        },
      });
    } catch (err) {
      if (err instanceof ReportTooLargeError) throw err;
      skipped.push(`${f.name} (could not unzip: ${err instanceof Error ? err.message : 'unknown'})`);
      continue;
    }
    for (const [path, bytes] of Object.entries(unzipped)) add({ name: path.split('/').pop() || path, bytes });
  }

  return { text: texts.length ? texts.join('\n\n') : null, pdf: texts.length ? null : pdf, names, skipped };
}
