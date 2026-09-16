import type { CaseAnalysis, CaseCitation, Workspace } from '../models';
import { reportIsStale, resolveCitation } from './case-report';

const normalize = (value: string) => value.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ').trim();

/** A full name/reference must occur in the quotation, not inside a different name. */
export function quoteNamesEntity(quote: string, name: string): boolean {
  const text = normalize(quote), needle = normalize(name);
  if (!needle) return false;
  for (let offset = text.indexOf(needle); offset >= 0; offset = text.indexOf(needle, offset + 1)) {
    const before = offset ? text[offset - 1]! : '';
    const after = text[offset + needle.length] ?? '';
    if (!/[\p{L}\p{M}\p{N}]/u.test(before) && !/[\p{L}\p{M}\p{N}]/u.test(after)) return true;
  }
  return false;
}

/** Shared by graph and search: every returned relationship has an exact current source. */
export function sourceBackedReportEntities(workspace: Workspace, report: CaseAnalysis) {
  const record = workspace.cases.find(item => item.id === report.caseId && item.ownerId === report.ownerId && !item.deletedAt);
  if (!record || reportIsStale(workspace, report)) return [];
  return (report.entities ?? []).flatMap((entity, index) => {
    if (!entity.citations.length) return [];
    const valid = entity.citations.every(citation => {
      if (!citation.quote || !Number.isInteger(citation.startOffset) || !Number.isInteger(citation.endOffset) || citation.endOffset <= citation.startOffset) return false;
      const source = resolveCitation(workspace, citation);
      return source?.evidence.caseId === report.caseId && source.evidence.ownerId === report.ownerId;
    });
    if (!valid) return [];
    const citations: CaseCitation[] = entity.citations.filter(citation => quoteNamesEntity(citation.quote, entity.name));
    return citations.length ? [{ entity, index, citations }] : [];
  });
}
