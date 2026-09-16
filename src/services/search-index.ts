import type { Case, Workspace } from '@domain/models';
import { latestCaseAnalysis } from '@domain/analysis/case-report';
import { sourceBackedReportEntities } from '@domain/analysis/report-entities';

export type SearchKind = 'Cases' | 'Claims' | 'Evidence' | 'Events' | 'Entities';
export interface SearchRecord {
  id: string;
  kind: SearchKind;
  caseId: string;
  recordId: string;
  /** Source passage for a derived entity result; recordId remains a real evidence ID. */
  segmentId?: string;
  title: string;
  context: string;
  text: string;
  searchText: string;
}

/** Search only records owned by this session and belonging to its visible cases. */
export function buildSearchIndex(ownerId: string, cases: readonly Case[], workspaces: readonly Workspace[]): SearchRecord[] {
  const visible = cases.filter((item) => item.ownerId === ownerId && item.deletedAt === null);
  const titles = new Map(visible.map((item) => [item.id, item.title]));
  const records: SearchRecord[] = [];
  const add = (record: Omit<SearchRecord, 'searchText'>) => records.push({ ...record, searchText: `${record.title} ${record.context} ${record.text}`.toLocaleLowerCase() });
  for (const item of visible) add({
    id: `case:${item.id}`, kind: 'Cases', caseId: item.id, recordId: item.id, title: item.title,
    context: item.category,
    text: [item.description, item.incidentDate, ...item.participants.map((person) => `${person.name} ${person.role} ${person.contact ?? ''}`), ...item.tags].filter(Boolean).join(' '),
  });
  for (const workspace of workspaces) {
    for (const item of workspace.claims) {
      if (item.ownerId !== ownerId || item.deletedAt !== null || !titles.has(item.caseId)) continue;
      add({ id: `claim:${item.id}`, kind: 'Claims', caseId: item.caseId, recordId: item.id, title: item.statement, context: titles.get(item.caseId)!, text: item.detail });
    }
    for (const item of workspace.evidence) {
      if (item.ownerId !== ownerId || item.deletedAt !== null || !titles.has(item.caseId)) continue;
      const extraction = item.extraction;
      const entities = extraction ? [
        ...extraction.people, ...extraction.organizations, ...extraction.transactionIds, ...extraction.invoiceNumbers,
        ...extraction.orderNumbers, ...extraction.emails, ...extraction.phones, ...extraction.addresses, ...extraction.keywords,
      ].map((entity) => entity.original).join(' ') : '';
      add({ id: `evidence:${item.id}`, kind: 'Evidence', caseId: item.caseId, recordId: item.id, title: item.title, context: titles.get(item.caseId)!,
        text: [item.note, item.fileName, extraction?.sourceText, extraction?.summary, entities,
          extraction?.chatMessages.map((message) => `${message.sender} ${message.recipient ?? ''} ${message.timestamp ?? ''} ${message.content}`).join(' '),
          extraction?.amounts.map((amount) => amount.original).join(' '), extraction?.dates.map((date) => date.original).join(' '),
          ...Object.values(item.confirmedFields),
        ].filter(Boolean).join(' '),
      });
    }
    for (const item of workspace.events) {
      if (item.ownerId !== ownerId || item.deletedAt !== null || !titles.has(item.caseId)) continue;
      add({ id: `event:${item.id}`, kind: 'Events', caseId: item.caseId, recordId: item.id, title: item.title, context: titles.get(item.caseId)!, text: `${item.description} ${item.occurredAt?.original ?? ''}` });
    }
    for (const item of workspace.cases) {
      if (item.ownerId !== ownerId || !titles.has(item.id)) continue;
      const report = latestCaseAnalysis(workspace, item.id);
      if (!report) continue;
      for (const { entity, index, citations } of sourceBackedReportEntities(workspace, report)) {
        const source = citations[0]!;
        add({ id: `entity:${report.id}:${index}`, kind: 'Entities', caseId: item.id, recordId: source.evidenceId, segmentId: source.segmentId,
          title: entity.name, context: `${titles.get(item.id)!} / ${entity.type.toLowerCase()} mentioned in evidence`, text: citations.map(citation => citation.quote).join('\n') });
      }
    }
  }
  return records;
}

export function matchesSearch(record: SearchRecord, query: string): boolean {
  return query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean).every((term) => record.searchText.includes(term));
}

export function searchSnippet(record: SearchRecord, query: string): string {
  const text = record.text.replace(/\s+/g, ' ').trim();
  const term = query.trim().toLocaleLowerCase().split(/\s+/).find((word) => text.toLocaleLowerCase().includes(word));
  const offset = term ? Math.max(0, text.toLocaleLowerCase().indexOf(term) - 45) : 0;
  return `${offset ? '…' : ''}${text.slice(offset, offset + 180)}${text.length > offset + 180 ? '…' : ''}`;
}

export function sanitizeRecentSearches(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim().slice(0, 160))
    .filter((item) => { const key = item.toLocaleLowerCase(); if (item.length < 2 || seen.has(key)) return false; seen.add(key); return true; })
    .slice(0, 8);
}

export function searchStorageKey(ownerId: string, preference = false): string {
  return `detact:v2:${preference ? 'remember-searches' : 'recent-searches'}:${encodeURIComponent(ownerId)}`;
}

/** Limit simultaneous database requests without excluding any cases. */
export async function mapWithConcurrency<T, R>(values: readonly T[], concurrency: number, read: (value: T) => Promise<R>): Promise<R[]> {
  const result: R[] = new Array(values.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), values.length) }, async () => {
    while (next < values.length) { const index = next++; result[index] = await read(values[index]!); }
  }));
  return result;
}
