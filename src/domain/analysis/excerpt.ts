/**
 * Locating a value inside the line it was read from.
 *
 * Every extracted value carries a `sourceQuote`: roughly sixty characters of the document
 * either side of the match (`quoteAround`, in the deterministic extractor). That quote is
 * the most valuable string this app holds — it is the difference between the app asserting
 * that two documents disagree and a reader *seeing* them disagree — and until now it was
 * computed on every field, carried through `ComparisonCell`, and never shown.
 *
 * Showing it is only useful if the value can be marked inside it. A reader scanning
 * `…nd the total payable is Rs. 1,80,000.00 within fourteen d…` should not have to hunt for
 * the figure the app is talking about. So this module answers one question: given a quote and
 * the value the app is displaying, which characters of the quote *are* that value?
 *
 * ## Why that is not `indexOf`
 *
 * The two strings come from opposite ends of the pipeline and are shaped by different rules:
 *
 *   - the quote is stored **normalized** — NFKC, collapsed whitespace — straight off the
 *     document, so it holds whatever the document wrote: `Rs. 1,80,000.00`;
 *   - the display value is **formatted** for a reader by `formatAmount` or `formatDate`, so
 *     it holds what the app writes: `₹1,80,000`.
 *
 * A plain substring search finds neither in the other. It succeeds on identifiers and
 * organisation names, which travel through the pipeline largely intact, and fails on exactly
 * the two field types a dispute usually turns on. So the search runs in three passes of
 * decreasing strictness, and every pass returns offsets **into the original quote** so the
 * caller can slice it without re-deriving anything.
 *
 * ## Why it fails towards nothing
 *
 * A wrong mark is worse than no mark: it would point a reader at the wrong characters of
 * their own evidence while the app claims to be showing them where a figure came from. So
 * every pass here is exact about what it accepts and returns `null` the moment it is not
 * certain. A caller that gets `null` shows the quote unmarked, which is still the document's
 * own words and still worth reading.
 */

/** A half-open character range in the quote: `quote.slice(start, end)` is the value. */
export interface QuoteMark {
  readonly start: number;
  readonly end: number;
}

/**
 * The longest a value may be before marking it stops meaning anything.
 *
 * A "value" that spans most of the quote highlights the whole line, which is the same as
 * highlighting none of it and costs the reader the contrast that made the mark useful.
 */
const MAX_MARK_RATIO = 0.7;

/** At least this many digits before the numeric pass will risk a match. */
const MIN_SIGNIFICANT_DIGITS = 2;

/**
 * The shortest run of characters worth marking.
 *
 * A one-character mark tells the reader nothing and lands on the first matching character in
 * the line, which for a digit is very often not the one the app means. Values this short do
 * not occur among the amounts, dates, names and reference numbers this app compares, so the
 * floor costs nothing real and removes a whole class of arbitrary mark.
 */
const MIN_MARK_LENGTH = 2;

/**
 * A figure split into the part that carries its magnitude and the part that does not.
 *
 * The distinction is the difference between a safe tolerance and a dangerous one. `1,80,000`
 * and `1,80,000.00` are the same amount written two ways, and a reader must see them marked.
 * `18` and `1,800` differ by a factor of a hundred, and marking one as the other would show a
 * reader a figure their document does not contain. Both pairs differ only by trailing zeros,
 * so a rule that looks at the digits alone cannot separate them — what separates them is
 * whether those zeros sat after a decimal point.
 */
interface Figure {
  /** Digits before the decimal separator, or every digit when there is none. */
  readonly integer: string;
  /** Digits after it. Empty when the figure is written without a fraction. */
  readonly fraction: string;
}

/**
 * A trailing group of one or two digits after a dot or comma — a decimal fraction.
 *
 * Longer trailing groups are left alone deliberately: `1.80.000` is a thousands-separated
 * figure and `12.03.2024` is a date, and reading either one's last group as paise would
 * change what the number means. Two digits is the widest fraction any currency this app
 * formats actually uses.
 */
const DECIMAL_TAIL = /[.,](\d{1,2})$/;

