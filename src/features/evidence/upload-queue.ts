/**
 * The evidence upload queue.
 *
 * This module holds the part of multi-file upload that has to be *correct* rather than
 * merely pleasant: what counts as a duplicate, what a file is provisionally titled, and
 * what a batch commit is actually going to do before it does any of it. None of it touches
 * React or React Native, so all of it is tested.
 *
 * ## Why the queue exists at all
 *
 * The product's premise is a person handing over ten heterogeneous files about one
 * situation — a bill, a screenshot of the payment, a chat export, a bank line — and getting
 * back the places where they agree and disagree. The upload screen used to take exactly one
 * file per visit: title it, correct its text, commit, come back. Ten files meant ten round
 * trips through a form, and the analysis could not begin until the last of them.
 *
 * That is not a missing convenience. Comparison is the entire product, and a flow that
 * admits one document at a time makes the user assemble the corpus by hand, one visit at a
 * time, with no view of what they have so far.
 *
 * ## Files are read one at a time on purpose
 *
 * Recognition is the expensive step — two ML Kit script models over a full-resolution
 * photograph. Ten of those started at once on a mid-range Android will contend for memory
 * and finish later than ten run in sequence, having also made the UI unresponsive while
 * they did it. The queue reads strictly in order and names the file it is on, so waiting
 * two minutes for ten photographs looks like progress rather than a hang.
 */

import type { EvidenceKind, RelationshipType } from '@domain/enums';
import type { ExtractedTextMethod } from '@domain/extraction/deterministic';

/** The two scripts ML Kit has a model for. Nothing else is readable on-device. */
export type OcrScript = 'Latin' | 'Devanagari';

/**
 * Where a queued file is in its life.
 *
 * `failed` means the *bytes* could not be read — the file is unusable and cannot be
 * committed. It does not mean recognition came back empty: a photograph with no readable
 * text is `ready`, because it has a hash, a size and a place for the user to type what it
 * says, all of which are worth keeping.
 */
export type QueueItemStatus = 'reading' | 'ready' | 'failed';

export interface ReadFailure {
  title: string;
  message: string;
  tone: 'info' | 'warn';
  icon: 'text-search' | 'image-off-outline' | 'information-outline';
}

/** Everything a re-read needs, kept so the user can retry without picking the file again. */
export interface ImageSource {
  uri: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
}

/**
 * A duplicate, and which pile it was found in.
 *
 * The distinction matters to the user: `case` means "you already have this, uploading it
 * again will record a DUPLICATE_OF relation", which is a legitimate thing to want. `batch`
 * means "you picked the same file twice just now", which is almost always a slip in a
 * multi-select gallery and is worth saying differently.
 */
export interface DuplicateMatch {
  scope: 'case' | 'batch';
  title: string;
}

export interface QueueItem {
  /**
   * Stable local key for React and for patching. Deliberately *not* the evidence id:
   * that is minted by the mutation layer at commit time, and an id invented here would
   * either go unused or, worse, be mistaken for a real record id somewhere downstream.
   */
  id: string;

  name: string;
  uri: string;
  mimeType: string;
  sizeBytes: number;
  kind: EvidenceKind;
  sha256: string;

  status: QueueItemStatus;
  /** The named step running right now, while `status` is `reading`. Null otherwise. */
  stage: string | null;

  title: string;
  text: string;
  /**
   * How the text in this item was obtained. Travels all the way into the stored
   * extraction, so the provenance the UI shows is the provenance the rule engine used.
   */
  textMethod: ExtractedTextMethod;

  note: string | null;
  failure: ReadFailure | null;
  needsManualText: boolean;

  /** Set for images only. The re-read affordances below are meaningless without it. */
  image: ImageSource | null;
  scriptOffer: OcrScript | null;
  aiOffered: boolean;
  rereading: boolean;

  duplicate: DuplicateMatch | null;

  /**
   * Per-item claim link, or null.
   *
   * Deliberately per item and not per batch. Linking is a claim about *this document's*
   * relationship to a claim; applying one polarity to ten files at once would manufacture
   * nine assertions the user never made, and CONTRADICTS in particular feeds straight into
   * findings the case screen presents as conflicts.
   */
  link: { claimId: string; type: RelationshipType } | null;
}

/**
 * A queued file's provisional title.
 *
 * Strips one trailing extension and nothing else. It is a placeholder the user is expected
 * to improve, not a guess at what the document is — inferring a title from content would
 * put a machine's words in a field the case screen presents as the user's.
 */
export function titleFromFileName(name: string): string {
  return name.replace(/\.[^/.]+$/, '').trim() || name;
}

/**
 * Finds an earlier copy of the same content, in the case first and then in this batch.
 *
 * Case wins when a file is in both, because that is the match with consequences: it is the
 * one that will produce a DUPLICATE_OF relation against a record that already exists.
 *
 * A stored record's hash is nullable and a queued file's is empty until its bytes are read,
 * and neither absence is a match — two files nobody could hash are not the same file. That
 * is the one comparison this function must refuse to make, because collapsing unreadable
 * files into each other would hide real documents behind a duplicate warning.
 *
 * `existing` is expected to be the live evidence list; deleted records are skipped by the
 * caller rather than here, so this stays a pure comparison over what it is handed.
 */
