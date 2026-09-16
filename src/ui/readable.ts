/**
 * The last thing between a stored value and a reader.
 *
 * ## Why this exists when `semantics.ts` already holds every label map
 *
 * It does hold them, and that is the point. `SEVERITY_LABELS`, `FINDING_STATUS_LABELS`,
 * `EXTRACTION_METHOD_LABELS`, `RELATIONSHIP_LABELS` and the rest are complete, correct and
 * carefully worded — and a review of the screens found them going unused at the places that
 * matter most. A person disputing a bank charge was shown `MATERIAL_AMOUNT_CONTRADICTION`
 * inside the finding meant to explain the problem to them; a violet chip on the analysis screen
 * read `TRANSACTION`; the connections screen printed nine raw ids and enum values through
 * `?? node.id` fallbacks. Every one of those sites had a map available two imports away.
 *
 * A per-screen fix would not have held. The maps are keyed by type, so a screen rendering a
 * value whose type it does not narrow — a `Record<string, string>` of detector inputs, a node
 * label of unknown provenance, a `catch` block's message — has no map to reach for and reaches
 * for the raw value instead. That is not carelessness; it is the only thing the type system
 * offers there.
 *
 * So this module offers one function that takes `unknown` and always returns something a person
 * can read. It consults every map in the app, and when none of them knows the value it changes
 * the *shape* of the string rather than passing it through: `MATERIAL_AMOUNT_CONTRADICTION`
 * becomes "Material amount contradiction". A detector written next year, with a constant nobody
 * remembered to add to a map, is therefore still readable. The failure mode is a slightly
 * clumsy sentence, not machine vocabulary on the product's core artefact.
 *
 * ## Why it must not touch anything that is already prose
 *
 * The same call sites carry real content: an amount lifted off a statement, a document title, a
 * participant's name, a date. Reshaping those would be worse than the bug it fixes — a title
 * would lose its capitals and an account number could be mangled. The identifier test is
 * therefore deliberately narrow: a candidate has to contain no whitespace *and* match one of
 * the four shapes code uses for names. `"Bank statement 4 May"` fails it on the space alone;
 * `"₹4,500.00"` fails it on both counts; `"NEEDS_REVIEW"` passes.
 */

import {
  AUDIT_ACTION_LABELS,
  EVIDENCE_KIND_LABELS,
  type EntityKind,
} from '@domain/enums';

import {
  ANALYSIS_LABELS,
  CASE_STATUS_LABELS,
  CLAIM_STATE_LABELS,
  CONFIDENCE_LABELS,
  DATE_PRECISION_LABELS,
  EXTRACTION_METHOD_LABELS,
  FINDING_STATUS_LABELS,
  PROCESSING_STATE_LABELS,
  RELATIONSHIP_LABELS,
  SEVERITY_LABELS,
} from './semantics';

/**
 * The kinds of thing a graph node or a search result can be.
 *
 * `EntityKindEnum`'s members are lowercase because they are also used as route segments and
 * storage discriminators. They still reach the screen as chip labels and as the kind line under
 * a search result, so they need spoken forms like everything else. "Conflict" is worded as
 * "Disagreement" because the app never asserts that two documents conflict — it reports that
 * they do not agree and leaves the judgement to the reader.
 */
export const ENTITY_KIND_LABELS: Record<EntityKind, string> = {
  claim: 'Claim',
  event: 'Event',
  evidence: 'Document',
  entity: 'Name or reference',
  conflict: 'Disagreement',
};

/**
 * What an extracted assertion is about.
 *
 * From `AssertionKind` in `@domain/analysis/evidence-intelligence`, which is a bare union rather
 * than a zod enum and so was never given a map. `DISCREPANCY` is spoken as "Difference" for the
 * reason above: the app describes what it found, it does not rule on it.
 */
export const ASSERTION_KIND_LABELS: Readonly<Record<string, string>> = {
  TRANSACTION: 'Payment',
  BILLING: 'Charge',
  STATUS: 'Status',
  COMMUNICATION: 'Message',
  DISCREPANCY: 'Difference',
};

/**
 * What a recognised name or reference refers to.
 *
 * From the `type` union on an extracted entity. `ORG` is spoken in full because the
 * abbreviation is developer shorthand, and `DOCUMENT` becomes "Reference" because at this point
 * in the pipeline it means "a document number found in the text", not the uploaded file.
 */
export const ENTITY_TYPE_LABELS: Readonly<Record<string, string>> = {
  PERSON: 'Person',
  ORG: 'Organisation',
  TRANSACTION: 'Payment reference',
  DOCUMENT: 'Reference',
  LOCATION: 'Place',
};

