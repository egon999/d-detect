/**
 * Domain value → visual role.
 *
 * Every mapping from a domain enum to a colour, icon or label lives here and nowhere
 * else. Two reasons this is a module rather than inline conditionals in components:
 *
 *   1. A new enum member is a type error everywhere it must be handled, so a new
 *      `AnalysisType` cannot silently render as grey.
 *   2. Consistency is the whole point of a status colour. If `HIGH` severity is amber
 *      on one screen and red on another, the colour has stopped carrying information.
 *
 * The palette is chosen so that the *semantics* are consistent across domains, not the
 * hues. Amber always means "a person should look at this". Red always means "this is a
 * conflict or a failure". Green always means "corroborated". Violet is reserved
 * exclusively for AI-derived content, so a user can always tell machine inference from
 * a recorded fact.
 */

import type { Tone } from './tokens';
/**
 * Type-only import. It is erased at compile time, so this module keeps no runtime
 * dependency on React Native or the icon font — but every icon name below is still
 * checked against the font's real glyph list by `tsc`.
 */
import type { IconName } from './icon';
import type {
  AnalysisType,
  CaseStatus,
  ClaimState,
  DatePrecision,
  ExtractionMethod,
  FindingStatus,
  MatchConfidence,
  ProcessingState,
  RelationshipType,
  Severity,
} from '@domain/enums';
import {
  ANALYSIS_LABELS,
  CASE_STATUS_LABELS,
  CLAIM_STATE_LABELS,
  CONFIDENCE_LABELS,
  PROCESSING_STATE_LABELS,
  RELATIONSHIP_LABELS,
} from '@domain/enums';

// ---------------------------------------------------------------------------
// Severity
// ---------------------------------------------------------------------------

export const SEVERITY_TONE: Record<Severity, Tone> = {
  HIGH: 'danger',
  MEDIUM: 'warn',
  LOW: 'info',
  INFO: 'neutral',
};

/**
 * Severity ordering for sorting findings. Declared explicitly rather than derived from
 * the enum's declaration order, so reordering the enum cannot silently change a sort.
 */
export const SEVERITY_RANK: Record<Severity, number> = {
  HIGH: 0,
  MEDIUM: 1,
  LOW: 2,
  INFO: 3,
};

export const SEVERITY_LABELS: Record<Severity, string> = {
  HIGH: 'High',
  MEDIUM: 'Medium',
  LOW: 'Low',
  INFO: 'Info',
};

// ---------------------------------------------------------------------------
// Claim state
// ---------------------------------------------------------------------------

/**
 * `MIXED_REVIEW` gets `warn` rather than `danger`: a claim with evidence on both sides
 * is not a problem, it is a question. Colouring it red would train users to read
 * "needs a human" as "something is wrong".
 */
export const CLAIM_STATE_TONE: Record<ClaimState, Tone> = {
  SUPPORTED: 'ok',
  CONTRADICTED: 'danger',
  UNSUPPORTED: 'neutral',
  MIXED_REVIEW: 'warn',
};

/** Material Design-ish glyph names, resolved to an icon set by `src/ui/icon.tsx`. */
export const CLAIM_STATE_ICON: Record<ClaimState, IconName> = {
  SUPPORTED: 'check-circle',
  CONTRADICTED: 'close-circle',
  UNSUPPORTED: 'circle-outline',
  MIXED_REVIEW: 'scale-balance',
};

// ---------------------------------------------------------------------------
// Processing state
// ---------------------------------------------------------------------------

export const PROCESSING_TONE: Record<ProcessingState, Tone> = {
  UPLOADING: 'info',
  QUEUED: 'neutral',
  PROCESSING: 'info',
  EXTRACTED: 'info',
  ANALYZED: 'ok',
  REVIEW_REQUIRED: 'warn',
  FAILED: 'danger',
  CONFIRMED: 'ok',
};

/**
 * True while work is actually running, in this process, right now — the only condition under
 * which a spinner or a pulse is a true statement.
 *
 * `QUEUED` used to be in this list and is the reason the predicate needs a docblock. Nothing in
 * this app processes evidence in the background: `requestEvidenceProcessing` runs inline, in the
 * screen that started it, and `reconcileInterruptedEvidence` says so at length. So a `QUEUED`
 * row is a stored document that will sit unread until a person opens it and presses Process —
 * and every surface reading this predicate gave it an animation that could never stop, on a case
 * where nothing whatever was happening. An in-flight animation on a state nothing advances is
 * the app telling the user to wait for work that is not queued behind anything.
 *
 * The two that remain are honest. A stranded `UPLOADING` is moved to `FAILED` on a cold start and
 * a stranded `PROCESSING` is demoted to `QUEUED` by the same pass, so either one that survives
 * belongs to a run that is genuinely live in this process.
 *
 * "Waiting, and nothing is working on it" is {@link isAwaitingProcessing}. It is a different
 * sentence with a different affordance, and the two must not share a spinner.
 */
