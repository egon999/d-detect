import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { makePdf } = require('./helpers/pdf-fixtures.js');
const { validateReport } = require('../src/contracts.js');
const baseUrl = process.env.E2E_API_URL || 'http://127.0.0.1:8788';
const authUrl = process.env.E2E_AUTH_URL || 'http://127.0.0.1:9099';
const withAI = process.env.E2E_WITH_AI === 'true';
for (const endpoint of [baseUrl, authUrl]) {
  if (!['127.0.0.1', 'localhost'].includes(new URL(endpoint).hostname)) throw new Error('This synthetic integration check runs only against local test services.');
}
const runId = randomUUID().replaceAll('-', '');
const prefix = runId.slice(0, 12);
const say = (event, details = {}) => process.stdout.write(`${JSON.stringify({event, ...details})}\n`);
async function account(suffix) {
  const response = await fetch(`${authUrl}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=synthetic-emulator-key`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({email: `qa-${prefix}-${suffix}@example.test`, password: `Synthetic-${runId}!`, returnSecureToken: true})});
  assert.equal(response.status, 200, 'Auth emulator account creation failed');
  const value = await response.json();
  return {uid: value.localId, token: value.idToken};
}
async function api(owner, route, method = 'GET', body, type = 'application/json') {
  const response = await fetch(`${baseUrl}${route}`, {method, headers: {Authorization: `Bearer ${owner.token}`, 'Content-Type': type}, ...(body === undefined ? {} : {body: type === 'application/json' ? JSON.stringify(body) : body})});
  const data = response.headers.get('content-type')?.includes('application/json') ? await response.json() : Buffer.from(await response.arrayBuffer());
  return {status: response.status, data};
}
const owner = await account('owner');
const stranger = await account('stranger');
assert.equal((await fetch(`${baseUrl}/api/workspace`)).status, 401);
say('firebase-auth-token-verified');
const now = Date.now();
const entity = (id) => ({id, ownerId: owner.uid, createdAt: now, updatedAt: now});
const caseId = `case_${prefix}`;
const firstClaimId = `claim_${prefix}_one`;
const secondClaimId = `claim_${prefix}_two`;
const noteId = `ev_${prefix}_note`;
const changes = [
  {op: 'put', collection: 'cases', record: {...entity(caseId), title: 'Synthetic mixed-evidence verification', description: 'Isolated automated integration test with public synthetic records.', category: 'Test verification', status: 'OPEN'}},
  {op: 'put', collection: 'claims', record: {...entity(firstClaimId), caseId, statement: 'Payment TX1001 of INR 1500 completed successfully.'}},
  {op: 'put', collection: 'claims', record: {...entity(secondClaimId), caseId, statement: 'Payment TEST-TX-2048 of INR 2500 completed successfully.'}},
  {op: 'put', collection: 'evidence', record: {...entity(noteId), caseId, title: 'Claimant statement', kind: 'NOTE', state: 'QUEUED', note: 'The claimant says TX1001 was paid successfully. This is an allegation to verify, not independent proof.', sourceLabel: 'Claimant perspective'}},
  {op: 'put', collection: 'auditLogs', record: {...entity(`aud_${prefix}`), caseId, actorId: owner.uid, action: 'CASE_CREATED', summary: 'Created isolated synthetic verification case.'}},
];
const created = await api(owner, '/api/commit', 'POST', {changes});
assert.equal(created.status, 200, JSON.stringify(created.data));
say('case-claims-note-persisted', {caseId});
const files = [
  {id: `ev_${prefix}_text`, title: 'Transaction log', name: 'transaction.txt', mime: 'text/plain', kind: 'TEXT', bytes: Buffer.from('Transaction ID: TX1001\nAmount: INR 1500.00\nPayment status: FAILED\nNo money was transferred.\n')},
  {id: `ev_${prefix}_image`, title: 'Transaction screenshot', name: 'synthetic-payment.png', mime: 'image/png', kind: 'IMAGE', bytes: await readFile(new URL('./fixtures/synthetic-payment.png', import.meta.url))},
  {id: `ev_${prefix}_pdf`, title: 'Mixed cover and scanned receipt', name: 'synthetic-mixed.pdf', mime: 'application/pdf', kind: 'PDF', bytes: makePdf()},
];
if (withAI) files.push({id: `ev_${prefix}_audio`, title: 'Recorded account', name: 'synthetic-payment.wav', mime: 'audio/wav', kind: 'AUDIO', bytes: await readFile(new URL('./fixtures/synthetic-payment.wav', import.meta.url))});
for (const file of files) {
  const metadata = await api(owner, '/api/commit', 'POST', {changes: [{op: 'put', collection: 'evidence', record: {...entity(file.id), caseId, title: file.title, kind: file.kind, state: 'UPLOADING', fileName: file.name, mimeType: file.mime, sizeBytes: file.bytes.length, sourceLabel: 'Synthetic test fixture'}}]});
  assert.equal(metadata.status, 200, JSON.stringify(metadata.data));
  const route = `/api/cases/${caseId}/evidence/${file.id}/file`;
  const uploaded = await api(owner, route, 'PUT', file.bytes, file.mime);
  assert.equal(uploaded.status, 201, JSON.stringify(uploaded.data));
  assert.equal(uploaded.data.sha256, createHash('sha256').update(file.bytes).digest('hex'));
  assert.ok(uploaded.data.jobId, 'A successful upload must persist its processing job without a separate client request');
  const download = await api(owner, route);
  assert.equal(download.status, 200);
  assert.equal(createHash('sha256').update(download.data).digest('hex'), uploaded.data.sha256);
  assert.equal((await api(stranger, route)).status, 404);
  say('private-original-stored-and-queued', {kind: file.kind, bytes: file.bytes.length});
}
const hidden = await api(stranger, '/api/workspace');
assert.equal(hidden.data.cases.length, 0);
assert.equal((await api(stranger, `/api/cases/${caseId}/analysis`, 'POST', {})).status, 404);
assert.equal((await api(owner, '/api/commit', 'POST', {changes: [{op: 'put', collection: 'caseAnalyses', record: {...entity('fake_report'), caseId}}]})).status, 403);
say('ownership-and-server-result-boundaries-verified');
async function waitFor(check, label) {
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    const workspace = (await api(owner, '/api/workspace')).data;
    const failed = workspace.processingJobs.find((job) => job.caseId === caseId && job.state === 'FAILED');
    assert.ok(!failed, `${label}: ${failed?.lastError}`);
    if (check(workspace)) return workspace;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${label} timed out`);
}
let workspace = await waitFor((data) => data.evidence.filter((item) => item.caseId === caseId).every((item) => item.state === 'EXTRACTED'), 'Evidence processing');
const image = workspace.evidence.find((item) => item.id.endsWith('_image'));
assert.equal(image.extraction.segments[0].method, 'OCR');
assert.match(image.extraction.sourceText, /Payment status: FAILED/);
assert.equal((image.extraction.sourceText.match(/Transaction ID/g) || []).length, 1, 'OCR must not invent duplicate image text');
const pdf = workspace.evidence.find((item) => item.id.endsWith('_pdf'));
assert.ok(pdf.extraction.segments.some((segment) => segment.page === 2 && segment.method === 'OCR'));
assert.match(pdf.extraction.sourceText, /TEST-TX-2048/);
assert.ok(workspace.evidence.every((item) => item.extraction.segments.length > 0));
say('mixed-processing-complete', {sources: workspace.evidence.length, pdfOcrPages: [...new Set(pdf.extraction.segments.filter((segment) => segment.method === 'OCR').map((segment) => segment.page))]});
const replay = await api(owner, '/api/commit', 'POST', {changes});
assert.equal(replay.status, 200, JSON.stringify(replay.data));
const afterReplay = (await api(owner, '/api/workspace')).data;
assert.equal(afterReplay.cases.length, 1);
assert.equal(afterReplay.evidence.find((item) => item.id === noteId).state, 'EXTRACTED');
say('lost-response-retry-idempotent');
if (withAI) {
  const queued = await api(owner, `/api/cases/${caseId}/analysis`, 'POST', {});
  assert.equal(queued.status, 202, JSON.stringify(queued.data));
  workspace = await waitFor((data) => data.caseAnalyses.some((item) => item.jobId === queued.data.jobId), 'Case analysis');
  const report = workspace.caseAnalyses.find((item) => item.jobId === queued.data.jobId);
  validateReport(report, workspace.evidence, workspace.claims);
  assert.equal(report.claims.length, 2);
  assert.ok(report.claims.every((item) => item.status !== 'SUPPORTED'), 'Failed transaction records cannot establish successful settlement');
  say('real-groq-analysis-grounded', {model: report.model, verdicts: report.claims.map((claim) => claim.status), citations: report.claims.reduce((count, claim) => count + claim.citations.length, 0), coverage: report.coverage});
}
say('integration-passed', {withAI, caseId});