/**
 * Reasons two documents are not independent of one another.
 *
 * From `DependencyReason` in `@domain/analysis/independence`. These decide whether the app is
 * allowed to describe two documents as corroborating each other, so the wording says what the
 * reader should conclude rather than naming the rule that fired.
 */
export const DEPENDENCY_REASON_LABELS: Readonly<Record<string, string>> = {
  BYTE_IDENTICAL: 'The same file, added twice',
  TEXT_DUPLICATE: 'The same text as another document',
  SUBSTRING_EXCERPT: 'An extract from another document',
  SHARED_TRANSACTION_RECORD: 'Both refer to the same payment record',
  EXPLICIT_LINK: 'Linked to another document by you',
};

/**
 * Every spoken form the app knows, flattened into one lookup.
 *
 * Built once at module load. Keys can collide between maps — `OPEN` is both a case status and a
 * finding status, `TRANSACTION` is both an assertion kind and an entity type — and later entries
 * win. The order below is therefore chosen so the more specific vocabulary is applied last: a
 * bare `TRANSACTION` with no type information around it is far more likely to be an entity type
 * on the connections screen than an assertion kind, and a caller that knows which it has should
 * be reading its own typed map directly instead of coming here.
 */
const SPOKEN: Readonly<Record<string, string>> = Object.freeze({
  ...CASE_STATUS_LABELS,
  ...PROCESSING_STATE_LABELS,
  ...FINDING_STATUS_LABELS,
  ...SEVERITY_LABELS,
  ...CLAIM_STATE_LABELS,
  ...CONFIDENCE_LABELS,
  ...ANALYSIS_LABELS,
  ...RELATIONSHIP_LABELS,
  ...EXTRACTION_METHOD_LABELS,
  ...DATE_PRECISION_LABELS,
  ...EVIDENCE_KIND_LABELS,
  ...AUDIT_ACTION_LABELS,
  ...ENTITY_KIND_LABELS,
  ...DEPENDENCY_REASON_LABELS,
  ...ASSERTION_KIND_LABELS,
  ...ENTITY_TYPE_LABELS,
});

/**
 * Suggestion states, which have no map anywhere and are three words long.
 *
 * Folded in above rather than exported, because nothing outside this module has a
 * `SuggestionStatus` in hand at the point where it renders one.
 */
const SUGGESTION_SPOKEN: Readonly<Record<string, string>> = {
  SUGGESTED: 'Suggested',
  ACCEPTED: 'Accepted',
  REJECTED: 'Not accepted',
};

/**
 * The four shapes a programmer writes a name in.
 *
 * Anchored, so a match means the *whole* string is an identifier and not merely that one
 * appears inside a sentence. Checked in order of how common they are in this codebase.
 */
const IDENTIFIER_SHAPES: readonly RegExp[] = [
  /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/, // SCREAMING_SNAKE_CASE
  /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/, // snake_case
  /^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/, // kebab-case
  /^[a-z]+(?:[A-Z][a-z0-9]*)+$/, //     camelCase
];

/**
 * Whether a string is a name from the code rather than words from a person or a document.
 *
 * The whitespace test comes first and rejects the overwhelming majority of real content in one
 * comparison. What survives it is a single unbroken token, and only the four shapes above are
 * treated as ours — which means a lone uppercase word like `PDF` or an account number like
 * `0000111122` is left exactly as it is, because neither is safe to reshape and both are things
 * a reader is meant to see verbatim.
 */
function looksLikeIdentifier(value: string): boolean {
  if (/\s/.test(value)) return false;
  return IDENTIFIER_SHAPES.some((shape) => shape.test(value));
}

/**
 * Turns an identifier into a sentence-case phrase.
 *
 * Only ever called on strings `looksLikeIdentifier` has accepted, so the separators are known
 * and the result is one line. Acronyms are the one special case: a run of capitals that
 * survives as its own word is left uppercase, so `SHARED_PDF_SOURCE` reads "Shared PDF source"
 * rather than "Shared pdf source".
 */
function humanise(value: string): string {
  const words = value
    // camelCase first: the boundary is a case change, not a separator, and splitting on the
    // separators afterwards then handles the mixed forms that appear in stored keys.
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[_\-\s]+/)
    .filter(Boolean);

  return words
    .map((word, index) => {
      // A short all-caps run is an acronym the reader knows — OCR, PDF, ID, AI. Lowercasing it
      // would make the phrase harder to read, not easier.
      if (word.length <= 4 && word === word.toUpperCase() && /[A-Z]/.test(word)) return word;
      const lowered = word.toLowerCase();
      return index === 0 ? lowered.charAt(0).toUpperCase() + lowered.slice(1) : lowered;
    })
    .join(' ');
}

