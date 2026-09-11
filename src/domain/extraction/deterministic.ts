import type { DateField, AmountField, Extraction, TextField } from '../models';
import { dateSortKey, normalizeDate, type DateOrder } from '../normalize/dates';
import { detectCurrency, normalizeAmount } from '../normalize/money';
import {
  clampText,
  normalizeEmail,
  normalizeIdentifier,
  normalizeName,
  normalizePhone,
  normalizeText,
} from '../normalize/text';

/**
 * Deterministic extraction.
 *
 * This is the layer that makes CaseGraph work with no AI at all. It reads plain text
 * (from a PDF, an OCR pass or a typed note) and produces the normalized `Extraction`
 * shape using pattern matching only — no model, no network, no randomness.
 *
 * Same input always yields the same output, which is what the rule engine's
 * reproducibility guarantee rests on. The optional AI layer later *adds* suggestions
 * on top; it never replaces what was found here.
 */

export const EXTRACTOR_VERSION = 'deterministic-v2';

const MAX_SOURCE_TEXT = 40_000;

export interface ExtractionInput {
  evidenceId: string;
  title: string;
  text: string;
  /** How to read ambiguous numeric dates. Defaults to day-first. */
  dateOrder?: DateOrder;
  /** OCR output is marked so the UI can warn that character errors are possible. */
  method?: 'DETERMINISTIC' | 'OCR';
}

/** Captures the ~60 characters around a match so the UI can show where a value came from. */
function quoteAround(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 30);
  const end = Math.min(text.length, index + length + 30);
  return normalizeText(text.slice(start, end));
}

/**
 * Labelled identifiers: "Invoice No: INV-2024-018", "Order #A1234", "UTR: 40382881".
 * Requiring a label avoids treating every alphanumeric token in a document as a
 * reference number.
 */
function matchLabelled(
  text: string,
  labelPattern: string,
  evidenceId: string,
  method: 'DETERMINISTIC' | 'OCR',
): TextField[] {
  const pattern = new RegExp(
    `${labelPattern}\\s*(?:number|no\\.?|num|id|#|:)?\\s*[:#-]?\\s*([A-Za-z0-9][A-Za-z0-9/_-]{2,40})`,
    'gi',
  );
  const found = new Map<string, TextField>();
  for (const match of text.matchAll(pattern)) {
    const raw = match[1]!;
    // A bare date or a pure label word is never a reference number.
    if (/^\d{1,2}[/-]\d{1,2}[/-]\d{2,4}$/.test(raw)) continue;
    const normalized = normalizeIdentifier(raw);
    if (normalized.length < 3 || found.has(normalized)) continue;
    found.set(normalized, {
      evidenceId,
      method,
      original: raw,
      normalized,
      sourceQuote: quoteAround(text, match.index, match[0].length),
    });
  }
  return [...found.values()];
}

function extractDates(
  text: string,
  evidenceId: string,
  method: 'DETERMINISTIC' | 'OCR',
  order: DateOrder,
): DateField[] {
  // Ordered most specific first so "15 March 2024" is not partly consumed by a
  // looser pattern. Each alternative is anchored on a word boundary.
  const patterns = [
    /\b\d{4}-\d{2}-\d{2}\b/g,
    /\b\d{1,2}[/.\-]\d{1,2}[/.\-]\d{2,4}\b/g,
    /\b\d{1,2}(?:st|nd|rd|th)?\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*,?\s+\d{2,4}\b/gi,
    /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{2,4}\b/gi,
    /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\s+\d{4}\b/gi,
  ];

  const byIso = new Map<string, DateField>();
  const claimed: Array<[number, number]> = [];

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const start = match.index;
      const end = start + match[0].length;
      // Skip a span already consumed by a more specific pattern.
      if (claimed.some(([from, to]) => start < to && end > from)) continue;

      const parsed = normalizeDate(match[0], order);
      if (!parsed.iso) continue;
      claimed.push([start, end]);

      const context = text.slice(Math.max(0, start - 40), start).toLowerCase();
      const role = /\bdue\b/.test(context)
        ? 'due'
        : /\b(paid|payment|received|credited|settled)\b/.test(context)
          ? 'paid'
          : /\b(issued|invoice date|dated|date of issue)\b/.test(context)
            ? 'issued'
            : /\b(deliver|submitted|handover|completed)\b/.test(context)
              ? 'delivered'
              : undefined;

      // Keyed by value so the same date repeated in a header and a footer counts once,
      // but keep the first occurrence that carries a role hint.
      const key = `${parsed.iso}|${role ?? ''}`;
      if (byIso.has(key)) continue;
      byIso.set(key, {
        evidenceId,
        method,
        original: parsed.original,
        iso: parsed.iso,
        precision: parsed.precision,
        ambiguous: parsed.ambiguous,
        ...(role ? { role } : {}),
        sourceQuote: quoteAround(text, start, match[0].length),
      });
    }
  }

  return [...byIso.values()].sort((a, b) =>
    dateSortKey({ original: a.original, iso: a.iso, precision: a.precision, ambiguous: a.ambiguous }).localeCompare(
      dateSortKey({ original: b.original, iso: b.iso, precision: b.precision, ambiguous: b.ambiguous }),
    ),
  );
}

