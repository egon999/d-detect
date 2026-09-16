import { describe, expect, it } from 'vitest';
import { classifyDocumentType, extractFromText } from '@domain/extraction/deterministic';
import { sampleText } from './fixtures/sample-documents';

const extract = (text: string, title = 'Test document') =>
  extractFromText({ evidenceId: 'evd_test', title, text, method: 'DETERMINISTIC' });

describe('extractFromText', () => {
  it('is pure: the same input always produces the same output', () => {
    const text = sampleText('invoice');
    expect(extract(text)).toEqual(extract(text));
  });

  it('reads an invoice number that sits below a heading of the same word', () => {
    // The heading "TAX INVOICE" precedes "Invoice Number: INV-2024-018". A naive matcher
    // captures the heading and never reaches the real value.
    const result = extract(sampleText('invoice'));
    expect(result.invoiceNumbers.map((field) => field.normalized)).toEqual(['INV2024018']);
  });

  it('normalizes reference numbers so differently punctuated forms match', () => {
    const a = extract('Invoice No: INV-2024/018').invoiceNumbers[0]?.normalized;
    const b = extract('invoice number inv_2024-018').invoiceNumbers[0]?.normalized;
    expect(a).toBe('INV2024018');
    expect(b).toBe('INV2024018');
  });

  it('does not stitch a reference number across whitespace', () => {
    // "INV 2024 018" gives no reliable way to tell where the reference ends, so nothing
    // is recorded. A missing identifier is recoverable; a wrong one silently links
    // unrelated documents together.
    expect(extract('Invoice number: INV 2024 018').invoiceNumbers).toEqual([]);
  });

  it('never treats a label word or a bare date as a reference number', () => {
    expect(extract('Invoice Date: 28/03/2024').invoiceNumbers).toEqual([]);
    expect(extract('Transaction Date: 28/03/2024').transactionIds).toEqual([]);
  });

  it('requires a stated currency before recording an amount', () => {
    expect(extract('Total: 85,000.00').amounts).toEqual([]);
    expect(extract('Total: INR 85,000.00').amounts[0]).toMatchObject({
      currency: 'INR',
      minorUnits: 8_500_000,
      role: 'total',
    });
  });

  it('tags amounts with the role implied by their surrounding words', () => {
    expect(extract('Total amount paid: INR 40,000.00').amounts[0]?.role).toBe('total');
    expect(extract('Amount received: INR 40,000.00').amounts[0]?.role).toBe('paid');
    expect(extract('GST: INR 1,000.00').amounts[0]?.role).toBe('tax');
  });

  it('reads an amount written with the currency code after the figure', () => {
    // The extraction pattern has two forms: a code or symbol before the number, and a code
    // after it. The second form read its captures from the wrong group indices — one of
    // which does not exist — so it matched nothing, and every amount written the way most
    // bank statements and invoices print it ("4500.00 INR") was silently absent rather than
    // wrong. Nothing warned: a document with no amounts simply produced no amount findings.
    const result = extract('Total paid: 4500.00 INR');

    expect(result.amounts[0]).toMatchObject({ currency: 'INR', minorUnits: 450_000 });
    expect(result.amounts[0]?.original).toBe('4500.00 INR');
  });

  it('keeps the same figure recorded under two different labels', () => {
    // A payment screenshot prints the paid amount and the wallet balance, and on a failed
    // transfer those can be the same number. Amounts were deduplicated on the figure alone,
    // so the second row was dropped and the surviving one was the unlabelled first:
    // `headlineAmount` then preferred whatever unrelated line carried `role: 'total'`.
    const result = extract(`Payment of Rs.100 to ABC Store
Wallet balance: Rs.100
Status: SUCCESS`);

    expect(result.amounts.map((amount) => [amount.minorUnits, amount.role])).toEqual([
      [10_000, undefined],
      [10_000, 'total'],
    ]);
  });

  it('still collapses a figure repeated with the same label', () => {
    const result = extract(`Total: INR 500
Total: INR 500`);

    expect(result.amounts).toHaveLength(1);
  });

  it('prints currencies with no minor unit without inventing one', () => {
    // The summary line assumed two decimal places for every currency except JPY and KRW,
    // so a yen invoice for 12,000 was summarised as "JPY 120.00" and a 1,500-fils Bahraini
    // charge as "BHD 15.00" — a hundredfold error on the one line a reader skims. The
    // exponent now comes from the currency table, which already knows which currencies
    // have no minor unit and which have three.
    expect(extract('Total: JPY 12000').summary).toContain('JPY 12,000');
    expect(extract('Total: BHD 1500').summary).toContain('BHD 1,500.000');
    expect(extract('Total: INR 1200.50').summary).toContain('INR 1,200.50');
  });

  it('reads an amount printed in Devanagari digits, and quotes the source verbatim', () => {
    // A Hindi bill states its total as ₹१००.५०. The ASCII `\d` in the extractor pattern
    // never matches those glyphs, so before the folded-search path this produced no amount
    // at all. The value must normalise to the same minor units as "100.50", while the
    // `original` and `sourceQuote` must still show what the document actually printed.
    const result = extract('कुल राशि: ₹१००.५०');
    expect(result.amounts[0]).toMatchObject({ currency: 'INR', minorUnits: 10_050 });
    expect(result.amounts[0]?.original).toContain('१००');
    expect(result.amounts[0]?.sourceQuote).toContain('१००');
  });

  it('reads a date printed in Devanagari digits', () => {
    const result = extract('दिनांक: १५/०३/२०२४');
    expect(result.dates.map((date) => date.iso)).toEqual(['2024-03-15']);
    // Provenance intact: the timeline shows the glyphs the document used, not folded ASCII.
    expect(result.dates[0]?.original).toContain('१५');
  });

  it('reads a Devanagari amount as equal to its ASCII twin — the ₹100 bill vs screenshot case', () => {
    // The brief's worked example: a bill and a payment screenshot of the same ₹100.
    // If one is in Devanagari and the other ASCII they must extract to identical minor
    // units, or the amount-mismatch rule flags a conflict between two equal figures.
    const bill = extract('Bill total: ₹१००', 'Bill').amounts[0]?.minorUnits;
    const screenshot = extract('Paid ₹100', 'Screenshot').amounts[0]?.minorUnits;
    expect(bill).toBe(screenshot);
  });

  it('tags dates with the role implied by their surrounding words', () => {
    const result = extract(sampleText('invoice'));
    const roles = Object.fromEntries(result.dates.map((date) => [date.iso, date.role]));
    expect(roles['2024-03-12']).toBe('issued');
    expect(roles['2024-03-26']).toBe('due');
  });

  it('marks numeric dates that could be read either way', () => {
    // 12/03/2024 is 12 March or 3 December depending on locale; 26/03 cannot be a month.
    const result = extract(sampleText('invoice'));
    expect(result.dates.find((date) => date.iso === '2024-03-12')?.ambiguous).toBe(true);
    expect(result.dates.find((date) => date.iso === '2024-03-26')?.ambiguous).toBe(false);
  });

  it('does not let a looser date pattern consume part of a more specific one', () => {
    const result = extract('Sent: 15 March 2024');
    expect(result.dates.map((date) => date.iso)).toEqual(['2024-03-15']);
  });

  it('separates organisations from people using legal-form words', () => {
    const result = extract('From: Pixelwave Studio\nTo: Harbour Retail Pvt Ltd\nClient: Ravi Menon');
    expect(result.organizations.map((field) => field.normalized)).toEqual([
      'pixelwave studio',
      'harbour retail',
    ]);
    expect(result.people.map((field) => field.normalized)).toEqual(['ravi menon']);
  });

  it('reads parties from explicit labels only, never from free text', () => {
    expect(extract('I spoke to Ravi Menon about the balance yesterday.').people).toEqual([]);
  });

  /*
    Indian retail merchants rarely print a legal-form word on a counter bill. Before the
    label itself was treated as a signal, "Paid to: Big Bazaar" was filed as a *person* —
    and because the rule layer's `organisationKeys` reads only `organizations`, a bill and
    a payment screenshot naming the same shop could never be grounded by shared party.
    They fell back to matching on date alone, so either document lacking a parseable date
    produced no finding at all. This is the regression guard for that.
  */
  it('treats a commercial label as an organisation even with no legal-form word', () => {
    const result = extract('Paid to: Big Bazaar\nMerchant: Reliance Fresh\nVendor: DMart');
    expect(result.organizations.map((field) => field.normalized)).toEqual([
      'big bazaar',
      'reliance fresh',
      'dmart',
    ]);
    expect(result.people).toEqual([]);
  });

  it('still requires a legal-form word behind an ambiguous label', () => {
    const result = extract('From: Ravi Menon\nTo: Anita Desai');
    expect(result.organizations).toEqual([]);
    expect(result.people.map((field) => field.normalized)).toEqual(['ravi menon', 'anita desai']);
  });

  /*
    A UPI receipt is the most common document this product is handed, and none of them use
    the `Label: Value` form. PhonePe, Google Pay and Paytm all put the label on its own line
    with the payee underneath and no colon anywhere, so before the block layout was read
    every one of those screenshots extracted no party at all — leaving the rule layer with
    nothing but the amount to match a receipt against the bill for the same purchase, and
    two unrelated payments of the same amount are indistinguishable.
  */
  it('reads a party from a label on its own line, as a payment app renders it', () => {
    const result = extract('Paid to\nSharma Electronics\n₹4,500\nTransaction successful');
    expect(result.organizations.map((field) => field.normalized)).toEqual(['sharma electronics']);
    expect(result.people).toEqual([]);
  });

  // Already handled before the block pattern existed — the single-line pattern's `\s*` after
  // the colon crosses a newline on its own. Kept as a guard: both patterns can match this
  // shape now, and it must keep producing exactly one organisation rather than a duplicate.
  it('reads a colon label whose value wrapped onto the next line', () => {
    const result = extract('Paid to:\nHarbour Retail Pvt Ltd');
    expect(result.organizations.map((field) => field.normalized)).toEqual(['harbour retail']);
  });

  it('keeps the block layout to labels that are unambiguous in a payment document', () => {
    // A bare "To" on its own line is an email header or a column heading far more often
    // than it is a payee, and the line beneath a heading is routinely unrelated.
    const result = extract('To\nAnita Desai');
    expect(result.people).toEqual([]);
    expect(result.organizations).toEqual([]);
  });

  /*
    The block layout reads whatever line follows the label, and on a receipt that line is as
    likely to be the amount or the word "Successful" as it is the payee. A party field
    reading "Success" is not cosmetic: it would ground two unrelated receipts against each
    other as naming the same party.
  */
  it('does not accept an amount, a status word or a field label as a party name', () => {
    expect(extract('Paid to\n₹4,500').organizations).toEqual([]);
    expect(extract('Paid to\nSuccessful').organizations).toEqual([]);
    expect(extract('Paid to\nTransaction ID').organizations).toEqual([]);
    expect(extract('Paid to\nUPI Ref No').organizations).toEqual([]);
    expect(extract('Paid to\n12/03/2024').organizations).toEqual([]);
    expect(extract('Paid to\nAmount:').organizations).toEqual([]);
  });

  it('files a person behind a block label that does not imply a business', () => {
    const result = extract('Received from\nRavi Menon');
    expect(result.people.map((field) => field.normalized)).toEqual(['ravi menon']);
    expect(result.organizations).toEqual([]);
  });

  it('rejects digit runs that are too short or too long to be phone numbers', () => {
    expect(extract('Phone: +91 98204 41180').phones[0]?.normalized).toBe('+919820441180');
    expect(extract('Ref: 12345').phones).toEqual([]);
  });

  it('records source quotes so every value can be traced back to the document', () => {
    const result = extract(sampleText('payment-receipt'));
    for (const field of [...result.dates, ...result.amounts, ...result.transactionIds]) {
      expect(field.sourceQuote).toBeTruthy();
      expect(field.evidenceId).toBe('evd_test');
    }
  });

  it('truncates very long source text and says so', () => {
    const result = extract('x'.repeat(50_000));
    expect(result.sourceTextTruncated).toBe(true);
    expect(result.sourceText.length).toBeLessThanOrEqual(40_000);
  });
});

describe('classifyDocumentType', () => {
  it('classifies each sample document by its dominant signal', () => {
    expect(classifyDocumentType(sampleText('invoice'))).toBe('Invoice');
    expect(classifyDocumentType(sampleText('agreement'))).toBe('Contract');
    expect(classifyDocumentType(sampleText('payment-receipt'))).toBe('Payment receipt');
  });

  it('counts header lines, so an email quoting an invoice is still an email', () => {
    // Regression: the occurrence counter used to drop the multiline flag, which stopped
    // the email rule from seeing anything past the first header line.
    expect(classifyDocumentType(sampleText('delivery-email'))).toBe('Email');
    expect(classifyDocumentType(sampleText('client-reply'))).toBe('Email');
  });

  it('falls back to a neutral label rather than guessing', () => {
    expect(classifyDocumentType(sampleText('reminder-note'))).toBe('Document');
  });
});
