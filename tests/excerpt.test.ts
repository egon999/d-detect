/**
 * Marking a value inside the line it was read from, tested.
 *
 * Two failures matter here, and they are not symmetric.
 *
 * A **missed** mark costs contrast: the reader sees the document's own words with nothing
 * picked out, which is a worse screen but an honest one. A **wrong** mark points a reader at
 * the wrong characters of their own evidence while the app claims to be showing them where a
 * figure came from — the app inventing agreement or disagreement that the document does not
 * contain. So the cases below spend most of their attention on what must *not* match, and on
 * the offsets landing exactly where the caller will slice.
 */

import { describe, expect, it } from 'vitest';

import { markInQuote, markQuote, quoteEdges } from '../src/domain/analysis/excerpt';

/** Slices the quote the way a renderer will, so an offset error shows up as wrong text. */
function marked(quote: string, value: string): string | null {
  const mark = markInQuote(quote, value);
  return mark ? quote.slice(mark.start, mark.end) : null;
}

describe('markInQuote — exact matches', () => {
  it('finds an identifier the document wrote as the app displays it', () => {
    const quote = 'TAX INVOICE Invoice Number: INV-2024-018 dated 12 March';
    expect(marked(quote, 'INV-2024-018')).toBe('INV-2024-018');
  });

  it('ignores case, which is how organisation names differ between documents', () => {
    const quote = 'issued to HARBOUR RETAIL PVT LTD for services';
    expect(marked(quote, 'Harbour Retail Pvt Ltd')).toBe('HARBOUR RETAIL PVT LTD');
  });

  it('reports offsets into the original quote, not a folded copy', () => {
    const quote = 'Ref ABC-991 confirmed';
    expect(markInQuote(quote, 'abc-991')).toEqual({ start: 4, end: 11 });
  });

  it('takes the first occurrence when a value appears twice', () => {
    const quote = 'INV-77 supersedes INV-77 issued earlier';
    expect(markInQuote(quote, 'INV-77')).toEqual({ start: 0, end: 6 });
  });
});

describe('markInQuote — whitespace differences', () => {
  it('matches across a space the document inserted', () => {
    const quote = 'order no. A1 234 567 shipped';
    expect(marked(quote, 'A1234567')).toBe('A1 234 567');
  });

  it('matches across a line break in the source text', () => {
    const quote = 'Invoice\nINV-2291\nissued';
    expect(marked(quote, 'INV-2291')).toBe('INV-2291');
  });

  it('matches when the value itself carries the extra spacing', () => {
    const quote = 'reference UTR40382881 credited';
    expect(marked(quote, 'UTR 40382881')).toBe('UTR40382881');
  });
});

describe('markInQuote — reformatted figures', () => {
  /**
   * The case the whole module exists for. `formatAmount` renders `₹1,80,000`; the document
   * wrote `Rs. 1,80,000.00`. Neither string contains the other.
   */
  it('matches a formatted amount against the figure the document wrote', () => {
    const quote = 'the total payable is Rs. 1,80,000.00 within fourteen days';
    expect(marked(quote, '₹1,80,000')).toBe('1,80,000.00');
  });

  it('matches when the document is the one omitting the paise', () => {
    const quote = 'balance due 1,20,000 only';
    expect(marked(quote, '₹1,20,000.00')).toBe('1,20,000');
  });

  /**
   * A date is the one field type the numeric pass deliberately gives up on: `14 March 2024`
   * and `14/03/2024` are the same day with no shared digit grouping, and a pass loose enough
   * to bridge them would be loose enough to mark the wrong day. Callers hand over the
   * extractor's own `original` instead — `ComparisonCell.sourceValue` — which makes it a
   * substring search again.
   */
  it('will not guess at a reformatted date, and matches the document wording', () => {
    const quote = 'payment was due on 14/03/2024 as agreed';
    expect(markInQuote(quote, '14 March 2024')).toBeNull();
    expect(marked(quote, '14/03/2024')).toBe('14/03/2024');
  });

  it('refuses two figures that differ in a significant digit', () => {
    const quote = 'the total payable is Rs. 1,20,000.00 within fourteen days';
    expect(markInQuote(quote, '₹1,80,000')).toBeNull();
  });

  /**
   * The misread-digit case the product is most afraid of. `1500` and `7500` share their
   * trailing zeros and nothing else, and marking one as the other would show a reader a
   * figure their document does not contain.
   */
  it('refuses a misread leading digit', () => {
    expect(markInQuote('charged Rs. 7,500 on the card', '₹1,500')).toBeNull();
  });

  /**
   * `18` and `1,800` differ only by trailing zeros, exactly like `1,80,000` and
   * `1,80,000.00` — but by a factor of a hundred rather than not at all. What separates them
   * is the decimal point, which is why the numeric pass compares magnitude and fraction
   * separately instead of comparing digit strings.
   */
  it('refuses a figure a hundred times larger than the one in the line', () => {
    expect(markInQuote('quantity 18 units at', '₹1,800')).toBeNull();
  });

  it('refuses a fraction the document does not agree with', () => {
    expect(markInQuote('paid Rs. 1,80,000.50 in full', '₹1,80,000')).toBeNull();
  });

  it('will not risk a single digit, which would land on any number in the line', () => {
    expect(markInQuote('paid 1 of 3 instalments on 9 May', '1')).toBeNull();
  });

  it('does not swallow the currency word next to the figure', () => {
    const quote = 'INR 45,000 transferred';
    expect(marked(quote, '₹45,000')).toBe('45,000');
  });
});

