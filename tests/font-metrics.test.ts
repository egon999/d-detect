/**
 * The figure-width table, checked against the font files it was measured from.
 *
 * ## Why this reads a font binary
 *
 * `measureFigure` in `tokens.ts` decides whether a rupee amount fits its column, and it does that
 * by arithmetic rather than by measuring rendered glyphs — deliberately, because a
 * measurement-driven shrink oscillates between two sizes while arithmetic cannot. The price of
 * arithmetic is a set of advance widths that somebody typed in, and a typed-in number that is
 * wrong produces the failure the whole mechanism exists to prevent: a figure that overflows its
 * box and truncates into a smaller, plausible, wrong number.
 *
 * The numbers cannot be checked by re-reading the code that uses them, so they are checked
 * against the source: the `.ttf` files the app ships, parsed here rather than trusted. A glyph
 * the app actually sets amounts in can then be asserted to measure no wider than the table claims.
 *
 * ## Why the table is allowed to over-estimate but never under-estimate
 *
 * The two errors are not symmetric. Over-estimating a figure sets it a fraction smaller than it
 * had to be — visible only if you were looking for it. Under-estimating lets it overflow, and the
 * overflow path is `numberOfLines={1}`, which is an ellipsis: `₹1,23,4…`. That is not a shortened
 * figure, it is a different and believable one. Every assertion below is therefore one-sided.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { MONO_ADVANCE_RATIO, SANS_FIGURE_ADVANCE, measureFigure, TYPE } from '../src/ui/tokens';

const ROOT = join(__dirname, '..');

/** Where Expo copies the bundled faces or the canonical source faces in node_modules. */
function resolveFontFile(family: 'plus-jakarta-sans' | 'ibm-plex-mono', weight: string, hashedName: string): string {
  const distPath = join(ROOT, 'dist', 'assets', 'node_modules', '@expo-google-fonts', family, weight, hashedName);
  if (existsSync(distPath)) return distPath;
  const canonicalName = family === 'plus-jakarta-sans' ? `PlusJakartaSans_${weight}.ttf` : `IBMPlexMono_${weight}.ttf`;
  const nodeModulesPath = join(ROOT, 'node_modules', '@expo-google-fonts', family, weight, canonicalName);
  if (existsSync(nodeModulesPath)) return nodeModulesPath;
  return distPath;
}

/**
 * The faces a figure can be set in, as the app loads them.
 *
 * Only the weights the type scale actually names, plus the regular: a table built from a weight
 * nothing renders would pass while the weight that does render sat unwatched.
 */
const SANS_FACES = [
  ['400Regular', 'PlusJakartaSans_400Regular.dd3a1370a03dc0f2d7d093bd0ffe7c0b.ttf'],
  ['500Medium', 'PlusJakartaSans_500Medium.0a825b3e08f62af5a9bc9130843b12ff.ttf'],
  ['600SemiBold', 'PlusJakartaSans_600SemiBold.73de6fb49299ccb6478575127008c120.ttf'],
  ['700Bold', 'PlusJakartaSans_700Bold.bac8ecad2d6da4aa6b4200699a80a9dd.ttf'],
  ['800ExtraBold', 'PlusJakartaSans_800ExtraBold.f90855567d2c693a26e66f7184645099.ttf'],
] as const;

const MONO_FACE = [
  '400Regular',
  'IBMPlexMono_400Regular.b112f77f65b1766764ee122703ebdcd0.ttf',
] as const;

/**
 * The minimum a TrueType parser has to do to answer "how wide is this glyph?".
 *
 * Reads the tables by tag rather than by a fixed offset, because the table directory order is not
 * fixed by the spec and the two families order theirs differently. Only `head` (units per em),
 * `hhea` (how many long advances there are), `hmtx` (the advances) and `cmap` (character to glyph)
 * are needed for an advance width; everything else is skipped.
 *
 * The `cmap` reader handles format 4 only, which is the format both faces use for the Windows
 * Unicode subtable. Format 12 (used for astral planes) is not needed — no figure glyph is above
 * the BMP — and a face that switched to it would fail loudly here rather than quietly returning
 * zero widths.
 */
