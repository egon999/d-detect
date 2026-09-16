import type { AnalysisType, MatchConfidence, Severity } from '../enums';
import { fieldPath } from '../extraction/merge';
import type { Extraction, UnconfirmedRead } from '../models';
import { TEXT_FIELD_KEYS } from '../models';
import type { FindingBasis, Rule, RuleContext, RuleFinding } from './types';

/**
 * Provenance quarantine for findings.
 *
 * ## The failure this exists to prevent
 *
 * A single misread digit turns ₹1,500 into ₹7,500. The rule engine then does its job
 * perfectly and reports a contradiction between two documents that agree completely. The
 * user is told their builder overcharged them. Nothing in the pipeline is broken; the
 * product has simply invented a dispute.
 *
 * On-device OCR gives no confidence scores (see `@services/ingestion/ocr`), so there is
 * no number to threshold on. The only honest position is that *every* value read from an
 * image is unconfirmed until a person says otherwise.
 *
 * ## Why the quarantine is per-finding, not per-field
 *
 * The obvious move — refuse to use unconfirmed values at all — is worse than the disease,
 * because it throws away the reading entirely and leaves the user with a blank card. The
 * useful distinction is what the value is being used *for*:
 *
 * - **Grouping, ordering and corroborating.** An unconfirmed value may be used freely. A
 *   misread here fails towards *silence*: two documents that should have been linked
 *   simply are not, and the user is no worse off than before they uploaded anything.
 * - **Contradicting.** An unconfirmed value may **not** produce a confident accusation. A
 *   misread here fails towards a *fabricated* dispute, which is an active harm.
 *
 * So a conflict-shaped finding resting on unconfirmed image-read values is marked
 * `provisional`: still shown, still explained, but framed as a question, with its
 * confidence forced to NEEDS_REVIEW and its severity stepped down one level so it cannot
 * outrank a conflict that is certainly real. The finding then *becomes* the prompt to
 * confirm — the user checks the two or three values it names, not every field of every
 * document. That keeps the review burden O(findings), not O(fields).
 *
 * Confirmation needs no extra bookkeeping: `effectiveExtraction` rewrites a confirmed
 * field's method to MANUAL, so the next analysis run simply stops seeing an unconfirmed
 * read and the finding stands or falls on its own.
 *
 * Pure: no I/O, no clock, no randomness.
 */

/**
 * Finding types that accuse the evidence of disagreeing with itself.
 *
 * Only these are ever quarantined. Everything else — corroboration, duplicates, related
 * evidence, gaps, unsupported claims — either fails safe or is already phrased as an
 * absence, and marking those provisional would drown a real signal in caveats.
 */
const CONTRADICTION_TYPES: ReadonlySet<AnalysisType> = new Set<AnalysisType>([
  'POSSIBLE_CONFLICT',
  'AMOUNT_MISMATCH',
]);

export function isContradictionType(type: AnalysisType): boolean {
  return CONTRADICTION_TYPES.has(type);
}

/**
 * Extraction keys worth naming in a confirm prompt.
 *
 * `keywords` is excluded deliberately: it holds a dozen repeated words that no rule ever
 * contradicts, and listing them would bury the two values that actually matter.
 */
const PROMPTABLE_TEXT_KEYS = TEXT_FIELD_KEYS.filter((key) => key !== 'keywords');

const FIELD_LABELS: Record<string, string> = {
  dates: 'Date',
  amounts: 'Amount',
  people: 'Person',
  organizations: 'Organisation',
  emails: 'Email address',
  phones: 'Phone number',
  invoiceNumbers: 'Invoice number',
  orderNumbers: 'Order number',
  transactionIds: 'Transaction reference',
  addresses: 'Address',
  keywords: 'Keyword',
};

/**
 * True when a value was produced by a machine reading something it could misread.
 *
 * DETERMINISTIC is excluded because it means the characters were already in the file.
 * AI is included because it sits *below* OCR in the provenance hierarchy: if a camera's
 * guess cannot raise an accusation on its own, a model's certainly cannot.
 *
 * Exported so that a rule which is *not* conflict-shaped, and therefore never quarantined,
 * can still notice that a value it depends on was guessed at and say so in its own words.
 * The predicate lives here, and only here, so "what counts as unconfirmed" has one answer.
 */
export function isUnconfirmedReading(method: string): boolean {
  return method === 'OCR' || method === 'AI';
}

/** Human-readable name for a field path, e.g. `amounts.0` → "Amount". */
export function labelForPath(path: string): string {
  const key = path.split('.')[0] ?? path;
  return FIELD_LABELS[key] ?? 'Value';
}

/**
 * Every value in one extraction that a machine read off an image (or a model proposed)
 * and that no person has confirmed.
 *
 * Takes the *effective* extraction, so a field a user has already corrected has method
 * MANUAL by the time it gets here and simply does not appear.
 */
export function unconfirmedReadsOf(evidenceId: string, extraction: Extraction | null): UnconfirmedRead[] {
  if (!extraction) return [];
  const reads: UnconfirmedRead[] = [];

  const collect = (key: string, fields: readonly { method: string; original: string }[]): void => {
    fields.forEach((field, index) => {
      if (!isUnconfirmedReading(field.method)) return;
      const path = fieldPath(key, index);
      reads.push({ evidenceId, path, label: labelForPath(path), reading: field.original });
    });
  };

  collect('dates', extraction.dates);
  collect('amounts', extraction.amounts);
  for (const key of PROMPTABLE_TEXT_KEYS) collect(key, extraction[key]);

  return reads;
}

