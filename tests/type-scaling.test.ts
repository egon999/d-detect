import { describe, it, expect } from 'vitest';

import {
  CONTROL_SCALE_CAP,
  HIT_TARGET,
  LAYOUT,
  TYPE,
  TYPE_SCALE_CAP,
  type TypeToken,
} from '../src/ui/tokens';

/**
 * The type scale under font scaling, computed from the real tokens.
 *
 * Font scaling is left **on** everywhere in this app. A user assembling evidence for a refund
 * or a deposit dispute is reading closely, often on a phone they have already turned up, and
 * text they cannot read is not a cosmetic failure. So the question is never whether to scale,
 * only how far — and `src/ui/tokens.ts` answers it with a per-rank ceiling plus one flat cap
 * for compact controls, both of which make arithmetic claims this file checks.
 *
 * ## Why these are worth a test rather than a comment
 *
 * Every failure mode here is invisible on the machine of whoever caused it. A developer at 100%
 * scale sees nothing wrong with a cap that clips a chip label at 160%, or with a mono value
 * that drifts half a line off the sans text beside it once the reader turns the system size up.
 * The person who finds out is a stranger with an accessibility setting on, and what they see is
 * a truncated label on the screen where the app makes its central claim.
 *
 * ## Why nothing here is a hard-coded expectation
 *
 * Each assertion recomputes from `TYPE`, `TYPE_SCALE_CAP` and the layout tokens, so re-cutting
 * the scale is what moves the numbers and only the invariant is pinned. Two geometries are
 * unavoidably literal — the chip's pill height and the compact header bar — and both are noted
 * with where the real value lives.
 */

/**
 * The sans ranks in descending order, as the scale's own docblock lists them.
 *
 * `statValue`, `bodyLarge`, `bodyMedium` and the mono ranks are excluded on purpose: they are
 * *paired* with ranks in this list rather than being steps of their own, and the pairings are
 * asserted separately below.
 *
 * `bodyLarge` and `bodyMedium` share a size with `subheading` and `body`, which is the point of
 * both — one is a larger opening line, the other the same body at another weight. Including
 * either in a strictly-descending list would assert exactly the opposite of what it is for.
 */
const DESCENDING: TypeToken[] = [
  'display',
  'title',
  'titleSmall',
  'heading',
  'subheading',
  'body',
  'bodySmall',
  'label',
  'caption',
  'overline',
];

/**
 * Each mono rank and the sans rank it is pinned to.
 *
 * `Text`'s `mono` prop swaps the *family* at a fixed size, so a value that turns out to have
 * been read from a document keeps the rhythm of the line it sits in. A cap is part of that size.
 */
const MONO_PAIRS: [TypeToken, TypeToken][] = [
  ['monoValue', 'body'],
  ['mono', 'label'],
  ['monoSmall', 'caption'],
  ['monoOverline', 'overline'],
];

const scaled = (token: TypeToken) => TYPE[token].fontSize * TYPE_SCALE_CAP[token];
const scaledLineHeight = (token: TypeToken, multiplier: number) =>
  TYPE[token].lineHeight * multiplier;

