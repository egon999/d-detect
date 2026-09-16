/**
 * Provenance for AI-derived values.
 *
 * ## The rule this module enforces structurally
 *
 * Nothing a model returns is ever a value in Detact. It is a *suggestion about* a value.
 * The difference is carried in three places on every record, and this module is what
 * guarantees all three are populated rather than leaving it to each call site:
 *
 * - `method: 'AI'` on the field's `Provenance`, which puts it last in the
 *   MANUAL > DETERMINISTIC > AI precedence order used by `@domain/extraction/merge`. A
 *   value a person confirmed can therefore never be overwritten by a later model run.
 * - `status: 'SUGGESTED'` on the stored `AIExtractionSuggestion`, so it takes effect only
 *   after someone taps accept. `ACCEPTED` is written by a user action, never by a model.
 * - `model` + `promptVersion`, so a suggestion remains attributable after the model is
 *   decommissioned or the prompt is reworded.
 *
 * ## Why model-supplied numbers are recomputed rather than stored
 *
 * The prompts ask the model for an `iso` date and a `minorUnits` amount, and this module
 * throws both away. It keeps only the `original` span — the text the model says it found —
 * and re-derives the canonical form with the same deterministic normalizers the no-AI path
 * uses (`normalizeDate`, `normalizeAmount`).
 *
 * That is the difference between "the model located a number" and "the model computed a
 * number". A model that miscounts cents, or resolves `03/04/2024` to the wrong month,
 * cannot introduce a wrong value here — the normalizer either agrees or returns `null` and
 * the candidate is dropped. A dropped suggestion is visibly absent; a plausible wrong
 * amount would be compared against real values by the rule engine and produce a
 * real-looking finding.
 *
 * A value the model reports but that is **not present in the source text** is also
 * dropped, which is the one check that catches outright fabrication rather than trusting
 * the prompt's instruction not to fabricate.
 *
 * ## Citations are verified here, not trusted
 *
 * The cross-document prompts in `./prompts` require a `{evidenceId, segmentId, quote}` for
 * every assertion. A prompt requirement is not a guarantee: a model will occasionally cite
 * `seg_14` in a document that has nine segments, or quote a sentence that reads like the
 * document but is not in it. Those are the two ways this product could show a user a
 * fabricated finding with a citation attached, which would be worse than showing no finding
 * at all — the citation is the thing that makes the output auditable, so an unchecked
 * citation is a lie with a footnote.
 *
 * `verifyCitations` resolves every claimed citation against the real segment list and the
 * real source text, and nothing downstream is allowed to render a citation that did not come
 * out of it. See the comment above `verifyCitations` for what happens to each failure.
 */

import { EXTRACTOR_VERSION } from '@domain/extraction/deterministic';
import type { MatchConfidence } from '@domain/enums';
import { newId } from '@domain/ids';
import type {
  AIExtractionSuggestion,
  AmountField,
  CaseCitation,
  DateField,
  Extraction,
  Provenance,
  TextField,
} from '@domain/models';
import { normalizeDate } from '@domain/normalize/dates';
import { normalizeAmount } from '@domain/normalize/money';
import { normalizeIdentifier, normalizeText } from '@domain/normalize/text';

/** Identifies the AI pass that produced a value, alongside `EXTRACTOR_VERSION` for the deterministic one. */
export function aiExtractionVersion(promptVersion: string): string {
  return `ai-${promptVersion}-over-${EXTRACTOR_VERSION}`;
}

/**
 * A model's self-reported confidence, as a band a person can act on.
 *
 * The single conversion every screen must use before showing an AI confidence. Nothing in
 * this app renders a model's number as a percentage, for the reason stated beside
 * `MatchConfidenceEnum` in `@domain/enums`: "99.7%" next to a machine guess implies a
 * precision the system does not have. Worse, the number is the model's opinion of its own
 * output — an unvalidated self-assessment — and a percentage presents it as a measurement.
 *
 * The bands are deliberately coarse and the ceiling is deliberately low. A model that
 * reports 0.99 still lands on `STRONG_MATCH`, never `EXACT_MATCH`: exact is reserved for
 * deterministic equality, such as two identical SHA-256 hashes. No amount of model
 * confidence earns that label.
 *
 * `null` — the model reported nothing — maps to `NEEDS_REVIEW`, the same as a low score.
 * That is the right collapse: in both cases a person has to look.
 *
 * @param value 0..1, or `null` when the model reported no confidence.
 */
