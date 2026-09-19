/**
 * The text-scaling policy, executed.
 *
 * Font scaling is on everywhere in this app, and it has to be: the people using it are
 * reading their own invoices and bank statements closely enough to build a dispute out of
 * them, and a meaningful share of them have already turned the system font size up. On
 * Android that goes to 2×. So every string in the product renders at a size the app does not
 * choose, inside boxes the app does.
 *
 * `TYPE_SCALE_CAP` and `CONTROL_SCALE_CAP` in `src/ui/tokens.ts` are the answer, and their
 * docblocks make three claims that are true when written and silently breakable by any later
 * edit to the type scale or to a control's height:
 *
 *   1. The scale *compresses* under magnification — every rank still outranks the one below
 *      it at maximum scale, with a gap a reader can see.
 *   2. Each mono rank is pinned to its sans partner, so a machine-read value keeps the
 *      rhythm of the prose line it sits in at every font size, not just at 100%.
 *   3. 1.5 is the largest multiplier at which the compact controls with no vertical padding to
 *      give still hold their label at the geometry they were drawn with — and the figure a
 *      button, which grows instead, uses to bound its label's *width*.
 *
 * This file turns those into assertions. The type metrics are read from the exported tokens
 * themselves, never from copies, so the test cannot drift away from what the app renders.
 *
 * The control heights below *are* copies, and that is a real limit worth stating: this repo
 * has no component-render tests, so nothing here can observe what `Chip` actually lays out.
 * They are the thresholds this test checks the tokens against — the same role `AA_TEXT` plays
 * in `theme-contrast.test.ts` — and each one names the file it mirrors so the pair can be
 * checked by eye when either moves.
 */

import { describe, expect, it } from 'vitest';

import {
  CONTROL_SCALE_CAP,
  LAYOUT,
  SPACING,
  TYPE,
  TYPE_SCALE_CAP,
  type TypeToken,
} from '@ui/tokens';

/** The line box a rank occupies once the reader has turned the font size all the way up. */
function maxLineHeight(token: TypeToken): number {
  return TYPE[token].lineHeight * TYPE_SCALE_CAP[token];
}

