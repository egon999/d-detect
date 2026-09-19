import type { Rule, RuleFinding } from '../types';
import {
  claimsAboutPaymentOutcome,
  claimsMentioningAnyone,
  distinctEvidenceLabels,
  transactionStatusLabel,
} from '../support';

export const statementDiscrepancyRule: Rule = {
  id: 'statement-discrepancy@1',
  title: 'Conflicting statements between sources',
  description: 'Different evidence items or participants make contradictory factual statements about the dispute.',
  rationale:
    'When multiple parties submit conflicting accounts of the same event, transaction, or communication, ' +
    'identifying contradictory assertions is the core prerequisite for evidence-grounded dispute resolution.',
  resultType: 'STATEMENT_DISCREPANCY',
  defaultSeverity: 'HIGH',
  priority: 94,
  enabled: true,

  evaluate(context) {
    const findings: RuleFinding[] = [];

    const items = context.evidence;
    if (items.length < 2 && context.claims.length === 0) return findings;

    // Two sources sharing a title is ordinary — "Screenshot" twice, or two exports from the
    // same app. Every finding below names both sides, so without distinct labels the
    // explanation reads `"Screenshot" contradicts "Screenshot"` and the `inputs` rows, which
    // are keyed by label, would collapse the two compared values into one.
    const labelOf = distinctEvidenceLabels(items);
    const label = (id: string): string => labelOf.get(id) ?? id;

    // Cross-examine evidence items against one another
    for (let i = 0; i < items.length; i++) {
      const itemA = items[i]!;
      const extA = context.extractionOf(itemA.id);
      if (!extA) continue;

      for (let j = i + 1; j < items.length; j++) {
        const itemB = items[j]!;
        const extB = context.extractionOf(itemB.id);
        if (!extB) continue;

        const labelA = label(itemA.id);
        const labelB = label(itemB.id);

        // Check for conflicting transaction statuses
        const statusConflict =
          (extA.transactionStatus === 'SUCCESS' && (extB.transactionStatus === 'FAILED' || extB.transactionStatus === 'CANCELLED')) ||
          (extB.transactionStatus === 'SUCCESS' && (extA.transactionStatus === 'FAILED' || extA.transactionStatus === 'CANCELLED'));

        if (statusConflict) {
          // Claims this conflict actually bears on, not claims that mention money. See
          // `claimsAboutPaymentOutcome` for what the topic regex here used to attach.
          const relevantClaims = claimsAboutPaymentOutcome(context.claims);
          findings.push({
            key: [itemA.id, itemB.id, 'status-conflict'],
            title: `Contradictory transaction outcomes between ${labelA} and ${labelB}`,
            explanation:
              `"${labelA}" records the payment as ${transactionStatusLabel(extA.transactionStatus).toLowerCase()}, ` +
              `while "${labelB}" records it as ${transactionStatusLabel(extB.transactionStatus).toLowerCase()}.`,
            caveat:
              'Both cannot describe the same transaction — but they may not be describing the ' +
              'same one at all, and a retry after a failure produces exactly this pair. Open ' +
              'each document and check which payment it is about.',
            severity: 'HIGH',
            confidence: 'STRONG_MATCH',
            inputs: {
              [labelA]: transactionStatusLabel(extA.transactionStatus),
              [labelB]: transactionStatusLabel(extB.transactionStatus),
            },
            supportingEvidenceIds: [itemA.id, itemB.id],
            relatedClaimIds: relevantClaims.map((c) => c.id),
            relatedEventIds: [],
          });
        }

        // Check for opposing senders / chat dialogue contradiction
        const sendersA = new Set((extA.chatMessages ?? []).map((m) => m.sender.toLowerCase()));
        const sendersB = new Set((extB.chatMessages ?? []).map((m) => m.sender.toLowerCase()));
        const commonSenders = [...sendersA].filter((s) => sendersB.has(s));

        const hasHostileA = (extA.chatMessages ?? []).some((m) => m.suspicious || m.tone === 'HOSTILE');
        const hasHostileB = (extB.chatMessages ?? []).some((m) => m.suspicious || m.tone === 'HOSTILE');

        if (commonSenders.length > 0 && (hasHostileA || hasHostileB)) {
          const relevantClaims = claimsMentioningAnyone(context.claims, commonSenders);
          findings.push({
            key: [itemA.id, itemB.id, 'chat-cross-perspective'],
            title: `Heated language involving ${commonSenders.join(', ')}, who appears in both records`,
            explanation:
              `${commonSenders.join(', ')} sends messages in both "${labelA}" and "${labelB}", ` +
              `and at least one of those records contains wording flagged as hostile.`,
            caveat:
              'Whether the two accounts conflict has not been determined. This matched on a ' +
              'sender name and on wording, nothing more; read both sides of the exchange before ' +
              'drawing a conclusion.',
            severity: 'MEDIUM',
            confidence: 'SUGGESTED_MATCH',
            inputs: {
              'Appears in both': commonSenders.join(', '),
              'First record': labelA,
              'Second record': labelB,
            },
            supportingEvidenceIds: [itemA.id, itemB.id],
            relatedClaimIds: relevantClaims.map((c) => c.id),
            relatedEventIds: [],
          });
        }

        // Check for opposing disputed points
        if (extA.disputedPoints?.length && extB.disputedPoints?.length) {
          // Whole words. `includes('dispute')` is true of "undisputed", so the claim
          // "the amount is undisputed between us" was attached to a disputed-point finding
          // as though it had raised the dispute.
          const disputeWording = /\b(?:disputes?|disputed|disputing|disagrees?|disagreed|disagreement)\b/i;
          const relevantClaims = context.claims.filter(
            (c) => disputeWording.test(c.statement) || disputeWording.test(c.detail),
          );
          findings.push({
            key: [itemA.id, itemB.id, 'disputed-points'],
            title: `Both records raise a disputed point worth comparing`,
            explanation:
              `"${labelA}" states: "${extA.disputedPoints[0]}". ` +
              `"${labelB}" states: "${extB.disputedPoints[0]}".`,
            caveat:
              'Both lines were picked up because they carry dispute wording, not because ' +
              'anything compared them. Whether they disagree is for you to judge.',
            severity: 'LOW',
            confidence: 'SUGGESTED_MATCH',
            inputs: {
              [labelA]: extA.disputedPoints[0]!,
              [labelB]: extB.disputedPoints[0]!,
            },
            supportingEvidenceIds: [itemA.id, itemB.id],
            relatedClaimIds: relevantClaims.map((c) => c.id),
            relatedEventIds: [],
          });
        }
      }
    }

    return findings;
  },
};