export function confidenceBand(value: number | null): MatchConfidence {
  if (value === null || !Number.isFinite(value)) return 'NEEDS_REVIEW';
  if (value >= 0.85) return 'STRONG_MATCH';
  if (value >= 0.6) return 'SUGGESTED_MATCH';
  return 'NEEDS_REVIEW';
}

export interface AIProvenanceInput {
  evidenceId: string;
  model: string;
  promptVersion: string;
  /** The span in the source text the value was read from, for the "where did this come from?" view. */
  sourceQuote?: string;
}

/** The `Provenance` every AI-derived field carries. `method` is `'AI'` and cannot be overridden. */
export function aiProvenance(input: AIProvenanceInput): Provenance {
  return {
    evidenceId: input.evidenceId,
    method: 'AI',
    ...(input.sourceQuote ? { sourceQuote: input.sourceQuote.slice(0, 400) } : {}),
    model: input.model.slice(0, 120),
    extractionVersion: aiExtractionVersion(input.promptVersion).slice(0, 60),
  };
}

/**
 * Confirms a model-reported span really occurs in the document it was read from.
 *
 * Compared after `normalizeText` on both sides so that whitespace and case differences
 * between the model's copy and the source do not reject a genuine find. `sourceText` is
 * optional because note-only evidence has none; with nothing to check against, the
 * candidate is allowed through on the prompt's instruction alone.
 */
function occursInSource(value: string, sourceText: string | undefined): boolean {
  if (!sourceText) return true;
  const needle = normalizeText(value).toLowerCase();
  if (!needle) return false;
  return normalizeText(sourceText).toLowerCase().includes(needle);
}

/** Captures the ~60 characters around the value in the source, mirroring the deterministic extractor's quotes. */
function quoteFor(value: string, sourceText: string | undefined): string | undefined {
  if (!sourceText) return undefined;
  const haystack = normalizeText(sourceText);
  const index = haystack.toLowerCase().indexOf(normalizeText(value).toLowerCase());
  if (index < 0) return undefined;
  return haystack.slice(Math.max(0, index - 30), Math.min(haystack.length, index + value.length + 30));
}

export interface SuggestedFieldsInput extends AIProvenanceInput {
  /** The text the model was given. Used to verify each span and to cut source quotes. */
  sourceText?: string;
}

/**
 * Turns a model-reported date into a `DateField`, or `null` if it cannot be trusted.
 *
 * Dropped when the span is absent from the source, or when the deterministic normalizer
 * cannot resolve it to an ISO value. `ambiguous` and `precision` come from the normalizer,
 * never from the model, so a date the app is unsure about is *marked* unsure.
 */
export function aiDateField(
  candidate: { original: string; role?: string },
  input: SuggestedFieldsInput,
): DateField | null {
  const original = candidate.original?.trim();
  if (!original) return null;
  if (!occursInSource(original, input.sourceText)) return null;

  const normalized = normalizeDate(original);
  // No ISO reading means the normalizer could not commit. Better absent than approximate.
  if (!normalized.iso) return null;

  return {
    ...normalized,
    original: original.slice(0, 120),
    ...(candidate.role ? { role: candidate.role.slice(0, 40) } : {}),
    ...aiProvenance({ ...input, sourceQuote: quoteFor(original, input.sourceText) }),
  };
}

/**
 * Turns a model-reported amount into an `AmountField`, or `null` if it cannot be trusted.
 *
 * The model's own `minorUnits` is ignored: `normalizeAmount` recomputes it from the span
 * and the stated currency, and returns `null` for anything it cannot parse exactly. The
 * currency must be one the money normalizer knows — an unrecognised code would otherwise
 * silently attribute an amount to the wrong currency.
 */
