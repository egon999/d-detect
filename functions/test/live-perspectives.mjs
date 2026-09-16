import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { validateReport } = require('../src/contracts.js');
const endpoint = 'http://127.0.0.1:8788';
const authEndpoint = 'http://127.0.0.1:9099';
if (process.env.E2E_WITH_AI !== 'true') throw new Error('Set E2E_WITH_AI=true to run this explicit real-provider synthetic check.');
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const auth = await fetch(`${authEndpoint}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=synthetic-emulator-key`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({email: `perspectives-${suffix}@example.test`, password: `Synthetic-${randomUUID()}!`, returnSecureToken: true})});
assert.equal(auth.status, 200);
const account = await auth.json();
async function api(route, method = 'GET', payload, type = 'application/json') {
  const result = await fetch(`${endpoint}${route}`, {method, headers: {Authorization: `Bearer ${account.idToken}`, 'Content-Type': type}, ...(payload === undefined ? {} : {body: type === 'application/json' ? JSON.stringify(payload) : payload})});
  const data = await result.json();
  assert.ok(result.ok, `${route}: ${data.error || result.status}`);
  return data;
}
const caseId = `case_perspectives_${suffix}`;
const now = Date.now();
const base = (id) => ({id, ownerId: account.localId, createdAt: now, updatedAt: now});
const claim = (name, statement) => ({op: 'put', collection: 'claims', record: {...base(`claim_${suffix}_${name}`), caseId, statement}});
const claims = [
  claim('schedule', 'All four submitted accounts say the meeting was scheduled for 18:30 on 12 September 2026.'),
  claim('witness', 'Chen says he personally witnessed Dev in the room at 18:40.'),
  claim('payment', 'The submitted evidence establishes that Dev completed a bank payment to Bea.'),
  claim('presence', 'Dev was in the meeting room at 18:40 on 12 September 2026.'),
];
await api('/api/commit', 'POST', {changes: [{op: 'put', collection: 'cases', record: {...base(caseId), title: 'Synthetic four-perspective conflict', category: 'Statement comparison', description: 'Four conflicting accounts; distinguish their content from verified real-world events.', status: 'OPEN'}}, ...claims]});
const statements = [
  ['asha', 'Asha', 'The meeting was scheduled for 18:30 on 12 September 2026. My account: I saw Dev in the meeting room at 18:40. I did not see any cash or bank payment.'],
  ['bea', 'Bea', 'The meeting was scheduled for 18:30 on 12 September 2026. My account: Dev was in the meeting room when Asha looked at the clock at 18:40. I have no bank receipt or transaction record.'],
  ['dev', 'Dev', 'The meeting was scheduled for 18:30 on 12 September 2026. My account: I left the meeting room at 18:25 and did not return. I deny being there at 18:40. I have not supplied any payment records.'],
  ['chen', 'Chen', 'The meeting was scheduled for 18:30 on 12 September 2026. My account: I arrived at 19:00 and did not see Dev in the room. I cannot say who was in the room at 18:40 because I was not there then.'],
];
const sourceIds = new Map();
for (const [slug, name, text] of statements) {
  const id = `ev_${suffix}_${slug}`;
  sourceIds.set(slug, id);
  await api('/api/commit', 'POST', {changes: [{op: 'put', collection: 'evidence', record: {...base(id), caseId, title: `${name}'s account`, sourceLabel: `${name}; attribution supplied by uploader`, capturedAt: '2026-09-12', kind: 'TEXT', state: 'UPLOADING', fileName: `${slug}.txt`, mimeType: 'text/plain', sizeBytes: Buffer.byteLength(text)}}]});
  await api(`/api/cases/${caseId}/evidence/${id}/file`, 'PUT', Buffer.from(text), 'text/plain');
}
async function waitFor(predicate) {
  for (let attempt = 0; attempt < 180; attempt++) {
    const workspace = await api('/api/workspace');
    const failure = workspace.processingJobs.find((job) => job.caseId === caseId && job.state === 'FAILED');
    assert.ok(!failure, failure?.lastError);
    if (predicate(workspace)) return workspace;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('Perspective analysis timed out.');
}
await waitFor((data) => data.evidence.length === 4 && data.evidence.every((item) => item.state === 'EXTRACTED'));
const job = await api(`/api/cases/${caseId}/analysis`, 'POST', {});
const workspace = await waitFor((data) => data.caseAnalyses.some((report) => report.jobId === job.jobId));
const report = workspace.caseAnalyses.find((item) => item.jobId === job.jobId);
validateReport(report, workspace.evidence, workspace.claims);
const assessment = (name) => report.claims.find((item) => item.claimId === `claim_${suffix}_${name}`);
const schedule = assessment('schedule');
assert.equal(schedule.status, 'SUPPORTED', 'Matching text in every submitted account supports the content-of-accounts claim.');
assert.equal(new Set(schedule.citations.map((item) => item.evidenceId)).size, 4, 'An all-four-accounts conclusion should cite all four sources.');
const witness = assessment('witness');
assert.equal(witness.status, 'CONTRADICTED');
assert.ok(witness.citations.some((item) => item.evidenceId === sourceIds.get('chen') && item.stance === 'CONTRADICTS'));
const payment = assessment('payment');
assert.ok(['INSUFFICIENT_EVIDENCE', 'UNRESOLVED'].includes(payment.status));
assert.ok(payment.missingInformation.length > 0, 'Absent bank records must remain a stated information gap.');
const presence = assessment('presence');
assert.ok(['DISPUTED', 'UNRESOLVED'].includes(presence.status));
assert.ok(presence.citations.some((item) => item.stance === 'SUPPORTS'));
assert.ok(presence.citations.some((item) => item.evidenceId === sourceIds.get('dev') && item.stance === 'CONTRADICTS'));
assert.ok(!presence.citations.some((item) => item.evidenceId === sourceIds.get('chen') && item.stance === 'CONTRADICTS'), 'A 19:00 observation does not contradict an 18:40 presence claim.');
process.stdout.write(`${JSON.stringify({event: 'multi-perspective-quality-passed', caseId, model: report.model, verdicts: Object.fromEntries(['schedule', 'witness', 'payment', 'presence'].map((name) => [name, assessment(name).status])), sourceCount: report.coverage.processedEvidence, citations: report.claims.reduce((count, item) => count + item.citations.length, 0), distinction: 'Direct account content separated from conflicting testimony and absent payment records'})}\n`);
