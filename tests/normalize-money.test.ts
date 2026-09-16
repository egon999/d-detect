import { describe, expect, it } from 'vitest';
import {
  currencyExponent,
  detectCurrency,
  formatAmount,
  normalizeAmount,
  relativeDifference,
} from '@domain/normalize/money';

describe('normalizeAmount', () => {
  it('stores minor units as integers, never floats', () => {
    expect(normalizeAmount('85,000.00', 'INR')?.minorUnits).toBe(8_500_000);
    expect(normalizeAmount('0.10', 'USD')?.minorUnits).toBe(10);
    // The reason minor units exist at all: 0.1 + 0.2 !== 0.3 in binary floating point.
    const a = normalizeAmount('0.10', 'USD')!.minorUnits;
    const b = normalizeAmount('0.20', 'USD')!.minorUnits;
    expect(a + b).toBe(normalizeAmount('0.30', 'USD')!.minorUnits);
  });

  it('handles Indian grouping', () => {
    expect(normalizeAmount('1,00,000.50', 'INR')?.minorUnits).toBe(10_000_050);
  });

  it('handles European notation where comma is the decimal separator', () => {
    expect(normalizeAmount('1.234,56', 'EUR')?.minorUnits).toBe(123_456);
  });

  it('reads a lone separator followed by three digits as grouping', () => {
    expect(normalizeAmount('1,500', 'INR')?.minorUnits).toBe(150_000);
    expect(normalizeAmount('1.500', 'EUR')?.minorUnits).toBe(150_000);
  });

  it('reads a lone separator followed by two digits as a decimal', () => {
    expect(normalizeAmount('1,50', 'EUR')?.minorUnits).toBe(150);
  });

  it('respects currencies that do not use two decimal places', () => {
    expect(currencyExponent('JPY')).toBe(0);
    expect(normalizeAmount('1,200', 'JPY')?.minorUnits).toBe(1200);
    // KWD has three: 1.5 dinar is 1500 fils.
    expect(normalizeAmount('1.5', 'KWD')?.minorUnits).toBe(1500);
  });

  it('reads accounting parentheses and minus signs as negative', () => {
    expect(normalizeAmount('(1,200.00)', 'USD')?.minorUnits).toBe(-120_000);
    expect(normalizeAmount('-1,200.00', 'USD')?.minorUnits).toBe(-120_000);
  });

  it('strips currency codes and symbols embedded in the value', () => {
    expect(normalizeAmount('INR 85,000.00', 'INR')?.minorUnits).toBe(8_500_000);
    expect(normalizeAmount('₹85,000.00', 'INR')?.minorUnits).toBe(8_500_000);
    expect(normalizeAmount('Rs. 85,000.00', 'INR')?.minorUnits).toBe(8_500_000);
  });

  it('returns null rather than a wrong amount', () => {
    // Inconsistent separator groups: a version number, not money.
    expect(normalizeAmount('1.2.3', 'USD')).toBeNull();
    // More decimal places than the currency has.
    expect(normalizeAmount('12.3456', 'USD')).toBeNull();
    expect(normalizeAmount('abc', 'USD')).toBeNull();
    expect(normalizeAmount('', 'USD')).toBeNull();
  });
});

describe('detectCurrency', () => {
  it('recognises codes, symbols and the Rs. shorthand', () => {
    expect(detectCurrency('Total: INR 85,000')).toBe('INR');
    expect(detectCurrency('₹85,000')).toBe('INR');
    expect(detectCurrency('Rs. 85,000')).toBe('INR');
    expect(detectCurrency('$1,200')).toBe('USD');
    expect(detectCurrency('1200 EUR')).toBe('EUR');
  });

  it('returns null instead of defaulting, so nothing is attributed to the wrong currency', () => {
    expect(detectCurrency('Total: 85,000')).toBeNull();
  });
});

