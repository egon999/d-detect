import * as Haptics from 'expo-haptics';
import { LinearGradient } from 'expo-linear-gradient';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Animated,
  Pressable as RNPressable,
  StyleSheet,
  View,
  type PressableProps as RNPressableProps,
  type StyleProp,
  type ViewProps,
  type ViewStyle,
} from 'react-native';

import { Icon, type IconName } from '../icon';
import { childLayoutStyleKeys, pressableLayoutWarning } from './pressable-style';
import {
  BORDER_WIDTH,
  FOCUS_RING,
  HIT_TARGET,
  LAYOUT,
  SPACING,
  type ElevationToken,
  type GradientStops,
  type Tone,
} from '../tokens';
import { useTheme } from '../theme';
import { useReducedMotion } from './Motion';
import { GlassSurface } from './GlassSurface';

export interface SurfaceProps extends ViewProps {

  variant?: 'surface' | 'raised' | 'sunken' | 'accent';
  elevation?: ElevationToken;

  bordered?: boolean;

  radius?: keyof ReturnType<typeof useTheme>['radius'];

  padding?: keyof ReturnType<typeof useTheme>['spacing'];

  glass?: boolean;

  glassVariant?: 'panel' | 'hero';

  translucent?: boolean;
  style?: StyleProp<ViewStyle>;
  children?: React.ReactNode;
}

export function Surface({
  variant = 'surface',
  elevation = 'low',
  bordered,
  radius = 'lg',
  padding,
  glass = false,
  glassVariant = 'panel',
  translucent = false,
  style,
  children,
  ...rest
}: SurfaceProps) {
  const theme = useTheme();

  if (glass) {
    return (
      <GlassSurface
        variant={glassVariant}
        elevation={variant === 'sunken' ? 'none' : elevation}
        radius={radius}
        padding={padding}
        translucent={translucent}
        bordered={bordered ?? true}
        tone={variant === 'accent' ? 'accent' : undefined}
        style={style}
        {...rest}
      >
        {children}
      </GlassSurface>
    );
  }

  const backgroundColor =
    variant === 'raised'
      ? theme.colors.surfaceRaised
      : variant === 'sunken'
        ? theme.colors.surfaceSunken
        : variant === 'accent'
          ? theme.colors.accentSurface
          : theme.colors.surface;

  const showBorder = bordered ?? true;

  return (
    <View
      style={[
        {
          backgroundColor,
          borderRadius: theme.radius[radius],
          borderWidth: showBorder ? BORDER_WIDTH.hairline : 0,
          borderColor: variant === 'accent' ? theme.colors.tones.accent.border : theme.colors.border,
          padding: padding ? theme.spacing[padding] : undefined,
        },
        style,
      ]}
      {...rest}
    >
      {children}
    </View>
  );
}

export interface PressableProps extends Omit<RNPressableProps, 'style' | 'children'> {

  style?: StyleProp<ViewStyle>;

  contentStyle?: StyleProp<ViewStyle>;
  children?: React.ReactNode;

  pressScale?: number;

  dimOnPress?: boolean;

  haptic?: boolean;

  disabled?: boolean;

  noDisabledOpacity?: boolean;

  noFeedback?: boolean;

  focusRingRadius?: number;

  noFocusRing?: boolean;
}

