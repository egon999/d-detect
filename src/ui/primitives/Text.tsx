/**
 * Text.
 *
 * Every string in the app goes through this component. Nothing renders a bare `<Text>`
 * with an inline font, for one reason: the sans/mono split is a product guarantee (see
 * `tokens.ts`), and a single stray `<Text>` with a hard-coded family is enough to break
 * it. Routing all type through here means the guarantee holds by construction.
 *
 * `variant` names a role, not a size. `mono` overrides the family while keeping the size
 * and rhythm of the variant, which is what you want when a name that is normally prose
 * turns out to have been read from a document.
 */

import React, { forwardRef } from 'react';
import { StyleSheet, Text as RNText, type TextProps as RNTextProps } from 'react-native';

import { FONT_FAMILY, type TypeToken } from '../tokens';
import { useTheme } from '../theme';
import type { Tone } from '../tokens';

/** How a variant maps to a colour when no explicit `tone` or `color` is given. */
const VARIANT_DEFAULT_TONE: Record<TypeToken, Tone | 'primary' | 'secondary'> = {
  display: 'primary',
  title: 'primary',
  heading: 'primary',
  subheading: 'primary',
  body: 'primary',
  bodyMedium: 'primary',
  bodySmall: 'secondary',
  label: 'secondary',
  caption: 'secondary',
  overline: 'secondary',
  statValue: 'primary',
  monoValue: 'primary',
  mono: 'primary',
  monoSmall: 'secondary',
  monoOverline: 'secondary',
};

export interface TextProps extends Omit<RNTextProps, 'style'> {
  variant?: TypeToken;
  /** An explicit semantic colour. Overrides the variant's default. */
  tone?: Tone;
  /** An explicit colour token name. Overrides both `tone` and the variant default. */
  colorToken?: keyof import('../tokens').ColorScheme;
  /**
   * Force the monospace family while keeping the variant's size. Use for values that
   * came out of a document but appear inside a prose context.
   */
  mono?: boolean;
  /** Centre the text. Shortcut for the most common non-default alignment. */
  center?: boolean;
  /** Uppercase transform, for `overline` headings that are written in sentence case in code. */
  uppercase?: boolean;
  style?: RNTextProps['style'];
  children?: React.ReactNode;
}

export const Text = forwardRef<RNText, TextProps>(function Text(
  {
    variant = 'body',
    tone,
    colorToken,
    mono = false,
    center = false,
    uppercase = false,
    style,
    children,
    ...rest
  },
  ref,
) {
  const theme = useTheme();
  const base = theme.type[variant];

  const defaultTone = VARIANT_DEFAULT_TONE[variant];
  let color: string;
  if (colorToken) {
    color = theme.colors[colorToken] as string;
  } else if (tone) {
    color = theme.tone(tone).fg;
  } else if (defaultTone === 'primary') {
    color = theme.colors.text;
  } else if (defaultTone === 'secondary') {
    color = theme.colors.textSecondary;
  } else {
    color = theme.tone(defaultTone).fg;
  }

  // Only the family is swapped, never the size — a monospace face at the same nominal
  // size has a different x-height, and re-scaling here would break the vertical rhythm
  // of every card that mixes the two.
  const fontFamily = mono ? monoFamilyFor(base.fontFamily) : base.fontFamily;

  return (
    <RNText
      ref={ref}
      style={[
        base,
        { fontFamily, color },
        center && styles.center,
        uppercase && styles.uppercase,
        style,
      ]}
      {...rest}
    >
      {children}
    </RNText>
  );
});

/** Maps a sans face to its mono counterpart at the same weight, preserving emphasis. */
function monoFamilyFor(sansFamily: string): string {
  switch (sansFamily) {
    case FONT_FAMILY.sansSemiBold:
    case FONT_FAMILY.sansBold:
    // Plex Mono stops at SemiBold, so ExtraBold lands there too. The alternative is
    // letting RN synthesise a heavier weight, which smears the stems at small sizes.
    case FONT_FAMILY.sansExtraBold:
      return FONT_FAMILY.monoSemiBold;
    case FONT_FAMILY.sansMedium:
      return FONT_FAMILY.monoMedium;
    default:
      return FONT_FAMILY.monoRegular;
  }
}

/** Mono-family text at an explicit token. Thin wrapper for table-like layouts. */
export function MonoText({ variant = 'mono', ...rest }: TextProps) {
  return <Text variant={variant} mono {...rest} />;
}

const styles = StyleSheet.create({
  center: { textAlign: 'center' },
  uppercase: { textTransform: 'uppercase' },
});
