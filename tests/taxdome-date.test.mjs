// Tests for src/lib/taxdome-date.ts (which day a TaxDome import is dated).
//   node --test tests/taxdome-date.test.mjs
// Needs Node 22.18+ / 24 (runs the .ts module directly via type stripping).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reportProducedAt, taxdomeReportDate, firmDate } from '../src/lib/taxdome-date.ts';

const header = (stamp) => `"Data extract produced by Jane Doe (12345) on ${stamp}"`;
const csv = (stamp, body = '"Report","Write-Up/Down %"\n"Date range","Last 7 Days"\n"Total","12.5%"\n') =>
  `${header(stamp)}\n${body}`;
const section = (name, content) => `=== File: ${name} ===\n${content}`;
const NOW = new Date('2026-10-18T12:00:00Z');

test('single CSV -> its production day in Chicago', () => {
  const text = section('a.csv', csv('10/14/2026 15:10 UTC'));
  assert.equal(reportProducedAt(text).toISOString(), '2026-10-14T15:10:00.000Z');
  assert.equal(taxdomeReportDate(text, NOW), '2026-10-14');
});

test('multiple CSVs -> latest production stamp wins', () => {
  const text = [
    section('a.csv', csv('10/13/2026 22:00 UTC')),
    section('b.csv', csv('10/14/2026 15:10 UTC')),
    section('c.csv', csv('10/14/2026 15:09 UTC')),
  ].join('\n\n');
  assert.equal(reportProducedAt(text).toISOString(), '2026-10-14T15:10:00.000Z');
  assert.equal(taxdomeReportDate(text, NOW), '2026-10-14');
});

test('late-evening Chicago (early UTC) rolls back to the previous day', () => {
  assert.equal(taxdomeReportDate(csv('10/15/2026 03:00 UTC'), NOW), '2026-10-14');
  // Winter (CST, UTC-6) too
  assert.equal(taxdomeReportDate(csv('01/15/2026 05:59 UTC'), NOW), '2026-01-14');
  assert.equal(taxdomeReportDate(csv('01/15/2026 06:00 UTC'), NOW), '2026-01-15');
});

test('no header -> today in Chicago, not UTC', () => {
  const text = '"Report","Amount"\n"Total","$4,321.00"\n';
  assert.equal(reportProducedAt(text), null);
  assert.equal(taxdomeReportDate(text, NOW), '2026-10-18');
  // 02:00 UTC on the 19th is still the 18th in Chicago
  assert.equal(taxdomeReportDate(text, new Date('2026-10-19T02:00:00Z')), '2026-10-18');
  assert.equal(taxdomeReportDate(null, NOW), '2026-10-18');
  assert.equal(taxdomeReportDate('', NOW), '2026-10-18');
});

test('PDF text with a seconds stamp is used when there is no CSV header', () => {
  const text = 'Weekly Numbers\nLast updated 10/17/2026 15:26:16 UTC\nWrite-Up/Down 12.5%';
  assert.equal(reportProducedAt(text).toISOString(), '2026-10-17T15:26:16.000Z');
  assert.equal(taxdomeReportDate(text, NOW), '2026-10-17');
});

test('CSV production header wins over other UTC stamps in the text', () => {
  const text = `${csv('10/14/2026 15:10 UTC')}\n"Last activity","10/16/2026 09:00 UTC"\n`;
  assert.equal(taxdomeReportDate(text, NOW), '2026-10-14');
});

test('malformed stamps are ignored', () => {
  assert.equal(reportProducedAt(header('13/40/2026 15:10 UTC')), null);
  assert.equal(reportProducedAt(header('02/31/2026 15:10 UTC')), null);
  assert.equal(reportProducedAt('10/14/2026 25:10 UTC'), null);
  assert.equal(taxdomeReportDate(header('02/31/2026 15:10 UTC'), NOW), '2026-10-18');
});

test('firmDate formats as YYYY-MM-DD', () => {
  assert.equal(firmDate(new Date('2026-03-08T12:00:00Z')), '2026-03-08');
});
