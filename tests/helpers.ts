import { extractFromText, type ExtractedTextMethod } from '@domain/extraction/deterministic';
import { hashText } from '@domain/hashing';
import type {
  Case,
  CaseEvent,
  Claim,
  EntityRef,
  Evidence,
  EvidenceRelationship,
  Workspace,
} from '@domain/models';
import { emptyWorkspace } from '@domain/models';
import { normalizeDate } from '@domain/normalize/dates';

/**
 * Builders for small, readable test workspaces.
 *
 * Evidence is always created by running real text through the real extractor rather
 * than by hand-writing an `Extraction` object. A test that fabricates extraction output
 * would keep passing after the extractor broke.
 */

export const OWNER = 'user_test';
export const CASE_ID = 'case_test';

let counter = 0;
const nextId = (prefix: string) => `${prefix}_${(counter += 1)}`;

/** Resets the id counter so each test file produces the same ids. */
export function resetIds(): void {
  counter = 0;
}

const stamps = { ownerId: OWNER, caseId: CASE_ID, createdAt: 1_000, updatedAt: 1_000 };

export function testCase(overrides: Partial<Case> = {}): Case {
  return {
    id: CASE_ID,
    ownerId: OWNER,
    createdAt: 1_000,
    updatedAt: 1_000,
    title: 'Test case',
    description: '',
    status: 'OPEN',
    category: '',
    priority: 'NORMAL',
    participants: [],
    tags: [],
    incidentDate: null,
    lastAnalyzedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

export function evidence(
  text: string,
  overrides: Partial<Evidence> & { id?: string; method?: ExtractedTextMethod } = {},
): Evidence {
  // `method` is not a field on Evidence — it is how the text was obtained, and it is
  // pulled out here so it reaches the extractor rather than landing on the record.
  const { method = 'DETERMINISTIC', ...rest } = overrides;
  const id = rest.id ?? nextId('evd');
  const title = rest.title ?? `Evidence ${id}`;
  return {
    ...stamps,
    id,
    title,
    kind: 'PDF',
    state: 'CONFIRMED',
    note: '',
    fileName: `${id}.pdf`,
    mimeType: 'application/pdf',
    sizeBytes: text.length,
    storagePath: `test/${id}.pdf`,
    sha256: hashText(text),
    extraction: extractFromText({ evidenceId: id, title, text, method }),
    confirmedFields: {},
    confirmedAt: null,
    failureReason: null,
    deletedAt: null,
    ...rest,
  };
}

export function claim(statement: string, overrides: Partial<Claim> = {}): Claim {
  return {
    ...stamps,
    id: overrides.id ?? nextId('clm'),
    statement,
    detail: '',
    requiredEventIds: [],
    state: 'UNSUPPORTED',
    deletedAt: null,
    ...overrides,
  };
}

export function event(title: string, iso: string | null, overrides: Partial<CaseEvent> = {}): CaseEvent {
  const id = overrides.id ?? nextId('evt');
  return {
    ...stamps,
    id,
    title,
    description: '',
    occurredAt: iso ? { ...normalizeDate(iso), evidenceId: id, method: 'MANUAL' } : null,
    claimIds: [],
    deletedAt: null,
    ...overrides,
  };
}

export const ref = {
  evidence: (id: string): EntityRef => ({ kind: 'evidence', id }),
  claim: (id: string): EntityRef => ({ kind: 'claim', id }),
  event: (id: string): EntityRef => ({ kind: 'event', id }),
};

export function link(
  from: EntityRef,
  to: EntityRef,
  type: EvidenceRelationship['type'],
  overrides: Partial<EvidenceRelationship> = {},
): EvidenceRelationship {
  return {
    ...stamps,
    id: overrides.id ?? nextId('rel'),
    from,
    to,
    type,
    origin: 'USER',
    material: false,
    note: '',
    createdByRuleId: null,
    ...overrides,
  };
}

export function workspace(parts: Partial<Workspace> = {}): Workspace {
  return { ...emptyWorkspace(), cases: [testCase()], ...parts };
}

/** Convenience: the finding types present in a set of results, deduped and sorted. */
export function resultTypes(results: readonly { resultType: string }[]): string[] {
  return [...new Set(results.map((result) => result.resultType))].sort();
}
