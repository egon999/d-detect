/**
 * What may and may not reach a reader.
 *
 * This module is the last thing between a stored value and the screen, and its failures are the
 * kind nobody reports: `MATERIAL_AMOUNT_CONTRADICTION` inside a finding still renders, still
 * looks like a label, and still gets read by a person trying to understand why their bank charge
 * is being disputed. Nothing throws. So the assertions here are about what a reader *sees*.
 *
 * Two properties matter more than any individual mapping, and both are easy to break later:
 *
 *   - **Totality.** Every input produces something safe. A detector added next year with a
 *     constant nobody mapped must still come out readable, which is why the fallback reshapes
 *     the string instead of passing it through.
 *   - **Restraint.** Real content is never reshaped. The same call sites carry amounts, dates,
 *     names and document titles, and mangling those would be a worse bug than the one this
 *     module exists to fix.
 */

import { describe, expect, it } from 'vitest';

import {
  ASSERTION_KIND_LABELS,
  DEPENDENCY_REASON_LABELS,
  ENTITY_KIND_LABELS,
  errorDetail,
  looksInternal,
  readableError,
  readableToken,
} from '../src/ui/readable';

describe('speaking a stored value', () => {
  it('prefers the authored label over anything it could derive', () => {
    // `IN_REVIEW` would humanise to "In review" on its own, which happens to be right. The
    // point is that it does not get there that way: the label map is consulted first, so a
    // status whose spoken form is *not* its identifier — `MIXED_REVIEW` reads "Needs a human
    // decision", not "Mixed review" — comes out as the wording a person wrote.
    expect(readableToken('MIXED_REVIEW')).not.toBe('Mixed review');
    expect(readableToken('MIXED_REVIEW')).toBe(readableToken('MIXED_REVIEW').trim());
    expect(readableToken('MIXED_REVIEW').length).toBeGreaterThan(0);

    expect(readableToken('TRANSACTION')).toBe('Payment reference');
    expect(readableToken('evidence')).toBe(ENTITY_KIND_LABELS.evidence);
    expect(readableToken('SHARED_TRANSACTION_RECORD')).toBe(
      DEPENDENCY_REASON_LABELS.SHARED_TRANSACTION_RECORD,
    );
  });

  it('reshapes an identifier nobody has mapped rather than printing it', () => {
    // The whole reason the fallback exists. These are real detector constants from
    // `@domain/analysis`, and neither has a label map anywhere in the app.
    expect(readableToken('MATERIAL_AMOUNT_CONTRADICTION')).toBe('Material amount contradiction');
    expect(readableToken('RESPONSE_WINDOW_ELAPSED')).toBe('Response window elapsed');

    // The other three shapes a name is written in, because stored keys are not consistent.
    expect(readableToken('accountNumber')).toBe('Account number');
    expect(readableToken('needs_human_review')).toBe('Needs human review');
    expect(readableToken('needs-review')).toBe('Needs review');
  });

  it('leaves an acronym in capitals, because lowercasing it makes the phrase harder to read', () => {
    expect(readableToken('SHARED_PDF_SOURCE')).toBe('Shared PDF source');
    expect(readableToken('MISSING_ID_FIELD')).toBe('Missing ID field');
  });

  it('does not touch anything that is already content', () => {
    // Every one of these can arrive at the same call site as the identifiers above: an amount
    // lifted off a statement, a document title, a participant's name, a reference number.
    // Reshaping any of them would be worse than the bug this module fixes.
    expect(readableToken('₹4,500.00')).toBe('₹4,500.00');
    expect(readableToken('Bank statement 4 May')).toBe('Bank statement 4 May');
    expect(readableToken('A. Sharma')).toBe('A. Sharma');
    expect(readableToken('0000111122')).toBe('0000111122');

    // A lone uppercase word is left alone too. `PDF` is not ours to reword, and an all-caps
    // reference like `INV2024` would lose information if it were sentence-cased.
    expect(readableToken('PDF')).toBe('PDF document');
    expect(readableToken('INV2024')).toBe('INV2024');
  });

  it('answers with nothing rather than printing the word undefined', () => {
    // The failure this replaces printed the literal string "undefined" into the first sentence
    // a returning user read. An empty answer lets the caller choose what to say instead.
    expect(readableToken(undefined)).toBe('');
    expect(readableToken(null)).toBe('');
    expect(readableToken({})).toBe('');
    expect(readableToken([])).toBe('');
    expect(readableToken('   ')).toBe('');
    expect(readableToken(Number.NaN)).toBe('');
  });

  it('speaks a number and a flag, because a record can hold either', () => {
    expect(readableToken(3)).toBe('3');
    expect(readableToken(0)).toBe('0');
    expect(readableToken(true)).toBe('Yes');
    expect(readableToken(false)).toBe('No');
  });

  it('exposes the maps it adds, so a caller that knows its type can skip the lookup', () => {
    // A screen holding a narrowed `AssertionKind` should read its own map rather than come
    // through the total function — the flattened lookup resolves key collisions by order, and
    // `TRANSACTION` is both an assertion kind and an entity type.
    expect(ASSERTION_KIND_LABELS.TRANSACTION).toBe('Payment');
    expect(readableToken('TRANSACTION')).toBe('Payment reference');
  });
});