describe('comparison and formatting', () => {
  it('refuses to compare across currencies, having no exchange rates', () => {
    const inr = normalizeAmount('85,000.00', 'INR')!;
    const usd = normalizeAmount('85,000.00', 'USD')!;
    expect(relativeDifference(inr, usd)).toBeNull();
  });

  it('expresses the difference as a fraction of the larger amount', () => {
    const billed = normalizeAmount('85,000.00', 'INR')!;
    const paid = normalizeAmount('40,000.00', 'INR')!;
    expect(relativeDifference(billed, paid)).toBeCloseTo(45 / 85, 6);
    expect(relativeDifference(billed, billed)).toBe(0);
  });

  it('formats with the right number of decimal places for the currency', () => {
    expect(formatAmount({ original: '', minorUnits: 8_500_000, currency: 'INR' })).toBe('INR 85,000.00');
    expect(formatAmount({ original: '', minorUnits: 1200, currency: 'JPY' })).toBe('JPY 1,200');
    expect(formatAmount({ original: '', minorUnits: -120_000, currency: 'USD' })).toBe('-USD 1,200.00');
  });
});

describe('non-ASCII digits', () => {
  // A bill printed in Hindi states its total in Devanagari digits. JavaScript's `\d` is
  // ASCII-only and NFKC does not transliterate between scripts, so before `foldDigits`
  // existed these produced no amount at all — the worse failure mode, because the document
  // appeared to have been read successfully.

  it('reads Devanagari digits as the number they are', () => {
    expect(normalizeAmount('१००', 'INR')?.minorUnits).toBe(10_000);
    expect(normalizeAmount('१,००,०००.५०', 'INR')?.minorUnits).toBe(10_000_050);
  });

  it('agrees with the ASCII spelling of the same amount', () => {
    // The whole point: a Devanagari bill and an ASCII payment screenshot must compare as
    // equal, or the amount-mismatch rule reports a conflict between two identical figures.
    expect(normalizeAmount('१००.५०', 'INR')?.minorUnits).toBe(
      normalizeAmount('100.50', 'INR')?.minorUnits,
    );
  });

  it('keeps the original string exactly as the document printed it', () => {
    // Normalization may only ever affect the *comparable* value. If `original` came back
    // folded, the UI would quote a receipt as saying something it never said.
    expect(normalizeAmount('१००', 'INR')?.original).toBe('१००');
  });

  it('handles the other digit blocks the product can plausibly meet', () => {
    expect(normalizeAmount('১০০', 'INR')?.minorUnits).toBe(10_000); // Bengali
    expect(normalizeAmount('௧௦௦', 'INR')?.minorUnits).toBe(10_000); // Tamil
    expect(normalizeAmount('١٠٠', 'AED')?.minorUnits).toBe(10_000); // Arabic-Indic
    expect(normalizeAmount('１００', 'USD')?.minorUnits).toBe(10_000); // Fullwidth
  });

  it('still refuses what is not a number', () => {
    // Folding must not turn the parser permissive: these were rejected before and stay
    // rejected, so a version string or an identifier cannot become an amount.
    expect(normalizeAmount('१.२.३', 'INR')).toBeNull();
    expect(normalizeAmount('अबc', 'INR')).toBeNull();
    // Four fraction digits force a decimal read (a 3-digit tail would be grouping), and
    // four is more than INR's two — so this is rejected exactly as "100.5555" would be.
    expect(normalizeAmount('१००.५५५५', 'INR')).toBeNull();
  });

  it('folds a Devanagari amount the same way it folds its ASCII twin', () => {
    // Guards the parser's grouping heuristic across the fold: "१००.५५५" must read as
    // grouping (→ 100555) identically to "100.555", never as a rejected over-precise
    // decimal. If these two ever diverge, the fold has stopped being transparent.
    expect(normalizeAmount('१००.५५५', 'INR')?.minorUnits).toBe(
      normalizeAmount('100.555', 'INR')?.minorUnits,
    );
  });
});
