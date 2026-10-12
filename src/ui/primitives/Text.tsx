import React, { forwardRef, useCallback, useState } from 'react';
import {
  StyleSheet,
  useWindowDimensions,
  View,
  Text as RNText,
  type LayoutChangeEvent,
  type TextProps as RNTextProps,
  type TextStyle,
  type ViewStyle,
} from 'react-native';

import {
  FONT_FAMILY,
  measureFigure,
  TABULAR,
  TYPE,
  TYPE_SCALE_CAP,
  type TypeToken,
} from '../tokens';
import { useTheme } from '../theme';
import type { Tone } from '../tokens';

const VARIANT_DEFAULT_TONE: Record<TypeToken, Tone | 'primary' | 'secondary'> = {
  display: 'primary',
  title: 'primary',
  titleSmall: 'primary',
  heading: 'primary',
  subheading: 'primary',
  bodyLarge: 'primary',
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

const VARIANT_TABULAR: Partial<Record<TypeToken, true>> = {
  statValue: true,
  monoValue: true,
  mono: true,
  monoSmall: true,
  monoOverline: true,
};

export interface TextProps extends Omit<RNTextProps, 'style'> {
  variant?: TypeToken;

  tone?: Tone;

  colorToken?: keyof import('../tokens').ColorScheme;

  mono?: boolean;

  tabular?: boolean;

  center?: boolean;

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
    tabular,
    center = false,
    uppercase = false,
    maxFontSizeMultiplier,
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

  const fontFamily = mono ? monoFamilyFor(base.fontFamily) : base.fontFamily;

  const wantsTabular = tabular ?? (mono || VARIANT_TABULAR[variant] === true);

  return (
    <RNText
      ref={ref}
      style={[
        base,
        { fontFamily, color },
        wantsTabular && TABULAR,
        center && styles.center,
        uppercase && styles.uppercase,
        style,
      ]}

      maxFontSizeMultiplier={maxFontSizeMultiplier ?? TYPE_SCALE_CAP[variant]}
      {...rest}
    >
      {children}
    </RNText>
  );
});

function monoFamilyFor(sansFamily: string): string {
  switch (sansFamily) {
    case FONT_FAMILY.sansSemiBold:
    case FONT_FAMILY.sansBold:

    case FONT_FAMILY.sansExtraBold:
      return FONT_FAMILY.monoSemiBold;
    case FONT_FAMILY.sansMedium:
      return FONT_FAMILY.monoMedium;
    default:
      return FONT_FAMILY.monoRegular;
  }
}

const styles = StyleSheet.create({
  center: { textAlign: 'center' },
  uppercase: { textTransform: 'uppercase' },

  figureFit: { maxWidth: '100%', overflow: 'hidden' },
});

const FIGURE_MIN_RATIO = 0.72;

type FigureVariant = Extract<
  TypeToken,
  'statValue' | 'display' | 'title' | 'titleSmall' | 'monoValue' | 'mono' | 'monoSmall'
>;

export interface FigureProps extends Omit<TextProps, 'variant' | 'children' | 'numberOfLines'> {

  children: string;

  variant?: FigureVariant;

  fit?: boolean;
}

export function Figure({
  children,
  variant = 'monoValue',
  fit = false,
  style,
  ...rest
}: FigureProps) {
  const theme = useTheme();
  const [available, setAvailable] = useState<number | null>(null);
  const { fontScale } = useWindowDimensions();

  const onLayout = useCallback((event: LayoutChangeEvent) => {
    const next = Math.round(event.nativeEvent.layout.width);

    setAvailable((previous) => (previous === next ? previous : next));
  }, []);

  const base = theme.type[variant];
  const cap = TYPE_SCALE_CAP[variant];
  const scale = Math.min(fontScale, cap);

  const natural = measureFigure(children, base.fontFamily, base.fontSize * scale);

  const ratio =
    fit && available !== null && available > 0 && natural > available
      ? Math.max(FIGURE_MIN_RATIO, available / natural)
      : 1;

  const fitted: TextStyle | null =
    ratio === 1
      ? null
      : {
          fontSize: base.fontSize * ratio,
          lineHeight: base.lineHeight * ratio,

          letterSpacing: base.letterSpacing * ratio,
        };

  const content = (
    <Text
      variant={variant}
      numberOfLines={1}

      maxFontSizeMultiplier={cap}
      style={[fitted, style]}
      {...rest}
    >
      {children}
    </Text>
  );

  if (!fit) return content;

  return (
    <View onLayout={onLayout} style={styles.figureFit as ViewStyle}>
      {content}
    </View>
  );
}
