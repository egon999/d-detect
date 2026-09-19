import type { MatchConfidence, RelationshipType } from '../enums';
import type { Claim, Evidence, Extraction, TextFieldKey } from '../models';
import { formatDate } from '../normalize/dates';
import { normalizeForSearch } from '../normalize/text';
import { filterIndependentSources } from '../analysis/independence';
import type { RuleContext } from './types';

/**
 * Helpers shared by more than one rule. Kept here rather than duplicated so that a
 * change to what "independent source" means updates every rule at once.
 */

/** Relationship types that mean "this evidence backs up that entity". */
export const SUPPORTING_TYPES: readonly RelationshipType[] = ['SUPPORTS', 'ATTACHED_TO_EVENT'];

/** Relationship types that mean "this evidence is not an independent source". */
const DEPENDENT_TYPES: readonly RelationshipType[] = ['DUPLICATE_OF', 'DERIVED_FROM'];

/** Evidence explicitly linked to an entity with one of the given relationship types. */
export function evidenceLinkedTo(
  context: RuleContext,
  kind: 'claim' | 'event',
  id: string,
  types: readonly RelationshipType[],
): Evidence[] {
  return context
    .linksTo(kind, id)
    .filter((link) => link.from.kind === 'evidence' && types.includes(link.type))
    .map((link) => context.evidenceById.get(link.from.id))
    .filter((item): item is Evidence => Boolean(item))
    .sort((a, b) => a.id.localeCompare(b.id));
}


/**
 * Reduces a set of evidence to genuinely independent sources.
 *
 * Accounts for SHA-256 byte identity, explicit relationship links (DUPLICATE_OF, DERIVED_FROM),
 * identical text content, and shared transaction anchors so derivative captures
 * do not inflate corroboration.
 */
export function independentSources(context: RuleContext, items: readonly Evidence[]): Evidence[] {
  return filterIndependentSources(context, items);
}

/** Identifier fields worth matching on, with the label used in explanations. */
export const IDENTIFIER_FIELDS: ReadonlyArray<{ key: TextFieldKey; label: string }> = [
  { key: 'invoiceNumbers', label: 'invoice number' },
  { key: 'orderNumbers', label: 'order number' },
  { key: 'transactionIds', label: 'transaction reference' },
];

export interface IdentifierGroup {
  field: TextFieldKey;
  /** Human label for the field, e.g. "invoice number". */
  label: string;
  /** The normalized identifier itself, e.g. INV2024018. */
  value: string;
  /** Every distinct source quoting it, id-sorted. Always two or more. */
  items: Evidence[];
}

/**
 * Groups evidence by the reference numbers they quote.
 *
 * Deliberately grouped rather than compared pairwise. Five documents about one invoice
 * produce ten pairs, and ten near-identical "these two share a reference" findings
 * would bury the case in noise. One finding per reference number says the same thing
 * once and reads like an observation a person would actually make.
 *
 * Duplicate uploads are collapsed first, so a re-uploaded file does not appear twice in
 * the same group.
 */
export function identifierGroups(
  context: RuleContext,
  items: readonly Evidence[] = context.evidence,
): IdentifierGroup[] {
  const sources = independentSources(context, items);
  const groups = new Map<string, IdentifierGroup>();

  for (const item of sources) {
    const extraction = context.extractionOf(item.id);
    if (!extraction) continue;

    for (const field of IDENTIFIER_FIELDS) {
      for (const value of new Set(extraction[field.key].map((entry) => entry.normalized))) {
        const key = `${field.key}:${value}`;
        const existing = groups.get(key);
        if (existing) existing.items.push(item);
        else groups.set(key, { field: field.key, label: field.label, value, items: [item] });
      }
    }
  }

  return [...groups.values()]
    .filter((group) => group.items.length > 1)
    .map((group) => ({ ...group, items: [...group.items].sort((a, b) => a.id.localeCompare(b.id)) }))
    .sort((a, b) => a.field.localeCompare(b.field) || a.value.localeCompare(b.value));
}