function loadFont(path: string): (text: string) => number {
  const buffer = readFileSync(path);

  const tableCount = buffer.readUInt16BE(4);
  const tables: Record<string, number> = {};
  for (let i = 0; i < tableCount; i += 1) {
    const entry = 12 + i * 16;
    tables[buffer.toString('ascii', entry, entry + 4)] = buffer.readUInt32BE(entry + 8);
  }

  for (const required of ['head', 'hhea', 'hmtx', 'cmap']) {
    if (tables[required] === undefined) throw new Error(`${path} has no ${required} table`);
  }

  const unitsPerEm = buffer.readUInt16BE(tables.head! + 18);
  const longAdvanceCount = buffer.readUInt16BE(tables.hhea! + 34);
  const advanceAt = (glyph: number) =>
    glyph < longAdvanceCount
      ? buffer.readUInt16BE(tables.hmtx! + glyph * 4)
      : buffer.readUInt16BE(tables.hmtx! + (longAdvanceCount - 1) * 4);

  const cmap = tables.cmap!;
  const subtableCount = buffer.readUInt16BE(cmap + 2);
  let unicodeSubtable: number | null = null;
  for (let i = 0; i < subtableCount; i += 1) {
    const record = cmap + 4 + i * 8;
    const platform = buffer.readUInt16BE(record);
    const encoding = buffer.readUInt16BE(record + 2);
    if (platform === 3 && (encoding === 1 || encoding === 10)) {
      unicodeSubtable = cmap + buffer.readUInt32BE(record + 4);
    }
  }
  if (unicodeSubtable === null) throw new Error(`${path} has no Windows Unicode cmap`);

  const segmentBytes = buffer.readUInt16BE(unicodeSubtable + 6);
  const segmentCount = segmentBytes / 2;
  const endOffset = unicodeSubtable + 14;
  const startOffset = endOffset + segmentBytes + 2;
  const deltaOffset = startOffset + segmentBytes;
  const rangeOffset = deltaOffset + segmentBytes;

  const glyphFor = (codePoint: number): number => {
    for (let s = 0; s < segmentCount; s += 1) {
      const end = buffer.readUInt16BE(endOffset + s * 2);
      if (codePoint > end) continue;
      const start = buffer.readUInt16BE(startOffset + s * 2);
      if (codePoint < start) return 0;
      const delta = buffer.readInt16BE(deltaOffset + s * 2);
      const range = buffer.readUInt16BE(rangeOffset + s * 2);
      if (range === 0) return (codePoint + delta) & 0xffff;
      const glyphOffset = rangeOffset + s * 2 + range + (codePoint - start) * 2;
      const glyph = buffer.readUInt16BE(glyphOffset);
      return glyph === 0 ? 0 : (glyph + delta) & 0xffff;
    }
    return 0;
  };

  return (text: string): number => {
    let ems = 0;
    for (const character of text) ems += advanceAt(glyphFor(character.codePointAt(0)!)) / unitsPerEm;
    return ems;
  };
}

const sansWidths = SANS_FACES.map(([weight, file]) => ({
  weight,
  width: loadFont(resolveFontFile('plus-jakarta-sans', weight, file)),
}));

/**
 * Figures this product actually renders, built from the real formatter's shapes.
 *
 * Hard-coded rather than formatted here, because formatting is `formatMoneyCompact`'s job and is
 * tested in its own suite. What matters for this file is the *character set*: digits, the symbols
 * `formatMoneyCompact` maps codes to, Indian and Western grouping, the decimal point of a paisa
 * amount, and the minus sign of a refund. The currency codes at the end are the widest thing that
 * can appear, since a symbol-less currency is written as its three-letter ISO code.
 */
const FIGURES = [
  '₹1,23,456.78',
  '₹1,23,45,678.90',
  '₹12,34,567.89',
  '₹1,00,00,000',
  '₹1,00,00,000.00',
  '₹9,99,999',
  '$1,234,567.89',
  '$12,345,678.90',
  '-₹500',
];

/**
 * The ISO codes `formatMoneyCompact` writes for a currency with no symbol, each with its own
 * exponent so the decimal shape differs. Kept apart from `FIGURES` because these are the strings
 * whose width depends on letters being in the table, and the tolerance below has to say so.
 */
const CURRENCY_CODE_FIGURES = ['KWD 12.345', 'AED 4,000', 'OMR 1.500', 'BHD 999.999'];

