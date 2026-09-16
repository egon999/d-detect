import type { AmountField, DateField } from '../models';
import { datesConflict, daysBetween, formatDate, type NormalizedDate } from '../normalize/dates';
import { amountsMateriallyDiffer, formatAmount } from '../normalize/money';

/**
 * Classification category for date differences between sources.
 */
export type DateConflictCategory =
  | 'CONSISTENT'
  | 'AMBIGUOUS_FORMATTING'
  | 'LIFECYCLE_STAGE_DIFFERENCE'
  | 'SETTLEMENT_TIMING_DIFFERENCE'
  | 'MATERIAL_DATE_CONTRADICTION';

export interface DateConflictClassification {
  category: DateConflictCategory;
  material: boolean;
  explanation: string;
  daysDifference: number | null;
}

/**
 * Classification category for amount differences between sources.
 */
export type AmountConflictCategory =
  | 'CONSISTENT'
  | 'CURRENCY_MISMATCH'
  | 'FEE_OR_TAX_VARIANCE'
  | 'PARTIAL_PAYMENT'
  | 'MATERIAL_AMOUNT_CONTRADICTION';

export interface AmountConflictClassification {
  category: AmountConflictCategory;
  material: boolean;
  explanation: string;
  differenceMinorUnits: number | null;
}

/**
 * Classification category for transaction status differences.
 */
export type StatusConflictCategory =
  | 'CONSISTENT'
  | 'INTERMEDIATE_PROGRESSION'
  | 'MATERIAL_STATUS_CONTRADICTION';

export interface StatusConflictClassification {
  category: StatusConflictCategory;
  material: boolean;
  explanation: string;
}

/**
 * What each category is called when a reader is shown it.
 *
 * ## Why these exist
 *
 * The three category unions above are storage values, and they were being rendered. Three rules
 * wrote `classification.category` straight into `finding.inputs`, which `finding-card.tsx`
 * displays as a label/value table — so someone reviewing their own case was shown
 * "Discrepancy: MATERIAL_AMOUNT_CONTRADICTION". That is the identifier, shouted, in the one
 * place the product is supposed to be explaining itself, and it is the same defect the audit
 * screen had before `AUDIT_ACTION_LABELS` was written.
 *
 * ## Why the wording is hedged where it is
 *
 * A category is this app's *reading* of a difference, not a finding of fact, and the labels have
 * to carry that. `MATERIAL_AMOUNT_CONTRADICTION` becomes "Amounts genuinely disagree" rather
 * than "Fraudulent amount"; `PARTIAL_PAYMENT` becomes "Looks like a part payment" rather than
 * "Part payment", because the classifier inferred it from two numbers and could be wrong. Every
 * finding also carries a written `explanation`, so these label the *kind* of difference and stop
 * there instead of restating the reasoning.
 *
 * `CONSISTENT` is included for completeness even though a rule that fires on a discrepancy never
 * reports it: a `Record` over the full union is what makes a category added later a typecheck
 * failure here rather than a raw identifier on someone's screen.
 */
export const DATE_CONFLICT_CATEGORY_LABELS: Record<DateConflictCategory, string> = {
  CONSISTENT: 'Dates agree',
  AMBIGUOUS_FORMATTING: 'Could be a day/month order difference',
  LIFECYCLE_STAGE_DIFFERENCE: 'Looks like two stages of the same process',
  SETTLEMENT_TIMING_DIFFERENCE: 'Looks like a settlement delay',
  MATERIAL_DATE_CONTRADICTION: 'Dates genuinely disagree',
};

export const AMOUNT_CONFLICT_CATEGORY_LABELS: Record<AmountConflictCategory, string> = {
  CONSISTENT: 'Amounts agree',
  CURRENCY_MISMATCH: 'Different currencies',
  FEE_OR_TAX_VARIANCE: 'Looks like a fee or tax difference',
  PARTIAL_PAYMENT: 'Looks like a part payment',
  MATERIAL_AMOUNT_CONTRADICTION: 'Amounts genuinely disagree',
};