export function Pressable({
  style,
  contentStyle,
  children,
  pressScale = 0.975,
  dimOnPress = false,
  haptic = false,
  disabled = false,
  noDisabledOpacity = false,
  noFeedback = false,
  focusRingRadius,
  noFocusRing = false,
  onPressIn,
  onPressOut,
  onPress,
  onFocus,
  onBlur,
  onLayout,
  ...rest
}: PressableProps) {
  const theme = useTheme();
  const reduced = useReducedMotion() === true;

  const scales = pressScale !== 1 && pressScale > 0 && !reduced;
  const dims = dimOnPress || (reduced && pressScale !== 1 && pressScale > 0);

  useEffect(() => {
    if (!__DEV__) return;
    const misplaced = childLayoutStyleKeys(style);
    if (misplaced.length > 0) console.warn(pressableLayoutWarning(misplaced));
  }, [style]);

  const [shortBy, setShortBy] = useState(0);
  const handleLayout = useCallback<NonNullable<RNPressableProps['onLayout']>>(
    (event) => {
      const missing = Math.max(0, HIT_TARGET - event.nativeEvent.layout.height);
      setShortBy((current) => (Math.abs(current - missing) < 0.5 ? current : missing));
      onLayout?.(event);
    },
    [onLayout],
  );

  const scale = useRef(new Animated.Value(1)).current;
  const opacity = useRef(new Animated.Value(1)).current;

  const handlePressIn = useCallback<NonNullable<RNPressableProps['onPressIn']>>(
    (event) => {
      if (haptic) {

        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
      }
      if (scales) {
        Animated.timing(scale, {
          toValue: pressScale,
          duration: theme.motion.duration.instant,
          useNativeDriver: true,
        }).start();
      }
      if (dims) {
        Animated.timing(opacity, {
          toValue: 0.62,
          duration: theme.motion.duration.instant,
          useNativeDriver: true,
        }).start();
      }
      onPressIn?.(event);
    },
    [haptic, scales, dims, pressScale, scale, opacity, theme.motion.duration.instant, onPressIn],
  );

  const handlePressOut = useCallback<NonNullable<RNPressableProps['onPressOut']>>(
    (event) => {
      if (scales) {

        Animated.spring(scale, {
          toValue: 1,
          damping: theme.motion.spring.snappy.damping,
          stiffness: theme.motion.spring.snappy.stiffness,
          mass: theme.motion.spring.snappy.mass,
          useNativeDriver: true,
        }).start();
      }
      if (dims) {
        Animated.timing(opacity, {
          toValue: 1,
          duration: theme.motion.duration.fast,
          useNativeDriver: true,
        }).start();
      }
      onPressOut?.(event);
    },
    [scales, dims, scale, opacity, theme.motion, onPressOut],
  );

  const handlePress = useCallback<NonNullable<RNPressableProps['onPress']>>(
    (event) => {
      if (disabled) return;
      onPress?.(event);
    },
    [disabled, onPress],
  );

  const [focused, setFocused] = useState(false);

  const handleFocus = useCallback<NonNullable<RNPressableProps['onFocus']>>(
    (event) => {
      setFocused(true);
      onFocus?.(event);
    },
    [onFocus],
  );

  const handleBlur = useCallback<NonNullable<RNPressableProps['onBlur']>>(
    (event) => {
      setFocused(false);
      onBlur?.(event);
    },
    [onBlur],
  );

  const showRing = focused && !disabled && !noFocusRing;
  const ringRadius = (focusRingRadius ?? theme.radius.md) + FOCUS_RING.radiusBleed;

  return (
    <RNPressable

      style={[{ minHeight: HIT_TARGET, justifyContent: 'center' }, style]}
      onLayout={handleLayout}
      hitSlop={shortBy > 0 ? { top: shortBy / 2, bottom: shortBy / 2 } : undefined}
      disabled={disabled}
      android_ripple={
        noFeedback || disabled
          ? undefined
          : { color: theme.colors.surfaceRaised, borderless: false }
      }
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      onPress={handlePress}
      onFocus={handleFocus}
      onBlur={handleBlur}
      accessibilityState={{ disabled }}
      {...rest}
    >
      <Animated.View
        style={[
          { transform: [{ scale }], opacity: disabled && !noDisabledOpacity ? 0.42 : opacity },

          styles.animatedWrapper,
          contentStyle,
        ]}
      >
        {children}
      </Animated.View>

      {showRing ? (
        <View

          pointerEvents="none"
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={[
            styles.focusRing,
            {
              top: FOCUS_RING.offset,
              left: FOCUS_RING.offset,
              right: FOCUS_RING.offset,
              bottom: FOCUS_RING.offset,
              borderWidth: FOCUS_RING.width,
              borderColor: theme.colors.focusRing,
              borderRadius: ringRadius,
            },
          ]}
        />
      ) : null}
    </RNPressable>
  );
}

const styles = StyleSheet.create({
  animatedWrapper: { flexGrow: 0 },
  tile: { alignItems: 'center', justifyContent: 'center' },
  focusRing: { position: 'absolute' },
});

export interface GradientProps extends ViewProps {

  colors: GradientStops;

  start?: { x: number; y: number };
  end?: { x: number; y: number };
  radius?: keyof ReturnType<typeof useTheme>['radius'];
  padding?: keyof ReturnType<typeof useTheme>['spacing'];
  style?: StyleProp<ViewStyle>;
  children?: React.ReactNode;
}

export function Gradient({
  colors,
  start = { x: 0, y: 0 },
  end = { x: 1, y: 1 },
  radius,
  padding,
  style,
  children,
  ...rest
}: GradientProps) {
  const theme = useTheme();

  return (
    <LinearGradient
      colors={colors}
      start={start}
      end={end}
      style={[
        {
          borderRadius: radius ? theme.radius[radius] : undefined,
          padding: padding ? theme.spacing[padding] : undefined,
        },
        style,
      ]}
      {...rest}
    >
      {children}
    </LinearGradient>
  );
}

