import type {
  AnalysisType,
  MatchConfidence,
  Severity,
} from '../enums';
import type {
  AnalysisResult,
  AmountField,
  CaseEvent,
  Claim,
  DateField,
  Evidence,
  EvidenceRelationship,
  Extraction,
  TextField,
  UnconfirmedRead,
  Workspace,
} from '../models';

/**
 * Rule engine contracts.
 *
 * A rule is a pure function from a read-only view of one case to a list of findings.
 * Rules perform no I/O, read no clock and hold no state, which is what lets the whole
 * analysis be re-run at any time and produce byte-identical results.
 *
 * Adding a rule means writing one module and registering it — no change to the
 * pipeline, the persistence layer or the UI.
 */

/** Any extracted value, whatever its shape. All three carry `method` and `original`. */
export type ExtractedField = DateField | AmountField | TextField;

/**
 * One value a rule actually compared.
 *
 * Optional, and purely an accuracy improvement: the engine can always fall back to "every
 * unconfirmed reading in the evidence this finding cites". Declaring the basis narrows
 * that to the values the rule genuinely looked at, so the confirm prompt a user is shown
 * names two fields rather than nine.
 */
export interface FindingBasis {
  evidenceId: string;
  /** What to call this value in a confirm prompt, e.g. "Date" or "Amount". */
  label: string;
  /** The field object as returned by `context.extractionOf` for that evidence item. */
  field: ExtractedField;
}

/**
 * What a rule returns. Deliberately *not* an `AnalysisResult`: identity, timestamps
 * and review status are the engine's responsibility, so a rule cannot accidentally
 * reset a finding a human has already dismissed.
 */
export interface RuleFinding {
  /**
   * The entities whose combination makes this finding unique. The engine sorts and
   * hashes these with the rule id to derive a stable document id, so the same
   * condition always maps to the same record instead of piling up duplicates.
   */
  key: readonly string[];
  title: string;
  /**
   * What the records say. Plain language, aimed at a reader with no technical or legal
   * background, and **only the observation** — no hedging, no caveat, no instruction.
   *
   * Kept to roughly one or two sentences on purpose, and pinned by `tests/rule-copy.test.ts`.
   * `FindingCard` renders this without truncation, which is only safe while it is short: the
   * card used to clip a four-sentence paragraph at three lines, so the app's careful reasoning
   * reached the reader cut off in the middle of a word. A budget here is what lets the card
   * stop clipping. See `docs/copy-doctrine.md`.
   */
  explanation: string;
  /**
   * Why this reading might be wrong.
   *
   * The hedge that used to be sentences three and four of `explanation`, where it was the
   * first thing truncation ate — so the one part of a finding that tells a reader not to trust
   * it was reliably the part they never saw. Split out, it gets a named control of its own on
   * the card, and no length budget: a caveat that needs four sentences may have four.
   *
   * Mandatory whenever the finding is hedged — a `NEEDS_REVIEW` confidence or a `LOW` severity
   * on a conflict-shaped rule means something about this reading is uncertain, and a test
   * fails a rule that hedges without saying why. Omit it only when the finding rests entirely
   * on values read out of machine-readable text and compared exactly.
   */
  caveat?: string;
  /** Overrides the rule's default severity when a specific instance warrants it. */
  severity?: Severity;
  confidence: MatchConfidence;
  supportingEvidenceIds?: readonly string[];
  relatedClaimIds?: readonly string[];
  relatedEventIds?: readonly string[];
  /** The literal values compared, so a reader can check the conclusion themselves. */
  inputs: Record<string, string>;
  /**
   * The exact values this finding rests on.
   *
   * A rule never decides its own trustworthiness — it reports what it compared, and the
   * engine applies the provenance quarantine uniformly (see `./provenance`). Keeping the
   * judgement out of the rules is what stops the policy from being copy-pasted twelve
   * times and drifting.
   */
  basis?: readonly FindingBasis[];
}

/**
 * A read-only, pre-indexed view of one case.
 *
 * The engine builds this once and shares it across every rule, so that rules stay
 * short and none of them pays to re-filter the workspace.
 */
export interface RuleContext {
  readonly caseId: string;
  readonly ownerId: string;
  /**
   * The moment the analysis is being run for, in epoch milliseconds, or `null` when no
   * clock was supplied.
   *
   * Injected rather than read, for the same reason `runAnalysis` takes it: a rule that
   * called `Date.now()` would make the analysis irreproducible, and a finding that cannot be
   * reproduced cannot be checked. With it injected, a run is still a pure function of
   * (workspace, caseId, now) and a test can name any date it likes.
   *
   * `null` for the derived read models that build a context to ask structural questions —
   * the timeline, the graph, claim state, the compare screen. A time-aware rule must treat
   * `null` as "say nothing", never as "assume today": the alternative is a finding about
   * elapsed time computed from a date the caller never provided.
   */
  readonly now: number | null;
  /** Active evidence only — soft-deleted items are excluded — sorted by id for determinism. */
  readonly evidence: readonly Evidence[];
  readonly claims: readonly Claim[];
  readonly events: readonly CaseEvent[];
  /** Relationships whose endpoints all still exist and are not deleted. */
  readonly relationships: readonly EvidenceRelationship[];

  readonly evidenceById: ReadonlyMap<string, Evidence>;
  readonly claimById: ReadonlyMap<string, Claim>;
  readonly eventById: ReadonlyMap<string, CaseEvent>;

  /** Effective extraction — machine values with human corrections already applied. */
  extractionOf(evidenceId: string): Extraction | null;
  /**
   * Every value in this evidence item that a machine read off an image (or a model
   * proposed) and that no person has confirmed.
   *
   * Lives on the shared context rather than inside each rule so that the provenance
   * policy is defined once. Confirmed fields never appear here, because
   * `effectiveExtraction` has already rewritten their method to MANUAL.
   */
  unconfirmedReads(evidenceId: string): readonly UnconfirmedRead[];
  /** Relationships pointing at an entity. */
  linksTo(kind: 'claim' | 'event' | 'evidence', id: string): readonly EvidenceRelationship[];
  /** Relationships originating from an entity. */
  linksFrom(kind: 'claim' | 'event' | 'evidence', id: string): readonly EvidenceRelationship[];
}

export interface Rule {
  /**
   * Stable and versioned, e.g. `duplicate-evidence@1`. Changing a rule's logic means
   * bumping the version, which changes the derived finding ids — old findings resolve
   * and new ones appear, rather than silently changing meaning under the same id.
   */
  readonly id: string;
  readonly title: string;
  /** One line, shown beside the finding in the reasoning trace. */
  readonly description: string;
  /** Why the rule exists and what it deliberately does *not* prove. */
  readonly rationale: string;
  readonly resultType: AnalysisType;
  readonly defaultSeverity: Severity;
  /** Higher runs first. Only affects presentation order, never correctness. */
  readonly priority: number;
  readonly enabled: boolean;
  evaluate(context: RuleContext): RuleFinding[];
}

/** Outcome of one engine run, including what changed relative to stored state. */
export interface AnalysisRunResult {
  /** Findings that currently hold. */
  results: AnalysisResult[];
  /** Previously open findings whose condition no longer holds. */
  resolved: AnalysisResult[];
  /** Ids of rules that were evaluated, for the run summary. */
  evaluatedRuleIds: string[];
  runAt: number;
}

export type WorkspaceView = Readonly<Workspace>;