export const STATUS_CONFLICT_CATEGORY_LABELS: Record<StatusConflictCategory, string> = {
  CONSISTENT: 'Statuses agree',
  INTERMEDIATE_PROGRESSION: 'Looks like two stages of the same process',
  MATERIAL_STATUS_CONTRADICTION: 'Statuses genuinely disagree',
};

/**
 * Classifies a date difference between two evidence items.
 *
 * Distinguishes lifecycle progressions, banking settlement delays, and ambiguous
 * formatting from genuine, material contradictions.
 */
export function classifyDateDiscrepancy(
  dateA: DateField | NormalizedDate,
  dateB: DateField | NormalizedDate,
  options: { labelA?: string; labelB?: string } = {},
): DateConflictClassification {
  const lblA = options.labelA || 'First source';
  const lblB = options.labelB || 'Second source';

  if (!datesConflict(dateA, dateB)) {
    return {
      category: 'CONSISTENT',
      material: false,
      explanation: `${lblA} (${formatDate(dateA)}) and ${lblB} (${formatDate(dateB)}) agree on the date.`,
      daysDifference: 0,
    };
  }

  // 1. Ambiguous formatting check (e.g. 03/04/2024 vs 04/03/2024)
  if (dateA.ambiguous || dateB.ambiguous) {
    return {
      category: 'AMBIGUOUS_FORMATTING',
      material: false,
      explanation:
        `At least one date (${dateA.ambiguous ? dateA.original : dateB.original}) was written in an ambiguous ` +
        `format where day-first and month-first readings are both possible. This may be a formatting difference ` +
        `rather than a substantive contradiction. Confirm the intended date convention before relying on this difference.`,
      daysDifference: daysBetween(dateA, dateB),
    };
  }

  const roleA = 'role' in dateA ? dateA.role : undefined;
  const roleB = 'role' in dateB ? dateB.role : undefined;

  // 2. Lifecycle stage differences: different roles describe different phases of a transaction
  if (roleA && roleB && roleA !== roleB) {
    const roles = new Set([roleA, roleB]);
    if (roles.has('issued') && (roles.has('paid') || roles.has('delivered'))) {
      return {
        category: 'LIFECYCLE_STAGE_DIFFERENCE',
        material: false,
        explanation:
          `${lblA} states ${roleA} date (${formatDate(dateA)}) while ${lblB} states ${roleB} date (${formatDate(dateB)}). ` +
          `These represent sequential stages of an ordinary transaction (issue vs settlement/fulfillment) rather than a contradiction.`,
        daysDifference: daysBetween(dateA, dateB),
      };
    }
  }

  // 3. Settlement timing differences (1 to 2 calendar days difference, e.g. payment initiated vs clearing)
  const days = daysBetween(dateA, dateB);
  if (days !== null && Math.abs(days) <= 2) {
    return {
      category: 'SETTLEMENT_TIMING_DIFFERENCE',
      material: false,
      explanation:
        `${lblA} (${formatDate(dateA)}) and ${lblB} (${formatDate(dateB)}) are within ${Math.abs(days)} day(s) of each other. ` +
        `This is consistent with standard payment processing, banking settlement windows, or time-zone offset across platforms.`,
      daysDifference: days,
    };
  }

  // 4. Genuine material contradiction
  return {
    category: 'MATERIAL_DATE_CONTRADICTION',
    material: true,
    explanation:
      `${lblA} gives ${formatDate(dateA)} while ${lblB} gives ${formatDate(dateB)} (${Math.abs(days ?? 0)} days difference). ` +
      `Because both describe the same event and are unambiguously dated, this represents a substantive contradiction between sources.`,
    daysDifference: days,
  };
}

/**
 * Classifies an amount difference between two figures.
 */