export function aiAmountField(
  candidate: { original: string; currency: string; role?: string },
  input: SuggestedFieldsInput,
): AmountField | null {
  const original = candidate.original?.trim();
  const currency = candidate.currency?.trim().toUpperCase();
  if (!original || !currency || currency.length !== 3) return null;
  if (!occursInSource(original, input.sourceText)) return null;

  const normalized = normalizeAmount(original, currency);
  if (!normalized) return null;

  return {
    original: normalized.original.slice(0, 120),
    minorUnits: normalized.minorUnits,
    currency: normalized.currency,
    ...(candidate.role ? { role: candidate.role.slice(0, 40) } : {}),
    ...aiProvenance({ ...input, sourceQuote: quoteFor(original, input.sourceText) }),
  };
}

/**
 * Turns a model-reported identifier, name or other string into a `TextField`.
 *
 * `normalizeIdentifier` first — reference numbers are the common case and comparing
 * `INV-2024-018` with `inv 2024 018` is what the rule engine needs — falling back to
 * plain text normalisation for names, which identifier normalisation would mangle.
 */
export function aiTextField(value: string, input: SuggestedFieldsInput): TextField | null {
  const original = value?.trim();
  if (!original) return null;
  if (!occursInSource(original, input.sourceText)) return null;

  const normalized = normalizeIdentifier(original) || normalizeText(original);
  if (!normalized) return null;

  return {
    original: original.slice(0, 600),
    normalized: normalized.slice(0, 600),
    ...aiProvenance({ ...input, sourceQuote: quoteFor(original, input.sourceText) }),
  };
}

/** The subset of an evidence analysis this module converts. Structural, so it accepts any compatible shape. */
export interface SuggestableAnalysis {
  dates?: ReadonlyArray<{ original: string; role?: string | undefined }>;
  amounts?: ReadonlyArray<{ original: string; currency: string; role?: string | undefined }>;
  identifiers?: ReadonlyArray<{ value: string }>;
  entities?: ReadonlyArray<{ type: 'person' | 'organization'; name: string }>;
}

/** AI-provenanced fields, ready to be shown beside the deterministic ones. */
export interface SuggestedFields {
  dates: DateField[];
  amounts: AmountField[];
  identifiers: TextField[];
  people: TextField[];
  organizations: TextField[];
  /** How many candidates the model returned that failed verification. Surfaceable as "n discarded". */
  discarded: number;
}

/**
 * Converts a validated evidence analysis into AI-provenanced domain fields.
 *
 * Every field that survives carries `method: 'AI'`, the model id and the prompt version.
 * Everything that fails verification is counted in `discarded` rather than dropped
 * silently, so the UI can be honest that the model proposed more than was kept.
 */
export function toSuggestedFields(
  analysis: SuggestableAnalysis,
  input: SuggestedFieldsInput,
): SuggestedFields {
  let discarded = 0;
  const keep = <T>(value: T | null): T[] => {
    if (value === null) {
      discarded += 1;
      return [];
    }
    return [value];
  };

  return {
    dates: (analysis.dates ?? []).flatMap((date) => keep(aiDateField(date, input))),
    amounts: (analysis.amounts ?? []).flatMap((amount) => keep(aiAmountField(amount, input))),
    identifiers: (analysis.identifiers ?? []).flatMap((id) => keep(aiTextField(id.value, input))),
    people: (analysis.entities ?? [])
      .filter((entity) => entity.type === 'person')
      .flatMap((entity) => keep(aiTextField(entity.name, input))),
    organizations: (analysis.entities ?? [])
      .filter((entity) => entity.type === 'organization')
      .flatMap((entity) => keep(aiTextField(entity.name, input))),
    discarded,
  };
}

export interface SuggestionRecordInput {
  ownerId: string;
  caseId: string;
  /** `null` for a case-level suggestion such as a dispute synthesis. */
  evidenceId: string | null;
  kind: AIExtractionSuggestion['kind'];
  model: string;
  promptVersion: string;
  summary: string;
  payload: Record<string, unknown>;
  sourceEvidenceIds?: string[];
  /** The model's own confidence where it reported one, clamped to 0..1. Omit if it did not. */
  confidence?: number;
  now?: number;
}

