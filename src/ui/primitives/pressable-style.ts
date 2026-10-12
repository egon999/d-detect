import type { StyleProp, ViewStyle } from 'react-native';

const CHILD_LAYOUT_KEYS = [
  'flexDirection',
  'flexWrap',
  'gap',
  'rowGap',
  'columnGap',
  'alignItems',
  'justifyContent',
] as const satisfies readonly (keyof ViewStyle)[];

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

  return [...found].sort();
}

export function pressableLayoutWarning(keys: string[]): string {
  return (
    `Pressable received ${keys.join(', ')} in "style". Those arrange the children of the node ` +
    'they are on, and "style" is applied to the touch target, whose only child is the press ' +
    'wrapper — so they will lay out one item and the children will stack. Pass them as ' +
    '"contentStyle" instead, which is applied to the node that holds the children.'
  );
}
