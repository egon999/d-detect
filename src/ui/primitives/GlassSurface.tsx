import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import React from 'react';
import { StyleSheet, View, type StyleProp, type ViewProps, type ViewStyle } from 'react-native';

import { BORDER_WIDTH, type ElevationToken } from '../tokens';
import { useTheme } from '../theme';

export interface GlassSurfaceProps extends ViewProps {
  children?: React.ReactNode;

  variant?: 'panel' | 'hero';

  elevation?: ElevationToken;

  radius?: keyof ReturnType<typeof useTheme>['radius'];

  padding?: keyof ReturnType<typeof useTheme>['spacing'];

  translucent?: boolean;

  blurred?: boolean;

  tone?: keyof ReturnType<typeof useTheme>['colors']['tones'];

  bordered?: boolean;
  style?: StyleProp<ViewStyle>;

  contentStyle?: StyleProp<ViewStyle>;
}

export function GlassSurface({
  children,
  variant = 'panel',
  elevation = 'low',
  radius = 'lg',
  padding,
  translucent = true,
  blurred = false,
  tone,
  bordered = true,
  style,
  contentStyle,
  ...rest
}: GlassSurfaceProps) {
  const theme = useTheme();
  const { glass } = theme.colors;
  const borderRadius = theme.radius[radius];
  const tonePalette = tone ? theme.tone(tone) : null;

  const sheen = variant === 'hero' ? glass.sheenStrong : glass.sheen;

  const outerBorder = tonePalette ? tonePalette.border : glass.border;

  const baseFill = translucent
    ? variant === 'hero'
      ? glass.fillStrong
      : glass.fill
    : theme.colors.surface;

  return (
    <View
      style={[
        {
          borderRadius,
          backgroundColor: blurred ? 'transparent' : baseFill,
          borderWidth: bordered ? BORDER_WIDTH.hairline : 0,
          borderColor: outerBorder,

          overflow: 'hidden',
        },
        theme.elevation[elevation],
        style,
      ]}
      {...rest}
    >
      {blurred ? (
        <BlurView
          intensity={glass.blurIntensity}
          tint={glass.blurTint}
          style={StyleSheet.absoluteFill}
          pointerEvents="none"
        />
      ) : null}

      {}
      <LinearGradient
        colors={sheen}
        start={{ x: 0.5, y: 0 }}
        end={{ x: 0.5, y: 1 }}
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
      />

      {}
      {tonePalette ? (
        <View
          style={[StyleSheet.absoluteFill, { backgroundColor: tonePalette.bg }]}
          pointerEvents="none"
        />
      ) : null}

      {}
      <View
        style={[
          StyleSheet.absoluteFill,
          styles.innerBorder,
          { borderRadius: Math.max(0, borderRadius - 1), borderColor: glass.innerBorder },
        ]}
        pointerEvents="none"
      />

      {}
      <View
        style={[
          styles.highlight,
          {
            left: borderRadius * 0.5,
            right: borderRadius * 0.5,
            backgroundColor: glass.highlight,
            opacity: variant === 'hero' ? 1 : 0.66,
          },
        ]}
        pointerEvents="none"
      />

      <View style={[padding ? { padding: theme.spacing[padding] } : null, contentStyle]}>
        {children}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  innerBorder: { borderWidth: BORDER_WIDTH.hairline, margin: 1 },
  highlight: {
    position: 'absolute',
    top: 0,

    height: 1,
  },
});