/**
 * Builds a storable `AIExtractionSuggestion`.
 *
 * `status` is hard-coded to `'SUGGESTED'` and is not a parameter. That is the whole point
 * of the record: it cannot be created already-accepted, so no code path can write a model
 * output straight into the case as an authoritative value. `reviewedAt` stays `null` until
 * a person acts.
 *
 * A missing or non-finite `confidence` is stored as `null`, not as a midpoint. An earlier
 * version substituted 0.5, which meant a model that reported nothing produced a record
 * claiming it was half sure — a number invented by this function and then rendered to a
 * user as though the model had said it.
 */
/**
 * The value stored in `model` when a suggestion was produced on the device, with no model
 * involved at all.
 *
 * Some of this app's reasoning does not need one. Two documents that both record an amount
 * in the same currency can be compared by arithmetic, and two dates can be ordered — so
 * `buildDeterministicReconciliation` and `buildDeterministicTimelineCoherence` answer the
 * cross-document questions without a network call, with the same citations and the same
 * result type as the model passes. That matters because a user with no API key is the
 * default user, and telling them the analysis is unavailable when half of it is arithmetic
 * is the app declining to do work it can already do.
 *
 * It is a sentinel rather than an empty string because a suggestion's provenance is the one
 * thing a reader must be able to trust. The UI branches on this value to show the on-device
 * reading mark instead of the violet AI stamp, so a deterministic comparison is never
 * presented as a model's opinion — and if a future reader greps for what wrote a record,
 * this string answers them.
 */
export const ON_DEVICE_ENGINE = 'on-device/deterministic';

/** Version of the on-device comparison logic, recorded so an old suggestion stays attributable. */
export const ON_DEVICE_ENGINE_VERSION = 'v1';

/** True when this suggestion came from on-device comparison rather than from a model. */
export function isOnDeviceSuggestion(suggestion: { model: string }): boolean {
  return suggestion.model === ON_DEVICE_ENGINE;
}

export function aiSuggestionRecord(input: SuggestionRecordInput): AIExtractionSuggestion {
  const now = input.now ?? Date.now();
  const confidence =
    typeof input.confidence === 'number' && Number.isFinite(input.confidence)
      ? Math.min(1, Math.max(0, input.confidence))
      : null;

  return {
    id: newId('sug'),
    ownerId: input.ownerId,
    caseId: input.caseId,
    createdAt: now,
    updatedAt: now,
    evidenceId: input.evidenceId,
    kind: input.kind,
    status: 'SUGGESTED',
    confidence,
    model: input.model.slice(0, 120),
    promptVersion: input.promptVersion.slice(0, 60),
    summary: input.summary.slice(0, 600),
    payload: input.payload,
    sourceEvidenceIds: input.sourceEvidenceIds ?? [],
    reviewedAt: null,
  };
}

// ---------------------------------------------------------------------------
// Citation verification
// ---------------------------------------------------------------------------

/**
 * One segment of one document, as `buildSegments` in `@domain/extraction/deterministic`
 * produces them.
 *
 * Structurally typed rather than `Extraction['segments'][number]` so that a caller can pass a
 * hand-built list — the audio and video extractors construct segments with `startMs`/`endMs`
 * before an `Extraction` exists — but it is asserted below to be assignable from the domain
 * type, so the two cannot drift apart without `tsc` saying so.
 */
export interface CitableSegment {
  id: string;
  text: string;
  startOffset: number;
  endOffset: number;
  /** Page in a paginated source. Present for PDFs. */
  page?: number | undefined;
  /** Offset into a recording, for a transcript segment. Present for audio and video. */
  startMs?: number | undefined;
  endMs?: number | undefined;
  method?: string | undefined;
}

/** Compile-time proof that a domain segment can be verified without conversion. */
const _segmentShapeMatches: (segment: Extraction['segments'][number]) => CitableSegment = (s) => s;
void _segmentShapeMatches;

