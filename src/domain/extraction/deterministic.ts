import type { DateField, AmountField, Extraction, TextField, TimedSegment } from '../models';
import { dateSortKey, normalizeDate, type DateOrder } from '../normalize/dates';
import { currencyExponent, detectCurrency, normalizeAmount } from '../normalize/money';
import {
  clampText,
  foldDigits,
  normalizeEmail,
  normalizeIdentifier,
  normalizeName,
  normalizePhone,
  normalizeText,
} from '../normalize/text';

/**
 * Deterministic extraction.
 *
 * This is the layer that makes Detact work with no AI at all. It reads plain text
 * (from a PDF, an OCR pass or a typed note) and produces the normalized `Extraction`
 * shape using pattern matching only — no model, no network, no randomness.
 *
 * Same input always yields the same output, which is what the rule engine's
 * reproducibility guarantee rests on. The optional AI layer later *adds* suggestions
 * on top; it never replaces what was found here.
 */

export const EXTRACTOR_VERSION = 'deterministic-v2';

const MAX_SOURCE_TEXT = 40_000;

/**
 * Bounds on segmentation.
 *
 * A 40,000-character document of short lines could produce thousands of segments, and every
 * one of them is stored on the evidence record and shipped to the device. 600 covers a long
 * bank statement; past that the tail is almost always boilerplate, and a citation into it
 * would be unreadable on a phone anyway. The per-segment cap matches the schema's own.
 */
const MAX_SEGMENTS = 600;
const MAX_SEGMENT_TEXT = 30_000;

/**
 * How the *text* handed to this extractor was obtained.
 *
 * `MANUAL` is deliberately absent. This module always parses characters with regular
 * expressions, so no field it produces was ever typed by a person — even when the
 * surrounding text was. `MANUAL` is reserved for a value a human entered or confirmed
 * field-by-field (see `confirmEvidenceFields` and `effectiveExtraction`), and claiming it
 * here would let a pattern-matching mistake wear a human's authority.
 */
export type ExtractedTextMethod = 'DETERMINISTIC' | 'OCR' | 'AI';