function figureOf(text: string): Figure {
  const digits = digitsOf(text);
  const tail = DECIMAL_TAIL.exec(text.trim());
  if (!tail) return { integer: digits, fraction: '' };
  const fraction = tail[1]!;
  // Guarded: a bare `.50` has no integer part to compare, and treating its digits as a
  // fraction would leave nothing behind and match every other bare fraction in the line.
  if (fraction.length >= digits.length) return { integer: digits, fraction: '' };
  return { integer: digits.slice(0, digits.length - fraction.length), fraction };
}

/** Whether a fraction is absent or all zeros — the two ways of writing "and no paise". */
function fractionIsEmpty(fraction: string): boolean {
  return fraction.length === 0 || !/[1-9]/.test(fraction);
}

/**
 * Whether two number-shaped strings describe the same figure.
 *
 * The magnitudes must match exactly. The fractions must match too, except that a written
 * `.00` and an omitted fraction are the same thing — which is the whole tolerance, and it is
 * the only one, because `formatAmount` drops a zero fraction that the document wrote.
 */
function sameFigure(left: string, right: string): boolean {
  const a = figureOf(left);
  const b = figureOf(right);
  if (a.integer !== b.integer || a.integer.length === 0) return false;
  if (a.fraction === b.fraction) return true;
  return fractionIsEmpty(a.fraction) && fractionIsEmpty(b.fraction);
}

/**
 * Lowercases without ever changing the string's length.
 *
 * Every offset this module returns indexes the caller's original quote, so a fold that
 * shifts positions would silently misplace every mark after the first affected character.
 * A handful of code points lengthen when lowercased — Turkish dotted capital I becomes two
 * code units — and for those the original character is kept instead. The cost is that such
 * a character will not match case-insensitively; the alternative is offsets that lie.
 */
function foldPreservingLength(value: string): string {
  let out = '';
  for (const char of value) {
    const lower = char.toLowerCase();
    out += lower.length === char.length ? lower : char;
  }
  return out;
}

/** Whitespace, including the non-breaking and narrow spaces that survive normalization. */
const WHITESPACE = /[\s  ]/;

/**
 * A whitespace-insensitive copy of `value`, plus the map back to where each kept character
 * came from.
 *
 * `offsets[i]` is the index in `value` of `compact[i]`, so a hit found in the compacted
 * string can be reported in the original's coordinates.
 */
function compact(value: string): { text: string; offsets: number[] } {
  let text = '';
  const offsets: number[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!;
    if (WHITESPACE.test(char)) continue;
    text += char;
    offsets.push(index);
  }
  return { text, offsets };
}

/** The digits of a string, in order, with everything else dropped. */
function digitsOf(value: string): string {
  let digits = '';
  for (const char of value) {
    if (char >= '0' && char <= '9') digits += char;
  }
  return digits;
}

/**
 * A run of digits and the separators that may sit between them.
 *
 * Deliberately does not include a leading currency symbol or a trailing unit: the mark
 * covers the figure, and letting it swallow `Rs.` would make the same value mark differently
 * depending on which document it appeared in.
 */