/** A document as the verifier sees it: its id, its segments, and the text they index into. */
export interface CitableDocument {
  evidenceId: string;
  segments: readonly CitableSegment[];
  /**
   * The `sourceText` the segments were cut from. Optional because note-only evidence may have
   * segments and no separate stored text; when it is supplied, segment offsets are checked
   * against it and corrected, so a citation's offsets always index this exact string.
   */
  sourceText?: string | undefined;
}

/** A citation exactly as a model returned it — every field suspect, hence all optional. */
export interface ClaimedCitation {
  evidenceId?: string | undefined;
  segmentId?: string | undefined;
  quote?: string | undefined;
}

/**
 * Why a claimed citation was thrown away. Bounded, so the UI can explain a rejection and a
 * test can assert the specific failure rather than just "fewer citations came back".
 */
export type CitationRejection =
  /** The model asserted something and cited nothing identifiable. */
  | 'no-segment-id'
  /** Named a document that was not in the request. */
  | 'unknown-evidence'
  /** Named a segment id that document does not have. The fabrication case. */
  | 'unknown-segment'
  /** Gave a bare segment id that more than one document has, so it names nothing. */
  | 'ambiguous-segment'
  /** Cited a real segment with no quote, so there is nothing to check. */
  | 'empty-quote'
  /** Quoted text that is not in the segment it was attributed to. The paraphrase case. */
  | 'quote-not-in-segment'
  /** The segment's own text could not be found in the document's source text. */
  | 'segment-not-in-source';

/** A citation that survived, with offsets that really index the document's source text. */
export interface VerifiedCitation {
  evidenceId: string;
  segmentId: string;
  /**
   * What the document says. When the model's copy was found character-for-character this is
   * that copy; when it only matched after whitespace and case folding this is the segment's
   * own text instead, because a re-spaced paraphrase must never be displayed inside quotation
   * marks as though the document had written it that way.
   */
  quote: string;
  startOffset: number;
  endOffset: number;
  /** `true` when the model's quote was found verbatim, so the offsets bound the quote itself. */
  exact: boolean;
  page?: number | undefined;
  startMs?: number | undefined;
  endMs?: number | undefined;
}

export interface RejectedCitation {
  reason: CitationRejection;
  /** What the model claimed, kept so a developer can see the rejection without re-running. */
  claimed: ClaimedCitation;
}

export interface CitationVerification {
  verified: VerifiedCitation[];
  rejected: RejectedCitation[];
}

/** Resolved segment lookup for one request. Build once, verify many. */
export interface CitationIndex {
  /** `evidenceId` -> `segmentId` -> segment. */
  byDocument: Map<string, Map<string, CitableSegment>>;
  /** `segmentId` -> the evidence ids that have it, for resolving a citation that omits one. */
  bySegmentId: Map<string, string[]>;
  sourceText: Map<string, string>;
}

/**
 * Indexes the documents a request was built from.
 *
 * `bySegmentId` exists because of a quirk that would otherwise be a silent correctness bug:
 * `buildSegments` numbers every document from `seg_0`, so a segment id is unique only *within*
 * one document. Ten documents in one request means ten different segments called `seg_0`. The
 * prompts therefore require `evidenceId` alongside `segmentId`, but models drop it, and
 * resolving a bare `seg_0` to whichever document happens to be first would attribute a quote
 * to the wrong file — the single most damaging thing this app could get wrong, because the
 * whole product is about which document said what. So a bare id resolves only when exactly one
 * document has it, and is rejected as `ambiguous-segment` otherwise.
 */
export function buildCitationIndex(documents: readonly CitableDocument[]): CitationIndex {
  const byDocument = new Map<string, Map<string, CitableSegment>>();
  const bySegmentId = new Map<string, string[]>();
  const sourceText = new Map<string, string>();

  for (const document of documents) {
    const segments = new Map<string, CitableSegment>();
    for (const segment of document.segments) {
      if (!segment.id) continue;
      // First writer wins. A duplicate id inside one document would make the second
      // unciteable either way, and preferring the earlier one keeps resolution stable
      // across runs.
      if (!segments.has(segment.id)) segments.set(segment.id, segment);
      const owners = bySegmentId.get(segment.id);
      if (owners) {
        if (!owners.includes(document.evidenceId)) owners.push(document.evidenceId);
      } else {
        bySegmentId.set(segment.id, [document.evidenceId]);
      }
    }
    byDocument.set(document.evidenceId, segments);
    if (document.sourceText) sourceText.set(document.evidenceId, document.sourceText);
  }

  return { byDocument, bySegmentId, sourceText };
}

