import { describe, expect, it } from 'vitest';
import { childLayoutStyleKeys, pressableLayoutWarning } from '@ui/primitives/pressable-style';

/**
 * The trap that made three screens lay out one item.
 *
 * `Pressable` applies the caller's `style` to the touch target and puts the children in an
 * animated wrapper one level down, so a `flexDirection` written in `style` arranges that
 * wrapper alone. No type catches it — a `StyleSheet.create` reference is not a fresh literal,
 * so excess-property checking never applies — and the result looks plausible enough to survive
 * review. Three agents diagnosed it independently before the prop and this check existed.
 *
 * The component's own use of this is a `__DEV__`-only `console.warn`, which the test
 * environment defines as false, so the detection is tested here as the pure function it is.
 */
describe('finding child-layout styles in the wrong place', () => {
  it('names each property that would arrange the wrapper instead of the children', () => {
    expect(childLayoutStyleKeys({ flexDirection: 'row', gap: 12 })).toEqual(['flexDirection', 'gap']);
    expect(childLayoutStyleKeys({ flexWrap: 'wrap' })).toEqual(['flexWrap']);
    expect(childLayoutStyleKeys({ rowGap: 4, columnGap: 8 })).toEqual(['columnGap', 'rowGap']);
    expect(childLayoutStyleKeys({ alignItems: 'center', justifyContent: 'space-between' })).toEqual([
      'alignItems',
      'justifyContent',
    ]);
  });

  it('says nothing about a style that only describes the box itself', () => {
    // The overwhelming majority of the app's call sites. A false positive here would print a
    // warning behind all 48 buttons and teach everyone to ignore the console.
    expect(
      childLayoutStyleKeys({
        paddingHorizontal: 16,
        paddingVertical: 12,
        backgroundColor: '#0E1836',
        borderRadius: 12,
        borderWidth: 1,
        minHeight: 44,
        width: '100%',
        opacity: 0.6,
        overflow: 'hidden',
      }),
    ).toEqual([]);
  });

  it('walks the array and conditional shapes call sites actually use', () => {
    // `style={[styles.row, active && styles.active]}` is the normal way this is written, and
    // it is the shape a naive `'flexDirection' in style` check misses entirely.
    expect(childLayoutStyleKeys([{ padding: 8 }, { flexDirection: 'row' }])).toEqual(['flexDirection']);
    expect(childLayoutStyleKeys([{ padding: 8 }, false && { gap: 4 }])).toEqual([]);
    expect(childLayoutStyleKeys([{ padding: 8 }, true && { gap: 4 }])).toEqual(['gap']);
    expect(childLayoutStyleKeys([[{ gap: 4 }], [[{ flexWrap: 'wrap' }]]])).toEqual(['flexWrap', 'gap']);
  });

  it('reports nothing for the absent, empty and non-object cases', () => {
    expect(childLayoutStyleKeys(undefined)).toEqual([]);
    expect(childLayoutStyleKeys(null)).toEqual([]);
    expect(childLayoutStyleKeys(false)).toEqual([]);
    expect(childLayoutStyleKeys({})).toEqual([]);
    expect(childLayoutStyleKeys([])).toEqual([]);
    // An older `StyleSheet.create` handed back opaque numbers. Nothing can be read off one, so
    // it is skipped rather than crashing the component every tappable element is behind.
    expect(childLayoutStyleKeys(7 as never)).toEqual([]);
  });

  it('does not treat an explicitly undefined property as set', () => {
    // `{ flexDirection: condition ? 'row' : undefined }` is a reset, not a row.
    expect(childLayoutStyleKeys({ flexDirection: undefined, gap: undefined })).toEqual([]);
  });

  it('reports the same keys in the same order however the style was assembled', () => {
    // The warning text is built from this, and a message whose wording shuffles between
    // renders is one a reader stops reading.
    expect(childLayoutStyleKeys({ gap: 8, flexDirection: 'row' })).toEqual(
      childLayoutStyleKeys([{ flexDirection: 'row' }, { gap: 8 }]),
    );
  });

  it('writes a warning that names the property and where it belongs', () => {
    const warning = pressableLayoutWarning(['flexDirection', 'gap']);
    expect(warning).toContain('flexDirection, gap');
    expect(warning).toContain('contentStyle');
    // The reason, not just the instruction: the next person needs to know why it did nothing.
    expect(warning).toMatch(/children will stack/);
  });
});