/** Stable ordering for entity id lists that end up in derived ids and explanations. */
export function sortedIds(ids: Iterable<string>): string[] {
  return [...ids].sort();
}

/** Short human label for an evidence item, used inside explanations. */
export function evidenceLabel(item: Evidence): string {
  return item.title || item.fileName || item.id;
}

/**
 * Quotes a piece of the user's own text at a length a finding can afford.
 *
 * A rule's `explanation` has a budget — see `docs/copy-doctrine.md` and `tests/rule-copy.test.ts`
 * — and every rule that quotes a claim statement, an event title or a document name is quoting
 * something the user typed, which has no length at all. One person's claim is eight words and
 * the next person's is a paragraph, so a template that reads comfortably against the sample case
 * can overrun the card against a real one. The rule cannot control that, and truncating at the
 * point of use is the only place it can be controlled: by the time the string reaches the card
 * it is one sentence with no seam to cut on.
 *
 * Cut on a word boundary rather than mid-word, because a quotation that stops inside a word
 * reads as a rendering bug and invites the reader to distrust the rest of the card. The ellipsis
 * is the real character, not three dots, so it is clear the text was shortened by the app rather
 * than trailing off in the source.
 *
 * Returns the text already wrapped in quotation marks. Callers used to add their own, and a
 * truncated string then closed its quote after the ellipsis or before it depending on who wrote
 * the template.
 */
export function quoteShort(text: string, max = 64): string {
  const clean = text.trim();
  if (clean.length <= max) return `"${clean}"`;
  // `\s+\S*$` drops the partial final word along with the space before it. If the cut lands
  // inside a single very long token there is nothing to trim, so the slice stands as-is.
  const cut = clean.slice(0, max).replace(/\s+\S*$/, '');
  return `"${(cut || clean.slice(0, max)).trimEnd()}…"`;
}

/**
 * Reader-facing wording for a transaction status.
 *
 * The stored value is a screaming-snake enum because it is a machine field the extractor
 * writes and the rules branch on. A finding's `inputs` is read by a person, though, and
 * putting `CANCELLED` in front of them shows the database's vocabulary rather than the
 * document's — the same mistake as printing a raw id. The phrasing is deliberately flat
 * ("the payment did not go through", not "payment failed!") because the rule that reports
 * it has already said what the conflict is; this is only naming the state the document
 * recorded.
 *
 * `UNKNOWN` says the document was read but no status was found, which is different from
 * the field being absent — a reader needs to be able to tell those apart.
 */
export function transactionStatusLabel(status: Extraction['transactionStatus']): string {
  switch (status) {
    case 'SUCCESS':
      return 'Completed';
    case 'FAILED':
      return 'Did not go through';
    case 'PENDING':
      return 'Still pending';
    case 'CANCELLED':
      return 'Cancelled';
    case 'UNKNOWN':
      return 'Not stated';
  }
}

/**
 * Labels for a set of sources, guaranteed distinct within that set.
 *
 * ## Why this exists
 *
 * `evidenceLabel` returns the title the user typed, and titles repeat constantly: the upload
 * screen asks for one title per file, and real users type "Screenshot", "Bill" or "Receipt"
 * over and over. Two sources sharing a title broke every finding that compares two documents,
 * in two separate ways:
 *
 * 1. **A compared value disappeared.** `inputs` is a `Record<string, string>` keyed by label,
 *    so `{ [label(a)]: '₹100', [label(b)]: '₹500' }` collapsed to a single key. The finding
 *    whose whole purpose is to let a reader check the conclusion showed one of the two figures
 *    it had compared. Silently — no error, nothing to notice.
 * 2. **The sentence became unreadable.** `"Screenshot" states ₹100 while "Screenshot" states
 *    ₹500` names the same document twice and tells the reader nothing about which is which.
 *
 * ## How a duplicate is resolved
 *
 * By adding the most recognisable distinguishing detail available, in order: the file name
 * (which the evidence list already shows, so the user can find the file), then the source
 * attribution, then a short id suffix. The id suffix is never reached in practice but it
 * cannot collide, which is what makes the guarantee unconditional rather than best-effort.
 *
 * Unique labels are returned untouched, so nothing is decorated for the sake of consistency —
 * a reader should see "Google Pay screenshot", not "Google Pay screenshot (gpay.png)".
 */