/** Match key for the tolerant pass: fold width, collapse whitespace, ignore case. */
const matchKey = (value: string) => normalizeText(value).toLowerCase();

/**
 * Locates a quote inside a segment and returns offsets into the document's source text.
 *
 * Two passes, in this order and no further. Exact `indexOf` first, because it yields true
 * character offsets a UI can highlight. Then a whitespace-and-case-folded containment check,
 * which accepts a model that re-wrapped a line it copied correctly, but *cannot* map back to
 * exact offsets — so that pass falls back to the segment's own span and text.
 *
 * There is deliberately no third, fuzzier pass. Edit distance or token overlap would start
 * accepting quotes the document does not contain, which is precisely the thing this function
 * exists to reject.
 */
function locateQuote(
  segment: CitableSegment,
  quote: string,
  documentText: string | undefined,
): { quote: string; startOffset: number; endOffset: number; exact: boolean } | null {
  // Where the segment really sits in the source text. Offsets are recomputed rather than
  // trusted: a re-extraction, a truncation at `sourceText`'s 40,000-character cap, or a
  // transcript stitched together from several passes can all leave a stale offset behind,
  // and a citation whose offsets point at the wrong characters is a citation that highlights
  // the wrong sentence.
  let base = segment.startOffset;
  if (documentText) {
    const slice = documentText.slice(segment.startOffset, segment.endOffset);
    if (slice !== segment.text) {
      const found = segment.text ? documentText.indexOf(segment.text) : -1;
      if (found < 0) return null;
      base = found;
    }
  }

  const exactIndex = segment.text.indexOf(quote);
  if (exactIndex >= 0) {
    return {
      quote,
      startOffset: base + exactIndex,
      endOffset: base + exactIndex + quote.length,
      exact: true,
    };
  }

  const needle = matchKey(quote);
  if (needle && matchKey(segment.text).includes(needle)) {
    const end = base + segment.text.length;
    // A zero-length span would fail `caseCitationSchema`'s offset refinement later, where the
    // cause would be invisible. `buildSegments` skips blank lines so this cannot happen from
    // that path; it is here for hand-built segment lists.
    if (end <= base) return null;
    return { quote: segment.text, startOffset: base, endOffset: end, exact: false };
  }

  return null;
}

/**
 * Checks every claimed citation against the real segments and returns only those that hold.
 *
 * What happens to a citation that does not verify: it is **dropped**, and the reason is
 * recorded in `rejected`. It is never repaired, never re-pointed at a nearby segment, and
 * never passed through with a caveat, because a citation is either a pointer to characters in
 * the user's own document or it is nothing. Callers use the count of rejections to decide the
 * fate of the assertion that carried them — `groundCitedItems` drops an assertion left with no
 * verified citation at all, and `weakenGradedState` downgrades one that lost some but not all.
 *
 * Deduplicates on `evidenceId + segmentId + offsets`, because a model asked for citations on
 * both a claim and its reasoning routinely returns the same one twice and a doubled citation
 * reads as two sources.
 */
