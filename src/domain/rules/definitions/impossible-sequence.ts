import type { AmountField, DateField, Evidence } from '../../models';
import { formatDate } from '../../normalize/dates';
import { formatAmount, relativeDifference } from '../../normalize/money';
import type { FindingBasis, Rule, RuleFinding } from '../types';
import { distinctEvidenceLabels, identifierGroups, type IdentifierGroup } from '../support';

/**
 * How far apart two dates have to be before "paid before it was billed" is real.
 *
 * Zero would be wrong. An invoice raised and settled on the same day is ordinary, and so
 * is a payment recorded a day early by a bank in another timezone. One day of slack keeps
 * those out of the report; anything beyond it is a genuine ordering problem.
 */
const SLACK_DAYS = 1;

/** The payment has to be materially short before an underpayment is worth raising. */
const SHORTFALL_TOLERANCE = 0.01;
const SHORTFALL_MINOR_UNITS = 100;

interface Dated {
  item: Evidence;
  date: DateField;
}

/** Whole days from `a` to `b`, positive when `b` is later. Day precision only. */
function dayGap(a: DateField, b: DateField): number | null {
  if (a.precision !== 'DAY' || b.precision !== 'DAY' || !a.iso || !b.iso) return null;
  const first = Date.parse(`${a.iso}T00:00:00Z`);
  const second = Date.parse(`${b.iso}T00:00:00Z`);
  if (Number.isNaN(first) || Number.isNaN(second)) return null;
  return Math.round((second - first) / 86_400_000);
}

/** The earliest date carrying a given role across a group of documents. */
function earliestWithRole(items: readonly Evidence[], role: string, context: Parameters<Rule['evaluate']>[0]): Dated | null {
  const candidates: Dated[] = [];
  for (const item of items) {
    const extraction = context.extractionOf(item.id);
    if (!extraction) continue;
    for (const date of extraction.dates) {
      if (date.role === role && date.iso) candidates.push({ item, date });
    }
  }
  if (candidates.length === 0) return null;
  return candidates.sort(
    (a, b) => (a.date.iso ?? '').localeCompare(b.date.iso ?? '') || a.item.id.localeCompare(b.item.id),
  )[0]!;
}

/** The amount carrying a given role, largest first. */
function amountWithRole(
  items: readonly Evidence[],
  role: string,
  context: Parameters<Rule['evaluate']>[0],
): { item: Evidence; amount: AmountField } | null {
  const candidates: Array<{ item: Evidence; amount: AmountField }> = [];
  for (const item of items) {
    const extraction = context.extractionOf(item.id);
    if (!extraction) continue;
    for (const amount of extraction.amounts) {
      if (amount.role === role) candidates.push({ item, amount });
    }
  }
  if (candidates.length === 0) return null;
  return candidates.sort(
    (a, b) => b.amount.minorUnits - a.amount.minorUnits || a.item.id.localeCompare(b.item.id),
  )[0]!;
}

/**
 * The reference numbers that put these documents in the same group.
 *
 * Included in every finding's basis, not just the dates and amounts being compared,
 * because the grouping is load-bearing in a way that is easy to miss: misreading
 * INV-2024-019 as INV-2024-018 does not fail quietly — it *joins* two unrelated
 * transactions and then reports a perfectly correct contradiction between them.
 */
function groupingBasis(
  group: IdentifierGroup,
  items: readonly Evidence[],
  context: Parameters<Rule['evaluate']>[0],
): FindingBasis[] {
  const basis: FindingBasis[] = [];
  for (const item of items) {
    const extraction = context.extractionOf(item.id);
    if (!extraction) continue;
    for (const field of extraction[group.field]) {
      if (field.normalized === group.value) basis.push({ evidenceId: item.id, label: group.label, field });
    }
  }
  return basis;
}