export function distinctEvidenceLabels(items: readonly Evidence[]): Map<string, string> {
  const byLabel = new Map<string, Evidence[]>();
  for (const item of items) {
    const label = evidenceLabel(item);
    const list = byLabel.get(label);
    if (list) list.push(item);
    else byLabel.set(label, [item]);
  }

  const resolved = new Map<string, string>();
  for (const [label, group] of byLabel) {
    if (group.length === 1) {
      resolved.set(group[0]!.id, label);
      continue;
    }

    // Sorted by id so the same set of sources always produces the same labels — findings are
    // content-addressed by their inputs, and a label that varied between runs would make an
    // unchanged case look like it had new findings.
    const ordered = [...group].sort((a, b) => a.id.localeCompare(b.id));
    const taken = new Set<string>();
    for (const item of ordered) {
      const candidates = [
        item.fileName ? `${label} (${item.fileName})` : null,
        item.sourceLabel ? `${label} (${item.sourceLabel})` : null,
        // `…` + the last 6 characters of the id. Always available, always distinct.
        `${label} (${item.id.slice(-6)})`,
      ];
      const chosen = candidates.find(
        (candidate): candidate is string => candidate !== null && !taken.has(candidate),
      );
      // The id-suffix candidate cannot be taken twice, so `chosen` is always defined; the
      // fallback keeps this total without a non-null assertion.
      const final = chosen ?? `${label} (${item.id})`;
      taken.add(final);
      resolved.set(item.id, final);
    }
  }

  return resolved;
}

/**
 * Pairs of evidence, each pair yielded once, in a deterministic order.
 * Used by every rule that compares two sources.
 */
export function* evidencePairs(items: readonly Evidence[]): Generator<[Evidence, Evidence]> {
  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      yield [items[i]!, items[j]!];
    }
  }
}

// ---------------------------------------------------------------------------
// Comparison groups
// ---------------------------------------------------------------------------

/**
 * Why a set of documents was put side by side.
 *
 * Ordered strongest first; the order is load-bearing, since a weaker grouping is
 * discarded when a stronger one already covers the same documents.
 */
export type ComparisonBasis =
  | 'SHARED_IDENTIFIER'
  | 'SHARED_PARTY_AND_DATE'
  | 'SAME_DAY'
  | 'SHARED_PARTY';

const BASIS_ORDER: readonly ComparisonBasis[] = [
  'SHARED_IDENTIFIER',
  'SHARED_PARTY_AND_DATE',
  'SAME_DAY',
  'SHARED_PARTY',
];

/**
 * How confident we are that one group really describes a single transaction or event.
 *
 * Never `EXACT_MATCH`. Nothing available here can *prove* two documents describe the
 * same thing — a shared invoice number is strong evidence of it, not a demonstration.
 * The ceiling is deliberate: it is the difference between "these agree" and "these are
 * about the same thing and they agree", and only the second is worth telling a user.
 */
const BASIS_CONFIDENCE: Record<ComparisonBasis, MatchConfidence> = {
  SHARED_IDENTIFIER: 'STRONG_MATCH',
  SHARED_PARTY_AND_DATE: 'STRONG_MATCH',
  SAME_DAY: 'SUGGESTED_MATCH',
  SHARED_PARTY: 'NEEDS_REVIEW',
};

/** One step down the ladder, used when a group rests on an ambiguously written date. */
const DOWNGRADED: Record<MatchConfidence, MatchConfidence> = {
  EXACT_MATCH: 'STRONG_MATCH',
  STRONG_MATCH: 'SUGGESTED_MATCH',
  SUGGESTED_MATCH: 'NEEDS_REVIEW',
  NEEDS_REVIEW: 'NEEDS_REVIEW',
};