describe('markInQuote — refusals', () => {
  it('returns null when the value is simply absent', () => {
    expect(markInQuote('nothing relevant in this line', 'INV-2024-018')).toBeNull();
  });

  it('returns null for an empty quote or an empty value', () => {
    expect(markInQuote('', 'anything')).toBeNull();
    expect(markInQuote('a line of text', '   ')).toBeNull();
  });

  it('returns null when the value is longer than the quote', () => {
    expect(markInQuote('short', 'a much longer value than the quote')).toBeNull();
  });

  /**
   * Marking most of a line is the same as marking none of it, and it costs the reader the
   * contrast that made the mark worth having.
   */
  it('refuses a match that would cover most of the quote', () => {
    expect(markInQuote('Pixelwave Studio', 'Pixelwave Studio')).toBeNull();
    expect(marked('signed by Pixelwave Studio on behalf of the agency', 'Pixelwave Studio')).toBe(
      'Pixelwave Studio',
    );
  });
});

describe('markQuote', () => {
  it('splits the quote into the three pieces a renderer needs', () => {
    expect(markQuote('due Rs. 1,80,000 now', '₹1,80,000')).toEqual({
      before: 'due Rs. ',
      match: '1,80,000',
      after: ' now',
      marked: true,
    });
  });

  it('puts the whole quote in `before` when nothing can be placed', () => {
    expect(markQuote('a line with no figure', '₹99')).toEqual({
      before: 'a line with no figure',
      match: '',
      after: '',
      marked: false,
    });
  });

  it('treats a missing value as no mark rather than throwing', () => {
    expect(markQuote('a line', null).marked).toBe(false);
    expect(markQuote('a line', undefined).before).toBe('a line');
  });

  it('reassembles to the original quote in both outcomes', () => {
    const quote = 'the total payable is Rs. 1,80,000.00 within fourteen days';
    for (const value of ['₹1,80,000', 'nothing here']) {
      const parts = markQuote(quote, value);
      expect(parts.before + parts.match + parts.after).toBe(quote);
    }
  });
});

describe('quoteEdges', () => {
  it('marks both ends of a quote cut out of a sentence', () => {
    expect(quoteEdges('nd the total payable is Rs. 1,80,000.00 within fourteen d')).toEqual({
      leading: true,
      trailing: true,
    });
  });

  it('leaves a quote that starts and ends cleanly alone', () => {
    expect(quoteEdges('Payment is due within fourteen days.')).toEqual({
      leading: false,
      trailing: false,
    });
  });

  it('treats a leading currency symbol or quotation mark as a clean start', () => {
    expect(quoteEdges('₹1,80,000 is outstanding.').leading).toBe(false);
    expect(quoteEdges('“as agreed the figure is fixed”').leading).toBe(false);
  });

  it('reports nothing for an empty quote', () => {
    expect(quoteEdges('   ')).toEqual({ leading: false, trailing: false });
  });
});