export function isProcessingInFlight(state: ProcessingState): boolean {
  return state === 'UPLOADING' || state === 'PROCESSING';
}

/**
 * True when the record is waiting for a person to start the work.
 *
 * Deliberately not folded into `needsHumanAction`. That one means "what was read cannot be relied
 * on until someone checks it" and carries a warn tone; nothing has gone wrong here. This document
 * has simply never been read, which is a task nobody has done yet rather than a fault — the same
 * reading `attention.ts` gives it when it files an unread document as `INFO`.
 */
export function isAwaitingProcessing(state: ProcessingState): boolean {
  return state === 'QUEUED';
}

/** True when the state means a person still has to act before the item is trustworthy. */
export function needsHumanAction(state: ProcessingState): boolean {
  return state === 'REVIEW_REQUIRED' || state === 'FAILED';
}

export const PROCESSING_ICON: Record<ProcessingState, IconName> = {
  UPLOADING: 'cloud-upload-outline',
  QUEUED: 'clock-outline',
  PROCESSING: 'sync',
  EXTRACTED: 'text-box-check-outline',
  ANALYZED: 'chart-timeline-variant',
  REVIEW_REQUIRED: 'alert-circle-outline',
  FAILED: 'alert-octagon-outline',
  CONFIRMED: 'check-decagram',
};

// ---------------------------------------------------------------------------
// Case status
// ---------------------------------------------------------------------------

export const CASE_STATUS_TONE: Record<CaseStatus, Tone> = {
  OPEN: 'accent',
  IN_REVIEW: 'info',
  CLOSED: 'neutral',
  ARCHIVED: 'neutral',
};

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

/**
 * A finding is never "red" because of what it concluded about the case — it is coloured
 * by how urgently a person needs to deal with it. That is why this reads off `severity`
 * rather than `resultType`: a corroborated claim and a conflict are equally important
 * pieces of information, and the app must not imply otherwise.
 */
export const FINDING_STATUS_TONE: Record<FindingStatus, Tone> = {
  OPEN: 'accent',
  REVIEWED: 'info',
  DISMISSED: 'neutral',
  RESOLVED: 'ok',
};

export const FINDING_STATUS_LABELS: Record<FindingStatus, string> = {
  OPEN: 'Open',
  REVIEWED: 'Reviewed',
  DISMISSED: 'Dismissed',
  RESOLVED: 'Resolved',
};

/**
 * The icon for a finding, which *does* reflect the finding's meaning — a conflict and a
 * corroboration should not look alike in a list, even at the same severity.
 */
export const ANALYSIS_ICON: Record<AnalysisType, IconName> = {
  POSSIBLE_CONFLICT: 'call-split',
  UNSUPPORTED_CLAIM: 'link-off',
  CORROBORATED_CLAIM: 'link-variant',
  CORROBORATED_EVENT: 'calendar-check',
  DUPLICATE_EVIDENCE: 'content-duplicate',
  MISSING_EVIDENCE: 'file-question-outline',
  AMOUNT_MISMATCH: 'calculator-variant-outline',
  RELATED_EVIDENCE: 'graph-outline',
  TIMELINE_GAP: 'timeline-alert-outline',
  UNLINKED_EVIDENCE: 'link-off',
  PAYMENT_STATUS_CONFLICT: 'cash-remove',
  HARASSMENT_INDICATOR: 'shield-alert-outline',
  STATEMENT_DISCREPANCY: 'format-quote-close',
  RESPONSE_OVERDUE: 'clock-alert-outline',
};

export { ANALYSIS_LABELS };

// ---------------------------------------------------------------------------
// Relationships
// ---------------------------------------------------------------------------

export const RELATIONSHIP_TONE: Record<RelationshipType, Tone> = {
  SUPPORTS: 'ok',
  CONTRADICTS: 'danger',
  RELATED_TO: 'neutral',
  DERIVED_FROM: 'info',
  DUPLICATE_OF: 'neutral',
  ATTACHED_TO_EVENT: 'info',
  RELEVANT_TO_CLAIM: 'accent',
  CORROBORATES: 'ok',
  INVOLVES: 'accent',
  MENTIONS: 'info',
};

