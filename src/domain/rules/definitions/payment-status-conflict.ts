import type { Rule, RuleFinding } from '../types';
import { claimsReadAsPaymentSucceeded, distinctEvidenceLabels, transactionStatusLabel } from '../support';

export const paymentStatusConflictRule: Rule = {
  id: 'payment-status-conflict@2',
  title: 'Payment status discrepancy',
  description: 'A document records a failed or cancelled payment while claims or other records assert completion.',
  rationale:
    'In financial and UPI disputes, parties often claim payments were made or received while ' +
    'official bank statements, gateway logs, or screenshots show transaction failure or cancellation. ' +
    'It does not prove a disagreement when the only thing on the other side is wording matched in ' +
    'free text a person typed — that half of the rule asks a question and is graded as one.',
  resultType: 'PAYMENT_STATUS_CONFLICT',
  defaultSeverity: 'HIGH',
  priority: 95,
  enabled: true,

  evaluate(context) {
    const findings: RuleFinding[] = [];

    // Distinct across the case: the finding names the failed document and lists the
    // documents that disagree with it, and two sources sharing a title would make that
    // list read as the same name twice.
    const labelOf = distinctEvidenceLabels(context.evidence);
    const label = (id: string): string => labelOf.get(id) ?? id;

    // Find any evidence with FAILED or CANCELLED status
    for (const item of context.evidence) {
      const extraction = context.extractionOf(item.id);
      if (!extraction) continue;

      if (extraction.transactionStatus === 'FAILED' || extraction.transactionStatus === 'CANCELLED') {
        // Whole-word, clause-scoped, and silent when the wording carries both senses. This
        // used to be five `includes()` calls, which read "the invoice remains unpaid" as an
        // assertion that the invoice was paid.
        const conflictingClaims = claimsReadAsPaymentSucceeded(context.claims);

        const conflictingEvidence = context.evidence.filter((other) => {
          if (other.id === item.id) return false;
          const otherExt = context.extractionOf(other.id);
          return otherExt?.transactionStatus === 'SUCCESS';
        });

        if (conflictingClaims.length > 0 || conflictingEvidence.length > 0) {
          const itemLabel = label(item.id);
          const status = transactionStatusLabel(extraction.transactionStatus).toLowerCase();

          /**
           * Both sides structured, or one side a guess about a sentence?
           *
           * `transactionStatus` on another document is a value the extractor parsed out of
           * that document: a person can open it and see the same word. A keyword hit in a
           * claim is this app's reading of prose somebody typed, and no amount of care with
           * the word list makes it more than that.
           *
           * So severity follows the weaker input. Two documents that disagree stay HIGH,
           * because both halves can be checked. A document against a reading of free text
           * drops to LOW and NEEDS_REVIEW — the level this file already uses elsewhere for
           * "whether they disagree is for you to judge" — because the finding's real content
           * is a question, and a question that outranks a demonstrated contradiction in the
           * severity sort is a question that will be believed.
           */
          const structured = conflictingEvidence.length > 0;

          // What actually disagrees decides how the finding is worded. Saying "this is
          // contradicted by other records" when the only thing on the other side is
          // something the user typed would overstate what the documents show.
          const contradictedBy = structured
            ? `${conflictingEvidence.length} other record${conflictingEvidence.length === 1 ? '' : 's'} ` +
              `record${conflictingEvidence.length === 1 ? 's' : ''} it as completed`
            : `the account of events recorded for this case says the payment went through`;

          const quoted = [...new Set(conflictingClaims.map((c) => c.matched))].sort().join(', ');

          findings.push({
            key: [item.id, ...conflictingClaims.map((c) => c.claim.id)],
            title: structured
              ? `"${itemLabel}" shows the payment ${status}`
              : `Does "${itemLabel}" describe the payment your account says went through?`,
            explanation: `"${itemLabel}" records the transaction as ${status}, while ${contradictedBy}.`,
            caveat: structured
              ? `The same amount can appear on a retry that succeeded after a first attempt ` +
                `failed, so the two records may be describing different transfers rather than ` +
                `disagreeing. Open both and check which payment each one is about.`
              : `The second half of this is the app's reading of wording you typed — it matched ` +
                `on the word "${quoted}" — not a value read from a document. The two may not be ` +
                `about the same payment, and the wording may simply have been read the wrong ` +
                `way. Nothing here shows the records disagree; it is worth a look only if the ` +
                `statement and the document were meant to describe the same transfer.`,
            severity: structured ? 'HIGH' : 'LOW',
            confidence: structured ? 'STRONG_MATCH' : 'NEEDS_REVIEW',
            inputs: {
              [itemLabel]: transactionStatusLabel(extraction.transactionStatus),
              ...(structured
                ? { 'Records showing it completed': conflictingEvidence.map((e) => label(e.id)).join(', ') }
                : {}),
              ...(conflictingClaims.length > 0
                ? {
                    'Statements read as saying it went through': String(conflictingClaims.length),
                    // Names the grounds so a reader can reject them. Without this the reading
                    // is unfalsifiable: the finding asserts a conflict and shows no working.
                    'Matched on the word': quoted,
                  }
                : {}),
            },
            supportingEvidenceIds: [item.id, ...conflictingEvidence.map((e) => e.id)],
            relatedClaimIds: conflictingClaims.map((c) => c.claim.id),
            relatedEventIds: [],
          });
        }
      }
    }

    return findings;
  },
};