/**
 * Sequences that cannot have happened in the order the documents describe.
 *
 * Every other rule in the registry compares *values* — two dates, two amounts, two
 * reference numbers — and asks whether they match. This one compares **roles**, and asks
 * whether the story they tell is possible. A payment dated before the invoice that
 * requested it, or a delivery dated after the invoice was already settled, is not a
 * disagreement between sources: it is a single narrative that does not hold together.
 *
 * That distinction matters for how it reports. A date conflict says "these two sources
 * disagree, check them". This says "read in order, these documents describe something
 * that could not have happened" — which in practice is almost always a typo, a
 * back-dated document, or the one genuinely interesting finding in the case.
 *
 * It is still framed as an observation. A retainer paid in advance legitimately precedes
 * its invoice, and the rule says so in the finding rather than assuming fraud.
 *
 * Scoped to documents that already share a reference number, for the same reason
 * `amount-mismatch` is: comparing a random invoice's date against a random receipt's date
 * would produce a finding for every unrelated pair in the case.
 */
export const impossibleSequenceRule: Rule = {
  id: 'impossible-sequence@1',
  title: 'Sequence does not hold together',
  description: 'Documents about one transaction describe events in an order that cannot happen.',
  rationale:
    'Compares the *roles* of dates and amounts rather than their values, so it detects a ' +
    'broken narrative rather than a disagreement. Only day-precision dates are compared, ' +
    'and one day of slack is allowed so that same-day and timezone-boundary records do ' +
    'not register. A legitimate advance payment produces this finding too, which is why ' +
    'it is reported as something to confirm rather than as an error.',
  resultType: 'POSSIBLE_CONFLICT',
  defaultSeverity: 'HIGH',
  priority: 92,
  enabled: true,

  evaluate(context) {
    const findings: RuleFinding[] = [];

    // Every finding here names two documents and asks the reader to open both and decide
    // which date is right. Two of them sharing a title makes that instruction impossible
    // to follow, so labels are made distinct across the case before any are quoted.
    const labelOf = distinctEvidenceLabels(context.evidence);
    const label = (item: Evidence): string => labelOf.get(item.id) ?? item.id;

    for (const group of identifierGroups(context)) {
      const issued = earliestWithRole(group.items, 'issued', context);
      const paid = earliestWithRole(group.items, 'paid', context);
      const delivered = earliestWithRole(group.items, 'delivered', context);
      const due = earliestWithRole(group.items, 'due', context);

      // --- Paid before it was billed -------------------------------------
      if (issued && paid) {
        const gap = dayGap(issued.date, paid.date);
        if (gap !== null && gap < -SLACK_DAYS) {
          const early = Math.abs(gap);
          findings.push({
            key: ['paid-before-issued', group.field, group.value],
            title: `Payment against ${group.value} is dated before the invoice`,
            explanation:
              `"${label(paid.item)}" records payment on ${formatDate(paid.date)}, which is ` +
              `${early} days before "${label(issued.item)}" was issued on ` +
              `${formatDate(issued.date)}. Both reference ${group.value}. An advance or retainer ` +
              `paid before invoicing explains this completely; so does a mistyped year on either ` +
              `document. Open both and confirm which date is right.`,
            confidence: 'NEEDS_REVIEW',
            supportingEvidenceIds: [issued.item.id, paid.item.id].sort(),
            inputs: {
              'Invoice issued': `${formatDate(issued.date)} — ${label(issued.item)}`,
              'Payment dated': `${formatDate(paid.date)} — ${label(paid.item)}`,
              'Days early': String(early),
              'Shared reference': group.value,
            },
            basis: [
              { evidenceId: issued.item.id, label: 'Invoice date', field: issued.date },
              { evidenceId: paid.item.id, label: 'Payment date', field: paid.date },
              ...groupingBasis(group, [issued.item, paid.item], context),
            ],
          });
        }
      }

      // --- Delivered after it was already paid for ------------------------
      if (paid && delivered) {
        const gap = dayGap(paid.date, delivered.date);
        if (gap !== null && gap > SLACK_DAYS) {
          findings.push({
            key: ['delivered-after-paid', group.field, group.value],
            title: `Delivery against ${group.value} is dated after payment`,
            explanation:
              `"${label(delivered.item)}" records delivery on ${formatDate(delivered.date)}, ` +
              `${gap} days after "${label(paid.item)}" records payment on ` +
              `${formatDate(paid.date)}. Paying before delivery is a normal arrangement, so this ` +
              `is only worth checking if the agreement was payment on receipt.`,
            severity: 'MEDIUM',
            confidence: 'NEEDS_REVIEW',
            supportingEvidenceIds: [paid.item.id, delivered.item.id].sort(),
            inputs: {
              'Payment dated': `${formatDate(paid.date)} — ${label(paid.item)}`,
              'Delivery dated': `${formatDate(delivered.date)} — ${label(delivered.item)}`,
              'Days after': String(gap),
              'Shared reference': group.value,
            },
            basis: [
              { evidenceId: paid.item.id, label: 'Payment date', field: paid.date },
              { evidenceId: delivered.item.id, label: 'Delivery date', field: delivered.date },
              ...groupingBasis(group, [paid.item, delivered.item], context),
            ],
          });
        }
      }

      // --- Due before issued ----------------------------------------------
      if (issued && due) {
        const gap = dayGap(issued.date, due.date);
        if (gap !== null && gap < -SLACK_DAYS) {
          findings.push({
            key: ['due-before-issued', group.field, group.value],
            title: `Due date on ${group.value} precedes the invoice date`,
            explanation:
              `"${label(due.item)}" gives a due date of ${formatDate(due.date)}, which is ` +
              `before the invoice date of ${formatDate(issued.date)}. A payment term cannot expire ` +
              `before the invoice exists, so one of these two dates is likely to be wrong.`,
            severity: 'MEDIUM',
            confidence: 'NEEDS_REVIEW',
            supportingEvidenceIds: [...new Set([issued.item.id, due.item.id])].sort(),
            inputs: {
              'Invoice issued': formatDate(issued.date),
              'Payment due': formatDate(due.date),
              'Shared reference': group.value,
            },
            basis: [
              { evidenceId: issued.item.id, label: 'Invoice date', field: issued.date },
              { evidenceId: due.item.id, label: 'Due date', field: due.date },
              ...groupingBasis(group, [issued.item, due.item], context),
            ],
          });
        }
      }

      // --- Paid less than billed ------------------------------------------
      const billed = amountWithRole(group.items, 'total', context);
      const settled = amountWithRole(group.items, 'paid', context);
      if (billed && settled && billed.amount.currency === settled.amount.currency) {
        const shortfall = billed.amount.minorUnits - settled.amount.minorUnits;
        const difference = relativeDifference(settled.amount, billed.amount);
        if (
          shortfall > SHORTFALL_MINOR_UNITS &&
          difference !== null &&
          difference > SHORTFALL_TOLERANCE
        ) {
          const gap: AmountField = { ...billed.amount, minorUnits: shortfall, original: '' };
          findings.push({
            key: ['short-payment', group.field, group.value, billed.amount.currency],
            title: `${group.value} was paid short by ${formatAmount(gap)}`,
            explanation:
              `"${label(billed.item)}" bills ${formatAmount(billed.amount)} against ` +
              `${group.value}, and "${label(settled.item)}" records a payment of ` +
              `${formatAmount(settled.amount)} — ${formatAmount(gap)} less. A deduction, a ` +
              `withheld tax, a platform fee or a part payment all produce this. It is recorded ` +
              `here so the shortfall is visible rather than assumed to be settled.`,
            confidence: 'NEEDS_REVIEW',
            supportingEvidenceIds: [...new Set([billed.item.id, settled.item.id])].sort(),
            inputs: {
              Billed: `${formatAmount(billed.amount)} — ${label(billed.item)}`,
              Paid: `${formatAmount(settled.amount)} — ${label(settled.item)}`,
              Shortfall: formatAmount(gap),
              'Shared reference': group.value,
            },
            basis: [
              { evidenceId: billed.item.id, label: 'Billed amount', field: billed.amount },
              { evidenceId: settled.item.id, label: 'Paid amount', field: settled.amount },
              ...groupingBasis(group, [billed.item, settled.item], context),
            ],
          });
        }
      }
    }

    return findings;
  },
};

/** Re-exported for tests that want to assert on the tolerance directly. */
export const IMPOSSIBLE_SEQUENCE_SLACK_DAYS = SLACK_DAYS;
