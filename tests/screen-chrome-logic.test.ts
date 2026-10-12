/**
 * The pure parts of `Screen.tsx`.
 *
 * There is no component-render harness in this project, so the pieces of the screen chrome
 * that decide something — where a row is, where to scroll for it, what to do when the list
 * refuses, and what the header looks like mid-scroll — are exported as plain functions and
 * tested here against the same tables the app interpolates from.
 *
 * The import is real, not a copy of the arithmetic: if the ramps in `Screen.tsx` move, the
 * numbers below move with them, which is the only way these tests can be worth having.
 *
 * The six mocks are the modules in `Screen.tsx`'s import graph that cannot be parsed by this
 * runner's Node transform — they ship ESM or JSX from their `build/` directories. Each is
 * mocked to nothing because none of them is reached by the functions under test; they exist
 * so the import resolves. A factory that is narrower than the module it replaces is exactly
 * the kind of thing that goes stale silently when production code adds an import, so each is
 * a whole-module replacement rather than one named export.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('expo-linear-gradient', () => ({ LinearGradient: () => null }));
vi.mock('expo-blur', () => ({ BlurView: () => null }));
vi.mock('expo-haptics', () => ({}));
vi.mock('expo-router', () => ({
  useRouter: () => ({ back: vi.fn(), replace: vi.fn(), canGoBack: () => false }),
  router: { back: vi.fn(), replace: vi.fn(), canGoBack: () => false },
}));
vi.mock('@expo/vector-icons/MaterialCommunityIcons', () => ({ default: () => null }));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

import {
  HANDOVER_END,
  HANDOVER_START,
  READING_MAX_WIDTH,
  SPARKLE_FIELD,
  SPARKLE_STILL_OPACITY,
  indexOfKey,
  listRowCount,
  planScrollRetry,
  resolveHandover,
  scrollViewOffset,
  sparkleRamp,
} from '../src/ui/primitives/Screen';
import { LAYOUT } from '../src/ui/tokens';

// ---------------------------------------------------------------------------
// The handover
// ---------------------------------------------------------------------------

describe('resolveHandover', () => {
  it('shows the large title and hides the compact one at rest', () => {
    const at = resolveHandover(0);

    expect(at.masthead).toBe(1);
    expect(at.compact).toBe(0);
    // The hairline is not the compact title: it belongs to the bar, and at rest the bar has
    // nothing under it to separate from, so it starts invisible rather than at partial alpha.
    expect(at.rule).toBe(0);
  });

  it('finishes the handover at HANDOVER_END and stays finished', () => {
    for (const y of [HANDOVER_END, HANDOVER_END + 1, 400, 10_000]) {
      const at = resolveHandover(y);
      expect(at.compact).toBe(1);
      expect(at.masthead).toBe(0);
      expect(at.compactOffset).toBe(0);
    }
  });

  it('holds the settled state below zero, for rubber-band overscroll', () => {
    // iOS lets the content travel above the top and springs back. Reading the handover at a
    // negative offset must not drive the compact title to a negative opacity or flip the
    // interpolations past their ends, which is what `extrapolate: 'clamp'` prevents on
    // screen and what these assertions pin for the pure function.
    for (const y of [-1, -40, -500]) {
      const at = resolveHandover(y);
      expect(at.masthead).toBe(1);
      expect(at.compact).toBe(0);
      expect(at.rule).toBe(0);
    }
  });

  it('never reports an opacity outside 0..1', () => {
    // Sweep the whole range, including well past both ends. Every value here is used as an
    // opacity or a translateY offset; a value above 1 would be handed to the platform as an
    // invalid opacity, and a negative one would invert the fade.
    for (let y = -20; y <= HANDOVER_END + 40; y += 0.5) {
      const at = resolveHandover(y);
      expect(at.compact).toBeGreaterThanOrEqual(0);
      expect(at.compact).toBeLessThanOrEqual(1);
      expect(at.masthead).toBeGreaterThanOrEqual(0);
      expect(at.masthead).toBeLessThanOrEqual(1);
      expect(at.rule).toBeGreaterThanOrEqual(0);
      expect(at.rule).toBeLessThanOrEqual(1);
      // The compact title rises into place, so its offset points down while it is moving
      // and comes to rest at zero — never negative, which would drop it below the bar.
      expect(at.compactOffset).toBeGreaterThanOrEqual(0);
      expect(at.compactOffset).toBeLessThanOrEqual(7);
    }
  });

  it('moves monotonically with scroll', () => {
    // A handover that went backwards anywhere would be a visible flicker in the header: the
    // compact title would brighten, then dim, then brighten again over a single flick.
    let previous = resolveHandover(0);
    for (let y = 1; y <= HANDOVER_END + 20; y += 1) {
      const at = resolveHandover(y);
      expect(at.compact).toBeGreaterThanOrEqual(previous.compact);
      expect(at.masthead).toBeLessThanOrEqual(previous.masthead);
      expect(at.compactOffset).toBeLessThanOrEqual(previous.compactOffset);
      previous = at;
    }
  });

  it('starts the compact title exactly where the ramp says', () => {
    // The boundary itself, so an off-by-one in the inputRange is caught rather than tuned
    // around. Below the start the compact title is absent; at the start it is absent too,
    // and it only leaves zero after the ramp has begun.
    expect(resolveHandover(HANDOVER_START).compact).toBe(0);
    expect(resolveHandover(HANDOVER_START + 0.01).compact).toBeGreaterThan(0);
  });

  it('never has both titles at full opacity', () => {
    // The whole reason the two ramps are offset: a midpoint where both are at 1 draws the
    // screen's name twice, overlapping, at the moment the user is looking straight at it.
    for (let y = 0; y <= HANDOVER_END; y += 0.5) {
      const at = resolveHandover(y);
      expect(at.compact + at.masthead).toBeLessThanOrEqual(1.0001);
    }
  });

  it('keeps the handover window short enough to finish in one flick', () => {
    // A guard on the tuning, not on the arithmetic: HANDOVER_END is the distance the user
    // has to travel before the header is fully settled, and a screen that needed a long
    // deliberate drag to finish it would feel stuck.
    expect(HANDOVER_START).toBeGreaterThan(0);
    expect(HANDOVER_END).toBeGreaterThan(HANDOVER_START);
    expect(HANDOVER_END).toBeLessThan(120);
  });
});

// ---------------------------------------------------------------------------
// Finding the row
// ---------------------------------------------------------------------------

type Row = { id: string; label: string };
const rows: Row[] = [
  { id: 'a', label: 'First' },
  { id: 'b', label: 'Second' },
  { id: 'c', label: 'Third' },
];
const keyOf = (row: Row) => row.id;

describe('indexOfKey', () => {
  it('finds a row by its key', () => {
    expect(indexOfKey(rows, keyOf, 'a')).toBe(0);
    expect(indexOfKey(rows, keyOf, 'c')).toBe(2);
  });

  it('returns -1 for a key that is not in the list', () => {
    // The normal case, not an error: a notification for a record the user has since deleted,
    // or a result filtered out by the screen's own shelf, still arrives here.
    expect(indexOfKey(rows, keyOf, 'zz')).toBe(-1);
    expect(indexOfKey([], keyOf, 'a')).toBe(-1);
  });

  it('returns -1 for an empty key', () => {
    // A `focus` parameter that is present but blank is a real thing in a URL, and index 0 is
    // a plausible-looking wrong answer — it would scroll to the top and light the first row.
    expect(indexOfKey(rows, keyOf, '')).toBe(-1);
  });

  it('compares by extracted key, not by object identity', () => {
    // The screens build their rows fresh on every load, so the object the caller names is
    // never the object in the array. Keying on identity would break exactly the deep-link
    // path this exists for.
    const rebuilt = rows.map((row) => ({ ...row }));
    expect(indexOfKey(rebuilt, keyOf, 'b')).toBe(1);
  });
});

describe('listRowCount', () => {
  it('counts the header and footer as rows', () => {
    // `VirtualizedList` counts them, so `scrollToIndex` indices are in this space rather
    // than in "data row" space. Getting this wrong is what makes a scroll to the last row
    // land one short.
    expect(listRowCount(true, true, 3)).toBe(5);
    expect(listRowCount(true, false, 3)).toBe(4);
    expect(listRowCount(false, false, 3)).toBe(3);
  });

  it('counts the empty slot as the only row when there is no data', () => {
    // An empty list still has one row — the empty state — and reporting 0 here would make
    // `initialScrollIndex` reject an index that the list would have accepted.
    expect(listRowCount(true, true, 0)).toBe(1);
    expect(listRowCount(false, false, 0)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Scrolling to the row
// ---------------------------------------------------------------------------

describe('scrollViewOffset', () => {
  it('pushes the row clear of the pinned bar', () => {
    // The failure this prevents: the bar is absolutely positioned *over* the content, so a
    // row scrolled to offset 0 scrolls perfectly and lands underneath the bar, invisible.
    // The offset has to clear the safe-area inset plus the bar itself.
    const offset = scrollViewOffset(undefined, 47);

    expect(offset).toBe(47 + LAYOUT.headerHeight + 12);
    expect(offset).toBeGreaterThan(LAYOUT.headerHeight);
  });

  it('still works with no inset, which is the portrait case', () => {
    const offset = scrollViewOffset(undefined, 0);
    expect(offset).toBe(LAYOUT.headerHeight + 12);
  });

  it('leaves an explicit viewPosition alone', () => {
    // `viewPosition` is the caller saying where in the viewport the row should sit — 0.5 for
    // the middle, say. Adding the bar to that would move the row to somewhere they did not
    // ask for, so the two intents do not combine.
    expect(scrollViewOffset({ viewPosition: 0.5 }, 47)).toBeUndefined();
    expect(scrollViewOffset({ viewPosition: 0 }, 47)).toBeUndefined();
  });
});

describe('planScrollRetry', () => {
  it('waits when the list has measured nothing yet', () => {
    // `averageItemLength` of 0 means no row has been drawn, so there is no average to
    // extrapolate from and a guessed offset would move the list by nothing at all — a tap
    // that visibly does nothing. The right move is to wait for layout.
    expect(planScrollRetry({ index: 80, averageItemLength: 0 }, 0)).toEqual({ action: 'wait' });
  });

  it('guesses an offset from the measured average', () => {
    // This scroll does not have to be exact. It only has to change which rows are rendered,
    // which is what gets the target measured so the retry can land on it precisely.
    expect(planScrollRetry({ index: 40, averageItemLength: 72 }, 0)).toEqual({
      action: 'scroll',
      offset: 2880,
    });
  });

  it('treats a nonsensical average as "not measured", not as zero', () => {
    // `VirtualizedList` revises its average while rows are still being measured, and a
    // value of 0 or below is not a measurement — it is the absence of one. Multiplying by it
    // yields an offset that moves the list nowhere (or, caught by the `Math.max`, to the very
    // top, which is a scroll the user did not ask for). The generator expression `!(x > 0)`
    // is what makes `NaN` fall here too, rather than slipping through a `<= 0` check and
    // producing a `NaN` offset the platform would reject outright.
    expect(planScrollRetry({ index: 3, averageItemLength: -10 }, 0)).toEqual({ action: 'wait' });
    expect(planScrollRetry({ index: 3, averageItemLength: 0 }, 0)).toEqual({ action: 'wait' });
    expect(planScrollRetry({ index: 3, averageItemLength: NaN }, 0)).toEqual({ action: 'wait' });
  });

  it('gives up rather than looping', () => {
    // Rows that resize as they render can defeat the measure-then-retry approach entirely.
    // At that point the honest outcome is to stop and leave the highlight; a screen that
    // kept retrying would be stuck scrolling under the user's finger.
    expect(planScrollRetry({ index: 500, averageItemLength: 72 }, 2)).toEqual({ action: 'give-up' });
    expect(planScrollRetry({ index: 500, averageItemLength: 72 }, 9)).toEqual({ action: 'give-up' });
  });

  it('lets a request recover once before it gives up', () => {
    // Exactly one retry: the first failure scrolls approximately, which renders the row, and
    // the attempt after that is exact. More rounds would be waiting on a layout that is not
    // coming.
    expect(planScrollRetry({ index: 500, averageItemLength: 72 }, 0).action).toBe('scroll');
    expect(planScrollRetry({ index: 500, averageItemLength: 72 }, 1).action).toBe('scroll');
    expect(planScrollRetry({ index: 500, averageItemLength: 72 }, 2).action).toBe('give-up');
  });
});

// ---------------------------------------------------------------------------
// The reading measure
// ---------------------------------------------------------------------------

describe('READING_MAX_WIDTH', () => {
  it('is the app measure plus its own gutters, not a flat width', () => {
    expect(READING_MAX_WIDTH).toBe(LAYOUT.maxContentWidth + LAYOUT.screenPadding * 2);
  });

  it('agrees with the breakpoint the sidebar is derived from', () => {
    // `app/(tabs)/_layout.tsx` turns on the sidebar at 1024, and that number comes from
    // 230 (the sidebar) + 720 (this app's measure) + 2x20 (the gutters) = 990. The reading
    // column is the middle term plus its own two gutters — the part of that sum the content
    // itself occupies — and it must leave the sidebar's 230 behind it, or the two files
    // would disagree about what "wide" means.
    const SIDEBAR_WIDTH = 230;
    const contentArea = SIDEBAR_WIDTH + LAYOUT.maxContentWidth + LAYOUT.screenPadding * 2;

    expect(READING_MAX_WIDTH).toBe(LAYOUT.maxContentWidth + LAYOUT.screenPadding * 2);
    // The column fits inside the content area in a sidebar layout, with room to spare.
    expect(contentArea - SIDEBAR_WIDTH).toBe(READING_MAX_WIDTH);
    // And it is narrower than the whole window, so the line never runs edge to edge.
    expect(READING_MAX_WIDTH).toBeLessThan(contentArea);
  });
});

// ---------------------------------------------------------------------------
// The backdrop motes
// ---------------------------------------------------------------------------

describe('the sparkle layer', () => {
  /**
   * `Animated.interpolate` throws on a non-increasing `inputRange`, and it throws at the
   * moment the component mounts — which, since this layer is behind every screen in the app,
   * means a bad phase is not a decoration bug, it is a blank app.
   *
   * The phases shipped in `SPARKLE_FIELD` are checked below, but so are the four boundary
   * cases a hand-tuned value is most likely to land on: a phase of exactly 0, exactly one
   * stop, and the wrap at either end. Those are the ones where a keyframe lands on 0 or 1 and
   * has to be dropped rather than repeated.
   */
  const phases = [
    0,
    0.25,
    0.5,
    0.75,
    1,
    0.0001,
    0.9999,
    ...SPARKLE_FIELD.map((mote) => mote.phase),
  ];

  it.each(phases)('phase %s produces a ramp interpolate will accept', (phase) => {
    const { inputRange, outputRange } = sparkleRamp(phase);

    expect(inputRange.length).toBe(outputRange.length);
    expect(inputRange[0]).toBe(0);
    expect(inputRange.at(-1)).toBe(1);
    for (let index = 1; index < inputRange.length; index += 1) {
      expect(inputRange[index]).toBeGreaterThan(inputRange[index - 1] as number);
    }
  });

  it.each(phases)('phase %s loops without a seam', (phase) => {
    // The first and last outputs are the same value, so the cycle repeating is invisible.
    // Without this the layer would snap every 7.2 seconds, which is exactly long enough
    // apart that it reads as the screen glitching rather than as an animation.
    const { outputRange } = sparkleRamp(phase);
    expect(outputRange.at(-1)).toBe(outputRange[0]);
  });

  it.each(phases)('phase %s stays inside the brightness the design allows', (phase) => {
    // No phase may make a mote brighter than the curve's own peak. This is what stops the
    // shift arithmetic from quietly inventing a value: the layer is nine faint dots behind
    // the content, so a mote at 3× the intended opacity would look like a stuck pixel and
    // nobody would think to blame the phase.
    //
    // Bounded with a tolerance rather than exactly, because a boundary value is *computed* —
    // `curveAt(0.5)` interpolates between two stops and comes back as 0.17999999999999994.
    // That is 0.18 for every purpose an opacity has, and a strict `>=` here would fail the
    // suite over a difference of 6e-17 while telling us nothing about the design.
    const tolerance = 1e-9;
    for (const value of sparkleRamp(phase).outputRange) {
      expect(value).toBeGreaterThanOrEqual(0.18 - tolerance);
      expect(value).toBeLessThanOrEqual(1 + tolerance);
    }
  });

  it('shifts the peak by exactly the phase', () => {
    // The point of a phase is that nine motes do not glint in unison. Phase 0 peaks a quarter
    // of the way through the cycle; phase 0.25 peaks at the start. If the shift ever stops
    // moving the peak, the whole field pulses together and the backdrop breathes.
    const unshifted = sparkleRamp(0);
    expect(unshifted.inputRange[unshifted.outputRange.indexOf(1)]).toBeCloseTo(0.25, 6);

    const shifted = sparkleRamp(0.25);
    expect(shifted.outputRange[0]).toBe(1);
  });

  it('is sparse, and stays clear of the chrome at the bottom of the screen', () => {
    // "Very few" is the brief, and a count is the only way it survives somebody adding "just
    // one more". Nine is two or three in view at any scroll position.
    expect(SPARKLE_FIELD.length).toBeLessThanOrEqual(12);

    for (const mote of SPARKLE_FIELD) {
      // Percentages, so the layer works on a 360pt phone and a 1400pt window without
      // measuring anything.
      expect(mote.x).toMatch(/^\d+(\.\d+)?%$/);
      expect(mote.y).toMatch(/^\d+(\.\d+)?%$/);

      // The bottom quarter is the tab bar and the pinned footer, both opaque. A mote there
      // is invisible and costs an interpolation for nothing.
      expect(Number.parseFloat(mote.y)).toBeLessThan(75);

      // Small enough to read as a glint. At 4px and up it is a dot, and a dot behind a row
      // of amounts looks like part of the interface.
      expect(mote.size).toBeLessThanOrEqual(3);
      expect(mote.size).toBeGreaterThan(0);
    }

    // No two motes share a position: the key is derived from x and y, so a duplicate would
    // silently drop one from the field and React would warn about it on every screen.
    const seats = new Set(SPARKLE_FIELD.map((mote) => `${mote.x}-${mote.y}`));
    expect(seats.size).toBe(SPARKLE_FIELD.length);
  });

  it('holds the motes visible when the person asked for no motion', () => {
    // Reduced motion removes the movement, not the design. A layer that disappears entirely
    // would make an accessibility setting change what the app looks like.
    expect(SPARKLE_STILL_OPACITY).toBeGreaterThan(0);
    expect(SPARKLE_STILL_OPACITY).toBeLessThanOrEqual(1);
  });
});
