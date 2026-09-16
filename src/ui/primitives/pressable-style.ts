import type { StyleProp, ViewStyle } from 'react-native';

/**
 * The style properties that arrange a box's *children* rather than the box.
 *
 * Everything else in a `ViewStyle` — padding, background, border, radius, width — describes
 * the box itself and behaves the same wherever in a one-child chain it is applied. These
 * seven do not: they are read by the flex algorithm against the children of the node that
 * carries them, so putting them one level too high is a silent no-op rather than an error.
 *
 * `alignItems` and `justifyContent` are in the list even though they are also meaningful on a
 * single-child wrapper, because a caller writing `flexDirection: 'row'` almost always writes
 * one of them in the same object and would otherwise be told about half its problem.
 */
const CHILD_LAYOUT_KEYS = [
  'flexDirection',
  'flexWrap',
  'gap',
  'rowGap',
  'columnGap',
  'alignItems',
  'justifyContent',
] as const satisfies readonly (keyof ViewStyle)[];

/**
 * Which child-arranging properties a style sets, if any.
 *
 * ## The bug this exists to make loud
 *
 * `Pressable` renders two nodes: the `RNPressable` that takes the touch, and one `Animated.View`
 * inside it that carries the press transform and holds the children. The caller's `style` goes
 * on the outer node. So a call site writing
 *
 * ```tsx
 * <Pressable style={{ flexDirection: 'row', gap: 12 }}>
 *   <IconTile /><Text>Title</Text><Chevron />
 * </Pressable>
 * ```
 *
 * lays out a row of exactly one item — the animated wrapper — while the icon, the title and
 * the chevron stack in a column inside it. Nothing warns, nothing throws, and the result is a
 * plausible-looking layout, so it survives review. Three separate agents working on different
 * screens hit this independently, in `evidence-row.tsx`, `case-card.tsx` and a third file, and
 * each diagnosed it from scratch before working around it.
 *
 * A type could not catch it: a `StyleSheet.create` reference is not a fresh object literal, so
 * excess-property checking does not apply to it, and that is how most of these are written.
 * A runtime check is what is left, and it is enough — the person who needs the message is
 * looking at the broken layout on a dev build at the moment it fires.
 *
 * Returned as the offending keys rather than a boolean so the warning can name them, and kept
 * pure and in its own module so it is testable without rendering anything. Arrays are walked
 * because `style={[styles.row, active && styles.rowActive]}` is the normal call shape; falsy
 * entries and the opaque numbers an older `StyleSheet` could return are skipped.
 */
export function childLayoutStyleKeys(style: StyleProp<ViewStyle>): string[] {
  const found = new Set<string>();

  const walk = (value: unknown): void => {
    if (!value) return;
    if (Array.isArray(value)) {
      for (const entry of value) walk(entry);
      return;
    }
    if (typeof value !== 'object') return;
    for (const key of CHILD_LAYOUT_KEYS) {
      if ((value as Record<string, unknown>)[key] !== undefined) found.add(key);
    }
  };

  walk(style);
  // Sorted so the warning text is stable between renders and between machines; an unstable
  // message is one a reader learns to skim past.
  return [...found].sort();
}

/** The dev-only warning `Pressable` prints when its `style` would arrange nothing. */
export function pressableLayoutWarning(keys: string[]): string {
  return (
    `Pressable received ${keys.join(', ')} in "style". Those arrange the children of the node ` +
    'they are on, and "style" is applied to the touch target, whose only child is the press ' +
    'wrapper — so they will lay out one item and the children will stack. Pass them as ' +
    '"contentStyle" instead, which is applied to the node that holds the children.'
  );
}
