import type { AmountField } from '../../models';
import { amountsMateriallyDiffer, formatAmount } from '../../normalize/money';
import { AMOUNT_CONFLICT_CATEGORY_LABELS, classifyAmountDiscrepancy } from '../../analysis/conflict-classification';
import type { Rule, RuleFinding } from '../types';
import { comparisonGroups, distinctEvidenceLabels } from '../support';

/**
 * Picks the amount that represents the headline figure of a document: an explicit
 * total if one was labelled, otherwise the largest value found. Comparing a line item
 * against another document's total would produce constant false positives.
 */
function headlineAmount(amounts: readonly AmountField[]): AmountField | null {
  const total = amounts.find((amount) => amount.role === 'total');
  if (total) return total;
  const paid = amounts.find((amount) => amount.role === 'paid');
  if (paid) return paid;
  return [...amounts].sort((a, b) => Math.abs(b.minorUnits) - Math.abs(a.minorUnits))[0] ?? null;
}

/**
 * Amount discrepancy between documents about the same transaction.
 *
 * Comparison is always grounded: two documents are only put side by side when something
 * concrete links them — a shared reference number, a shared party and date, or the same
 * day — and the finding repeats that link so the reader can judge whether it was fair.
 * See {@link comparisonGroups}. An earlier version compared only within shared reference
 * numbers, which sounded rigorous and missed nearly every real case: a shop's bill number
 * and a payment app's UPI reference come from unrelated numbering schemes and never match.
 *
 * Integer minor units are compared — never floats — so the result is exactly reproducible.
 * Published benchmarks put frontier models at under 5% on float arithmetic at scale, which
 * is precisely why this comparison is code and not a prompt.
 *
 * One finding is raised per group, spanning the lowest and highest figures in it. Reporting
 * every mismatched pair separately would restate a single discrepancy three or four times.
 *
 * The finding is explicitly framed as "worth checking", because partial payments, taxes,
 * platform fees and currency conversion all produce legitimate differences. It reports the
 * difference; it does not decide what the difference means.
 */