function extractAmounts(
  text: string,
  evidenceId: string,
  method: 'DETERMINISTIC' | 'OCR',
): AmountField[] {
  // Currency must be stated, either as a symbol/code before the number or a code after
  // it. An unqualified "1,200" is not treated as money.
  const pattern =
    /(?:(INR|USD|EUR|GBP|AUD|CAD|SGD|AED|CHF|CNY|NZD|ZAR|JPY|KRW|BHD|KWD|OMR|Rs\.?)|([₹$€£¥₩₽]))\s*([\d][\d,.\s]*\d|\d)|([\d][\d,.\s]*\d|\d)\s*(INR|USD|EUR|GBP|AUD|CAD|SGD|AED|CHF|CNY|NZD|ZAR|JPY|KRW)\b/gi;

  const results: AmountField[] = [];
  const seen = new Set<string>();

  for (const match of text.matchAll(pattern)) {
    const currencyToken = match[1] ?? match[2] ?? match[6];
    const numberToken = match[3] ?? match[5];
    if (!currencyToken || !numberToken) continue;

    const currency = detectCurrency(currencyToken);
    if (!currency) continue;

    const amount = normalizeAmount(numberToken, currency);
    if (!amount) continue;

    const key = `${currency}:${amount.minorUnits}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const context = text.slice(Math.max(0, match.index - 50), match.index).toLowerCase();
    const role = /\b(total|grand total|amount due|balance)\b/.test(context)
      ? 'total'
      : /\b(paid|received|credited|transferred)\b/.test(context)
        ? 'paid'
        : /\b(tax|gst|vat)\b/.test(context)
          ? 'tax'
          : /\b(advance|deposit|retainer)\b/.test(context)
            ? 'advance'
            : undefined;

    results.push({
      evidenceId,
      method,
      original: normalizeText(match[0]),
      minorUnits: amount.minorUnits,
      currency,
      ...(role ? { role } : {}),
      sourceQuote: quoteAround(text, match.index, match[0].length),
    });
  }

  return results;
}

function extractEmails(text: string, evidenceId: string, method: 'DETERMINISTIC' | 'OCR'): TextField[] {
  const found = new Map<string, TextField>();
  for (const match of text.matchAll(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g)) {
    const normalized = normalizeEmail(match[0]);
    if (found.has(normalized)) continue;
    found.set(normalized, {
      evidenceId,
      method,
      original: match[0],
      normalized,
      sourceQuote: quoteAround(text, match.index, match[0].length),
    });
  }
  return [...found.values()];
}

function extractPhones(text: string, evidenceId: string, method: 'DETERMINISTIC' | 'OCR'): TextField[] {
  const found = new Map<string, TextField>();
  for (const match of text.matchAll(/(?:\+\d{1,3}[\s-]?)?(?:\d[\s-]?){9,13}\d/g)) {
    const normalized = normalizePhone(match[0]);
    // Between 10 and 15 digits, per E.164. Shorter runs are usually amounts or ids.
    const digitCount = normalized.replace(/\D/g, '').length;
    if (digitCount < 10 || digitCount > 15 || found.has(normalized)) continue;
    found.set(normalized, {
      evidenceId,
      method,
      original: normalizeText(match[0]),
      normalized,
      sourceQuote: quoteAround(text, match.index, match[0].length),
    });
  }
  return [...found.values()];
}

/**
 * People and organisations are read from explicit labels only ("From:", "Bill To:",
 * "Client:"). Free-text name detection without a model produces too many false
 * positives to be useful, and a wrong name in an evidence record is worse than none.
 */
function extractParties(
  text: string,
  evidenceId: string,
  method: 'DETERMINISTIC' | 'OCR',
): { people: TextField[]; organizations: TextField[] } {
  const people = new Map<string, TextField>();
  const organizations = new Map<string, TextField>();

  const pattern =
    /^[ \t]*(from|to|bill(?:ed)? to|billed by|client|vendor|supplier|customer|paid to|paid by|issued by|recipient|sender)\s*:\s*(.{2,80})$/gim;

  for (const match of text.matchAll(pattern)) {
    const raw = normalizeText(match[2]!).replace(/<[^>]*>/g, '').replace(/[,;]$/, '').trim();
    if (!raw || raw.includes('@') || /^\d+$/.test(raw)) continue;

    const normalized = normalizeName(raw);
    if (normalized.length < 2) continue;

    const looksLikeOrg = /\b(pvt|private|ltd|limited|inc|llc|llp|corp|company|technologies|solutions|studio|services|agency|labs|systems|enterprises)\b/i.test(raw);
    const target = looksLikeOrg ? organizations : people;
    if (target.has(normalized)) continue;

    target.set(normalized, {
      evidenceId,
      method,
      original: raw,
      normalized,
      sourceQuote: quoteAround(text, match.index, match[0].length),
    });
  }

  return { people: [...people.values()], organizations: [...organizations.values()] };
}

const DOCUMENT_TYPE_RULES: Array<{ type: string; test: RegExp; weight: number }> = [
  { type: 'Invoice', test: /\b(invoice|tax invoice|bill to|amount due)\b/i, weight: 3 },
  { type: 'Payment receipt', test: /\b(receipt|payment received|transaction successful|utr|paid successfully|payment confirmation)\b/i, weight: 3 },
  { type: 'Email', test: /^(from|to|subject|sent|cc)\s*:/im, weight: 2 },
  { type: 'Contract', test: /\b(agreement|contract|terms and conditions|hereby agree|scope of work|statement of work)\b/i, weight: 3 },
  { type: 'Bank statement', test: /\b(bank statement|account statement|opening balance|closing balance|ifsc)\b/i, weight: 3 },
  { type: 'Chat export', test: /\b(\[\d{1,2}:\d{2}\]|whatsapp|chat transcript)\b/i, weight: 2 },
  { type: 'Quotation', test: /\b(quotation|quote|estimate|proposal)\b/i, weight: 2 },
];

export function classifyDocumentType(text: string): string {
  let best = { type: 'Document', score: 0 };
  for (const rule of DOCUMENT_TYPE_RULES) {
    if (!rule.test.test(text)) continue;
    // Count occurrences so a document that mentions "invoice" once in passing does not
    // outrank one whose whole body is an invoice.
    const occurrences = text.match(new RegExp(rule.test.source, 'gi'))?.length ?? 1;
    const score = rule.weight * Math.min(occurrences, 4);
    if (score > best.score) best = { type: rule.type, score };
  }
  return best.type;
}

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'have', 'has', 'was', 'were', 'will', 'not',
  'you', 'your', 'our', 'are', 'but', 'all', 'any', 'can', 'been', 'please', 'thanks', 'regards',
  'hi', 'hello', 'dear', 'best', 'sent', 'date', 'total', 'amount', 'number', 'invoice',
]);

function extractKeywords(text: string, evidenceId: string, method: 'DETERMINISTIC' | 'OCR'): TextField[] {
  const counts = new Map<string, number>();
  for (const match of text.toLowerCase().matchAll(/\b[a-z]{4,}\b/g)) {
    const word = match[0];
    if (STOP_WORDS.has(word)) continue;
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 12)
    .map(([word]) => ({ evidenceId, method, original: word, normalized: word }));
}

/** Builds a one-line summary from the strongest signals, without calling a model. */
function buildSummary(documentType: string, dates: DateField[], amounts: AmountField[]): string {
  const parts = [documentType];
  const total = amounts.find((a) => a.role === 'total') ?? amounts[0];
  if (total) {
    const exponent = total.currency === 'JPY' || total.currency === 'KRW' ? 0 : 2;
    const value = (Math.abs(total.minorUnits) / 10 ** exponent).toLocaleString('en-US', {
      minimumFractionDigits: exponent,
      maximumFractionDigits: exponent,
    });
    parts.push(`${total.currency} ${value}`);
  }
  const anchor = dates.find((d) => d.role === 'issued') ?? dates[0];
  if (anchor?.iso) parts.push(`dated ${anchor.iso}`);
  return parts.join(' · ');
}

/**
 * Runs the full deterministic extraction over a block of text.
 * Pure: no I/O, no clock reads, no randomness.
 */
export function extractFromText(input: ExtractionInput): Extraction {
  const method = input.method ?? 'DETERMINISTIC';
  const order = input.dateOrder ?? 'DMY';
  const { text: sourceText, truncated } = clampText(input.text, MAX_SOURCE_TEXT);
  const { evidenceId } = input;

  const dates = extractDates(sourceText, evidenceId, method, order);
  const amounts = extractAmounts(sourceText, evidenceId, method);
  const parties = extractParties(sourceText, evidenceId, method);
  const documentType = classifyDocumentType(sourceText);

  return {
    documentType,
    title: input.title,
    summary: buildSummary(documentType, dates, amounts),
    dates,
    amounts,
    people: parties.people,
    organizations: parties.organizations,
    emails: extractEmails(sourceText, evidenceId, method),
    phones: extractPhones(sourceText, evidenceId, method),
    invoiceNumbers: matchLabelled(sourceText, '(?:tax\\s+)?invoice', evidenceId, method),
    orderNumbers: matchLabelled(sourceText, '(?:order|po|purchase\\s+order)', evidenceId, method),
    transactionIds: matchLabelled(sourceText, '(?:transaction|txn|utr|reference|ref|payment)', evidenceId, method),
    addresses: [],
    keywords: extractKeywords(sourceText, evidenceId, method),
    sourceText,
    sourceTextTruncated: truncated,
    extractorVersion: EXTRACTOR_VERSION,
  };
}