describe('type scaling', () => {
  describe('the cap table covers the scale', () => {
    it('gives every type token exactly one cap and no orphans', () => {
      expect(Object.keys(TYPE_SCALE_CAP).sort()).toEqual(Object.keys(TYPE).sort());
    });

    it('never caps a rank below 1, which would shrink text the reader asked to enlarge', () => {
      for (const [token, cap] of Object.entries(TYPE_SCALE_CAP)) {
        expect(cap, token).toBeGreaterThanOrEqual(1);
      }
    });
  });

  describe('hierarchy survives magnification', () => {
    it('keeps the ranks strictly ordered at 1x', () => {
      for (let i = 1; i < DESCENDING.length; i += 1) {
        const above = DESCENDING[i - 1]!;
        const below = DESCENDING[i]!;
        expect(TYPE[above].fontSize, `${above} vs ${below}`).toBeGreaterThan(TYPE[below].fontSize);
      }
    });

    it('keeps the ranks strictly ordered at every rank ceiling', () => {
      // The point of the whole cap table. A flat 2x multiplier would put `subheading` and `body`
      // within a point of each other at the top of the range, so hierarchy the reader cannot
      // rank becomes texture — and it would do that for exactly the users reading hardest.
      for (let i = 1; i < DESCENDING.length; i += 1) {
        const above = DESCENDING[i - 1]!;
        const below = DESCENDING[i]!;
        expect(scaled(above), `${above} vs ${below} at cap`).toBeGreaterThan(scaled(below));
      }
    });

    it('keeps the ranks strictly ordered at every breakpoint in the range, not just at the ceiling', () => {
      // Every cap is >= 1 and never above the cap of the rank below it, so two adjacent ranks
      // can only *converge* as the reader scales up — they cannot cross and then come apart
      // again. That is what makes the tightest point the ceiling, and it is why this test
      // exists rather than being a duplicate of the two above: it is the assertion that the
      // *reason* holds, and it fails the moment someone gives a lower rank a smaller cap than
      // the rank above it. Two ranks that pass at 1x and 2x and collide at 1.75x are the same
      // bug as the one this file was written for, just harder to notice.
      //
      // The breakpoints are the caps themselves, because a rank's rendered size stops moving
      // once it reaches its own ceiling — so the interesting multipliers are exactly the
      // distinct caps in the table, swept in ascending order with a step between each.
      const breakpoints = [...new Set(Object.values(TYPE_SCALE_CAP))].sort((a, b) => a - b);
      const steps = [1, ...breakpoints.flatMap((c) => [c - 0.05, c, c + 0.05])];

      for (const multiplier of steps) {
        if (multiplier < 1) continue;
        for (let i = 1; i < DESCENDING.length; i += 1) {
          const above = DESCENDING[i - 1]!;
          const below = DESCENDING[i]!;
          const at = (token: TypeToken) =>
            TYPE[token].fontSize * Math.min(multiplier, TYPE_SCALE_CAP[token]);
          expect(at(above), `${above} vs ${below} at ${multiplier.toFixed(2)}x`)
            .toBeGreaterThan(at(below));
        }
      }
    });

    it('never lets two adjacent ranks sit less than half a point apart', () => {
      // Strict ordering is not enough on its own. `label` 13 and `caption` 12 used to be given
      // escalating caps, which is right in principle and, at a one-point size step, left them
      // 0.6pt apart at the ceiling — a gap that is strictly positive and completely invisible.
      // The floor here is half a point at 1x, which is the smallest size difference that
      // survives the sub-pixel rounding Android applies to an sp measurement; the caps then do
      // the rest, because a lower rank's cap is never below a higher one's, so a gap can only
      // widen with magnification.
      const FLOOR = 0.5;
      for (let i = 1; i < DESCENDING.length; i += 1) {
        const above = DESCENDING[i - 1]!;
        const below = DESCENDING[i]!;
        expect(scaled(above) - scaled(below), `${above} vs ${below} at cap`)
          .toBeGreaterThanOrEqual(FLOOR);
      }
    });

    it('compresses the scale under magnification rather than multiplying it', () => {
      // The caps rise monotonically as rank descends, so the small end nearly doubles while the
      // large end grows by less than half. A masthead at 72pt consumes half the screen and
      // pushes the content it labels below the fold; the reader who turned the setting up did it
      // for `caption`, not for `display`.
      for (let i = 1; i < DESCENDING.length; i += 1) {
        const above = DESCENDING[i - 1]!;
        const below = DESCENDING[i]!;
        expect(TYPE_SCALE_CAP[below], `${below} vs ${above}`)
          .toBeGreaterThanOrEqual(TYPE_SCALE_CAP[above]);
      }

      const first = DESCENDING[0]!;
      const last = DESCENDING[DESCENDING.length - 1]!;
      const rangeAt1x = TYPE[first].fontSize / TYPE[last].fontSize;
      const rangeAtCap = scaled(first) / scaled(last);
      expect(rangeAtCap).toBeLessThan(rangeAt1x);
    });
  });

  describe('leading keeps its proportion to the size', () => {
    /**
     * The band a line height may sit in, as a multiple of its own font size.
     *
     * The floor is 1.0 rather than something comfortable, because that is the value at which
     * ascenders and descenders of consecutive lines touch — a rank under it is not tight, it is
     * overlapping, and `display` at 1.11 is deliberately close to the floor because a
     * single-line hero is set tight on purpose. The ceiling of 1.7 is above the loosest real
     * rank (the body ranks at 1.5) and below the point where a paragraph stops reading as a
     * block.
     *
     * The reason this is worth asserting is that a line height which does not scale with its
     * size is invisible at 1x and obvious at 1.75x. If `lineHeight` were a ratio applied at
     * render time it would be moot, but it is an absolute point value in the style object, so a
     * rank can pass every ordering test above while its lines grow into each other.
     */
    const MIN_RATIO = 1;
    const MAX_RATIO = 1.7;

    it.each(Object.keys(TYPE) as TypeToken[])('%s sets leading in proportion to its size', (token) => {
      const ratio = TYPE[token].lineHeight / TYPE[token].fontSize;
      expect(ratio, `${token} leading ratio ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(MIN_RATIO);
      expect(ratio, `${token} leading ratio ${ratio.toFixed(2)}`).toBeLessThanOrEqual(MAX_RATIO);
    });

    it('holds the tightest rank at or above the point where lines start to touch', () => {
      // The band test above is permissive enough to pass a scale that is uniformly too tight.
      // This is the same question asked of the *worst* rank, stated against `display` by name
      // because it is the rank the product sets closest on purpose: a single-line hero with a
      // line box barely taller than its caps. If a future re-cut tightens it further, the
      // ascenders of one line will meet the descenders of the one above it in wrapped text,
      // and no ordering test would notice.
      const tightest = (Object.keys(TYPE) as TypeToken[]).reduce((worst, token) =>
        TYPE[token].lineHeight / TYPE[token].fontSize <
        TYPE[worst].lineHeight / TYPE[worst].fontSize
          ? token
          : worst,
      );
      expect(TYPE[tightest].lineHeight / TYPE[tightest].fontSize).toBeGreaterThanOrEqual(1.1);
    });
  });

  describe('mono ranks are pinned to their sans partners', () => {
    it.each(MONO_PAIRS)('%s matches %s in size and cap', (mono, sans) => {
      // Size is the pairing that `Text` depends on: its `mono` prop swaps the *family* and
      // nothing else, so the sans rank's own size and leading are what a mid-sentence mono value
      // renders at. Capping the standalone mono rank differently would hold the pair together at
      // 1x and split it at 1.75x, reintroducing baseline drift in every card that mixes machine
      // and human text — which is most cards in this product.
      expect(TYPE[mono].fontSize).toBe(TYPE[sans].fontSize);
      expect(TYPE_SCALE_CAP[mono]).toBe(TYPE_SCALE_CAP[sans]);
      // Leading is tuned per rank and is deliberately *not* identical — these differ by up to a
      // point and a half. What must not happen is a divergence large enough to see when a mono
      // line and a sans line sit in the same card, so it is held under a tenth of a line.
      expect(Math.abs(TYPE[mono].lineHeight - TYPE[sans].lineHeight)).toBeLessThan(
        TYPE[sans].lineHeight * 0.1,
      );
    });

    it('pairs statValue with display rather than with its own size', () => {
      // A stat figure is a headline made of digits, and it sits on a tile beside a `caption`
      // that is scaling by 1.9. Letting it take a cap derived from its own 32pt would grow it
      // out of the tile.
      expect(TYPE_SCALE_CAP.statValue).toBe(TYPE_SCALE_CAP.display);
    });
  });

  describe('fixed-height chrome still fits its label at the ceiling', () => {
    it('keeps the compact header title inside the bar', () => {
      // `LAYOUT.headerHeight` is a contract, not a measurement: the bar is absolutely positioned
      // and three places pad their scroll content by `insets.top + headerHeight`, two of them
      // outside `Screen.tsx`. A bar that grew with the font scale would slide under none of that
      // padding and sit on top of the first row of content. It stays safe by arithmetic instead.
      const title = scaledLineHeight('subheading', TYPE_SCALE_CAP.subheading);
      expect(title).toBeLessThanOrEqual(LAYOUT.headerHeight);
    });
  });

  describe('CONTROL_SCALE_CAP is derived from the tightest control', () => {
    /**
     * The small chip's pill height, from `Chip`.
     *
     * A literal because it is a literal there: `const height = compact ? 26 : 32`. It was chosen
     * so a `caption` sits *in* the pill rather than pressed against both edges, which is exactly
     * the relationship this block checks — so if someone lowers it, this figure is the one to
     * bring across, and the assertion below will already have failed.
     */
    const CHIP_HEIGHT_SM = 26;

    it('fits a caption label inside the small chip at the cap', () => {
      expect(scaledLineHeight('caption', CONTROL_SCALE_CAP)).toBeLessThanOrEqual(CHIP_HEIGHT_SM);
    });

    it('is the largest tenth-step that fits, which is why it is 1.5 and not 1.6', () => {
      // The cap is a derived figure rather than a comfortable one. Asserting the *next* step
      // overflows is what makes it derived: raise the cap without re-drawing the chip and this
      // fails, instead of a label quietly clipping on a stranger's phone.
      const nextStep = Math.round((CONTROL_SCALE_CAP + 0.1) * 10) / 10;
      expect(scaledLineHeight('caption', nextStep)).toBeGreaterThan(CHIP_HEIGHT_SM);
    });

    it('fits a segment label inside the 40pt segment, which has no vertical padding', () => {
      // `SegmentedControl`'s segment is `minHeight: 40` carrying a `label` — the second of the
      // three boxes `CONTROL_SCALE_CAP`'s docblock names. The height is a literal there for the
      // same reason as the chip's, and a segment that outgrew it would not clip: it would wrap
      // the row into a column and stop reading as a choice between alternatives.
      const SEGMENT_HEIGHT = 40;
      expect(scaledLineHeight('label', CONTROL_SCALE_CAP)).toBeLessThanOrEqual(SEGMENT_HEIGHT);
    });

    it('fits the avatar initials inside the default 44pt circle', () => {
      // The one place in the app where the box genuinely cannot grow: an avatar is a circle of a
      // size the caller chose, drawn with `overflow: 'hidden'`. `UserAvatar` defaults to
      // `HIT_TARGET` and renders `label` below 56.
      expect(scaledLineHeight('label', CONTROL_SCALE_CAP)).toBeLessThanOrEqual(HIT_TARGET);
    });

    it('fits a caption inside the leading tile, which is also a fixed square', () => {
      expect(scaledLineHeight('caption', CONTROL_SCALE_CAP)).toBeLessThanOrEqual(LAYOUT.tileSize);
    });

    it('sits below every per-rank cap it overrides', () => {
      // A control cap that exceeded a rank's own ceiling would be a ceiling that raises rather
      // than lowers, which is not what any call site passing it is asking for.
      for (const token of ['caption', 'label', 'bodySmall'] as const) {
        expect(CONTROL_SCALE_CAP, token).toBeLessThanOrEqual(TYPE_SCALE_CAP[token]);
      }
    });
  });
});