export function verifyCitations(
  claimed: readonly ClaimedCitation[] | undefined,
  index: CitationIndex,
): CitationVerification {
  const verified: VerifiedCitation[] = [];
  const rejected: RejectedCitation[] = [];
  const seen = new Set<string>();

  for (const citation of claimed ?? []) {
    const segmentId = citation.segmentId?.trim();
    if (!segmentId) {
      rejected.push({ reason: 'no-segment-id', claimed: citation });
      continue;
    }

    let evidenceId = citation.evidenceId?.trim();
    if (!evidenceId) {
      const owners = index.bySegmentId.get(segmentId) ?? [];
      if (owners.length === 0) {
        rejected.push({ reason: 'unknown-segment', claimed: citation });
        continue;
      }
      if (owners.length > 1) {
        rejected.push({ reason: 'ambiguous-segment', claimed: citation });
        continue;
      }
      evidenceId = owners[0];
    }

    const segments = evidenceId === undefined ? undefined : index.byDocument.get(evidenceId);
    if (!segments || evidenceId === undefined) {
      rejected.push({ reason: 'unknown-evidence', claimed: citation });
      continue;
    }

    const segment = segments.get(segmentId);
    if (!segment) {
      rejected.push({ reason: 'unknown-segment', claimed: citation });
      continue;
    }

    const quote = citation.quote?.trim();
    if (!quote) {
      rejected.push({ reason: 'empty-quote', claimed: citation });
      continue;
    }

    const located = locateQuote(segment, quote, index.sourceText.get(evidenceId));
    if (!located) {
      // Either the quote is not in the segment, or the segment is not in the source text.
      // Told apart so a stale extraction does not get reported as a model fabrication.
      const documentText = index.sourceText.get(evidenceId);
      const segmentMissing =
        documentText !== undefined &&
        segment.text.length > 0 &&
        !documentText.includes(segment.text) &&
        documentText.slice(segment.startOffset, segment.endOffset) !== segment.text;
      rejected.push({
        reason: segmentMissing ? 'segment-not-in-source' : 'quote-not-in-segment',
        claimed: citation,
      });
      continue;
    }

    const dedupeKey = `${evidenceId}|${segmentId}|${located.startOffset}|${located.endOffset}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    verified.push({
      evidenceId,
      segmentId,
      // 4000 is `caseCitationSchema`'s cap on `quote`. Cutting here means a long segment
      // produces a shortened citation rather than one the domain schema rejects.
      quote: located.quote.slice(0, 4000),
      startOffset: located.startOffset,
      endOffset: located.endOffset,
      exact: located.exact,
      ...(segment.page !== undefined ? { page: segment.page } : {}),
      ...(segment.startMs !== undefined ? { startMs: segment.startMs } : {}),
      ...(segment.endMs !== undefined ? { endMs: segment.endMs } : {}),
    });
  }

  return { verified, rejected };
}

/**
 * Converts verified citations into the domain's `CaseCitation`.
 *
 * Only takes `VerifiedCitation`, which is the point: there is no path from a model's reply to
 * a stored `CaseCitation` that does not go through `verifyCitations` first, and the type system
 * is what enforces that rather than a convention someone has to remember.
 *
 * `stance` is the caller's, not the model's. It comes from which array the citation was in —
 * `supportingCitations` or `conflictingCitations` — so a model cannot label its own quote as
 * contradicting a claim while filing it under support.
 *
 * Note the deliberate loss: `page`, `startMs` and `endMs` do not survive, because
 * `caseCitationSchema` has no field for them. `formatCitationLocation` is for showing a
 * timestamp or page beside a citation that is still in `VerifiedCitation` form.
 */
export function toCaseCitations(
  verified: readonly VerifiedCitation[],
  stance: CaseCitation['stance'],
): CaseCitation[] {
  return verified.map((citation) => ({
    evidenceId: citation.evidenceId,
    segmentId: citation.segmentId.slice(0, 160),
    quote: citation.quote.slice(0, 4000),
    startOffset: citation.startOffset,
    endOffset: citation.endOffset,
    stance,
  }));
}

/** `mm:ss` — or `h:mm:ss` past an hour — for a moment in a recording. */
function timecode(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  const mmss = `${minutes}:${String(seconds).padStart(2, '0')}`;
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}` : mmss;
}

/**
 * Where in the source a citation points, in the terms of that source.
 *
 * A page number for a PDF, a timecode for a recording, and a character range for anything
 * else. Character offsets are correct for all three but useless to a person holding a voice
 * note: "characters 412-460" cannot be found by ear, whereas "1:47" can be scrubbed to. The
 * `startMs`/`endMs` fields are populated by the audio and video extractors; this function is
 * written to handle them now so that a transcript citation is displayable the moment they
 * appear, rather than falling back to an offset into a transcript the user never sees.
 */
export function formatCitationLocation(citation: VerifiedCitation): string {
  if (citation.startMs !== undefined) {
    const start = timecode(citation.startMs);
    return citation.endMs !== undefined && citation.endMs > citation.startMs
      ? `${start}–${timecode(citation.endMs)}`
      : start;
  }
  if (citation.page !== undefined) return `Page ${citation.page}`;
  return `Characters ${citation.startOffset}–${citation.endOffset}`;
}

/** Anything a model returned that carries citations. */
export interface CitedItem {
  citations?: readonly ClaimedCitation[] | undefined;
}

/** An item whose citations were checked, with what the check cost it. */
export interface GroundedItem<T> {
  item: T;
  citations: VerifiedCitation[];
  /** `WEAKENED` when at least one citation was rejected but at least one survived. */
  grounding: 'GROUNDED' | 'WEAKENED';
  rejected: RejectedCitation[];
}

export interface GroundedItems<T> {
  kept: GroundedItem<T>[];
  /** Items left with no verified citation at all. Counted, never shown as a finding. */
  dropped: Array<{ item: T; rejected: RejectedCitation[] }>;
}

/**
 * Applies citation verification to a list of model assertions.
 *
 * An item with no surviving citation is dropped rather than shown uncited. That is the harder
 * of the two available choices — the alternative, showing it with "no source", puts a
 * plausible sentence about the user's own money in front of them with nothing behind it, and
 * users read a sentence and skip the caveat. Dropped items stay in `dropped` so a caller can
 * say "three suggestions were discarded" instead of quietly returning less.
 */
export function groundCitedItems<T extends CitedItem>(
  items: readonly T[] | undefined,
  index: CitationIndex,
): GroundedItems<T> {
  const kept: GroundedItem<T>[] = [];
  const dropped: Array<{ item: T; rejected: RejectedCitation[] }> = [];

  for (const item of items ?? []) {
    const { verified, rejected } = verifyCitations(item.citations, index);
    if (verified.length === 0) {
      dropped.push({ item, rejected });
      continue;
    }
    kept.push({
      item,
      citations: verified,
      grounding: rejected.length > 0 ? 'WEAKENED' : 'GROUNDED',
      rejected,
    });
  }

  return { kept, dropped };
}

/**
 * The graded vocabulary, as identifiers.
 *
 * Kept here rather than in `./semantic-assistant` because `weakenGradedState` needs it and
 * this module is the one that decides a state cannot stand. The prose the model is shown lives
 * in `GRADED_ASSESSMENT_STATES` in `./prompts`; these are the strings the schemas accept, and
 * the two must be edited together.
 */
export const GRADED_STATES = [
  'STRONGLY_SUPPORTED',
  'SUPPORTED',
  'CONFLICTING',
  'INSUFFICIENT',
  'INCONCLUSIVE',
  'REQUIRES_REVIEW',
] as const;

export type GradedState = (typeof GRADED_STATES)[number];

/**
 * One step weaker, as a mapping rather than a scale.
 *
 * These six states are not points on a line, so an ordinal "subtract one" would produce
 * nonsense — `CONFLICTING` is not a weaker `SUPPORTED`, it is a different finding. What a
 * failed verification licenses is a statement about *our confidence in the model's reading*,
 * not a new statement about the evidence. That is why everything terminates at
 * `REQUIRES_REVIEW`: it is the only state that says "a person has to look at this", which is
 * exactly true of an assertion whose citations did not all hold up. Collapsing to
 * `INSUFFICIENT` would instead assert something about the user's documents, which nothing has
 * established.
 */
const WEAKER_STATE: Record<GradedState, GradedState> = {
  STRONGLY_SUPPORTED: 'SUPPORTED',
  SUPPORTED: 'REQUIRES_REVIEW',
  CONFLICTING: 'REQUIRES_REVIEW',
  INSUFFICIENT: 'INSUFFICIENT',
  INCONCLUSIVE: 'INCONCLUSIVE',
  REQUIRES_REVIEW: 'REQUIRES_REVIEW',
};

/** Downgrades a state the citations no longer fully support. Never upgrades. */
export function weakenGradedState(state: GradedState): GradedState {
  return WEAKER_STATE[state];
}

