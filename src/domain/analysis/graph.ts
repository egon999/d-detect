import { isConflictFinding, type EntityKind, type RelationshipType, type Severity } from '../enums';
import type { CaseCitation, ClaimAssessment, Workspace } from '../models';
import { buildRuleContext } from '../rules/engine';
import { latestCaseAnalysis, resolveCitation, ASSESSMENT_LABELS } from './case-report';
import { sourceBackedReportEntities } from './report-entities';

/** A read model of persisted records and source-checked analytical statements. */
export interface GraphNode {
  id: string;
  kind: EntityKind;
  label: string;
  sublabel: string;
  severity: Severity | null;
  degree: number;
  x: number;
  y: number;
  citations?: CaseCitation[];
  reason?: string;
  /** Synthetic report nodes are inspected through citations, never an invented record route. */
  reportKind?: 'agreement' | 'contradiction' | 'timeline' | 'entity';
}

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  type: RelationshipType;
  origin: 'USER' | 'RULE' | 'AI';
  material: boolean;
  reason: string;
  citations: CaseCitation[];
}

export interface CaseGraph { nodes: GraphNode[]; edges: GraphEdge[]; width: number; height: number }
export interface GraphFilters {
  kinds?: readonly EntityKind[];
  relationshipTypes?: readonly RelationshipType[];
  userLinksOnly?: boolean;
}

const KIND_ORDER: readonly EntityKind[] = ['claim', 'event', 'evidence', 'entity', 'conflict'];
const SEVERITY_RANK: Record<Severity, number> = { HIGH: 3, MEDIUM: 2, LOW: 1, INFO: 0 };
const NODE_SPACING = 190;
const BAND_SPACING = 180;
const PADDING = 100;
const fullName = (value: string) => value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase();

/**
 * Whether a passage names a person, as a whole word.
 *
 * Both arguments must already be folded with {@link fullName} — NFKC, collapsed whitespace,
 * lower-cased. That folding is what makes the match work at all: a name is stored folded
 * (the extractor runs it through `normalizeText`) while raw source text is not, so a
 * full-width character, an OCR ligature or a run of spaces was enough to make a plain
 * `indexOf` miss a name that was plainly there, and the mention was dropped with no error.
 * Folding is the caller's job because this runs once per segment per person per
 * participant, and re-folding the same passage at each of those is the cost the caller's
 * cache exists to avoid.
 *
 * Every occurrence is checked, not just the first, and only a match sitting at a word
 * boundary counts, so "Ravi" is not read inside "Ravindra".
 */
function namesPerson(foldedText: string, foldedName: string): boolean {
  if (!foldedName) return false;

  for (let from = 0; ; ) {
    const at = foldedText.indexOf(foldedName, from);
    if (at < 0) return false;
    const before = at > 0 ? foldedText[at - 1] ?? '' : '';
    const after = foldedText[at + foldedName.length] ?? '';
    if (!/[\p{L}\p{N}]/u.test(before) && !/[\p{L}\p{N}]/u.test(after)) return true;
    from = at + 1;
  }
}

/** Compact occupied bands only; stable ordering and minimum spacing avoid node overlap. */
function layout(nodes: GraphNode[], edges: GraphEdge[]): Pick<CaseGraph, 'width' | 'height'> {
  const bands = KIND_ORDER.map(kind => nodes.filter(node => node.kind === kind).sort((a, b) => a.id.localeCompare(b.id))).filter(band => band.length);
  const width = Math.max(360, Math.max(1, ...bands.map(band => band.length)) * NODE_SPACING + PADDING * 2);
  const neighbours = new Map<string, string[]>();
  for (const edge of edges) {
    neighbours.set(edge.from, [...(neighbours.get(edge.from) ?? []), edge.to]);
    neighbours.set(edge.to, [...(neighbours.get(edge.to) ?? []), edge.from]);
  }
  const byId = new Map(nodes.map(node => [node.id, node]));
  const position = () => bands.forEach((band, bandIndex) => band.forEach((node, index) => {
    node.x = (width - (band.length - 1) * NODE_SPACING) / 2 + index * NODE_SPACING;
    node.y = PADDING + bandIndex * BAND_SPACING;
  }));
  position();
  // Reorder within a band by neighbour position, without moving nodes into each other.
  for (let pass = 0; pass < 3; pass++) {
    for (const band of bands) {
      const score = new Map(band.map(node => {
        const linked = neighbours.get(node.id) ?? [];
        return [node.id, linked.length ? linked.reduce((sum, id) => sum + (byId.get(id)?.x ?? node.x), 0) / linked.length : node.x];
      }));
      band.sort((a, b) => (score.get(a.id)! - score.get(b.id)!) || a.id.localeCompare(b.id));
    }
    position();
  }
  return { width, height: Math.max(180, (bands.length - 1) * BAND_SPACING + PADDING * 2) };
}

