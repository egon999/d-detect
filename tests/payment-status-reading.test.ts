import { describe, expect, it } from 'vitest';

import { extractFromText } from '@domain/extraction/deterministic';
import { runAnalysis } from '@domain/rules/engine';

import { CASE_ID, claim, evidence, workspace } from './helpers';

/**
 * How the app decides that a payment failed, and what it is allowed to do with that.
 *
 * ## Why this file exists
 *
 * `transactionStatus` is the highest-consequence value the deterministic extractor produces.
 * Three places treat it as a fact read off the page: `payment-status-conflict` and
 * `statement-discrepancy` raise findings on it, and `evidence-intelligence` marks a claim
 * `CONTRADICTED`. So a misreading here does not degrade gracefully into a weaker suggestion —
 * it becomes the app telling a user, at HIGH severity and in the audit trail, that their own
 * documents show they were not paid.
 *
 * Every case below is a reading that was wrong in exactly that way. They are grouped by the
 * mistake rather than by the module, because they were one mistake made three times: deciding
 * a question the text does not answer, instead of declining to answer it.
 */

const NOW = 1_700_000_000_000;

const statusOf = (text: string) =>
  extractFromText({ evidenceId: 'evd_x', title: 'Document', text, method: 'DETERMINISTIC' }).transactionStatus;

describe('reading a payment outcome off a document', () => {
  it('does not let the order of the words decide the outcome', () => {
    // The document proves the money arrived. Because `FAILED` was tested first and returned
    // on the first hit, it was classified `FAILED` — and a retry that succeeds after a first
    // attempt fails is one of the most common shapes a real UPI receipt takes.
    const retry = 'The first attempt failed. The retry was successful and the amount was credited.';
    expect(statusOf(retry)).not.toBe('FAILED');

    // The mirror image must not be decided by word order either. Neither reading is
    // available from the text alone, so both abstain.
    expect(statusOf(retry)).toBe('UNKNOWN');
    expect(statusOf('Payment successful. An earlier attempt had failed.')).toBe('UNKNOWN');
  });

  it('reads an unpaid invoice as recording no transaction outcome', () => {
    // `unpaid` used to be in the failure vocabulary. An unpaid invoice is not a failed
    // payment: nothing was attempted, so nothing failed. Calling it `FAILED` handed the
    // conflict rules a gateway rejection that never existed.
    expect(statusOf('This invoice is unpaid.')).toBe('UNKNOWN');
    expect(statusOf('Invoice INV-2029\nAmount: INR 12,000\nBalance due')).toBe('UNKNOWN');
  });

  it('believes a labelled status field over a word in a sentence', () => {
    // A labelled field is what the rest of the app believes this value to be: something a
    // person can open the document and point at.
    expect(statusOf('UPI Ref: 8492048102\nStatus: FAILED\nAmount: INR 50,000')).toBe('FAILED');
    expect(statusOf('Status: SUCCESS\nNote: an earlier attempt had failed')).toBe('SUCCESS');
    expect(statusOf('UPI Transaction Status - Successful\nAmount: INR 1,200')).toBe('SUCCESS');
    expect(statusOf('Txn Status: Pending')).toBe('PENDING');
  });

  it('abstains when two labelled fields disagree', () => {
    // A statement covering several transfers. Which one the dispute is about is not something
    // this function can know, and picking a winner would hide the other value entirely.
    expect(statusOf('Txn 1\nStatus: SUCCESS\n\nTxn 2\nStatus: FAILED')).toBe('UNKNOWN');
  });

  it('still reads an unambiguous document', () => {
    expect(statusOf('Your payment of INR 4,500 was declined by the issuing bank.')).toBe('FAILED');
    expect(statusOf('INR 4,500 has been credited to the beneficiary account.')).toBe('SUCCESS');
    expect(statusOf('The transaction was cancelled at your request.')).toBe('CANCELLED');
  });

  it('is not left with a sticky lastIndex between documents', () => {
    // The field scanner carries /g on a module-level literal. Without resetting `lastIndex`
    // the second call resumes from the first call's offset, so identical documents would
    // classify differently depending on what was read before them.
    const doc = 'Status: FAILED\nAmount: INR 10';
    expect([statusOf(doc), statusOf(doc), statusOf(doc)]).toEqual(['FAILED', 'FAILED', 'FAILED']);
  });
});

const FAILED_DOC = 'UPI Transaction ID: UPI-8492048102\nStatus: FAILED\nAmount: INR 50,000';

const conflictFor = (statement: string) => {
  const run = runAnalysis(
    workspace({ evidence: [evidence(FAILED_DOC)], claims: [claim(statement)] }),
    CASE_ID,
    NOW,
  );
  return run.results.find((r) => r.resultType === 'PAYMENT_STATUS_CONFLICT');
};

describe('reading a claim as asserting the payment went through', () => {
  it.each([
    ['the invoice remains unpaid', 'The invoice remains unpaid'],
    ['a negated success word', 'I have not paid this invoice'],
    ['never received', 'I never received the money'],
    ['was not transferred', 'The payment was not transferred'],
    ['prepaid and repaid as substrings of paid', 'This was a prepaid order that was repaid to me'],
  ])('says nothing when the claim agrees with the document: %s', (_case, statement) => {
    // Each of these is a user describing a payment that did not arrive, against a document
    // recording the same thing. The app used to answer with a HIGH-severity finding that
    // their statement contradicted their own evidence.
    expect(conflictFor(statement)).toBeUndefined();
  });

  it('asks about a claim that genuinely reads as asserting payment', () => {
    const finding = conflictFor('Rahul transferred the money to me and it was received');
    expect(finding).toBeDefined();
    // A reading of prose can only ever produce a question. See `payment-status-conflict`.
    expect(finding?.severity).toBe('LOW');
    expect(finding?.inputs['Matched on the word']).toBe('transferred');
  });
});

describe('which claims a document conflict is attached to', () => {
  const twoDocumentConflict = (statements: string[]) =>
    runAnalysis(
      workspace({
        evidence: [
          evidence('UPI Payment\nRef No: TXN-1\nStatus: SUCCESS\nAmount: INR 12,000', { title: 'A' }),
          evidence('UPI Payment\nRef No: TXN-2\nStatus: FAILED\nAmount: INR 12,000', { title: 'B' }),
        ],
        claims: statements.map((statement) => claim(statement)),
      }),
      CASE_ID,
      NOW,
    ).results.find((r) => r.resultType === 'STATEMENT_DISCREPANCY');

  it('does not attach itself to a claim that merely mentions money', () => {
    // `relatedClaimIds` decides which findings show up on a claim. The old topic regex
    // matched `amount`, so in a payments app a HIGH-severity contradiction was pinned to
    // every claim in the case — including one saying there was no disagreement at all.
    const finding = twoDocumentConflict(['The amount is undisputed between us']);
    expect(finding).toBeDefined();
    expect(finding?.relatedClaimIds).toEqual([]);
  });

  it('attaches to a claim that is about the payment outcome, either direction', () => {
    const finding = twoDocumentConflict(['I never received the money']);
    expect(finding?.relatedClaimIds).toHaveLength(1);
  });
});
