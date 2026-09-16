/**
 * Throwaway: dumps the sample workspace as a localStorage payload for browser review.
 * Delete this file and public/design-seed-tmp.json when the visual pass is finished.
 */
import { mkdirSync, writeFileSync } from 'node:fs';

import { WORKSPACE_COLLECTIONS } from './src/data/repository';
import { buildSampleWorkspace } from './tests/fixtures/build-sample-workspace';

const OWNER = 'usr_design_review';
const workspace = buildSampleWorkspace(OWNER, Date.parse('2026-09-16T09:00:00Z'));

const shard: Record<string, unknown[]> = {};
for (const collection of WORKSPACE_COLLECTIONS) {
  if (collection === 'cases') continue;
  shard[collection] = workspace[collection] as unknown[];
}

/** A few thin extra cases so the list screen has realistic density, not one row. */
const base = workspace.cases[0]!;
const extras = [
  {
    id: 'case_deposit_withheld',
    title: 'Flat deposit withheld after move-out',
    status: 'OPEN' as const,
    category: 'Tenancy deposit',
    priority: 'NORMAL' as const,
    description: 'Landlord kept the full two-month deposit citing damage that was there on day one.',
    incidentDate: '2026-07-04',
    tags: ['tenancy', 'deposit'],
  },
  {
    id: 'case_bank_reversal',
    title: 'Card debited twice for one booking',
    status: 'OPEN' as const,
    category: 'Bank charge',
    priority: 'URGENT' as const,
    description: 'Two identical debits of ₹18,400 for a single hotel booking; only one refunded.',
    incidentDate: '2026-08-29',
    tags: ['bank', 'refund'],
  },
  {
    id: 'case_freelance_scope',
    title: 'Extra work billed outside the brief',
    status: 'CLOSED' as const,
    category: 'Contract dispute',
    priority: 'LOW' as const,
    description: 'Agency invoiced for research hours the signed brief did not cover.',
    incidentDate: '2026-04-18',
    tags: ['contract'],
  },
].map((extra, index) => ({
  ...base,
  ...extra,
  createdAt: base.createdAt - (index + 1) * 86_400_000 * 9,
  updatedAt: base.updatedAt - (index + 1) * 86_400_000 * 3,
  participants: [],
  lastAnalyzedAt: null,
}));

const allCases = [...workspace.cases, ...extras];
const emptyShard: Record<string, unknown[]> = {};
for (const collection of WORKSPACE_COLLECTIONS) {
  if (collection === 'cases') continue;
  emptyShard[collection] = [];
}

const payload: Record<string, string> = {
  'detact:v1:identity': JSON.stringify({
    id: OWNER,
    email: 'asha.menon@example.com',
    displayName: 'Asha Menon',
    createdAt: Date.parse('2026-06-01T00:00:00Z'),
  }),
  'detact:v1:offline-active': 'true',
  'detact:v1:onboarding-seen': 'true',
  [`detact:v1:${OWNER}:cases`]: JSON.stringify(allCases),
};
for (const record of allCases) {
  payload[`detact:v1:${OWNER}:case:${record.id}`] = JSON.stringify(
    record.id === base.id ? shard : emptyShard,
  );
}

mkdirSync('public', { recursive: true });
writeFileSync('public/design-seed-tmp.json', JSON.stringify(payload));

console.log('cases:', workspace.cases.length, workspace.cases.map((c) => c.id).join(','));
console.log('evidence:', workspace.evidence.length);
console.log('claims:', workspace.claims.length);
console.log('findings:', workspace.analysisResults.length);
console.log('events:', workspace.events.length);