export function buildGraph(workspace: Readonly<Workspace>, caseId: string, filters: GraphFilters = {}): CaseGraph {
  const caseRecord = workspace.cases.find(item => item.id === caseId && !item.deletedAt);
  if (!caseRecord) return { nodes: [], edges: [], width: 600, height: 600 };
  // A graph can never cross either a case or an account boundary, even from bad legacy data.
  const scoped = Object.fromEntries(Object.entries(workspace).map(([key, records]) => [key, records.filter((item: { ownerId: string; caseId?: string; id: string }) =>
    item.ownerId === caseRecord.ownerId && (key === 'cases' ? item.id === caseId : item.caseId === caseId))])) as unknown as Workspace;
  const context = buildRuleContext(scoped, caseId);
  const report = latestCaseAnalysis(scoped, caseId);
  const kinds = new Set(filters.kinds ?? ['claim', 'event', 'evidence']);
  const allowedTypes = filters.relationshipTypes ? new Set(filters.relationshipTypes) : null;
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const edgeIds = new Set<string>();
  const nodeMap = new Map<string, GraphNode>();
  const severityById = new Map<string, Severity>();
  const findings = scoped.analysisResults.filter(item => item.status !== 'DISMISSED' && item.status !== 'RESOLVED');
  for (const finding of findings) {
    for (const id of [...finding.relatedClaimIds, ...finding.relatedEventIds, ...finding.supportingEvidenceIds]) {
      const previous = severityById.get(id);
      if (!previous || SEVERITY_RANK[finding.severity] > SEVERITY_RANK[previous]) severityById.set(id, finding.severity);
    }
  }
  const addNode = (value: Omit<GraphNode, 'degree' | 'x' | 'y'>) => {
    if (!kinds.has(value.kind) || nodeMap.has(value.id)) return;
    const node = { ...value, degree: 0, x: 0, y: 0 };
    nodeMap.set(node.id, node); nodes.push(node);
  };
  const validCitations = (citations: readonly CaseCitation[]) => citations.filter(citation => {
    if (!citation.quote || !Number.isInteger(citation.startOffset) || !Number.isInteger(citation.endOffset) || citation.endOffset <= citation.startOffset) return false;
    const source = resolveCitation(scoped, citation);
    return source !== null && source.evidence.caseId === caseId && source.evidence.ownerId === caseRecord.ownerId;
  });
  const addEdge = (edge: GraphEdge) => {
    if (!nodeMap.has(edge.from) || !nodeMap.has(edge.to) || (allowedTypes && !allowedTypes.has(edge.type)) || (filters.userLinksOnly && edge.origin !== 'USER')) return;
    if (!edgeIds.has(edge.id)) { edgeIds.add(edge.id); edges.push(edge); }
  };
  const assessmentIsCurrent = (assessment: ClaimAssessment) => {
    const citations = validCitations(assessment.citations);
    if (citations.length !== assessment.citations.length) return false;
    const supports = citations.some(item => item.stance === 'SUPPORTS');
    const contradicts = citations.some(item => item.stance === 'CONTRADICTS');
    if (assessment.status === 'SUPPORTED' || assessment.status === 'PARTIALLY_SUPPORTED') return supports;
    if (assessment.status === 'CONTRADICTED') return contradicts;
    if (assessment.status === 'DISPUTED') return supports && contradicts;
    return true;
  };
  for (const claim of context.claims) {
    const assessment = report?.claims.find(item => item.claimId === claim.id && item.statement === claim.statement && assessmentIsCurrent(item));
    addNode({ id: claim.id, kind: 'claim', label: claim.statement,
      sublabel: assessment ? ASSESSMENT_LABELS[assessment.status] : 'Not assessed for this claim version',
      severity: severityById.get(claim.id) ?? null,
      ...(assessment ? { citations: validCitations(assessment.citations), reason: assessment.explanation } : {}),
    });
  }
  for (const event of context.events) addNode({ id: event.id, kind: 'event', label: event.title, sublabel: event.occurredAt?.iso ?? 'Date not recorded', severity: severityById.get(event.id) ?? null });
  for (const item of context.evidence) addNode({ id: item.id, kind: 'evidence', label: item.title, sublabel: item.extraction?.documentType ?? item.kind, severity: severityById.get(item.id) ?? null });
  for (const participant of caseRecord.participants) addNode({ id: `entity:${participant.id}`, kind: 'entity', label: participant.name, sublabel: participant.role || 'Participant', severity: null });

  const conflicts = findings.filter(item => isConflictFinding(item.resultType));
  if (!filters.userLinksOnly) {
    for (const finding of conflicts) addNode({ id: `conflict:${finding.id}`, kind: 'conflict', label: finding.title, sublabel: 'Recorded finding', severity: finding.severity, reason: finding.explanation });
  }
  const resolveNode = (ref: { kind: string; id: string }) => {
    const direct = nodeMap.get(ref.id);
    if (direct?.kind === ref.kind) return direct.id;
    const prefixed = nodeMap.get(`${ref.kind}:${ref.id}`);
    return prefixed?.kind === ref.kind ? prefixed.id : null;
  };
  for (const link of context.relationships) {
    // Legacy AI links have no source citations. Verified report links are constructed below.
    if (link.origin === 'AI') continue;
    const from = resolveNode(link.from), to = resolveNode(link.to);
    if (!from || !to) continue;
    const changedClaim = [link.from, link.to].some(ref => ref.kind === 'claim' && context.claims.some(claim => claim.id === ref.id && claim.updatedAt > link.updatedAt));
    const earlierPolarity = changedClaim && ['SUPPORTS', 'CONTRADICTS', 'CORROBORATES'].includes(link.type);
    if (earlierPolarity && link.origin === 'RULE') continue;
    const reason = link.note.trim() || (link.origin === 'USER' ? 'Relationship recorded by the case owner.' : `Relationship produced by rule ${link.createdByRuleId ?? 'recorded with this case'}.`);
    addEdge({ id: link.id, from, to, type: earlierPolarity ? 'RELATED_TO' : link.type, origin: link.origin, material: earlierPolarity ? false : link.material,
      reason: earlierPolarity ? `This user relationship predates a claim edit and needs review. Its earlier classification was ${link.type.toLowerCase()}. ${reason}` : reason, citations: [] });
  }
  if (!filters.userLinksOnly) {
    for (const finding of conflicts) {
      for (const sourceId of [...finding.supportingEvidenceIds, ...finding.relatedClaimIds, ...finding.relatedEventIds]) {
        addEdge({ id: `finding:${finding.id}:${sourceId}`, from: sourceId, to: `conflict:${finding.id}`, type: 'RELATED_TO', origin: 'RULE', material: false, reason: finding.explanation, citations: [] });
      }
    }
    /*
      Folded text per document, built on first use and shared across every participant.

      `fullName` normalizes and lower-cases a whole string, and a document's source text
      runs to hundreds of kilobytes. Folding inside the participant loop meant re-folding
      every document, and every segment of it, once per participant — on a path that runs
      at render. Keyed by document id; segment folds are index-aligned to
      `extraction.segments`.
    */
    const foldedDocuments = new Map<string, { source: string; segments: readonly string[] }>();

    for (const participant of caseRecord.participants) {
      const participantName = fullName(participant.name);

      for (const item of context.evidence) {
        const extraction = item.extraction;
        if (!extraction) continue;

        let entry = foldedDocuments.get(item.id);
        if (!entry) {
          entry = {
            source: fullName(extraction.sourceText),
            segments: extraction.segments.map((segment) => fullName(segment.text)),
          };
          foldedDocuments.set(item.id, entry);
        }
        const folded = entry;

        const citations: CaseCitation[] = [];
        const seen = new Set<string>();

        for (const person of extraction.people) {
          if (person.evidenceId !== item.id || fullName(person.original) !== participantName) continue;
          if (!person.sourceQuote) continue;

          // The extractor's claimed passage must really be in the document. A model that
          // reports a person it invented a quote for is not evidence of a mention, and this
          // is the check that refuses it.
          //
          // Compared folded, which is the fix: `sourceQuote` is stored normalized (NFKC,
          // collapsed whitespace) while `sourceText` is raw, so a plain `indexOf` missed a
          // passage that was plainly there — a full-width character, an OCR ligature or a
          // double space was enough — and the mention was dropped with no error. Folding
          // both sides also lets a quote window that spanned a line break still match, since
          // normalization turns the newline into the space the folded source already has.
          if (!folded.source.includes(fullName(person.sourceQuote))) continue;

          // Cite the segment that names the person, by the segment's own text and offsets.
          // The folded quote cannot be cited directly: `resolveCitation` checks that the raw
          // slice at a citation's offsets still equals its `quote`, and a folded string does
          // not equal the raw text it came from. A segment's text matches its own span
          // exactly, so citing it round-trips and the mention survives to the graph.
          const index = extraction.segments.findIndex(
            (candidate, at) => !seen.has(candidate.id) && namesPerson(folded.segments[at] ?? '', participantName),
          );
          if (index < 0) continue;

          const segment = extraction.segments[index]!;
          seen.add(segment.id);

          citations.push(
            ...validCitations([
              {
                evidenceId: item.id,
                segmentId: segment.id,
                quote: segment.text,
                startOffset: segment.startOffset,
                endOffset: segment.endOffset,
                stance: 'CONTEXT',
              },
            ]),
          );
        }
        if (citations.length) addEdge({ id: `mention:${item.id}:${participant.id}`, from: item.id, to: `entity:${participant.id}`, type: 'MENTIONS', origin: 'RULE', material: false,
          reason: 'The extracted source text contains this full name. This establishes a mention, not authorship or identity.', citations });
      }
    }
    if (report) {
      for (const { entity, index, citations } of sourceBackedReportEntities(scoped, report)) {
        const id = `report:${report.id}:entity:${index}`;
        const reason = 'The cited source explicitly names this entity. A mention does not establish identity, authorship or responsibility.';
        addNode({ id, kind: 'entity', reportKind: 'entity', label: entity.name, sublabel: entity.type.toLowerCase(), severity: null, reason, citations });
        for (const evidenceId of new Set(citations.map(citation => citation.evidenceId))) {
          addEdge({ id: `${id}:${evidenceId}`, from: evidenceId, to: id, type: 'MENTIONS', origin: 'AI', material: false, reason, citations: citations.filter(citation => citation.evidenceId === evidenceId) });
        }
      }
      for (const assessment of report.claims) {
        const claim = context.claims.find(item => item.id === assessment.claimId && item.statement === assessment.statement);
        if (!claim || !assessmentIsCurrent(assessment)) continue;
        const citations = validCitations(assessment.citations);
        const groups = new Map<string, CaseCitation[]>();
        for (const citation of citations) {
          const key = `${citation.evidenceId}:${citation.stance}`;
          groups.set(key, [...(groups.get(key) ?? []), citation]);
        }
        for (const [key, sources] of groups) addEdge({ id: `report:${report.id}:${claim.id}:${key}`, from: sources[0]!.evidenceId, to: claim.id,
          type: sources[0]!.stance === 'CONTEXT' ? 'RELATED_TO' : sources[0]!.stance,
          origin: 'AI', material: false, reason: assessment.explanation, citations: sources });
      }
      const addStatement = (kind: 'agreement' | 'contradiction' | 'timeline', index: number, label: string, candidates: CaseCitation[], date?: string | null) => {
        const citations = validCitations(candidates);
        // If a contributing source vanished, the entire assertion needs a fresh analysis.
        if (citations.length !== candidates.length || !citations.length) return;
        if (kind === 'agreement') {
          const sourceKeys = citations.map(citation => {
            const source = context.evidenceById.get(citation.evidenceId);
            return source?.sha256 ?? source?.extraction?.sourceText ?? citation.evidenceId;
          });
          if (new Set(sourceKeys).size < 2) return;
        }
        const id = `report:${report.id}:${kind}:${index}`;
        const sublabel = kind === 'agreement' ? 'Cross-source agreement' : kind === 'contradiction' ? 'Conflicting sources' : date ?? 'Date unresolved';
        addNode({ id, kind: kind === 'agreement' ? 'entity' : kind === 'contradiction' ? 'conflict' : 'event', reportKind: kind, label, sublabel, severity: kind === 'contradiction' ? 'MEDIUM' : null, citations, reason: label });
        for (const evidenceId of new Set(citations.map(item => item.evidenceId))) addEdge({ id: `${id}:${evidenceId}`, from: evidenceId, to: id, type: 'RELATED_TO', origin: 'AI', material: false, reason: `Source passage for this ${kind}.`, citations: citations.filter(item => item.evidenceId === evidenceId) });
      };
      report.agreements.forEach((item, index) => addStatement('agreement', index, item.statement, item.citations));
      report.contradictions.forEach((item, index) => addStatement('contradiction', index, item.statement, item.citations));
      report.timeline.forEach((item, index) => addStatement('timeline', index, item.description, item.citations, item.occurredAt));
    }
  }
  for (const edge of edges) { nodeMap.get(edge.from)!.degree++; nodeMap.get(edge.to)!.degree++; }
  return { nodes, edges, ...layout(nodes, edges) };
}

/** Breadth-first focus traversal is linear in graph size at each requested hop. */
export function neighbourhood(graph: CaseGraph, nodeId: string, depth = 1): Set<string> {
  const neighbours = new Map<string, Set<string>>();
  for (const edge of graph.edges) {
    if (!neighbours.has(edge.from)) neighbours.set(edge.from, new Set());
    if (!neighbours.has(edge.to)) neighbours.set(edge.to, new Set());
    neighbours.get(edge.from)!.add(edge.to); neighbours.get(edge.to)!.add(edge.from);
  }
  const reached = new Set([nodeId]);
  let frontier = [nodeId];
  for (let step = 0; step < depth && frontier.length; step++) {
    const next: string[] = [];
    for (const id of frontier) for (const neighbour of neighbours.get(id) ?? []) {
      if (!reached.has(neighbour)) { reached.add(neighbour); next.push(neighbour); }
    }
    frontier = next;
  }
  return reached;
}

export function orphanNodes(graph: CaseGraph): GraphNode[] { return graph.nodes.filter(node => node.degree === 0); }