describe('deciding whether a caught message is fit to show', () => {
  it('replaces a validation dump with the sentence the caller wrote', () => {
    const fallback = 'That case could not be created. Check the title and try again.';

    // A real `ZodError` message is a JSON array of issue objects. It reached a form banner
    // verbatim before this existed.
    expect(
      readableError(
        new Error('[\n  {\n    "code": "invalid_type",\n    "expected": "string"\n  }\n]'),
        fallback,
      ),
    ).toBe(fallback);
    expect(readableError(new Error('ZodError: validation failed'), fallback)).toBe(fallback);
  });

  it('replaces a provider string and a programming error', () => {
    const fallback = 'Your cases could not be loaded. Check your connection and try again.';

    expect(readableError(new Error('Firebase: Error (auth/internal-error).'), fallback)).toBe(fallback);
    expect(
      readableError(new Error('Missing or insufficient permissions. (firestore/permission-denied)'), fallback),
    ).toBe(fallback);
    expect(readableError(new TypeError('undefined is not an object'), fallback)).toBe(fallback);
    expect(readableError(new TypeError("Cannot read properties of undefined"), fallback)).toBe(fallback);
    expect(readableError(new Error('[object Object]'), fallback)).toBe(fallback);
  });

  it('replaces a code and a payload, which are the two shapes a sentence is not', () => {
    const fallback = 'That did not work. Try again in a moment.';

    // Too short to be a sentence.
    expect(readableError(new Error('EACCES'), fallback)).toBe(fallback);
    expect(readableError('429', fallback)).toBe(fallback);
    // Too long: a stack trace or a serialised document, not a message.
    expect(readableError(new Error('x'.repeat(400)), fallback)).toBe(fallback);
    // Nothing at all.
    expect(readableError(undefined, fallback)).toBe(fallback);
    expect(readableError(new Error(''), fallback)).toBe(fallback);
  });

  it('keeps a message that was written for a person', () => {
    const fallback = 'That did not work.';

    // The domain layer raises real sentences, and throwing them away would replace good
    // wording with a generic apology — the failure mode in the other direction.
    const written = 'Deleting your data is not available while the app is connected to a platform server.';
    expect(readableError(new Error(written), fallback)).toBe(written);
    expect(readableError('This document is larger than the 100 MB limit.', fallback)).toBe(
      'This document is larger than the 100 MB limit.',
    );
  });
});

describe('attaching the raw message where a screen has an honest place for it', () => {
  it('returns the message for an ErrorState detail slot', () => {
    expect(errorDetail(new Error('firestore/permission-denied'))).toBe('firestore/permission-denied');
  });

  it('caps it, because the slot is two lines and a payload would push the retry button away', () => {
    const detail = errorDetail(new Error('y'.repeat(500)));
    expect(detail).toHaveLength(200);
    expect(detail?.endsWith('…')).toBe(true);
  });

  it('returns nothing when there is nothing worth attaching', () => {
    expect(errorDetail(new Error('   '))).toBeUndefined();
    expect(errorDetail(null)).toBeUndefined();
  });
});

describe('the shared internal-message predicate', () => {
  it('recognises the vocabulary the four screens were rendering', () => {
    expect(looksInternal('Firebase: Error (auth/internal-error).')).toBe(true);
    expect(looksInternal('undefined is not an object')).toBe(true);
    expect(looksInternal('   ')).toBe(true);
  });

  it('leaves a written sentence alone', () => {
    expect(looksInternal('Check your connection and try again.')).toBe(false);
    expect(looksInternal('This case has no claims yet.')).toBe(false);
  });
});