export const amountMismatchRule: Rule = {
  id: 'amount-mismatch@2',
  title: 'Amount mismatch',
  description: 'Documents that appear to describe one transaction state different amounts.',
  rationale:
    'A difference between a billed and a received amount is the single most common ' +
    'substantive issue in a payment dispute. The rule reports the difference and names ' +
    'the grounds on which the two documents were compared, leaving the interpretation to ' +
    'the user, because partial payment and fees are ordinary.',
  resultType: 'AMOUNT_MISMATCH',
  defaultSeverity: 'HIGH',
  priority: 90,
  enabled: true,

  evaluate(context) {
    const findings: RuleFinding[] = [];

    /**
     * Labels resolved once across the whole case, not per pair.
     *
     * Deliberate: the label a source is given must be the same in every finding that mentions
     * it. Disambiguating per pair would name the same file "Screenshot (gpay.png)" in one
     * finding and "Screenshot" in the next, which reads as two different documents.
     */
    const labelOf = distinctEvidenceLabels(context.evidence);
    const label = (id: string): string => labelOf.get(id) ?? id;

    // A pair can be linked on more than one ground — and separately, be attached to a
    // claim. Reporting the same two figures twice reads as two problems when there is one.
    const reportedPairs = new Set<string>();
    const pairKey = (ids: readonly string[]): string => [...ids].sort().join('|');

    for (const group of comparisonGroups(context)) {
      const quoted = group.items
        .map((item) => {
          const extraction = context.extractionOf(item.id);
          const amount = extraction ? headlineAmount(extraction.amounts) : null;
          return amount ? { item, amount } : null;
        })
        .filter((entry): entry is { item: (typeof group.items)[number]; amount: AmountField } => entry !== null);

      if (quoted.length < 2) continue;

      // Compare within a single currency only: Detact holds no exchange rates and
      // will not invent a conversion.
      const byCurrency = new Map<string, typeof quoted>();
      for (const entry of quoted) {
        const list = byCurrency.get(entry.amount.currency);
        if (list) list.push(entry);
        else byCurrency.set(entry.amount.currency, [entry]);
      }

      for (const entries of byCurrency.values()) {
        if (entries.length < 2) continue;

        const sorted = [...entries].sort((a, b) => a.amount.minorUnits - b.amount.minorUnits);
        const lowest = sorted[0]!;
        const highest = sorted[sorted.length - 1]!;

        if (!amountsMateriallyDiffer(lowest.amount, highest.amount)) continue;
        const absolute = Math.abs(highest.amount.minorUnits - lowest.amount.minorUnits);

        const gap: AmountField = { ...highest.amount, minorUnits: absolute, original: '' };

        // Exactly the two documents the finding names. Listing every document in the group
        // would attach sources to a finding that never quotes them, and — because the same
        // two files are usually linked on several grounds at once — would let one discrepancy
        // be reported again under each weaker ground, since the id set differs every time.
        const involved = [lowest.item.id, highest.item.id].sort();

        const seen = pairKey(involved);
        if (reportedPairs.has(seen)) continue;
        reportedPairs.add(seen);

        const classification = classifyAmountDiscrepancy(lowest.amount, highest.amount, {
          labelA: label(highest.item.id),
          labelB: label(lowest.item.id),
        });

        findings.push({
          key: [group.key, highest.amount.currency],
          title: 'Two documents state different amounts',
          explanation:
            `"${label(highest.item.id)}" states ${formatAmount(highest.amount)} while ` +
            `"${label(lowest.item.id)}" states ${formatAmount(lowest.amount)}, a difference ` +
            `of ${formatAmount(gap)}. They were compared because ${group.reason} — so they may ` +
            `describe the same transaction. ${classification.explanation} Open both sources and confirm which figure is correct.`,
          confidence: 'NEEDS_REVIEW',
          severity: classification.material ? 'HIGH' : 'MEDIUM',
          supportingEvidenceIds: involved,
          inputs: {
            [label(highest.item.id)]: formatAmount(highest.amount),
            [label(lowest.item.id)]: formatAmount(lowest.amount),
            Difference: formatAmount(gap),
            'Compared because': group.reason,
            Discrepancy: AMOUNT_CONFLICT_CATEGORY_LABELS[classification.category],
          },
        });
      }
    }

    // Beyond what the documents themselves reveal, a user linking two files to one claim
    // is an explicit assertion that they belong together — stronger grounding than anything
    // the extractor can infer, and worth comparing even when no shared signal was found.
    for (const claim of context.claims) {
      const linkedEvidenceIds = context.relationships
        .filter((r) => r.to.kind === 'claim' && r.to.id === claim.id && r.from.kind === 'evidence')
        .map((r) => r.from.id);

      if (linkedEvidenceIds.length < 2) continue;

      const quoted = linkedEvidenceIds
        .map((id) => {
          const item = context.evidence.find((e) => e.id === id);
          if (!item) return null;
          const extraction = context.extractionOf(id);
          const amount = extraction ? headlineAmount(extraction.amounts) : null;
          return amount ? { item, amount } : null;
        })
        .filter((e): e is { item: (typeof context.evidence)[number]; amount: AmountField } => e !== null);

      if (quoted.length < 2) continue;

      const byCurrency = new Map<string, typeof quoted>();
      for (const entry of quoted) {
        const list = byCurrency.get(entry.amount.currency);
        if (list) list.push(entry);
        else byCurrency.set(entry.amount.currency, [entry]);
      }

      for (const entries of byCurrency.values()) {
        if (entries.length < 2) continue;
        const sorted = [...entries].sort((a, b) => a.amount.minorUnits - b.amount.minorUnits);
        const lowest = sorted[0]!;
        const highest = sorted[sorted.length - 1]!;

        if (!amountsMateriallyDiffer(lowest.amount, highest.amount)) continue;
        const absolute = Math.abs(highest.amount.minorUnits - lowest.amount.minorUnits);

        const gap: AmountField = { ...highest.amount, minorUnits: absolute, original: '' };
        const involved = [lowest.item.id, highest.item.id].sort();

        // Shares the set used by the grounded pass above, so a pair already reported on a
        // document signal is not reported a second time because it also hangs off a claim.
        const seen = pairKey(involved);
        if (reportedPairs.has(seen)) continue;
        reportedPairs.add(seen);

        const classification = classifyAmountDiscrepancy(lowest.amount, highest.amount, {
          labelA: label(highest.item.id),
          labelB: label(lowest.item.id),
        });

        findings.push({
          key: ['claim-amount-mismatch', claim.id, highest.amount.currency, ...involved],
          title: `Conflicting amounts for claim "${claim.statement.slice(0, 36)}..."`,
          explanation:
            `"${label(highest.item.id)}" states ${formatAmount(highest.amount)} while ` +
            `"${label(lowest.item.id)}" states ${formatAmount(lowest.amount)}, a difference ` +
            `of ${formatAmount(gap)} linked to the same claim. ${classification.explanation} Review both sources to resolve the conflict.`,
          confidence: 'NEEDS_REVIEW',
          severity: classification.material ? 'HIGH' : 'MEDIUM',
          supportingEvidenceIds: involved,
          inputs: {
            [label(highest.item.id)]: formatAmount(highest.amount),
            [label(lowest.item.id)]: formatAmount(lowest.amount),
            Difference: formatAmount(gap),
            Claim: claim.statement,
            Discrepancy: AMOUNT_CONFLICT_CATEGORY_LABELS[classification.category],
          },
        });
      }
    }

    return findings;
  },
};