export const RELATIONSHIP_ICON: Record<RelationshipType, IconName> = {
  SUPPORTS: 'arrow-top-right',
  CONTRADICTS: 'arrow-top-right',
  RELATED_TO: 'link-variant',
  DERIVED_FROM: 'source-branch',
  DUPLICATE_OF: 'content-duplicate',
  ATTACHED_TO_EVENT: 'calendar-arrow-right',
  RELEVANT_TO_CLAIM: 'target',
  CORROBORATES: 'checkbox-marked-circle-outline',
  INVOLVES: 'account-multiple',
  MENTIONS: 'card-text-outline',
};

export { RELATIONSHIP_LABELS };

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

/**
 * `AI` is the only violet in the app. That exclusivity is the point: violet on screen
 * always means "a model produced this and no one has confirmed it".
 *
 * OCR is `warn` (amber), not `info` (blue). Blue reads as *more* settled than the grey of a
 * deterministic read, which would invert the provenance hierarchy on screen — an OCR value,
 * guessed at from pixels, would look more trustworthy than one read straight from a text
 * layer. Amber is the app's documented "a person should look at this", which is exactly what
 * an unconfirmed image-read is: a misread digit here is the failure the whole product is
 * built to avoid, so its colour has to say "check me".
 */
export const EXTRACTION_METHOD_TONE: Record<ExtractionMethod, Tone> = {
  MANUAL: 'accent',
  DETERMINISTIC: 'neutral',
  OCR: 'warn',
  AI: 'ai',
};

/**
 * Re-exported from `@domain/enums`, where it now lives.
 *
 * It was defined here, which made it invisible to `src/domain/rules/` — a layer with no UI
 * imports by design. The response-overdue rule needed to say where a date came from, could not
 * reach this map, and wrote the enum member instead, so a finding read "Date read by:
 * DETERMINISTIC". Kept exported from this module so every component that imports it from `@ui`
 * is unaffected.
 */
export { EXTRACTION_METHOD_LABELS } from '@domain/enums';

/**
 * One icon per provenance tier. Previously OCR and DETERMINISTIC shared `text-search`, so
 * the two reads that most need distinguishing looked identical in the source line. OCR now
 * carries `text-recognition` — the glyph that depicts reading characters off an image —
 * while a deterministic read keeps the plain document-search glyph.
 */
export const EXTRACTION_METHOD_ICON: Record<ExtractionMethod, IconName> = {
  MANUAL: 'pencil-outline',
  DETERMINISTIC: 'text-search',
  OCR: 'text-recognition',
  AI: 'creation',
};

/**
 * How a *provisional* finding presents itself.
 *
 * A finding turns provisional when it accuses two documents of disagreeing but at least one
 * compared value was read from an image and never confirmed by a person (see
 * `AnalysisResult.provisional`). It is shown as a question, not a verdict, and it carries
 * its own one-tap prompt to confirm the reading — which, once confirmed, re-runs the rule
 * against a human-vouched value and either stands the finding up or makes it vanish.
 *
 * `tone: 'warn'`, deliberately never `'danger'`: an unconfirmed conflict is a thing to
 * check, not a thing that is known to be wrong. Colouring it red would manufacture exactly
 * the false certainty this mechanism exists to prevent.
 */
export const PROVISIONAL_FINDING: {
  tone: Tone;
  icon: IconName;
  label: string;
  prompt: string;
} = {
  tone: 'warn',
  icon: 'help-circle-outline',
  label: 'Provisional',
  prompt: 'Confirm this reading',
};

/**
 * How trustworthy a value is, in words. Ordered so provenance precedence
 * (MANUAL > DETERMINISTIC > OCR > AI) can be compared rather than hand-coded at each
 * call site.
 */
export const EXTRACTION_METHOD_RANK: Record<ExtractionMethod, number> = {
  MANUAL: 3,
  DETERMINISTIC: 2,
  OCR: 1,
  AI: 0,
};

export const CONFIDENCE_TONE: Record<MatchConfidence, Tone> = {
  EXACT_MATCH: 'ok',
  STRONG_MATCH: 'accent',
  SUGGESTED_MATCH: 'warn',
  NEEDS_REVIEW: 'neutral',
};

export { CONFIDENCE_LABELS };

/**
 * Deliberately worded so a low-precision date never reads as a claim of accuracy.
 * `UNKNOWN` in particular must not look like an error — an undated document is a
 * legitimate thing to have.
 */
export const DATE_PRECISION_LABELS: Record<DatePrecision, string> = {
  DAY: 'Exact date',
  MONTH: 'Month only',
  YEAR: 'Year only',
  UNKNOWN: 'No date found',
};

export const DATE_PRECISION_TONE: Record<DatePrecision, Tone> = {
  DAY: 'neutral',
  MONTH: 'warn',
  YEAR: 'warn',
  UNKNOWN: 'neutral',
};

export { CASE_STATUS_LABELS, CLAIM_STATE_LABELS, PROCESSING_STATE_LABELS };
