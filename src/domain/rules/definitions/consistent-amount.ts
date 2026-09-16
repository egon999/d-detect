import type { AmountField } from '../../models';
import { formatAmount } from '../../normalize/money';
import type { Rule, RuleFinding } from '../types';
import { comparisonGroups, distinctEvidenceLabels } from '../support';

/**
 * Picks the headline transaction amount from an evidence extraction.
 */
function headlineAmount(amounts: readonly AmountField[]): AmountField | null {
  const total = amounts.find((amount) => amount.role === 'total');
  if (total) return total;
  const paid = amounts.find((amount) => amount.role === 'paid');
  if (paid) return paid;
  return [...amounts].sort((a, b) => Math.abs(b.minorUnits) - Math.abs(a.minorUnits))[0] ?? null;
}

/**
 * Corroborated transaction amount across independent documents.
 *
 * The worked example: a mall bill for ₹100 and a Google Pay screenshot for ₹100, dated the
 * same day. Two unrelated systems recording one payment is real corroboration, and saying so
 * is useful.
 *
 * ## Why this rule is grounded, and why that matters more here than anywhere else
 *
 * An earlier version grouped every document in the case by `currency:minorUnits` alone. Two
 * entirely unrelated ₹5,000 receipts — a rent payment in March and a phone bill in August —
 * were reported as "corroborated across 2 sources" with EXACT_MATCH confidence. Round numbers
 * repeat constantly in real money, so this did not misfire occasionally; it misfired by
 * default.
 *
 * That is the worst direction for this product to fail in. A missed contradiction leaves the
 * user where they started. A manufactured corroboration actively misleads them into thinking
 * something is established when nothing is, and it does so in the confident voice the rest of
 * the app has earned. Detact reports disagreement only where documents are linked; it must
 * hold agreement to exactly the same standard, or the asymmetry itself becomes a bias toward
 * false comfort.
 *
 * So corroboration is reported only inside a {@link comparisonGroups} group, and the finding
 * states the grounds. Confidence is inherited from the group and is never `EXACT_MATCH`:
 * matching figures are an exact match of *values*, which is not the same as proof that the two
 * documents describe one transaction — and that second thing is what the finding asserts.
 */
export const consistentAmountRule: Rule = {
  id: 'consistent-amount@2',
  title: 'Consistent transaction amount',
  description: 'Independent documents that appear to describe one transaction state the same amount.',
  rationale:
    'When independent documents that are already linked by a reference, a party or a date ' +
    'record the same figure, that is genuine cross-source corroboration. The link is required: ' +
    'identical amounts alone are a coincidence of round numbers, not evidence.',
  resultType: 'CORROBORATED_EVENT',
  defaultSeverity: 'INFO',
  priority: 35,
  enabled: true,

  evaluate(context) {
    const findings: RuleFinding[] = [];

    // Labels made distinct across the case. This rule counts sources — "4 documents agree on
    // ₹100" — so a title shared by several of them collapsing into one `inputs` key would
    // leave the finding claiming four sources while showing one. See `distinctEvidenceLabels`.
    const labelOf = distinctEvidenceLabels(context.evidence);
    const label = (id: string): string => labelOf.get(id) ?? id;

    // One pair of documents can be linked on more than one ground. Reporting the same
    // agreement twice would inflate how corroborated a figure looks.
    const reported = new Set<string>();

    for (const group of comparisonGroups(context)) {
      const withAmounts = group.items
        .map((item) => {
          const extraction = context.extractionOf(item.id);
          const amount = extraction ? headlineAmount(extraction.amounts) : null;
          // Zero is skipped deliberately: a document the extractor read no figure from
          // should not corroborate another document it also read no figure from.
          return amount && amount.minorUnits > 0 ? { item, amount } : null;
        })
        .filter((entry): entry is { item: (typeof group.items)[number]; amount: AmountField } => entry !== null);

      if (withAmounts.length < 2) continue;

      const byAmount = new Map<string, typeof withAmounts>();
      for (const entry of withAmounts) {
        const key = `${entry.amount.currency}:${entry.amount.minorUnits}`;
        const existing = byAmount.get(key);
        if (existing) existing.push(entry);
        else byAmount.set(key, [entry]);
      }

      for (const [amountKey, entries] of byAmount.entries()) {
        if (entries.length < 2) continue;

        const ids = entries.map((entry) => entry.item.id).sort();
        const dedupeKey = `${amountKey}|${ids.join('|')}`;
        if (reported.has(dedupeKey)) continue;
        reported.add(dedupeKey);

        const formatted = formatAmount(entries[0]!.amount);
        const labels = entries.map((entry) => label(entry.item.id));

        const inputs: Record<string, string> = {
          'Agreed amount': formatted,
          'Independent sources': String(entries.length),
          'Compared because': group.reason,
        };
        for (const entry of entries) {
          inputs[label(entry.item.id)] = formatAmount(entry.amount);
        }

        findings.push({
          key: [group.key, 'amount-agreement', amountKey],
          title: `${entries.length} documents agree on ${formatted}`,
          explanation:
            `${labels.map((label) => `"${label}"`).join(' and ')} each record ${formatted}. ` +
            `They were compared because ${group.reason}. These are separate documents rather ` +
            `than copies of one file, so the figure is supported from more than one source. ` +
            `That the amounts agree does not establish that the payment took place — only that ` +
            `these documents do not disagree about it.`,
          confidence: group.confidence,
          severity: 'INFO',
          supportingEvidenceIds: ids,
          inputs,
        });
      }
    }

    return findings;
  },
};