/**
 * Locates a field the rule compared inside its evidence item's extraction, so it can be
 * named by path in a confirm prompt.
 *
 * Identity first: `context.extractionOf` memoises, so a rule that pulled the field out of
 * the context is holding the very object stored there. Value matching is the fallback for
 * a rule that copied or reconstructed the field, and it deliberately compares `original`
 * — the literal characters as read — rather than the normalized value, because two
 * different readings can normalize to the same thing.
 */
function resolveBasis(basis: FindingBasis, extraction: Extraction | null): UnconfirmedRead | null {
  if (!extraction) return null;
  if (!isUnconfirmedReading(basis.field.method)) return null;

  const search = (key: string, fields: readonly { method: string; original: string }[]): string | null => {
    const byIdentity = fields.indexOf(basis.field as never);
    if (byIdentity >= 0) return fieldPath(key, byIdentity);
    const byValue = fields.findIndex(
      (field) => field.original === basis.field.original && field.method === basis.field.method,
    );
    return byValue >= 0 ? fieldPath(key, byValue) : null;
  };

  const keys: readonly string[] = ['dates', 'amounts', ...PROMPTABLE_TEXT_KEYS];
  for (const key of keys) {
    const fields = extraction[key as keyof Extraction];
    if (!Array.isArray(fields)) continue;
    const path = search(key, fields as readonly { method: string; original: string }[]);
    if (path) return { evidenceId: basis.evidenceId, path, label: basis.label, reading: basis.field.original };
  }
  return null;
}

/** Drops duplicates, then orders by evidence then path so a run is byte-identical to the last. */
function tidy(reads: readonly UnconfirmedRead[]): UnconfirmedRead[] {
  const byKey = new Map<string, UnconfirmedRead>();
  for (const read of reads) byKey.set(`${read.evidenceId}|${read.path}`, read);
  return [...byKey.values()].sort(
    (a, b) => a.evidenceId.localeCompare(b.evidenceId) || a.path.localeCompare(b.path),
  );
}

/**
 * The unconfirmed readings a finding actually rests on.
 *
 * A rule that declares `basis` gets a precise answer: only the values it genuinely
 * compared. A rule that declares nothing gets the conservative answer — every unconfirmed
 * reading in the evidence it cites. That fallback is what makes the check uniform: a new
 * rule is covered the day it is written, and the failure mode of forgetting to declare a
 * basis is an over-broad confirm prompt rather than a fabricated accusation.
 */
export function unconfirmedReadsBehind(finding: RuleFinding, context: RuleContext): UnconfirmedRead[] {
  if (finding.basis?.length) {
    const resolved = finding.basis
      .map((entry) => resolveBasis(entry, context.extractionOf(entry.evidenceId)))
      .filter((read): read is UnconfirmedRead => read !== null);
    return tidy(resolved);
  }

  return tidy((finding.supportingEvidenceIds ?? []).flatMap((id) => context.unconfirmedReads(id)));
}

/** One step down. A conflict that might not exist must not sit above one that does. */
const DEMOTED: Record<Severity, Severity> = {
  HIGH: 'MEDIUM',
  MEDIUM: 'LOW',
  LOW: 'LOW',
  INFO: 'INFO',
};

export interface Quarantine {
  provisional: boolean;
  unconfirmedReads: UnconfirmedRead[];
  severity: Severity;
  confidence: MatchConfidence;
  explanation: string;
}

/** "the amount on Invoice.jpg (read as "₹7,500")" — names what to check, and what it currently says. */
function describeRead(read: UnconfirmedRead, context: RuleContext): string {
  const item = context.evidenceById.get(read.evidenceId);
  const where = item ? `"${item.title}"` : 'the source document';
  return `the ${read.label.toLowerCase()} on ${where} (read as "${read.reading}")`;
}

function joinWithAnd(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/**
 * Applies the quarantine to one finding.
 *
 * Returns the values the engine should store. Leaves everything untouched when the
 * finding is not conflict-shaped, or when nothing behind it was read from an image.
 */
export function quarantineFinding(rule: Rule, finding: RuleFinding, context: RuleContext): Quarantine {
  const severity = finding.severity ?? rule.defaultSeverity;
  const unchanged: Quarantine = {
    provisional: false,
    unconfirmedReads: [],
    severity,
    confidence: finding.confidence,
    explanation: finding.explanation,
  };

  if (!isContradictionType(rule.resultType)) return unchanged;

  const reads = unconfirmedReadsBehind(finding, context);
  if (reads.length === 0) return unchanged;

  // At most three are named. Beyond that the sentence stops being a prompt and starts
  // being a list, and the rest are visible on the finding itself.
  const named = joinWithAnd(reads.slice(0, 3).map((read) => describeRead(read, context)));
  const more = reads.length > 3 ? `, and ${reads.length - 3} more` : '';

  return {
    provisional: true,
    unconfirmedReads: reads,
    severity: DEMOTED[severity],
    // Never EXACT or STRONG. Whatever the rule believed, it was comparing a guess.
    confidence: 'NEEDS_REVIEW',
    explanation:
      `${finding.explanation}\n\n` +
      `This comparison used ${named}${more}, which was read from an image rather than from ` +
      `text in the file. Image reading can mistake one digit for another, so this may not be ` +
      `a real disagreement at all. Confirm the reading and this finding will either firm up or go away.`,
  };
}
