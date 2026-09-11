import type { Extraction } from './models';

export function normalizeText(value: string): string { return value.normalize('NFKC').replace(/\s+/g, ' ').trim(); }
export function normalizeIdentifier(value: string): string { return normalizeText(value).toUpperCase().replace(/[\s._-]+/g, ''); }
export function normalizeDate(original: string): { original: string; iso: string | null; precision: 'DAY' | 'MONTH' | 'UNKNOWN' } {
  const text = original.trim();
  if (/^\d{4}-\d{2}$/.test(text)) {
    const month = Number(text.slice(5));
    return { original, iso: month >= 1 && month <= 12 ? text : null, precision: month >= 1 && month <= 12 ? 'MONTH' : 'UNKNOWN' };
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const parsed = new Date(`${text}T00:00:00Z`);
    if (!Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === text) return { original, iso: text, precision: 'DAY' };
  }
  return { original, iso: null, precision: 'UNKNOWN' };
}
const decimals: Record<string, number> = { USD: 2, EUR: 2, GBP: 2, INR: 2, CAD: 2, AUD: 2, JPY: 0, KWD: 3 };
export function normalizeAmount(original: string, currency: string): { original: string; minorUnits: number; currency: string } | null {
  const code = currency.toUpperCase();
  const scale = decimals[code];
  if (scale === undefined) return null;
  const value = original.trim().replace(/^(USD|EUR|GBP|INR|CAD|AUD|JPY|KWD)\s*/i, '').replace(/^[$€£₹]\s*/, '');
  if (!/^-?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(value)) return null;
  const [whole = '', fraction = ''] = value.replace(/,/g, '').replace(/^-/, '').split('.');
  if (fraction.length > scale) return null;
  const minorUnits = Number(whole) * 10 ** scale + Number(fraction.padEnd(scale, '0'));
  if (!Number.isSafeInteger(minorUnits)) return null;
  return { original, minorUnits: value.startsWith('-') ? -minorUnits : minorUnits, currency: code };
}
export function extractText(source: string, evidenceId: string, title: string, method: 'DETERMINISTIC' | 'MANUAL' = 'DETERMINISTIC'): Extraction {
  const sourceText = source.slice(0, 30000);
  const field = (original: string, value = normalizeText(original)) => ({ original, value, evidenceId, method });
  const identifiers = (regex: RegExp) => [...sourceText.matchAll(regex)].map(match => field(match[1]!, normalizeIdentifier(match[1]!)));
  const amounts = [...sourceText.matchAll(/\b(USD|EUR|GBP|INR|CAD|AUD|JPY|KWD)\s+(-?[\d,]+(?:\.\d+)?)/gi)].flatMap(match => {
    const value = normalizeAmount(match[2]!, match[1]!);
    return value ? [{ ...value, original: match[0], evidenceId, method }] : [];
  });
  return {
    documentType: /invoice/i.test(sourceText) ? 'Invoice' : /receipt|payment/i.test(sourceText) ? 'Payment record' : /from:|subject:/i.test(sourceText) ? 'Email' : 'Document', title,
    dates: [...sourceText.matchAll(/\b\d{4}-\d{2}-\d{2}\b/g)].map(match => ({ ...normalizeDate(match[0]), evidenceId, method })), amounts,
    invoiceNumbers: identifiers(/invoice\s*(?:number|no\.?|#|:)\s*([A-Z0-9][A-Z0-9._-]*)/gi),
    orderNumbers: identifiers(/order\s*(?:number|no\.?|#|:)\s*([A-Z0-9][A-Z0-9._-]*)/gi),
    transactionIds: identifiers(/transaction\s*(?:id|number|#|:)\s*([A-Z0-9][A-Z0-9._-]*)/gi),
    emails: [...sourceText.matchAll(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi)].map(match => field(match[0], match[0].toLowerCase())),
    phones: [], people: [], organizations: [], addresses: [], keywords: [], sourceText, version: 'deterministic-v1',
  };
}
export function effectiveExtraction(evidence: { extraction: Extraction | null; confirmedExtraction: Extraction | null }): Extraction | null { return evidence.confirmedExtraction ?? evidence.extraction; }