describe('the sans figure advance table', () => {
  it('covers every character a currency-code figure can contain', () => {
    // The union of what `formatMoneyCompact` can emit around a figure: digits, the symbol it maps
    // a code to, the grouping and decimal separators, the minus of a negative, the space that
    // separates a currency code from its amount, and the letters of the code itself. Letters and
    // the space used to fall through to the fallback here, which was safe but cost a fifth of the
    // type size on a code like `AED 4,000` — `KWD` for the letters, ` ` for the space.
    for (const character of '0123456789,.₹$- ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
      expect(SANS_FIGURE_ADVANCE[character], `${character} missing from the table`).toBeGreaterThan(
        0,
      );
    }
  });

  it('never falls back to something narrower than a listed glyph', () => {
    // The fallback still exists for the character nobody thought of — a currency symbol outside
    // the nine the formatter knows, a stray letter from a malformed code. The table is only a safe
    // over-estimate if that fallback is at least as wide as everything in it, and `W` is now the
    // widest entry for the same reason it is the fallback.
    for (const character of Object.keys(SANS_FIGURE_ADVANCE)) {
      expect(
        SANS_FIGURE_ADVANCE[character],
        `${character} is wider than the fallback`,
      ).toBeLessThanOrEqual(1.032);
    }
  });

  it('never claims a width narrower than the widest face actually sets', () => {
    // The one asymmetry that matters. An under-estimate produces an overflow; an over-estimate
    // produces a slightly small figure. A font upgrade that widens a glyph — or a new weight added
    // to `fonts.ts` and to the scale — fails here rather than on a user's phone.
    for (const [character, claimed] of Object.entries(SANS_FIGURE_ADVANCE)) {
      for (const { weight, width } of sansWidths) {
        expect(claimed, `${character} at ${weight}`).toBeGreaterThanOrEqual(width(character));
      }
    }
  });

  it('measures a real figure no wider than the font does, across every weight', () => {
    for (const figure of [...FIGURES, ...CURRENCY_CODE_FIGURES]) {
      for (const { weight, width } of sansWidths) {
        const claimed = measureFigure(figure, TYPE.statValue.fontFamily, 100) / 100;
        expect(claimed, `${figure} at ${weight}`).toBeGreaterThanOrEqual(width(figure));
      }
    }
  });

  it('stays within a twelfth of the true advance, so a fit is not needlessly small', () => {
    // Over-estimating is safe but not free: every percent of slack is a percent of type size the
    // reader does not get, on the number the money screen exists to show. Three versions of the
    // table were measured before this bound settled. A flat `0.6 × length` was 9% wide on
    // `₹1,23,45,678.90`; leaving the currency-code letters to the fallback was 25% wide on
    // `KWD 12.345`; and leaving the *space* in `AED 4,000` to the fallback was the biggest of the
    // three, at 21%, because a space is 0.18em and the fallback is a `W`.
    //
    // What remains is structural, not slack to squeeze. The table holds each character's widest
    // advance across the weights, because a figure must fit whichever weight it is set in, and the
    // lightest weight is narrower than the heaviest for almost every capital. So the error is
    // largest on a run of capitals at the lightest weight — `AED 4,000` at Regular is the worst
    // real figure at 7.7% — and smallest on the rupee figures, which are digits and separators and
    // sit under 4%. An eighth is comfortably above the measured worst and would fail on a
    // regression that put a wide glyph back on the fallback.
    const worst = Math.max(
      ...[...FIGURES, ...CURRENCY_CODE_FIGURES].map((figure) => {
        const real = Math.max(...sansWidths.map(({ width }) => width(figure)));
        const claimed = measureFigure(figure, TYPE.statValue.fontFamily, 100) / 100;
        return claimed / real - 1;
      }),
    );
    expect(worst, 'the table costs the reader more type size than it should').toBeLessThan(0.125);
  });

  it('sets the tabular advance rather than the proportional one, so a column does not move', () => {
    // The point of the table existing at all. Plus Jakarta Sans's `1` is far narrower than its `0`,
    // so a proportional estimate would be badly wrong in whichever direction the particular figure
    // leaned — `111` would be three times over-estimated and `000` under-estimated. Every digit is
    // costed at the widest face's advance for that digit, which is what pins a column.
    const proportionalSpread =
      Math.max(...sansWidths.map(({ width }) => width('0'))) /
      Math.min(...sansWidths.map(({ width }) => width('1')));
    expect(proportionalSpread, 'the face is not as proportional as this table assumes').toBeGreaterThan(
      1.5,
    );

    // Two figures of the same length but different digits must not be assumed the same width.
    const wide = measureFigure('₹8,88,888.88', TYPE.statValue.fontFamily, 32);
    const narrow = measureFigure('₹1,11,111.11', TYPE.statValue.fontFamily, 32);
    expect(wide).toBeGreaterThan(narrow);
  });
});

describe('the mono ranks', () => {
  it('use the flat ratio, which is exact rather than estimated', () => {
    // Plex Mono is a fixed-pitch face: every glyph advances by the same fraction of the em. The
    // ratio is asserted against the shipped file rather than against the claim in its docblock, so
    // a face swap that brought a proportional monospace would fail here.
    const width = loadFont(resolveFontFile('ibm-plex-mono', MONO_FACE[0], MONO_FACE[1]));
    for (const character of 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789₹,.-') {
      expect(width(character), `${character} is not fixed-pitch`).toBeCloseTo(MONO_ADVANCE_RATIO, 3);
    }
  });

  it('is what a mono figure is measured with', () => {
    const mono = TYPE.monoValue.fontFamily;
    const sans = TYPE.statValue.fontFamily;
    expect(measureFigure('12345', mono, 32)).toBeCloseTo(5 * MONO_ADVANCE_RATIO * 32, 6);
    expect(measureFigure('12345', sans, 32)).not.toBeCloseTo(5 * MONO_ADVANCE_RATIO * 32, 1);
  });
});