export interface ComparisonGroup {
  basis: ComparisonBasis;
  /**
   * Stable, collision-free key for this grouping, used to derive finding ids.
   * Carries the basis so that regrouping the same documents on different grounds
   * produces a different finding rather than silently overwriting one.
   */
  key: string;
  /**
   * The linking fact, phrased to drop into a sentence: "both reference INV2024018",
   * "both dated 12 September 2026". This is what makes a finding explainable — the
   * user can see the grounds for the comparison and reject them if they are wrong.
   */
  reason: string;
  confidence: MatchConfidence;
  /** Every distinct source in the group, id-sorted. Always two or more. */
  items: Evidence[];
}

/** Normalised organisation names worth grouping on. */
function organisationKeys(context: RuleContext, item: Evidence): string[] {
  const extraction = context.extractionOf(item.id);
  if (!extraction) return [];
  return [
    ...new Set(
      extraction.organizations
        .map((field) => field.normalized)
        // Two-character "organisations" are almost always extraction noise, and grouping
        // on one would sweep unrelated documents together.
        .filter((value) => value.length >= 3),
    ),
  ];
}

/**
 * Day-precision dates, each flagged for whether its written form is ambiguous.
 *
 * Ambiguous dates are deliberately *kept*. `12/03/2024` could be 12 March or 3 December, but
 * when two documents both carry it and both normalise the same way, whatever the true day is,
 * it is the same day in both — which is all grouping needs to decide. Discarding them would
 * lose the most common case in the product, since dd/mm dates are how most receipts are printed.
 *
 * The residual risk is real but narrower: an Indian merchant writing day-first and a payment
 * app writing month-first would produce the same key for different days. That is handled by
 * downgrading the group's confidence and saying so in the reason, rather than by refusing to
 * compare the documents at all.
 */
function dayKeys(context: RuleContext, item: Evidence): Array<{ iso: string; ambiguous: boolean }> {
  const extraction = context.extractionOf(item.id);
  if (!extraction) return [];
  const byIso = new Map<string, boolean>();
  for (const date of extraction.dates) {
    if (date.precision !== 'DAY' || !date.iso) continue;
    byIso.set(date.iso, (byIso.get(date.iso) ?? false) || date.ambiguous);
  }
  return [...byIso.entries()].map(([iso, ambiguous]) => ({ iso, ambiguous }));
}

/** Human-readable form of a `YYYY-MM-DD` key. */
function formatDayKey(iso: string): string {
  return formatDate({ original: iso, iso, precision: 'DAY', ambiguous: false });
}

/**
 * Finds sets of documents that plausibly describe the same transaction or event.
 *
 * ## Why this exists
 *
 * Comparing amounts only where documents share a reference number sounds rigorous and
 * is, in practice, close to useless. A mall bill carries a bill number; the Google Pay
 * screenshot of that same payment carries a UPI reference. Two systems, two numbering
 * schemes, no overlap — so the single most common real scenario this product exists to
 * handle produced no comparison at all.
 *
 * The inverse failure is worse. A rule that compares amounts with *no* grounding will
 * happily announce that two unrelated ₹5,000 receipts "corroborate" each other. In a
 * tool people use to work out what actually happened, inventing agreement is a more
 * damaging error than missing a disagreement.
 *
 * So grouping is explicit and always stated. Documents are compared when something
 * concrete links them, that link is carried on the group as `reason`, and every finding
 * built from a group repeats it. A user who sees "both dated 12 September 2026" can tell
 * at a glance whether the comparison was fair — which is the whole point, because the
 * app is not in a position to know that a shop and a bank happened to share a date by
 * coincidence.
 *
 * ## Grouping, not chaining
 *
 * Groups are formed per signal, exactly like {@link identifierGroups}, and never merged.
 * Union-find would chain A to C because A shares a date with B and B shares a merchant
 * with C — a transitive link nobody asserted and that is usually false.
 *
 * A weaker group is dropped when a stronger group already contains all of its documents,
 * so two files sharing both an invoice number and a date are reported once, on the
 * stronger ground.
 *
 * Duplicate uploads are collapsed first, so a re-uploaded file never corroborates itself.
 */