const NUMBER_RUN = /[0-9][0-9.,'’   \-/]*[0-9]|[0-9]/g;

/**
 * Finds `value` inside `quote`, or returns `null` when it cannot be placed with certainty.
 *
 * Three passes, strictest first:
 *
 *  1. **Case-insensitive substring.** Catches identifiers, reference numbers, organisation
 *     and person names — anything that reaches the reader roughly as the document wrote it,
 *     and anything at all when the caller passes the extractor's own `original` value.
 *  2. **Whitespace-insensitive substring.** Catches a value the document broke across a line
 *     or spaced differently: `INV 2024 018` against `INV2024018`.
 *  3. **Numeric signature.** The fallback for a figure the app reformatted, when only the
 *     display string is to hand: each number-shaped run in the quote is compared against the
 *     value by magnitude and fraction. Requires two significant digits.
 *
 * Note what pass 3 deliberately does *not* do: recognise `14 March 2024` in `14/03/2024`.
 * Two date strings that parse to the same day can be written with no digits in common, and a
 * pass that reordered and re-based digit groups to bridge that would be guessing on the one
 * field type where a wrong mark is most plausible. Callers with a `DateField` have the
 * document's own wording in `original` and should pass that instead, which turns the whole
 * problem back into pass 1. See `ComparisonCell.sourceValue`.
 *
 * A value that would cover most of the quote is refused outright — see `MAX_MARK_RATIO`.
 */
export function markInQuote(quote: string, value: string): QuoteMark | null {
  const needle = value.trim();
  if (quote.length === 0 || needle.length < MIN_MARK_LENGTH) return null;
  if (needle.length > quote.length) return null;

  const limit = Math.floor(quote.length * MAX_MARK_RATIO);
  const within = (mark: QuoteMark): QuoteMark | null => {
    const width = mark.end - mark.start;
    if (width < MIN_MARK_LENGTH) return null;
    return width <= Math.max(limit, MIN_MARK_LENGTH) ? mark : null;
  };

  // 1. Exact, case-folded.
  const exact = foldPreservingLength(quote).indexOf(foldPreservingLength(needle));
  if (exact >= 0) return within({ start: exact, end: exact + needle.length });

  // 2. Whitespace-insensitive, mapped back through the offset table.
  const haystack = compact(foldPreservingLength(quote));
  const compactNeedle = compact(foldPreservingLength(needle)).text;
  if (compactNeedle.length >= MIN_MARK_LENGTH) {
    const hit = haystack.text.indexOf(compactNeedle);
    if (hit >= 0) {
      const start = haystack.offsets[hit]!;
      const end = haystack.offsets[hit + compactNeedle.length - 1]! + 1;
      return within({ start, end });
    }
  }

  // 3. Numeric signature.
  if (digitsOf(needle).length < MIN_SIGNIFICANT_DIGITS) return null;

  NUMBER_RUN.lastIndex = 0;
  for (let run = NUMBER_RUN.exec(quote); run !== null; run = NUMBER_RUN.exec(quote)) {
    if (!sameFigure(run[0]!, needle)) continue;
    return within({ start: run.index, end: run.index + run[0]!.length });
  }

  return null;
}

/**
 * Splits a quote into the run before the value, the value, and the run after it.
 *
 * The shape a renderer wants: three strings, no offsets to get wrong, and a `marked` flag
 * so the caller can style the middle only when there is something to style. When the value
 * cannot be placed, everything lands in `before` and `marked` is false — the quote still
 * reads correctly, which is the point of failing this way rather than throwing.
 */
export interface MarkedQuote {
  readonly before: string;
  readonly match: string;
  readonly after: string;
  readonly marked: boolean;
}

export function markQuote(quote: string, value: string | null | undefined): MarkedQuote {
  const mark = value ? markInQuote(quote, value) : null;
  if (!mark) return { before: quote, match: '', after: '', marked: false };
  return {
    before: quote.slice(0, mark.start),
    match: quote.slice(mark.start, mark.end),
    after: quote.slice(mark.end),
    marked: true,
  };
}

/**
 * Whether a quote was cut out of the middle of the document, at each end.
 *
 * `quoteAround` slices a fixed window either side of a match without regard for word or
 * sentence boundaries, so a stored quote routinely begins and ends mid-word. Rendered as-is
 * it reads like a mangled sentence; rendered with an ellipsis it reads like what it is, a cut
 * from a longer document — which is the honesty this screen exists for.
 *
 * The test is typographic, not semantic, and it is allowed to be wrong: an ellipsis is a
 * hint about the cut, never a claim about the contents. A quote that opens on a capital, an
 * opening quotation mark or a currency symbol is treated as starting cleanly; one that closes
 * on terminal punctuation is treated as ending cleanly.
 */
export function quoteEdges(quote: string): { leading: boolean; trailing: boolean } {
  const text = quote.trim();
  if (text.length === 0) return { leading: false, trailing: false };
  const first = text[0]!;
  const last = text[text.length - 1]!;
  return {
    leading: !/[A-Z“"'(\[₹$€£]/.test(first),
    trailing: !/[.!?:;”"')\]]/.test(last),
  };
}