/**
 * A phrase a reader can understand, for any stored value at all.
 *
 * This is the function a screen calls when it is about to render something it did not write.
 * Its contract is total: a mapped constant becomes its authored label, an unmapped identifier
 * becomes a sentence-case phrase, real content passes through untouched, and anything that is
 * not a usable string becomes `''` so a caller can fall back rather than print "undefined".
 *
 * @param value anything a record, a detector or an API can put in front of a reader.
 * @returns the phrase to render, or `''` when there is nothing worth rendering.
 */
export function readableToken(value: unknown): string {
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value !== 'string') return '';

  const trimmed = value.trim();
  if (trimmed.length === 0) return '';

  const spoken = SPOKEN[trimmed] ?? SUGGESTION_SPOKEN[trimmed];
  if (spoken) return spoken;

  return looksLikeIdentifier(trimmed) ? humanise(trimmed) : trimmed;
}

/**
 * Whether a message is a machine's vocabulary rather than a sentence for a person.
 *
 * The canonical implementation. `@features/settings/auth-errors` re-exports it under the same
 * name so the sign-in forms keep their existing import, and it lives here because the four
 * screens that most needed it — the analysis panel, the evidence row, the activity feed and the
 * upload form — are nowhere near the auth layer and were each rendering a caught `message`
 * directly for want of a shared answer to this question.
 */
export function looksInternal(message: string): boolean {
  const trimmed = message.trim();
  if (trimmed.length === 0) return true;
  if (/(auth|firestore|storage|functions)\/[a-z0-9-]+/i.test(trimmed)) return true;

  const lowered = trimmed.toLowerCase();
  return INTERNAL_MARKERS.some((marker) => lowered.includes(marker));
}

/**
 * Substrings that mean "the app broke", not "you did something wrong".
 *
 * Two groups. The first names the machinery — a message that mentions Firebase or a Zod issue
 * is describing our plumbing to someone who did not ask about it. The second is the shape of a
 * JavaScript type error, which reaches a `catch` block far more often than anyone expects and
 * is never actionable: nobody can fix "undefined is not an object" from a screen.
 */
const INTERNAL_MARKERS: readonly string[] = [
  'firebase',
  'firestore',
  'zoderror',
  'validation failed',
  'invalid_type',
  'unrecognized_keys',
  'expected object, received',
  'undefined is not',
  'null is not',
  'is not a function',
  'cannot read propert',
  'unexpected token',
  'json parse',
  'network request failed',
  '[object object]',
];

/**
 * The sentence to show when something a screen attempted did not work.
 *
 * ## Why the fallback is a required argument
 *
 * A single house error message would have been easier and would have made every failure in the
 * app read the same, which is the state this replaces — four screens rendering a raw exception
 * because the alternative on offer was a message that told the user nothing. The caller knows
 * what was being attempted and is the only one who can say what to do about it, so it has to
 * supply that sentence. What this function decides is narrower and is the part no screen should
 * be deciding for itself: whether the message it was handed is fit to show.
 *
 * A message is shown only when it reads as prose written for a person — no machine markers, and
 * long enough to be a sentence rather than a code. Everything else is replaced by the fallback,
 * so a `ZodError`'s JSON issue array, a Firestore permission string and a `TypeError` all arrive
 * at the reader as the same actionable sentence the screen author wrote.
 *
 * @param caught whatever reached the `catch`.
 * @param fallback what to say when the caught value cannot be shown. Written by the caller.
 * @returns a sentence for a person, never a raw message.
 */
export function readableError(caught: unknown, fallback: string): string {
  const raw =
    caught instanceof Error
      ? caught.message
      : typeof caught === 'string'
        ? caught
        : '';

  const trimmed = raw.trim();
  // A one-word message is a code even when it passes every marker test, and a message longer
  // than a paragraph is a stack trace or a serialised payload. Neither is a sentence.
  if (trimmed.length < 12 || trimmed.length > 300) return fallback;
  if (looksInternal(trimmed)) return fallback;
  return trimmed;
}

/**
 * The raw message, when a screen has somewhere honest to put it.
 *
 * `ErrorState` has a `detail` slot for exactly this: a collapsed, secondary line that a user can
 * read out to whoever is helping them, below a primary message that already told them what to
 * do. That is a legitimate home for provider vocabulary, so this returns it — trimmed and length
 * capped, because the slot is one or two lines and a serialised payload would push the retry
 * button off the screen.
 *
 * @returns the message, or `undefined` when there is nothing worth attaching.
 */
export function errorDetail(caught: unknown): string | undefined {
  const raw = caught instanceof Error ? caught.message : typeof caught === 'string' ? caught : '';
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.length > 200 ? `${trimmed.slice(0, 199)}…` : trimmed;
}
