import { describe, expect, it } from 'vitest';
import {
  classifyAmountDiscrepancy,
  classifyDateDiscrepancy,
  classifyStatusDiscrepancy,
} from '@domain/analysis/conflict-classification';
import { normalizeDate } from '@domain/normalize/dates';
import { normalizeAmount } from '@domain/normalize/money';
import type { AmountField, DateField } from '@domain/models';

describe('classifyDateDiscrepancy', () => {
  it('returns CONSISTENT when dates are identical', () => {
    const d1 = normalizeDate('15 March 2024');
    const d2 = normalizeDate('15 March 2024');
    const result = classifyDateDiscrepancy(d1, d2);
    expect(result.category).toBe('CONSISTENT');
    expect(result.material).toBe(false);
    expect(result.daysDifference).toBe(0);
  });

  it('classifies ambiguous dates as AMBIGUOUS_FORMATTING', () => {
    const d1 = normalizeDate('03/04/2024', 'DMY'); // 2024-04-03, ambiguous: true
    const d2 = normalizeDate('03/04/2024', 'MDY'); // 2024-03-04, ambiguous: true
    const result = classifyDateDiscrepancy(d1, d2);
    expect(result.category).toBe('AMBIGUOUS_FORMATTING');
    expect(result.material).toBe(false);
  });

  it('classifies issued vs paid/delivered as LIFECYCLE_STAGE_DIFFERENCE', () => {
    const d1: DateField = {
      evidenceId: 'evd_test',
      iso: '2024-03-10',
      precision: 'DAY',
      original: '10 March 2024',
      ambiguous: false,
      role: 'issued',
      method: 'DETERMINISTIC',
      sourceQuote: 'Issued on 10 March 2024',
    };
    const d2: DateField = {
      evidenceId: 'evd_test',
      iso: '2024-03-20',
      precision: 'DAY',
      original: '20 March 2024',
      ambiguous: false,
      role: 'paid',
      method: 'DETERMINISTIC',
      sourceQuote: 'Paid on 20 March 2024',
    };
    const result = classifyDateDiscrepancy(d1, d2);
    expect(result.category).toBe('LIFECYCLE_STAGE_DIFFERENCE');
    expect(result.material).toBe(false);
    expect(result.daysDifference).toBe(10);
  });

  it('classifies 1-2 calendar days difference as SETTLEMENT_TIMING_DIFFERENCE', () => {
    const d1 = normalizeDate('15 March 2024');
    const d2 = normalizeDate('17 March 2024');
    const result = classifyDateDiscrepancy(d1, d2);
    expect(result.category).toBe('SETTLEMENT_TIMING_DIFFERENCE');
    expect(result.material).toBe(false);
    expect(Math.abs(result.daysDifference ?? 0)).toBe(2);
  });

  it('classifies large differences as MATERIAL_DATE_CONTRADICTION', () => {
    const d1 = normalizeDate('10 March 2024');
    const d2 = normalizeDate('25 March 2024');
    const result = classifyDateDiscrepancy(d1, d2);
    expect(result.category).toBe('MATERIAL_DATE_CONTRADICTION');
    expect(result.material).toBe(true);
    expect(Math.abs(result.daysDifference ?? 0)).toBe(15);
  });
});

