// Tests for src/lib/taxdome-job.ts (webhook -> background import hand-off:
// job signing and payload validation).
//   node --test tests/taxdome-job.test.mjs
// Needs Node 22.18+ / 24 (runs the .ts module directly via type stripping).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isJobId,
  jobKeys,
  parseJobMeta,
  parseJobRequest,
  signTaxdomeJob,
  verifyTaxdomeJob,
} from '../src/lib/taxdome-job.ts';

const secret = 'test-session-secret';
const req = { job_id: '0b9f3c1e-5a2d-4c7b-9e1f-2a3b4c5d6e7f', team: 'leadership', file_name: 'a.csv, b.csv' };

test('signature round-trips and is bound to secret, job, team and file name', () => {
  const sig = signTaxdomeJob(secret, req);
  assert.match(sig, /^[0-9a-f]{64}$/);
  assert.ok(verifyTaxdomeJob(secret, req, sig));
  assert.ok(!verifyTaxdomeJob('other-secret', req, sig));
  assert.ok(!verifyTaxdomeJob(secret, { ...req, team: 'management' }, sig));
  assert.ok(!verifyTaxdomeJob(secret, { ...req, file_name: 'x.pdf' }, sig));
  assert.ok(!verifyTaxdomeJob(secret, { ...req, job_id: '1b9f3c1e-5a2d-4c7b-9e1f-2a3b4c5d6e7f' }, sig));
  assert.ok(!verifyTaxdomeJob(secret, req, undefined));
  assert.ok(!verifyTaxdomeJob(secret, req, sig.slice(1)));
  assert.ok(!verifyTaxdomeJob(undefined, req, sig));
});

test('a null file name signs like an empty one but differs from a real name', () => {
  const a = { ...req, file_name: null };
  assert.ok(verifyTaxdomeJob(secret, a, signTaxdomeJob(secret, a)));
  assert.notEqual(signTaxdomeJob(secret, a), signTaxdomeJob(secret, req));
});

test('signing without SESSION_SECRET throws', () => {
  assert.throws(() => signTaxdomeJob(undefined, req), /SESSION_SECRET/);
});

test('parseJobRequest accepts the route body and rejects junk', () => {
  assert.deepEqual(parseJobRequest(JSON.stringify(req)), req);
  assert.deepEqual(parseJobRequest(JSON.stringify({ job_id: req.job_id, team: 'management' })), {
    job_id: req.job_id,
    team: 'management',
    file_name: null,
  });
  assert.equal(parseJobRequest(''), null);
  assert.equal(parseJobRequest('not json'), null);
  assert.equal(parseJobRequest(JSON.stringify({ ...req, job_id: '../etc/passwd' })), null);
  assert.equal(parseJobRequest(JSON.stringify({ ...req, team: '' })), null);
  assert.equal(parseJobRequest(JSON.stringify({ ...req, file_name: 5 })), null);
});

test('job ids and blob keys', () => {
  assert.ok(isJobId(req.job_id));
  assert.ok(!isJobId('abc'));
  assert.ok(!isJobId(null));
  assert.deepEqual(jobKeys(req.job_id), { meta: `${req.job_id}/meta`, pdf: `${req.job_id}/pdf` });
});

test('parseJobMeta validates the stored report', () => {
  const meta = { team: 'leadership', fileName: 'a.csv', text: '=== File: a.csv ===\n1,2', hasPdf: false };
  assert.deepEqual(parseJobMeta(meta), meta);
  assert.deepEqual(parseJobMeta({ team: 'leadership', fileName: null, text: null, hasPdf: true }), {
    team: 'leadership',
    fileName: null,
    text: null,
    hasPdf: true,
  });
  assert.equal(parseJobMeta(null), null);
  assert.equal(parseJobMeta({ ...meta, text: null }), null, 'neither text nor pdf');
  assert.equal(parseJobMeta({ ...meta, hasPdf: 'yes' }), null);
  assert.equal(parseJobMeta({ ...meta, team: 7 }), null);
});