describe('every rank carries a ceiling', () => {
  it('caps every token in the type scale', () => {
    // `satisfies Record<TypeToken, number>` catches a missing entry at compile time. This
    // catches the other direction — a rank deleted from `TYPE` and left behind here, which
    // compiles fine and quietly documents a ceiling for a variant nothing can render.
    expect(Object.keys(TYPE_SCALE_CAP).sort()).toEqual(Object.keys(TYPE).sort());
  });

  it('never caps below 1', () => {
    // React Native reads `maxFontSizeMultiplier` below 1 as a sentinel rather than a ceiling:
    // `0` means "inherit from the parent" and `null` means "inherit the global default". A
    // fraction written here in the belief it would *shrink* text would instead switch the cap
    // off for that rank and let it scale without limit — the exact failure this file exists
    // to prevent, arriving through the fix for it.
    for (const [token, cap] of Object.entries(TYPE_SCALE_CAP)) {
      expect(cap, `${token} is capped below 1`).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('the scale compresses under magnification rather than exploding', () => {
  /** The sans ranks, largest first. The hierarchy a reader is meant to be able to rank. */
  const DESCENDING: TypeToken[] = [
    'display',
    'title',
    'heading',
    'subheading',
    'body',
    'bodySmall',
    'label',
    'caption',
    'overline',
  ];

  it('keeps every rank above the one below it at maximum scale', () => {
    // Measured on `fontSize`, not on the line box. `subheading` is 17.5/24 and `body` is
    // 15.5/23.5 — two points apart in size and half a point apart in leading, because prose
    // is set with more air than a heading is. Ranking them by line height would compare the
    // leading and conclude the hierarchy had already collapsed at 100%.
    for (let index = 0; index < DESCENDING.length - 1; index += 1) {
      const larger = DESCENDING[index]!;
      const smaller = DESCENDING[index + 1]!;

      const atRest = TYPE[larger].fontSize / TYPE[smaller].fontSize;
      const atMax =
        (TYPE[larger].fontSize * TYPE_SCALE_CAP[larger]) /
        (TYPE[smaller].fontSize * TYPE_SCALE_CAP[smaller]);

      // Compression is the intent, so the gap is allowed to narrow — `display` gives up more
      // of its lead over `title` than `caption` gives up over `overline`, and that is the
      // whole design. Collapse is not: a pair that retains less than nine tenths of its
      // resting separation is on its way to two ranks a reader cannot tell apart, which is
      // the failure `TYPE`'s own docblock calls "type stops being hierarchy and becomes
      // texture". The bottom of the scale is already close — `bodySmall` and `label` are 0.5pt
      // apart and separated by weight rather than size — so it has nothing left to give and
      // the caps there are equal.
      expect(atMax, `${larger} inverts with ${smaller} at maximum scale`).toBeGreaterThan(1);
      expect(atMax / atRest, `${larger} collapses onto ${smaller} at maximum scale`).toBeGreaterThan(0.9);
    }
  });

  it('narrows the distance between the top and the bottom of the scale', () => {
    // The reader who set Android to 2× did it because `caption` at 12pt was unreadable to
    // them. They did not ask for `display` at 72pt, which is a masthead filling the screen and
    // pushing the content it labels below the fold. So the small end must gain proportionally
    // more than the large end — which is the same thing as saying the range narrows.
    const rangeAtRest = TYPE.display.fontSize / TYPE.overline.fontSize;
    const rangeAtMax =
      (TYPE.display.fontSize * TYPE_SCALE_CAP.display) /
      (TYPE.overline.fontSize * TYPE_SCALE_CAP.overline);

    expect(rangeAtMax).toBeLessThan(rangeAtRest);
    // And not so far that the hierarchy flattens into one size, which the per-pair check
    // above would still pass with a range near 1.
    expect(rangeAtMax).toBeGreaterThan(2);
  });
});

describe('the mono ranks stay pinned to their sans partners', () => {
  /** The pairing asserted in `TYPE`'s own docblock. */
  const PAIRS: ReadonlyArray<readonly [TypeToken, TypeToken]> = [
    ['monoValue', 'body'],
    ['mono', 'label'],
    ['monoSmall', 'caption'],
    ['monoOverline', 'overline'],
  ];

  it('caps each mono rank exactly as its sans partner', () => {
    // A cap is part of a size. Capping `monoValue` at 1.75 and `body` at 1.9 would hold the
    // pair together at 100% and split it by 2.3pt at maximum scale — reintroducing the
    // baseline drift in every card that mixes a machine-read amount with the sentence
    // explaining it, which is most cards in this product, and only for the users who raised
    // the font size.
    for (const [monoToken, sansToken] of PAIRS) {
      expect(TYPE_SCALE_CAP[monoToken], `${monoToken} drifts from ${sansToken}`).toBe(
        TYPE_SCALE_CAP[sansToken],
      );
    }
  });

  it('starts from the same size, which is what makes the pairing meaningful', () => {
    // Guards the assumption the check above rests on: equal caps only keep a pair together
    // while the pair starts equal.
    for (const [monoToken, sansToken] of PAIRS) {
      expect(TYPE[monoToken].fontSize, `${monoToken} is not ${sansToken}'s size`).toBe(
        TYPE[sansToken].fontSize,
      );
    }
  });
});

describe('compact controls contain their own labels at the control ceiling', () => {
  /**
   * The boxes in the design system that are sized from their label and have no vertical padding
   * to absorb a larger one, with the rank each holds. Mirrors of the components named — see this
   * file's header on why they are copies and what that does and does not buy.
   *
   * Buttons are deliberately absent. They carry `paddingVertical` derived from their own line
   * box, so they grow with the label by design rather than containing it; the block below
   * checks that instead.
   */
  const CONTROLS: ReadonlyArray<{ name: string; box: number; token: TypeToken }> = [
    { name: 'Chip, sm pill (Chip.tsx)', box: 26, token: 'caption' },
    { name: 'Chip, md pill (Chip.tsx)', box: 32, token: 'caption' },
    { name: 'ProgressChip pill (Chip.tsx)', box: 26, token: 'caption' },
    { name: 'SegmentedControl segment (Button.tsx)', box: 40, token: 'label' },
    { name: 'UserAvatar at its default size (UserAvatar.tsx)', box: 44, token: 'label' },
  ];

  it('fits every control label inside the geometry it was drawn with', () => {
    // All but the avatar use `minHeight`, so failing this does not clip anything — it means the
    // pill silently grows into a rounded rectangle and the segmented control stops being a row
    // of equal segments. The avatar is the one genuine clip: a fixed circle with
    // `overflow: 'hidden'`.
    for (const { name, box, token } of CONTROLS) {
      expect(
        TYPE[token].lineHeight * CONTROL_SCALE_CAP,
        `${name} outgrows the geometry it was drawn with`,
      ).toBeLessThanOrEqual(box);
    }
  });

  it('is the largest tenth-step at which that is true', () => {
    // `CONTROL_SCALE_CAP`'s docblock claims 1.5 is derived rather than chosen for comfort.
    // This is that derivation: the binding control is the 26pt chip, whose height was picked
    // so a caption sits *in* the pill rather than against its edges, and which stops
    // containing its label one tenth-step up. A future re-cut of the type scale that makes
    // room for more should raise the constant and change this number with it, deliberately.
    const tightest = Math.min(
      ...CONTROLS.map(({ box, token }) => box / TYPE[token].lineHeight),
    );
    expect(CONTROL_SCALE_CAP).toBeLessThanOrEqual(tightest);
    expect(CONTROL_SCALE_CAP + 0.1).toBeGreaterThan(tightest);
  });

  it('still magnifies a control label by half', () => {
    // A ceiling is a trade against the reader, so it is worth stating the floor of the trade:
    // the smallest text in any control still gains 50%. A cap that had quietly drifted down
    // towards 1 would satisfy every other assertion in this block.
    expect(CONTROL_SCALE_CAP).toBeGreaterThanOrEqual(1.5);
  });
});

describe('a button is defined by its padding rather than by its height', () => {
  /**
   * `DIMENSIONS` in `Button.tsx`, mirrored — the height each size was drawn at and the spacing
   * step its `paddingVertical` takes — plus the rank that size's label uses.
   */
  const BUTTON_SIZES: ReadonlyArray<{
    name: string;
    drawnHeight: number;
    paddingVertical: number;
    token: TypeToken;
  }> = [
    { name: 'sm', drawnHeight: 40, paddingVertical: SPACING.sm, token: 'bodyMedium' },
    { name: 'md', drawnHeight: 48, paddingVertical: SPACING.md, token: 'subheading' },
    { name: 'lg', drawnHeight: 56, paddingVertical: SPACING.lg, token: 'subheading' },
  ];

  it('resolves to the height it was drawn at, from the padding alone', () => {
    // A button's height is `max(minHeight, lineHeight + 2 × paddingVertical)`, and it is the
    // second term that decides what a *grown* button looks like — the one holding a wrapped
    // label, or a magnified one. So the second term has to already equal the first at 100%:
    // too large and the resting button is taller than the design, too small and the first
    // magnified pixel makes it jump from 48 to 60. Neither is visible in review, because
    // nothing in this repo renders a button. This is the arithmetic instead: 24 + 12 + 12 = 48.
    for (const { name, drawnHeight, paddingVertical, token } of BUTTON_SIZES) {
      const fromPadding = TYPE[token].lineHeight + paddingVertical * 2;

      expect(fromPadding, `button ${name} is taller than it was drawn`).toBeLessThanOrEqual(
        drawnHeight,
      );
      // Half a point of slack, which is exactly what `sm` needs: `bodyMedium`'s line box is
      // 23.5 and the spacing scale has no 8.25 step, so `minHeight` rounds the last half point.
      // More slack than that and `minHeight` has stopped being a floor and gone back to being
      // the height, which is the state this whole pass exists to get out of.
      expect(
        drawnHeight - fromPadding,
        `button ${name} leans on minHeight instead of its own padding`,
      ).toBeLessThanOrEqual(0.5);
    }
  });
});

describe('the fixed boxes that are not controls', () => {
  it('fits the compact header title inside the header height', () => {
    // `ScreenHeaderBar` is the one place in the design system that keeps a fixed `height`, and
    // it has to: `LAYOUT.headerHeight` is a contract, not a measurement — the bar is absolutely
    // positioned and three screens pad their scroll content by `insets.top + headerHeight` so
    // content clears it. A bar that grew with the font scale would sit on top of the first row
    // of content on every one of them.
    //
    // What makes that safe is arithmetic rather than care, and this is the arithmetic.
    expect(maxLineHeight('subheading')).toBeLessThanOrEqual(LAYOUT.headerHeight);
  });

  it('fits a single-line field inside its resting height', () => {
    // `TextField` uses `minHeight`, so this is not a clipping check — it is a check that the
    // field a user types into does not jump to a taller box the moment they focus it at a
    // raised font scale. 50 is the resting height in `Field.tsx`.
    expect(maxLineHeight('body')).toBeLessThanOrEqual(50);
    expect(maxLineHeight('mono')).toBeLessThanOrEqual(50);
  });
});
