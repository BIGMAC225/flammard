// Tests for src/lib/taxdome-files.ts (TaxDome webhook file handling).
//   node tests/taxdome-files.test.mjs            synthetic fixtures only
//   node tests/taxdome-files.test.mjs <dir>      also the real report files in <dir>
//                                                (the CSVs and a PDF from a TaxDome email)
// Needs Node 22.18+ / 24 (runs the .ts module directly via type stripping).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { collectReportFiles, ReportTooLargeError, MAX_REPORT_BYTES } from '../src/lib/taxdome-files.ts';

const csvA = '﻿"Report","Write-Up/Down %"\n"Date range","Last 7 Days"\n"Total","12.5%"\n';
const csvB = '"Billed Invoices","Amount"\n"Total","$4,321.00"\n';
const fakePdf = strToU8('%PDF-1.4\n% fake pdf body\n%%EOF\n');
const file = (name, bytes, type = '') => ({ name, type, bytes: typeof bytes === 'string' ? strToU8(bytes) : bytes });
const noNul = (s) => assert.ok(!s.includes('\u0000'), 'text contains NUL');

test('zip of CSVs -> one text section per CSV, no pdf', () => {
  const zip = zipSync({ 'Write-UpDown % (x).csv': strToU8(csvA), 'Billed Invoices per  (y).csv': strToU8(csvB), '__MACOSX/._a.csv': new Uint8Array([0, 1, 2]), 'dir/': new Uint8Array() });
  const r = collectReportFiles([file('Write-UpDown % (x)_and_others.zip', zip, 'application/zip')]);
  assert.deepEqual(r.names, ['Write-UpDown % (x).csv', 'Billed Invoices per  (y).csv']);
  assert.equal(r.pdf, null);
  assert.equal(r.skipped.length, 0);
  assert.equal(r.text.match(/^=== File: /gm).length, 2);
  assert.ok(r.text.startsWith('=== File: Write-UpDown % (x).csv ===\n"Report"'), 'BOM stripped');
  noNul(r.text);
});

test('same CSVs as separate files -> identical text', () => {
  const zip = zipSync({ 'a.csv': strToU8(csvA), 'b.csv': strToU8(csvB) });
  const fromZip = collectReportFiles([file('r.zip', zip)]);
  const direct = collectReportFiles([file('a.csv', csvA, 'text/csv'), file('b.csv', csvB, 'text/csv')]);
  assert.equal(direct.text, fromZip.text);
  assert.deepEqual(direct.names, fromZip.names);
});

test('PDF alone -> pdf set, no text', () => {
  const r = collectReportFiles([file('Weekly Numbers.pdf', fakePdf, 'application/pdf')]);
  assert.equal(r.text, null);
  assert.ok(Buffer.isBuffer(r.pdf));
  assert.deepEqual(r.names, ['Weekly Numbers.pdf']);
});

test('PDF sniffed by magic bytes without name or type (file_base64 path)', () => {
  const r = collectReportFiles([file('report', fakePdf)]);
  assert.ok(r.pdf);
});

test('zip with only a PDF -> pdf set', () => {
  const r = collectReportFiles([file('report', zipSync({ 'Weekly Numbers.pdf': fakePdf }))]);
  assert.equal(r.text, null);
  assert.ok(r.pdf);
  assert.equal(r.pdf.subarray(0, 5).toString('latin1'), '%PDF-');
});

test('binary junk is skipped, not decoded as text', () => {
  const junk = new Uint8Array(4096).map((_, i) => (i * 7919) % 256);
  const r = collectReportFiles([file('junk.bin', junk), file('a.csv', csvA)]);
  assert.deepEqual(r.skipped, ['junk.bin (not a PDF or text file)']);
  assert.deepEqual(r.names, ['a.csv']);
  noNul(r.text);
  const only = collectReportFiles([file('junk.bin', junk)]);
  assert.equal(only.text, null);
  assert.equal(only.pdf, null);
});

test('zip bomb over the 20 MB limit -> ReportTooLargeError (413)', () => {
  const bomb = zipSync({ 'big.csv': new Uint8Array(MAX_REPORT_BYTES + 1) }, { level: 9 });
  assert.ok(bomb.length < 100_000, `bomb is small (${bomb.length} bytes)`);
  assert.throws(() => collectReportFiles([file('bomb.zip', bomb)]), (e) => e instanceof ReportTooLargeError && e.status === 413);
});

test('zip with too many entries -> ReportTooLargeError', () => {
  const many = Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`f${i}.csv`, strToU8('a,b\n1,2\n')]));
  assert.throws(() => collectReportFiles([file('many.zip', zipSync(many))]), ReportTooLargeError);
});

test('corrupt .zip is skipped with a reason', () => {
  const r = collectReportFiles([file('broken.zip', new Uint8Array([0x50, 0x4b, 3, 4, 0, 0, 0]))]);
  assert.equal(r.skipped.length, 1);
  assert.match(r.skipped[0], /^broken\.zip \(could not unzip/);
});

const dir = process.argv[2];
if (dir) {
  test(`real files in ${dir}`, () => {
    const names = readdirSync(dir).sort();
    const csvs = names.filter((n) => n.endsWith('.csv'));
    const pdfName = names.find((n) => n.endsWith('.pdf'));
    const read = (n) => file(n, new Uint8Array(readFileSync(join(dir, n))));
    const zip = zipSync(Object.fromEntries(csvs.map((n) => [n, read(n).bytes])));
    const zipName = `${csvs[csvs.length - 1].replace(/\.csv$/, '')}_and_others.zip`;
    const a = collectReportFiles([file(zipName, zip, 'application/zip')]);
    assert.equal(a.names.length, csvs.length);
    assert.equal(a.text.match(/^=== File: /gm).length, csvs.length);
    assert.equal(a.pdf, null);
    assert.equal(a.skipped.length, 0);
    noNul(a.text);
    const b = collectReportFiles(csvs.map(read));
    assert.equal(b.text, a.text);
    if (pdfName) {
      const c = collectReportFiles([read(pdfName)]);
      assert.equal(c.text, null);
      assert.ok(c.pdf);
      const d = collectReportFiles([file('pdf.zip', zipSync({ [pdfName]: read(pdfName).bytes }))]);
      assert.ok(d.pdf && d.pdf.equals(c.pdf));
    }
    console.log(`real: ${csvs.length} CSVs, zip ${zip.length} bytes -> text ${a.text.length} chars; names: ${a.names.join(' | ')}`);
  });
}
