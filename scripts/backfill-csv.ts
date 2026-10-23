// Replays the archived daily fulfillment zips/CSVs into job_snapshots, one
// import run (source 'csv') per archived date, oldest first — for filling the
// days the API poller didn't run yet, or replaying history after a schema
// change. A directory imports every *.zip and *.csv in it sorted by name
// (the "(YYYY-MM-DD HH_mm_ss)" stamp in TaxDome's file names makes name order
// date order); each file continues on error and the script exits 1 if any
// file failed. Rows a run has already written are skipped by the import
// (on conflict do nothing), so a re-run is safe.
//
//   node scripts/backfill-csv.ts <file-or-directory>
//
// Needs DATABASE_URL or NETLIFY_DATABASE_URL in the environment. Node 24 runs
// the .ts files directly.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { collectReportFiles } from '../src/lib/taxdome-files.ts';
import { runFulfillmentCsvImport } from '../src/lib/fulfillment-csv-import.ts';

const target = process.argv[2];
if (!target) {
  console.error('Usage: node scripts/backfill-csv.ts <file-or-directory>');
  process.exit(1);
}
if (!process.env.DATABASE_URL && !process.env.NETLIFY_DATABASE_URL) {
  console.error('Set DATABASE_URL or NETLIFY_DATABASE_URL to the Postgres connection string.');
  process.exit(1);
}

const stat = statSync(target);
const files = stat.isDirectory()
  ? readdirSync(target)
      .filter((name) => /\.(csv|zip)$/i.test(name))
      .sort()
      .map((name) => join(target, name))
  : [target];

let failed = 0;
for (const path of files) {
  const name = path.split(/[\\/]/).pop() ?? path;
  try {
    const bytes = new Uint8Array(readFileSync(path));
    const collected = collectReportFiles([{ name, bytes }]);
    if (!collected.text) throw new Error('no CSV text found in the file');
    const result = await runFulfillmentCsvImport({ fileName: name, text: collected.text });
    console.log(
      `${name}: run ${result.run_id} snapshot ${result.snapshot_date} rows_in_file ${result.rows_in_file} jobs_written ${result.jobs_written}`
    );
  } catch (err) {
    failed++;
    console.log(`${name}: FAILED — ${err instanceof Error ? err.message : err}`);
  }
}

console.log(`${files.length - failed}/${files.length} files imported`);
process.exitCode = failed ? 1 : 0;