export function comparisonGroups(
  context: RuleContext,
  items: readonly Evidence[] = context.evidence,
): ComparisonGroup[] {
  const sources = independentSources(context, items);
  const candidates = new Map<string, ComparisonGroup & { ambiguousDate: boolean }>();

  const add = (
    key: string,
    basis: ComparisonBasis,
    reason: string,
    item: Evidence,
    ambiguousDate = false,
  ): void => {
    const existing = candidates.get(key);
    if (existing) {
      existing.items.push(item);
      existing.ambiguousDate = existing.ambiguousDate || ambiguousDate;
      return;
    }
    candidates.set(key, {
      basis,
      key,
      reason,
      confidence: BASIS_CONFIDENCE[basis],
      items: [item],
      ambiguousDate,
    });
  };

  for (const item of sources) {
    const extraction = context.extractionOf(item.id);
    if (!extraction) continue;

    for (const field of IDENTIFIER_FIELDS) {
      for (const value of new Set(extraction[field.key].map((entry) => entry.normalized))) {
        add(
          `SHARED_IDENTIFIER:${field.key}:${value}`,
          'SHARED_IDENTIFIER',
          `both reference ${field.label} ${value}`,
          item,
        );
      }
    }

    const days = dayKeys(context, item);
    const organisations = organisationKeys(context, item);

    for (const day of days) {
      add(
        `SAME_DAY:${day.iso}`,
        'SAME_DAY',
        `both are dated ${formatDayKey(day.iso)}`,
        item,
        day.ambiguous,
      );
      for (const organisation of organisations) {
        add(
          `SHARED_PARTY_AND_DATE:${organisation}:${day.iso}`,
          'SHARED_PARTY_AND_DATE',
          `both name ${organisation} and are dated ${formatDayKey(day.iso)}`,
          item,
          day.ambiguous,
        );
      }
    }

    for (const organisation of organisations) {
      add(`SHARED_PARTY:${organisation}`, 'SHARED_PARTY', `both name ${organisation}`, item);
    }
  }

  const populated = [...candidates.values()]
    .filter((group) => group.items.length > 1)
    .map(({ ambiguousDate, ...group }) => ({
      ...group,
      items: [...group.items].sort((a, b) => a.id.localeCompare(b.id)),
      // A date that could be read two ways still groups the documents, but the app should
      // not sound as sure about it. The reader is told which way it was read so they can
      // correct it if the two documents came from differently-configured systems.
      confidence: ambiguousDate ? DOWNGRADED[group.confidence] : group.confidence,
      reason: ambiguousDate
        ? `${group.reason} (that date is written in a form that can be read two ways)`
        : group.reason,
    }))
    .sort(
      (a, b) =>
        BASIS_ORDER.indexOf(a.basis) - BASIS_ORDER.indexOf(b.basis) || a.key.localeCompare(b.key),
    );

  // Keep a group only when some stronger group does not already cover the same documents.
  // Sorted strongest-first above, so everything already kept is at least as strong.
  const kept: ComparisonGroup[] = [];
  for (const group of populated) {
    const ids = new Set(group.items.map((item) => item.id));
    const covered = kept.some((existing) => {
      const existingIds = new Set(existing.items.map((item) => item.id));
      return [...ids].every((id) => existingIds.has(id));
    });
    if (!covered) kept.push(group);
  }

  return kept;
}

// ---------------------------------------------------------------------------
// Reading free text a person typed
// ---------------------------------------------------------------------------

