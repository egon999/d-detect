/**
 * Icons.
 *
 * The app uses one icon family throughout, Material Community Icons, because it is the
 * only set bundled with `@expo/vector-icons` that covers every domain concept this app
 * needs (evidence, relationships, provenance) without reaching for a second family.
 *
 * `IconName` is derived from the font's own glyph map rather than declared as `string`.
 * That is the whole reason this wrapper exists: every icon name in `semantics.ts` is
 * then checked by the compiler, so a typo like `x-circle` is a build failure rather than
 * a blank square on a user's screen.
 */

import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import React from 'react';
import type { ComponentProps } from 'react';

type GlyphProps = ComponentProps<typeof MaterialCommunityIcons>;

/** Every valid glyph name in the bundled font. */
export type IconName = GlyphProps['name'];

export interface IconProps {
  name: IconName;
  size?: number;
  color: string;
  /** Reduces opacity rather than changing colour, for disabled affordances. */
  disabled?: boolean;
}

/**
 * Defaults to `size={18}`: the app's dense lists are the common case, and an 18px glyph
 * sits correctly against 13–15px text. Pass an explicit size for anything larger.
 */
export function Icon({ name, size = 18, color, disabled = false }: IconProps) {
  return (
    <MaterialCommunityIcons
      name={name}
      size={size}
      color={color}
      style={disabled ? { opacity: 0.4 } : undefined}
      // Icon glyphs are decorative: the adjacent label carries the meaning. Marking them
      // accessible would make a screen reader announce every row twice.
      accessible={false}
      importantForAccessibility="no"
    />
  );
}

export { MaterialCommunityIcons };