export interface ExtractionInput {
  evidenceId: string;
  title: string;
  text: string;
  /** How to read ambiguous numeric dates. Defaults to day-first. */
  dateOrder?: DateOrder;
  /**
   * Where the text came from. **Required, with no default**, because the only honest
   * default is the wrong one: an earlier version fell back to `'DETERMINISTIC'`, so text
   * recognised from pixels was stamped as having been read from the document itself and
   * the UI told the user "Read from the document" about a value a camera had guessed at.
   * Making this required turns every new ingestion path into a compile error until its
   * author states the provenance.
   */
  method: ExtractedTextMethod;
  /**
   * Clock positions for a time-based source, in the same order as the lines of `text`
   * appears in. Optional because every source without a clock - a PDF, a spreadsheet, a
   * photograph, a typed note - has none, and those callers pass nothing rather than an
   * empty list. The matching contract is documented on `IngestResult.timedSegments` in
   * `@services/ingestion/types`; this is the consuming side of that handoff.
   */
  timedSegments?: TimedSegment[];
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
  method: ExtractedTextMethod,
): TextField[] {
  // The `(?=...\d)` lookahead requires the captured token to contain a digit, and it is
  // inside the pattern rather than a check afterwards on purpose. A document reads
  // "TAX INVOICE\n\nInvoice Number: INV-2024-018": rejecting the word "Invoice" after
  // the match would consume it and leave the real value unmatched, so the invoice would
  // fail to record its own number. Inside the pattern the engine backtracks instead.
  const pattern = new RegExp(
    `${labelPattern}\\s*(?:number|no\\.?|num|id|#|:)?\\s*[:#-]?\\s*((?=[A-Za-z0-9/_-]*\\d)[A-Za-z0-9][A-Za-z0-9/_-]{2,40})`,
    'gi',
  );
  const found = new Map<string, TextField>();
  for (const match of text.matchAll(pattern)) {
    const raw = match[1]!;
    // A bare date is never a reference number.
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
  method: ExtractedTextMethod,
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

  // Match against a digit-folded copy so `१५-०ॣ-२०२४` is seen by the ASCII `\d` patterns,
  // then read `original` and the quote back out of the untouched source at the same indices.
  // `foldDigits` swaps one code point for one code point, so a position in `searchText` is
  // the same position in `text` — the source glyphs are preserved for display while the
  // parser sees digits it understands.
  const searchText = foldDigits(text);

  for (const pattern of patterns) {
    for (const match of searchText.matchAll(pattern)) {
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
        original: text.slice(start, end),
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
  method: ExtractedTextMethod,
): AmountField[] {
  // Currency must be stated, either as a symbol/code before the number or a code after
  // it. An unqualified "1,200" is not treated as money.
  //
  // Named groups, not numbered ones. The numbered form of this pattern had `currencyToken`
  // read group 6 — which does not exist — and `numberToken` read group 5, which is the
  // *currency* of the trailing form. The whole second alternative was therefore dead, and
  // every amount written the common way round ("Total paid: 4500.00 INR") was silently
  // dropped: not a wrong figure on screen, an absent one, with the amount rules finding
  // nothing to compare. Names cannot be knocked out of alignment by editing the pattern.
  const pattern =
    /(?:(?<leadCode>INR|USD|EUR|GBP|AUD|CAD|SGD|AED|CHF|CNY|NZD|ZAR|JPY|KRW|BHD|KWD|OMR|Rs\.?)|(?<symbol>[₹$€£¥₩₽]))\s*(?<leadNumber>[\d][\d,.\s]*\d|\d)|(?<trailNumber>[\d][\d,.\s]*\d|\d)\s*(?<trailCode>INR|USD|EUR|GBP|AUD|CAD|SGD|AED|CHF|CNY|NZD|ZAR|JPY|KRW|BHD|KWD|OMR)\b/gi;

  const results: AmountField[] = [];
  const seen = new Set<string>();

  // Same folded-search trick as `extractDates`: the pattern's `\d` classes are ASCII-only,
  // so `₹१००` would otherwise not register as an amount at all — not a wrong figure, just a
  // silently absent one on a document that looks like it read fine. Indices are shared with
  // the unfolded text, so `original` and the quote still show the printed glyphs.
  const searchText = foldDigits(text);

  for (const match of searchText.matchAll(pattern)) {
    const groups = match.groups;
    const currencyToken = groups?.leadCode ?? groups?.symbol ?? groups?.trailCode;
    const numberToken = groups?.leadNumber ?? groups?.trailNumber;
    if (!currencyToken || !numberToken) continue;

    const currency = detectCurrency(currencyToken);
    if (!currency) continue;

    const amount = normalizeAmount(numberToken, currency);
    if (!amount) continue;

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

    // Role is part of the key, as it is in `extractDates`. A payment screenshot prints the
    // same figure twice — once as the headline and once against "Total" — and keying on the
    // figure alone kept whichever came first, which is the bare one. The labelled copy was
    // then discarded, so the only amount left carrying `role: 'total'` was some unrelated
    // line further down: on a wallet receipt, the closing balance. `headlineAmount` prefers
    // the total, so the rules ended up comparing a wallet balance against the other
    // document's payment. Keeping one row per figure *per role* preserves the label without
    // reintroducing the duplicate rows the dedupe exists to remove.
    const key = `${currency}:${amount.minorUnits}:${role ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const exp = currencyExponent(currency);
    const normalized = amount.minorUnits / Math.pow(10, exp);

    results.push({
      evidenceId,
      method,
      original: normalizeText(text.slice(match.index, match.index + match[0].length)),
      minorUnits: amount.minorUnits,
      currency,
      normalized,
      ...(role ? { role } : {}),
      sourceQuote: quoteAround(text, match.index, match[0].length),
    });
  }

  return results;
}

function extractEmails(text: string, evidenceId: string, method: ExtractedTextMethod): TextField[] {
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

function extractPhones(text: string, evidenceId: string, method: ExtractedTextMethod): TextField[] {
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
 *
 * Two label layouts are read: `Label: Value` on one line, and a label on its own line with
 * the value beneath it. The second is what a payment app produces and is explained at its
 * pattern below.
 */
function extractParties(
  text: string,
  evidenceId: string,
  method: ExtractedTextMethod,
): { people: TextField[]; organizations: TextField[] } {
  const people = new Map<string, TextField>();
  const organizations = new Map<string, TextField>();

  /**
   * Files one label/value pair, or rejects it.
   *
   * Shared by both layouts so a guard can never apply to one and not the other: a
   * `Paid to: ₹4,500` is exactly as wrong as the same thing split across two lines.
   */
  const record = (label: string, value: string, index: number, length: number): void => {
    const raw = normalizeText(value).replace(/<[^>]*>/g, '').replace(/[,;]$/, '').trim();
    if (!raw || raw.includes('@') || /^\d+$/.test(raw)) return;

    /*
      Things that sit where a name sits but are never a name. Worth rejecting explicitly
      because the block layout reads whatever line follows the label, and on a receipt that
      is as likely to be the amount or the word "Successful" as it is the payee — and a
      party field reading "Success" is not a cosmetic problem: it would ground two unrelated
      receipts against each other as the same party.
    */
    if (/^[₹$€£]?\s*[\d,.\s]+$/.test(raw)) return;
    if (/^\d{1,4}[/-]\d{1,2}[/-]\d{1,4}$/.test(raw)) return;
    if (raw.endsWith(':')) return;
    if (
      /^(success(ful)?|completed|complete|pending|failed|processing|debited|credited|transaction(\s+(id|details|successful))?|upi(\s+(id|ref(erence)?(\s+no)?))?|ref(erence)?(\s+(no|id))?|utr|amount|date|time|status|balance|total|paid|to|from)\b/i.test(
        raw,
      )
    ) {
      return;
    }

    const normalized = normalizeName(raw);
    if (normalized.length < 2) return;

    /*
      Two independent signals that a name is a business, because relying on the legal-form
      word alone silently dropped most of the target market. "Paid to: Big Bazaar",
      "Merchant: Reliance Fresh" and "Vendor: DMart" carry no `pvt`/`ltd`/`inc`, so they
      were filed as *people* — and `organisationKeys` in the rule layer reads only
      `organizations`, so those documents could never be grounded by shared party. A bill
      and a payment screenshot naming the same shop were left to match on date alone.

      The label is the stronger signal and it is the one the writer of the document chose:
      nobody is "billed by" or "paid to" a private individual in the documents this reads,
      whereas `from`/`to`/`sender`/`recipient`/`client` are genuinely ambiguous — a client
      is very often a named person — and those still need the legal-form word before a name
      is promoted to an organisation.
    */
    const commercialLabel =
      /^(bill(?:ed)? to|billed by|vendor|supplier|paid to|issued by|merchant|store|outlet|sent to)$/i.test(
        label.trim(),
      );
    const legalForm =
      /\b(pvt|private|ltd|limited|inc|llc|llp|corp|company|technologies|solutions|studio|services|agency|labs|systems|enterprises|stores?|retail|mart|bazaar|traders?|industries|foods?|electronics)\b/i.test(
        raw,
      );
    const target = commercialLabel || legalForm ? organizations : people;
    if (target.has(normalized)) return;

    target.set(normalized, {
      evidenceId,
      method,
      original: raw,
      normalized,
      sourceQuote: quoteAround(text, index, length),
    });
  };

  const pattern =
    /^[ \t]*(from|to|bill(?:ed)? to|billed by|client|vendor|supplier|customer|paid to|paid by|issued by|merchant|store|outlet|recipient|sender)\s*:\s*(.{2,80})$/gim;

  for (const match of text.matchAll(pattern)) {
    record(match[1]!, match[2]!, match.index, match[0].length);
  }

  /*
    The same labels written across two lines, which is how a payment app renders them.

    A UPI receipt from PhonePe, Google Pay or Paytm — by far the most common document this
    product is handed — puts the label on its own line and the payee underneath it, with no
    colon anywhere:

        Paid to
        Sharma Electronics
        ₹4,500

    The single-line pattern above cannot see that, so every one of those screenshots was
    read as naming nobody at all. Parties are what `organisationKeys` in the rule layer uses
    to establish that two documents concern the same transaction, so a receipt and the bill
    for the same purchase had nothing to be matched on but their amount — and an amount
    alone is the weakest possible grounding, since two unrelated payments of ₹4,500 are
    indistinguishable.

    Deliberately narrower than the single-line form. A bare "To" or "From" alone on a line
    is an email header or a form heading at least as often as it is a payee, and the line
    after a heading is frequently the start of an unrelated column — so only labels that are
    unambiguous in a payment document are read this way. The optional colon covers
    "Paid to:" with the value wrapped onto the next line, which is what a narrow screenshot
    produces.
  */
  const blockPattern =
    /^[ \t]*(paid to|paid by|received from|sent to|beneficiary|banking name|merchant)[ \t]*:?[ \t]*\r?\n[ \t]*(.{2,80})$/gim;

  for (const match of text.matchAll(blockPattern)) {
    record(match[1]!, match[2]!, match.index, match[0].length);
  }

  return { people: [...people.values()], organizations: [...organizations.values()] };
}

const DOCUMENT_TYPE_RULES: Array<{ type: string; test: RegExp; weight: number }> = [
  { type: 'Invoice', test: /\b(invoice|tax invoice|bill to|amount due)\b/i, weight: 3 },
  { type: 'Payment receipt', test: /\b(receipt|payment received|payment confirmation|transaction successful|transaction id|amount paid|paid to|utr|neft|imps|rtgs|upi|google pay|phonepe|paytm)\b/i, weight: 3 },
  { type: 'Retail bill', test: /\b(bill\s+no|bill\s+number|cash\s+memo|retail\s+bill|counter\s+bill|challan)\b/i, weight: 3 },
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
    // outrank one whose whole body is an invoice. The original flags are carried over —
    // dropping `m` here would stop the email rule's `^` matching header lines.
    const flags = rule.test.flags.includes('g') ? rule.test.flags : `${rule.test.flags}g`;
    const occurrences = text.match(new RegExp(rule.test.source, flags))?.length ?? 1;
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

function extractKeywords(text: string, evidenceId: string, method: ExtractedTextMethod): TextField[] {
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
    // Ask the money layer how many minor units this currency has. Assuming 2 printed a
    // ¥12,000 invoice as "JPY 120.00" and a 500 fils Bahraini charge as "BHD 5.00" — a
    // hundredfold error in the summary line, on documents where the currency has no
    // decimal places at all and no reader would think to check.
    const exponent = currencyExponent(total.currency);
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

function extractChatMessages(text: string): Extraction['chatMessages'] {
  const lines = text.split('\n');
  const messages: Extraction['chatMessages'] = [];
  const chatRegex =
    /^(?:\[?((?:\d{4}[/.-]\d{1,2}[/.-]\d{1,2}|\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4})(?:,\s*|\s+)\d{1,2}:\d{2}(?::\d{2})?(?:\s*[APap][Mm])?)\]?(?:\s*[-–—]\s*|\s*:\s*|\s+))?([^:\n]+?):\s+(.+)$/;
  const suspiciousKeywords =
    /\b(threat|kill|ruin|leak|destroy|harass|defame|expose|police|jail|consequence|pay or else|warn|blackmail|mar dunga|dekh lunga|barbad|phaswa dunga|case kar dunga|dhamki|viral kar dunga|paise de|refund or else|jaan se|court mein|jail bhejunga)\b/i;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = line.match(chatRegex);
    if (match) {
      const timestamp = match[1]?.trim();
      const rawSender = match[2]?.replace(/^[-–—]\s*/, '').trim();
      const content = match[3]?.trim();
      if (rawSender && content && rawSender.length < 50) {
        const isSuspicious = suspiciousKeywords.test(content);
        messages.push({
          sender: rawSender,
          content,
          timestamp: timestamp || undefined,
          suspicious: isSuspicious,
          tone: isSuspicious ? 'HOSTILE' : 'NORMAL',
        });
      }
    }
  }
  return messages.slice(0, 50);
}

/**
 * The four senses a payment outcome can carry, and the words that signal each.
 *
 * Kept as one table rather than a sequence of early returns because the order of the
 * checks used to *be* the answer: `FAILED` was tested first, so "the first attempt failed,
 * the retry was successful and the amount was credited" — a document that proves the money
 * arrived — was classified `FAILED`. Three places downstream then treat that as a fact read
 * off the page: `payment-status-conflict` and `statement-discrepancy` raise HIGH-severity
 * findings on it, and `evidence-intelligence` marks a claim `CONTRADICTED`. A word-order
 * accident became the app telling someone their own receipt showed they had not paid.
 *
 * `unpaid` is deliberately absent. An unpaid invoice records no transaction outcome at all —
 * nothing was attempted, so nothing failed — and calling it `FAILED` fed the conflict rules a
 * gateway rejection that never happened. An invoice awaiting payment is `UNKNOWN` here, which
 * is the truthful reading, and it is the invoice rules' business rather than this field's.
 */
const TRANSACTION_SENSES: ReadonlyArray<readonly [Extraction['transactionStatus'], RegExp]> = [
  ['FAILED', /\b(?:failed|failure|declined|rejected|bounced|unsuccessful|dishonou?red|insufficient funds)\b/i],
  ['SUCCESS', /\b(?:success|successful|succeeded|completed|credited|settled|paid in full)\b/i],
  ['PENDING', /\b(?:pending|processing|in progress|under review|awaiting|initiated)\b/i],
  ['CANCELLED', /\b(?:cancelled|canceled|voided|reversed|refunded|chargeback)\b/i],
];

/**
 * A labelled status field and its value: `Status: FAILED`, `UPI Payment Status - Successful`.
 *
 * This is the thing the rest of the app believes `transactionStatus` to be — a value a person
 * can open the document and point at — as opposed to a word that happened to appear in a
 * sentence. So a labelled field is read first and settles the question on its own.
 *
 * The label is matched as "any short run of text on this line ending in the word status",
 * which covers the variants real receipts use (`Txn Status`, `UPI Transaction Status`) without
 * a list of vendor spellings to keep up to date.
 */
const STATUS_FIELD = /(?:^|\n)[^\n]{0,30}?\bstatus\b[^\S\n]*[:\-–—][^\S\n]*([^\n]{1,40})/gi;

/** Every sense present in a fragment of text, in table order. */
function sensesIn(text: string): Extraction['transactionStatus'][] {
  return TRANSACTION_SENSES.filter(([, pattern]) => pattern.test(text)).map(([sense]) => sense);
}

/**
 * The payment outcome a document records, or `UNKNOWN` when it does not record one clearly.
 *
 * Abstains whenever the text carries more than one sense and no labelled field decides
 * between them. That is the same rule `claimsReadAsPaymentSucceeded` follows for claims:
 * used to abstain, never to conclude. A document describing a failure *and* a success is
 * usually a retry, a partial refund, or a statement covering several transfers — and which
 * one the dispute is about is not something a keyword can know. Returning `UNKNOWN` costs a
 * finding that might have been useful; returning a guess costs the user their credibility.
 */
function extractTransactionStatus(text: string): Extraction['transactionStatus'] {
  // Regex carries /g, so its lastIndex persists across calls on the shared literal.
  STATUS_FIELD.lastIndex = 0;
  const labelled = new Set<Extraction['transactionStatus']>();
  for (let hit = STATUS_FIELD.exec(text); hit; hit = STATUS_FIELD.exec(text)) {
    for (const sense of sensesIn(hit[1] ?? '')) labelled.add(sense);
  }
  // Two labelled fields disagreeing is a document covering more than one transaction. If the
  // two are genuinely in conflict, that is for a rule comparing documents to raise, with both
  // values on screen — not for this function to pick a winner from.
  if (labelled.size === 1) return [...labelled][0]!;
  if (labelled.size > 1) return 'UNKNOWN';

  const senses = sensesIn(text);
  return senses.length === 1 ? senses[0]! : 'UNKNOWN';
}

function extractDisputedPoints(text: string): string[] {
  const points: string[] = [];
  const lines = text.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (/\b(dispute|claim|refused|denied|unauthorized|fraud|fake|discrepancy|mismatch)\b/i.test(trimmed)) {
      if (trimmed.length >= 10 && trimmed.length <= 300) {
        points.push(trimmed);
      }
    }
  }
  return points.slice(0, 10);
}

/**
 * Cuts the source text into addressable pieces.
 *
 * Everything else in this file pulls *values* out of a document — a date, an amount, a
 * reference number. Segments are the opposite operation: they keep the document itself,
 * divided into spans that something can point at. The AI layer cites a segment id when it
 * makes a suggestion, and the citation is checked by looking the id up here and confirming
 * the quoted text is really in the span. Without that, a model claiming "the invoice says
 * ₹4,500" cannot be distinguished from a model that invented the figure.
 *
 * The split is on line breaks, not sentences. Documents this app reads — receipts, payment
 * screenshots, chat exports, statements — are laid out in lines, and a sentence splitter
 * would glue a table's rows together and cut an amount away from its label.
 *
 * Offsets are into the already-clamped `sourceText`, so they stay valid against the string
 * that is actually stored on the evidence record.
 */
/**
 * The clock positions a timed segment may lend a built segment, or `null` when it has none.
 *
 * Only finite, non-negative values pass - what `extractionSchema.segments` accepts. A
 * negative or NaN position from a transcription layer would fail the schema at write time
 * and take the whole extraction down with it, which one bad span should never do. `endMs`
 * is optional by design: text read off a single video frame was observed at an instant,
 * and claiming a duration for it would put a number on screen that nothing measured.
 */
function clockPositionOf(timed: TimedSegment): { startMs: number; endMs?: number } | null {
  if (!Number.isFinite(timed.startMs) || timed.startMs < 0) return null;
  if (timed.endMs === undefined) return { startMs: timed.startMs };
  return Number.isFinite(timed.endMs) && timed.endMs >= 0 ? { startMs: timed.startMs, endMs: timed.endMs } : null;
}

function buildSegments(
  sourceText: string,
  method: string,
  timedSegments?: TimedSegment[],
): Extraction['segments'] {
  const segments: Extraction['segments'] = [];
  let cursor = 0;
  let index = 0;
  // Position in `timedSegments`, walked alongside the lines per the handoff contract
  // documented on `IngestResult.timedSegments` in `@services/ingestion/types`: advance
  // only when a line's trimmed text equals the pointed-at segment's text, and leave it
  // where it is otherwise. Matching on text rather than on position is what keeps the two
  // in step across the section headings and frame markers the ingestion layer interleaves,
  // and advancing only on a match is what keeps a recording that says "Yes." twice from
  // having its second "Yes." timed as its first.
  let timedIndex = 0;

  for (const line of sourceText.split('\n')) {
    const startOffset = cursor;
    // +1 for the '\n' that `split` consumed. The last line has no trailing newline, but
    // `cursor` is not read again after it, so overshooting by one there is harmless.
    cursor += line.length + 1;

    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (segments.length >= MAX_SEGMENTS) break;

    // Realign the recorded span onto the trimmed text so a citation never resolves to
    // leading whitespace, which is invisible and would make an offset look wrong.
    const lead = line.length - line.trimStart().length;
    const text = trimmed.slice(0, MAX_SEGMENT_TEXT);
    const timed = timedSegments?.[timedIndex];
    const matched = timed !== undefined && timed.text === text;
    // The pointer follows the *text correspondence*, not whether the timings on the other
    // end turned out usable, so one invalid span cannot desync every span after it.
    if (matched) timedIndex += 1;
    const timing = matched && timed !== undefined ? clockPositionOf(timed) : null;

    segments.push({
      id: `seg_${index}`,
      text,
      startOffset: startOffset + lead,
      // `text.length`, not `trimmed.length`. A line longer than `MAX_SEGMENT_TEXT` is stored
      // truncated, and recording the untruncated end made the span claim characters the
      // segment does not contain: `sourceText.slice(startOffset, endOffset)` then returned
      // more text than `segment.text`, and every citation checked by that comparison — the
      // one `resolveCitation` performs on every render — failed on the documents most
      // likely to matter. The span now describes exactly the text that was kept.
      endOffset: startOffset + lead + text.length,
      ...(timing !== null ? { startMs: timing.startMs } : {}),
      ...(timing !== null && timing.endMs !== undefined ? { endMs: timing.endMs } : {}),
      method,
    });
    index += 1;
  }

  return segments;
}

/**
 * Runs the full deterministic extraction over a block of text.
 * Pure: no I/O, no clock reads, no randomness.
 */
export function extractFromText(input: ExtractionInput): Extraction {
  const { method } = input;
  const order = input.dateOrder ?? 'DMY';
  const { text: sourceText, truncated } = clampText(input.text, MAX_SOURCE_TEXT);
  const { evidenceId } = input;

  const dates = extractDates(sourceText, evidenceId, method, order);
  const amounts = extractAmounts(sourceText, evidenceId, method);
  const parties = extractParties(sourceText, evidenceId, method);
  const documentType = classifyDocumentType(sourceText);

  return {
    segments: buildSegments(sourceText, method, input.timedSegments),
    limitations: truncated ? ['Only the retained source text was extracted; the original exceeds the text limit.'] : [],
    documentType,
    title: input.title,
    summary: buildSummary(documentType, dates, amounts),
    dates,
    amounts,
    parties: [...parties.people, ...parties.organizations],
    people: parties.people,
    organizations: parties.organizations,
    emails: extractEmails(sourceText, evidenceId, method),
    phones: extractPhones(sourceText, evidenceId, method),
    invoiceNumbers: matchLabelled(sourceText, '(?:tax\\s+)?(?:invoice|bill|receipt|memo|voucher|challan)', evidenceId, method),
    orderNumbers: matchLabelled(sourceText, '(?:order|po|purchase\\s+order)', evidenceId, method),
    transactionIds: matchLabelled(
      sourceText,
      '(?:transaction|txn|utr|reference|ref|payment|upi|rrn|gpay|paytm|phonepe)',
      evidenceId,
      method,
    ),
    addresses: [],
    keywords: extractKeywords(sourceText, evidenceId, method),
    chatMessages: extractChatMessages(sourceText),
    transactionStatus: extractTransactionStatus(sourceText),
    disputedPoints: extractDisputedPoints(sourceText),
    sourceText,
    sourceTextTruncated: truncated,
    extractorVersion: EXTRACTOR_VERSION,
  };
}