/**
 * A claim that *reads as* asserting the payment went through, and the word that made it
 * read that way.
 *
 * The second field is the point. A rule that says "your statement contradicts this
 * document" and cannot say which word it matched on is unfalsifiable; one that names the
 * word lets the reader answer "that is not what I meant" and move on.
 */
export interface KeywordReadClaim {
  claim: Claim;
  /** The single word this reading rests on, e.g. `received`. */
  matched: string;
}

/**
 * Words that, on their own, read as "the payment went through".
 *
 * Deliberately the same five the rule has always used. Widening the list would change what
 * the rule *finds*; this change is only about no longer being wrong on what it already
 * found, and the two should not be mixed into one edit.
 */
const PAYMENT_SUCCEEDED_TERMS: ReadonlySet<string> = new Set([
  'paid',
  'transferred',
  'received',
  'settled',
  'sent',
]);

/**
 * Words that read as "the payment did not go through" — the *same* sense the document is
 * recording when its status is FAILED or CANCELLED.
 *
 * Used to abstain, never to conclude. See {@link claimsReadAsPaymentSucceeded}.
 */
const PAYMENT_FAILED_TERMS: ReadonlySet<string> = new Set([
  'unpaid',
  'failed',
  'failure',
  'declined',
  'rejected',
  'bounced',
  'reversed',
  'cancelled',
  'canceled',
  'refunded',
  'pending',
]);

/**
 * Tokens that flip the sense of the clause they sit in.
 *
 * Note what this list is *not* asked to do. It never has to be complete, because a cue it
 * misses does not produce a confident accusation — it produces a LOW-severity question that
 * names the word it matched on. The list is an accuracy improvement on a reading that is
 * already presented as a reading.
 */
const NEGATION_CUES: ReadonlySet<string> = new Set([
  'not',
  'never',
  'no',
  'nor',
  'neither',
  'none',
  'nothing',
  'without',
  'cannot',
  'refused',
  'denied',
  'yet',
  'awaiting',
  'still',
]);

/**
 * Clause boundaries. Splitting on these is what keeps a negation from reaching across
 * "I paid the deposit, but the balance was never sent" and suppressing both halves.
 */
const CLAUSE_SPLIT = /[.;:!?,]+|\b(?:but|although|though|however|whereas|while)\b/;