export interface IconTileProps {
  icon: IconName;

  tone?: Tone;
  size?: 'sm' | 'md' | 'lg';

  bordered?: boolean;
  style?: StyleProp<ViewStyle>;
}

const TILE_SIZES = {
  sm: { box: 30, glyph: 15, radius: 'sm' as const },
  md: { box: LAYOUT.tileSize, glyph: 19, radius: 'md' as const },
  lg: { box: LAYOUT.tileSizeLarge, glyph: 22, radius: 'lg' as const },
};

export function IconTile({
  icon,
  tone = 'neutral',
  size = 'md',
  bordered = false,
  style,
}: IconTileProps) {
  const theme = useTheme();
  const palette = theme.tone(tone);
  const dims = TILE_SIZES[size];

  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        styles.tile,
        {
          width: dims.box,
          height: dims.box,
          borderRadius: theme.radius[dims.radius],
          backgroundColor: palette.bg,
          borderWidth: bordered ? BORDER_WIDTH.hairline : 0,
          borderColor: palette.border,
        },
        style,
      ]}
    >
      <Icon name={icon} size={dims.glyph} color={palette.fg} />
    </View>
  );
}

export interface DividerProps {

  inset?: keyof ReturnType<typeof useTheme>['spacing'];

  spacing?: keyof ReturnType<typeof useTheme>['spacing'];

  accent?: boolean;

  vertical?: boolean;

  subtle?: boolean;
}

export function Divider({
  inset,
  spacing = 'none',
  accent = false,
  vertical = false,
  subtle = false,
}: DividerProps) {
  const theme = useTheme();
  const color = accent
    ? theme.colors.accentHairline
    : subtle
      ? theme.colors.borderSubtle
      : theme.colors.border;

  if (vertical) {
    return (
      <View
        style={{
          width: BORDER_WIDTH.hairline,
          alignSelf: 'stretch',
          backgroundColor: color,
          marginTop: inset ? theme.spacing[inset] : 0,
          marginBottom: inset ? theme.spacing[inset] : 0,
          marginLeft: spacing ? theme.spacing[spacing] : 0,
          marginRight: spacing ? theme.spacing[spacing] : 0,
        }}
      />
    );
  }

  return (
    <View
      style={{
        height: BORDER_WIDTH.hairline,
        backgroundColor: color,
        marginLeft: inset ? theme.spacing[inset] : 0,
        marginRight: inset ? theme.spacing[inset] : 0,
        marginTop: spacing ? theme.spacing[spacing] : 0,
        marginBottom: spacing ? theme.spacing[spacing] : 0,
      }}
    />
  );
}

export interface RowProps extends ViewProps {
  gap?: keyof ReturnType<typeof useTheme>['spacing'];
  align?: ViewStyle['alignItems'];
  justify?: ViewStyle['justifyContent'];

  wrap?: boolean;

  between?: boolean;
  children?: React.ReactNode;
}

export function Row({
  gap = 'md',
  align = 'center',
  justify,
  wrap = false,
  between = false,
  style,
  children,
  ...rest
}: RowProps) {
  const theme = useTheme();
  return (
    <View
      style={[
        {
          flexDirection: 'row',
          alignItems: align,
          justifyContent: between ? 'space-between' : justify,
          gap: theme.spacing[gap],
          flexWrap: wrap ? 'wrap' : 'nowrap',
        },
        style,
      ]}
      {...rest}
    >
      {children}
    </View>
  );
}

export interface StackProps extends ViewProps {
  gap?: keyof ReturnType<typeof useTheme>['spacing'];
  align?: ViewStyle['alignItems'];
  justify?: ViewStyle['justifyContent'];

  flex?: boolean;
  children?: React.ReactNode;
}

export function Stack({
  gap = 'md',
  align,
  justify,
  flex = false,
  style,
  children,
  ...rest
}: StackProps) {
  const theme = useTheme();
  return (
    <View
      style={[
        {
          flexDirection: 'column',
          alignItems: align,
          justifyContent: justify,
          gap: theme.spacing[gap],
          flex: flex ? 1 : undefined,
        },
        style,
      ]}
      {...rest}
    >
      {children}
    </View>
  );
}

export function Spacer({ size }: { size?: keyof ReturnType<typeof useTheme>['spacing'] }) {
  const theme = useTheme();
  return <View style={{ flex: size ? 0 : 1, width: size ? theme.spacing[size] : undefined }} />;
}

export { SPACING };