export function findDuplicate(
  sha256: string,
  existing: ReadonlyArray<{ sha256: string | null; title: string }>,
  batch: ReadonlyArray<Pick<QueueItem, 'sha256' | 'title'>>,
): DuplicateMatch | null {
  if (!sha256) return null;

  const inCase = existing.find((record) => record.sha256 === sha256);
  if (inCase) return { scope: 'case', title: inCase.title };

  const inBatch = batch.find((item) => item.sha256 === sha256);
  if (inBatch) return { scope: 'batch', title: inBatch.title };

  return null;
}

/**
 * Re-derives every item's duplicate flag against the case and against the rest of the queue.
 *
 * Needed because duplication is a property of the *set*, not of a file. Detecting it once as
 * each file is read leaves the flag stale the moment the set changes: remove one of two
 * identical screenshots and the survivor goes on warning that it was "picked twice", naming
 * a file that is no longer there. A warning that outlives its cause is worse than none,
 * because the next real one gets ignored.
 *
 * Each item is compared against the items *before* it, so in a pair exactly one is flagged —
 * the later one, which is the one the user would remove.
 */
export function recomputeDuplicates(
  items: readonly QueueItem[],
  existing: ReadonlyArray<{ sha256: string | null; title: string }>,
): QueueItem[] {
  const seen: Array<Pick<QueueItem, 'sha256' | 'title'>> = [];

  return items.map((item) => {
    const duplicate = findDuplicate(item.sha256, existing, seen);
    if (item.sha256) seen.push({ sha256: item.sha256, title: item.title });

    // Returns the same object when nothing changed, so an unrelated removal does not
    // invalidate every card's memoised extraction preview.
    if (
      duplicate?.scope === item.duplicate?.scope &&
      duplicate?.title === item.duplicate?.title
    ) {
      return item;
    }

    return { ...item, duplicate };
  });
}

/**
 * Whether the queue can be committed, and what to say when it cannot.
 *
 * Returns the reason rather than a bare boolean so the submit button can carry it as its
 * own label. A disabled control that does not say why it is disabled is a dead end.
 */
export function describeReadiness(items: readonly QueueItem[]):
  | { ready: true; count: number }
  | { ready: false; reason: string } {
  if (items.length === 0) {
    return { ready: false, reason: 'Add a file to get started' };
  }

  if (items.some((item) => item.status === 'reading' || item.rereading)) {
    return { ready: false, reason: 'Still reading files…' };
  }

  const committable = items.filter((item) => item.status === 'ready');
  if (committable.length === 0) {
    return { ready: false, reason: 'No file here could be read' };
  }

  const untitled = committable.filter((item) => !item.title.trim());
  if (untitled.length > 0) {
    return {
      ready: false,
      reason:
        untitled.length === 1
          ? 'One file still needs a title'
          : `${untitled.length} files still need a title`,
    };
  }

  return { ready: true, count: committable.length };
}

/**
 * What a commit will produce, worked out before anything is written.
 *
 * Separating the plan from the execution is what lets the outcome be reported honestly.
 * The screen can say "8 saved, 2 could not be read" because the two piles were counted
 * here, rather than inferred afterwards from whatever happened to throw.
 */
export interface CommitPlan {
  /** Items that will be written, in queue order. */
  committable: QueueItem[];
  /** Items whose bytes never read, which are dropped with a count shown to the user. */
  unreadable: QueueItem[];
}

export function planCommit(items: readonly QueueItem[]): CommitPlan {
  const committable: QueueItem[] = [];
  const unreadable: QueueItem[] = [];

  for (const item of items) {
    if (item.status === 'ready') committable.push(item);
    else unreadable.push(item);
  }

  return { committable, unreadable };
}

/**
 * The sentence shown after a batch lands.
 *
 * Written here, next to `planCommit`, because the two have to agree: every file the plan
 * accounted for is accounted for in this summary, and no file is silently absent from
 * both. An upload flow that drops a document without saying so is the one failure this
 * product cannot afford — the user would go on to read an analysis of nine files believing
 * it covered ten.
 */
export function summariseCommit(input: {
  saved: number;
  unreadable: number;
  withoutCloudCopy: number;
}): string {
  const parts: string[] = [
    input.saved === 1 ? '1 file saved. Check processing status in the case.' : `${input.saved} files saved. Check processing status in the case.`,
  ];

  if (input.unreadable > 0) {
    parts.push(
      input.unreadable === 1
        ? '1 file was left out because its contents could not be read.'
        : `${input.unreadable} files were left out because their contents could not be read.`,
    );
  }

  if (input.withoutCloudCopy > 0) {
    parts.push(
      input.withoutCloudCopy === 1
        ? '1 was kept on this device only — its backup copy did not upload.'
        : `${input.withoutCloudCopy} were kept on this device only — their backup copies did not upload.`,
    );
  }

  return parts.join(' ');
}