describe('classifyAmountDiscrepancy', () => {
  it('returns CONSISTENT when amounts are equal or within negligible tolerance', () => {
    const a1 = normalizeAmount('1,500.00', 'INR')!;
    const a2 = normalizeAmount('1,500.00', 'INR')!;
    const result = classifyAmountDiscrepancy(
      { ...a1, evidenceId: 'evd_test', method: 'DETERMINISTIC', sourceQuote: '1500' },
      { ...a2, evidenceId: 'evd_test', method: 'DETERMINISTIC', sourceQuote: '1500' },
    );
    expect(result.category).toBe('CONSISTENT');
    expect(result.material).toBe(false);
  });

  it('flags currency mismatch as CURRENCY_MISMATCH with material=true', () => {
    const a1 = normalizeAmount('1,500.00', 'INR')!;
    const a2 = normalizeAmount('1,500.00', 'USD')!;
    const result = classifyAmountDiscrepancy(
      { ...a1, evidenceId: 'evd_test', method: 'DETERMINISTIC', sourceQuote: 'INR 1500' },
      { ...a2, evidenceId: 'evd_test', method: 'DETERMINISTIC', sourceQuote: 'USD 1500' },
    );
    expect(result.category).toBe('CURRENCY_MISMATCH');
    expect(result.material).toBe(true);
    expect(result.differenceMinorUnits).toBeNull();
  });

  it('classifies small fee/tax differences as FEE_OR_TAX_VARIANCE', () => {
    // Difference is 500 / 10500 = ~4.7%
    const a1 = normalizeAmount('10,000.00', 'INR')!;
    const a2 = normalizeAmount('10,500.00', 'INR')!;
    const result = classifyAmountDiscrepancy(
      { ...a1, evidenceId: 'evd_test', method: 'DETERMINISTIC', sourceQuote: '10000' },
      { ...a2, evidenceId: 'evd_test', method: 'DETERMINISTIC', sourceQuote: '10500' },
    );
    expect(result.category).toBe('FEE_OR_TAX_VARIANCE');
    expect(result.material).toBe(false);
    expect(result.differenceMinorUnits).toBe(50000);
  });

  it('classifies paid vs total as PARTIAL_PAYMENT', () => {
    const a1: AmountField = {
      ...normalizeAmount('5,000.00', 'INR')!,
      evidenceId: 'evd_test',
      role: 'paid',
      method: 'DETERMINISTIC',
      sourceQuote: 'Paid 5000',
    };
    const a2: AmountField = {
      ...normalizeAmount('10,000.00', 'INR')!,
      evidenceId: 'evd_test',
      role: 'total',
      method: 'DETERMINISTIC',
      sourceQuote: 'Total 10000',
    };
    const result = classifyAmountDiscrepancy(a1, a2);
    expect(result.category).toBe('PARTIAL_PAYMENT');
    expect(result.material).toBe(false);
  });

  it('classifies substantial unexpected amount variance as MATERIAL_AMOUNT_CONTRADICTION', () => {
    const a1 = normalizeAmount('10,000.00', 'INR')!;
    const a2 = normalizeAmount('25,000.00', 'INR')!;
    const result = classifyAmountDiscrepancy(
      { ...a1, evidenceId: 'evd_test', method: 'DETERMINISTIC', sourceQuote: '10000' },
      { ...a2, evidenceId: 'evd_test', method: 'DETERMINISTIC', sourceQuote: '25000' },
    );
    expect(result.category).toBe('MATERIAL_AMOUNT_CONTRADICTION');
    expect(result.material).toBe(true);
  });
});

describe('classifyStatusDiscrepancy', () => {
  it('returns CONSISTENT when statuses match or either is UNKNOWN', () => {
    expect(classifyStatusDiscrepancy('SUCCESS', 'SUCCESS').category).toBe('CONSISTENT');
    expect(classifyStatusDiscrepancy('UNKNOWN', 'SUCCESS').category).toBe('CONSISTENT');
  });

  it('identifies PENDING to final state progression as INTERMEDIATE_PROGRESSION', () => {
    const res = classifyStatusDiscrepancy('PENDING', 'SUCCESS');
    expect(res.category).toBe('INTERMEDIATE_PROGRESSION');
    expect(res.material).toBe(false);
  });

  it('flags SUCCESS vs FAILED as MATERIAL_STATUS_CONTRADICTION', () => {
    const res = classifyStatusDiscrepancy('SUCCESS', 'FAILED');
    expect(res.category).toBe('MATERIAL_STATUS_CONTRADICTION');
    expect(res.material).toBe(true);
  });
});