export function classifyAmountDiscrepancy(
  amountA: AmountField,
  amountB: AmountField,
  options: { labelA?: string; labelB?: string } = {},
): AmountConflictClassification {
  const lblA = options.labelA || 'First source';
  const lblB = options.labelB || 'Second source';

  if (amountA.currency !== amountB.currency) {
    return {
      category: 'CURRENCY_MISMATCH',
      material: true,
      explanation:
        `${lblA} reports ${amountA.currency} (${formatAmount(amountA)}) while ${lblB} reports ${amountB.currency} (${formatAmount(amountB)}). ` +
        `These cannot be directly compared without conversion documentation.`,
      differenceMinorUnits: null,
    };
  }

  if (!amountsMateriallyDiffer(amountA, amountB)) {
    return {
      category: 'CONSISTENT',
      material: false,
      explanation: `${lblA} and ${lblB} agree on the amount (${formatAmount(amountA)}).`,
      differenceMinorUnits: 0,
    };
  }

  const diff = Math.abs(amountA.minorUnits - amountB.minorUnits);
  const max = Math.max(Math.abs(amountA.minorUnits), Math.abs(amountB.minorUnits));
  const ratio = max > 0 ? diff / max : 0;

  // Small percentage differences (e.g. 1% to 18%) typical of tax/service fee/surcharge
  if (ratio > 0 && ratio <= 0.18) {
    return {
      category: 'FEE_OR_TAX_VARIANCE',
      material: false,
      explanation:
        `${lblA} (${formatAmount(amountA)}) and ${lblB} (${formatAmount(amountB)}) differ by ${(ratio * 100).toFixed(1)}%. ` +
        `This variance is within common tax, convenience fee, or gateway deduction ranges. Check itemized line items to confirm whether fees were added.`,
      differenceMinorUnits: diff,
    };
  }

  // Partial payment indicator (e.g. role labelled 'paid' vs 'total')
  if (
    (amountA.role === 'paid' && amountB.role === 'total' && amountA.minorUnits < amountB.minorUnits) ||
    (amountB.role === 'paid' && amountA.role === 'total' && amountB.minorUnits < amountA.minorUnits)
  ) {
    return {
      category: 'PARTIAL_PAYMENT',
      material: false,
      explanation:
        `One source reports a paid amount (${formatAmount(amountA.role === 'paid' ? amountA : amountB)}) ` +
        `against a total invoice of ${formatAmount(amountA.role === 'total' ? amountA : amountB)}. ` +
        `This is consistent with a partial or installment payment rather than a conflicting transaction claim.`,
      differenceMinorUnits: diff,
    };
  }

  return {
    category: 'MATERIAL_AMOUNT_CONTRADICTION',
    material: true,
    explanation:
      `${lblA} states ${formatAmount(amountA)} while ${lblB} states ${formatAmount(amountB)} ` +
      `(difference of ${formatAmount({ original: String(diff), minorUnits: diff, currency: amountA.currency })}). ` +
      `This is a material discrepancy in transaction figures that requires clarification.`,
      differenceMinorUnits: diff,
  };
}

/**
 * Classifies a transaction status difference between two sources.
 */
export function classifyStatusDiscrepancy(
  statusA: string,
  statusB: string,
  options: { labelA?: string; labelB?: string } = {},
): StatusConflictClassification {
  const lblA = options.labelA || 'First source';
  const lblB = options.labelB || 'Second source';

  if (statusA === statusB || statusA === 'UNKNOWN' || statusB === 'UNKNOWN') {
    return {
      category: 'CONSISTENT',
      material: false,
      explanation: `Status in ${lblA} and ${lblB} is mutually compatible.`,
    };
  }

  // Progression from PENDING to final state
  if (statusA === 'PENDING' || statusB === 'PENDING') {
    const finalStatus = statusA === 'PENDING' ? statusB : statusA;
    return {
      category: 'INTERMEDIATE_PROGRESSION',
      material: false,
      explanation:
        `One record shows status as Pending while another shows ${finalStatus}. ` +
        `This represents a status progression over processing time rather than an outright contradiction. Check timestamp order to confirm final state.`,
    };
  }

  // Direct conflict (e.g. SUCCESS vs FAILED)
  return {
    category: 'MATERIAL_STATUS_CONTRADICTION',
    material: true,
    explanation:
      `${lblA} states "${statusA}" while ${lblB} states "${statusB}". ` +
      `This is a direct contradiction regarding whether the transaction succeeded or failed.`,
  };
}