/** Words, with `’` folded to `'` so `didn’t` and `didn't` tokenize alike. */
function words(clause: string): string[] {
  return clause.replace(/[‘’ʼ]/g, "'").match(/[a-z0-9']+/g) ?? [];
}

function isNegated(clause: string): boolean {
  return words(clause).some((word) => NEGATION_CUES.has(word) || word.endsWith("n't"));
}

/**
 * Claims whose wording reads as asserting that a payment succeeded.
 *
 * ## What was wrong before
 *
 * This was `text.includes('paid')`, which is `true` of `unpaid`, `prepaid` and `repaid`;
 * `includes('received')` is `true` of `never received`; `includes('sent')` is `true` of
 * `unsent`. So the single most common thing a user writes when their payment failed — "the
 * invoice remains unpaid" — was classified as asserting the opposite, and the app told them
 * their own statement contradicted their own bank record. At HIGH severity, in the audit
 * trail, about evidence that agreed perfectly.
 *
 * ## What this does instead
 *
 * Three things, in order of how much weight they carry:
 *
 * 1. **Whole words.** `\b`-style token matching disposes of the entire `unpaid`/`prepaid`/
 *    `repaid`/`unsent` class outright, without a list of exceptions to maintain.
 * 2. **Clause-scoped negation.** Any negation cue anywhere in the same clause suppresses the
 *    reading. Scoped to the clause rather than a fixed window of preceding words, so there
 *    is no token distance to tune, and it over-suppresses rather than under-suppresses —
 *    the failure direction is silence.
 * 3. **Abstain when both senses are present.** A claim that says both `failed` and `paid`
 *    is not classified by which appears first. Nothing here can tell which one describes
 *    *this* transaction, so it produces nothing at all.
 *
 * ## What it still cannot do, and why that is survivable
 *
 * It cannot read "hardly what I'd call received". No word-matching rule can, and the honest
 * response is not a longer list but a ceiling on what the result is allowed to claim: a
 * caller must treat this as a guess about a sentence, not as a value read off a document,
 * and grade its findings accordingly. `payment-status-conflict` does exactly that — a match
 * here can only ever produce a LOW-severity question that quotes the word it matched.
 */
export function claimsReadAsPaymentSucceeded(claims: readonly Claim[]): KeywordReadClaim[] {
  const found: KeywordReadClaim[] = [];

  for (const claim of claims) {
    const text = normalizeForSearch(`${claim.statement} ${claim.detail}`);

    // Both senses in one statement: say nothing. This is the same defect as a classifier
    // that checks FAILED before SUCCESS and returns on the first hit — the answer would be
    // decided by word order rather than by meaning.
    if (words(text).some((word) => PAYMENT_FAILED_TERMS.has(word))) continue;

    let matched: string | null = null;
    for (const clause of text.split(CLAUSE_SPLIT)) {
      if (isNegated(clause)) continue;
      matched = words(clause).find((word) => PAYMENT_SUCCEEDED_TERMS.has(word)) ?? null;
      if (matched) break;
    }

    if (matched) found.push({ claim, matched });
  }

  return found;
}

/**
 * Claims that are *about* whether a payment went through, in either direction.
 *
 * This answers a different question from {@link claimsReadAsPaymentSucceeded}, and the
 * difference is why it exists separately. That function decides what a claim *asserts*, so it
 * has to honour negation and abstain on ambiguity. This one only decides what a claim is
 * *about*, which is what `relatedClaimIds` means: whether a finding belongs on this claim's
 * screen. "I never received the money" asserts failure and is plainly relevant to a document
 * conflict over the same payment, so negation is not filtered here — both directions attach.
 *
 * ## What it replaces
 *
 * A topic regex: `/\b(paid|pay|payment|amount|due|settle|transfer|balance|receipt|invoice|
 * money|fee)\b/`. In a payments dispute app, that matches essentially every claim a user
 * writes — "the amount is undisputed between us" matched on `amount` — so a HIGH-severity
 * contradiction between two documents was attached to every claim in the case, including
 * claims stating the opposite of a dispute. `relatedClaimIds` drives which findings appear on
 * a claim, so the effect was a red contradiction pinned to unrelated statements, and a user
 * who learns that the attachment means nothing stops reading all of them.
 */
export function claimsAboutPaymentOutcome(claims: readonly Claim[]): Claim[] {
  return claims.filter((claim) => {
    const text = normalizeForSearch(`${claim.statement} ${claim.detail}`);
    return words(text).some(
      (word) => PAYMENT_SUCCEEDED_TERMS.has(word) || PAYMENT_FAILED_TERMS.has(word),
    );
  });
}

/**
 * Claims mentioning a named participant.
 *
 * Whole-word, and name parts shorter than three characters are ignored entirely. The
 * substring match this replaces — `claimText.includes(sender)` — attached a finding to every
 * claim in the case whenever a chat export carried a short or initial-only sender name, since
 * a one-letter name is a substring of almost any sentence.
 *
 * A name is split into parts and matches on any one of them, because a chat export labels the
 * sender however the app stored them ("Rahul Sharma", "+91 98…", "Rahul S.") while a user
 * writing a claim says "Rahul". Requiring the whole name to appear would drop the ordinary case.
 */
export function claimsMentioningAnyone(claims: readonly Claim[], names: readonly string[]): Claim[] {
  const wanted = new Set(names.flatMap((name) => words(name.toLowerCase())).filter((part) => part.length >= 3));
  if (wanted.size === 0) return [];
  return claims.filter((claim) => {
    const text = normalizeForSearch(`${claim.statement} ${claim.detail}`);
    return words(text).some((word) => wanted.has(word));
  });
}
