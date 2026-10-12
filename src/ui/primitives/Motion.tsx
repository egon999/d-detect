import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  Animated,
  Easing,
  StyleSheet,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';

import { MOTION } from '../tokens';
import { useTheme } from '../theme';
import { Text, type TextProps } from './Text';

export function useReducedMotion(): boolean | null {
  const [reduced, setReduced] = useState<boolean | null>(null);

  useEffect(() => {
    let active = true;

    AccessibilityInfo.isReduceMotionEnabled()
      .then((value) => {
        if (active) setReduced(value);
      })

      .catch(() => {
        if (active) setReduced(false);
      });

    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', (value) => {
      setReduced(value);
    });

    return () => {
      active = false;
      subscription.remove();
    };
  }, []);

  return reduced;
}

export interface FadeInProps {
  children?: React.ReactNode;

  delay?: number;
  duration?: number;
  style?: StyleProp<ViewStyle>;

  flex?: boolean;
}

export function FadeIn({ children, delay = 0, duration, style, flex = false }: FadeInProps) {
  const theme = useTheme();
  const reduced = useReducedMotion();
  const opacity = useRef(new Animated.Value(1)).current;

  const played = useRef(false);

  const ms = duration ?? theme.motion.duration.slow;

  useEffect(() => {
    if (reduced === null || reduced || played.current) return;
    played.current = true;

    opacity.setValue(0);
    const animation = Animated.timing(opacity, {
      toValue: 1,
      duration: ms,
      delay,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    });
    animation.start();

    return () => animation.stop();
  }, [reduced, delay, ms, opacity]);

  return (
    <Animated.View style={[flex ? styles.flex : null, { opacity }, style]}>{children}</Animated.View>
  );
}

export interface SlideUpInProps extends FadeInProps {

  distance?: number;
}

export function SlideUpIn({
  children,
  delay = 0,
  duration,
  distance,
  style,
  flex = false,
}: SlideUpInProps) {
  const theme = useTheme();
  const reduced = useReducedMotion();
  const progress = useRef(new Animated.Value(1)).current;
  const played = useRef(false);

  const ms = duration ?? theme.motion.duration.slow;
  const travel = distance ?? MOTION.enterDistance;

  useEffect(() => {
    if (reduced === null || reduced || played.current) return;
    played.current = true;

    progress.setValue(0);
    const animation = Animated.timing(progress, {
      toValue: 1,
      duration: ms,
      delay,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    });
    animation.start();

    return () => animation.stop();
  }, [reduced, delay, ms, progress]);

  const translateY = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [travel, 0],
  });

  return (
    <Animated.View
      style={[flex ? styles.flex : null, { opacity: progress, transform: [{ translateY }] }, style]}
    >
      {children}
    </Animated.View>
  );
}

export interface StaggerProps {
  children?: React.ReactNode;

  step?: number;

  delay?: number;

  variant?: 'slide' | 'fade';

  distance?: number;

  gap?: keyof ReturnType<typeof useTheme>['spacing'];
  style?: StyleProp<ViewStyle>;
}

export function Stagger({
  children,
  step = MOTION.stagger,
  delay = 0,
  variant = 'slide',
  distance,
  gap,
  style,
}: StaggerProps) {
  const theme = useTheme();

  const items = React.Children.toArray(children);

  return (
    <View style={[gap ? { gap: theme.spacing[gap] } : null, style]}>
      {items.map((child, index) => {
        const childDelay = delay + Math.min(index * step, MOTION.staggerCap);

        return variant === 'fade' ? (
          <FadeIn key={keyFor(child, index)} delay={childDelay}>
            {child}
          </FadeIn>
        ) : (
          <SlideUpIn key={keyFor(child, index)} delay={childDelay} distance={distance}>
            {child}
          </SlideUpIn>
        );
      })}
    </View>
  );
}

function keyFor(child: React.ReactNode, index: number): string {
  if (React.isValidElement(child) && child.key != null) return String(child.key);
  return `stagger-${index}`;
}

export interface ShimmerProps {

  width?: number | `${number}%`;
  height?: number;
  radius?: keyof ReturnType<typeof useTheme>['radius'];
  style?: StyleProp<ViewStyle>;
}

export function Shimmer({ width = '100%', height = 14, radius = 'xs', style }: ShimmerProps) {
  const theme = useTheme();
  const reduced = useReducedMotion();
  const travel = useRef(new Animated.Value(0)).current;

  const [measured, setMeasured] = useState(0);

  useEffect(() => {
    if (reduced === null || reduced || measured <= 0) return;

    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(travel, {
          toValue: 1,
          duration: theme.motion.ambient.shimmer,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),

        Animated.delay(theme.motion.ambient.shimmerGap),
        Animated.timing(travel, { toValue: 0, duration: 0, useNativeDriver: true }),
      ]),
    );
    loop.start();

    return () => loop.stop();
  }, [reduced, measured, travel, theme.motion.ambient.shimmer, theme.motion.ambient.shimmerGap]);

  const sweepWidth = Math.max(48, measured * 0.55);
  const translateX = travel.interpolate({
    inputRange: [0, 1],
    outputRange: [-sweepWidth, measured],
  });

  return (
    <View
      onLayout={(event) => {
        const next = event.nativeEvent.layout.width;

        setMeasured((current) => (Math.abs(current - next) > 0.5 ? next : current));
      }}
      style={[
        {
          width,
          height,
          borderRadius: theme.radius[radius],
          backgroundColor: theme.colors.skeleton,
          overflow: 'hidden',
        },
        style,
      ]}
    >
      {measured > 0 && reduced === false ? (
        <Animated.View

          style={[styles.sweep, { width: sweepWidth, transform: [{ translateX }] }]}
          pointerEvents="none"
        >
          <LinearGradient

            colors={['transparent', theme.colors.skeletonHighlight, 'transparent']}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 0 }}
            style={StyleSheet.absoluteFillObject}
          />
        </Animated.View>
      ) : null}
    </View>
  );
}

export interface AnimatedCounterProps extends Omit<TextProps, 'children'> {
  value: number;

  duration?: number;

  decimals?: number;
  prefix?: string;
  suffix?: string;

  grouped?: boolean;
  style?: StyleProp<TextStyle>;
}

export function AnimatedCounter({
  value,
  duration,
  decimals = 0,
  prefix = '',
  suffix = '',
  grouped = true,
  style,
  ...textProps
}: AnimatedCounterProps) {
  const theme = useTheme();
  const reduced = useReducedMotion();
  const progress = useRef(new Animated.Value(value)).current;
  const [display, setDisplay] = useState(value);

  const from = useRef(value);

  const ms = duration ?? theme.motion.duration.deliberate;

  useEffect(() => {
    if (reduced === null) return;

    if (reduced || from.current === value) {
      progress.setValue(value);
      setDisplay(value);
      from.current = value;
      return;
    }

    const listener = progress.addListener(({ value: current }) => setDisplay(current));

    const animation = Animated.timing(progress, {
      toValue: value,
      duration: ms,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    });
    animation.start(() => {
      from.current = value;
    });

    return () => {
      animation.stop();

      progress.removeListener(listener);
    };
  }, [value, reduced, ms, progress]);

  const formatted = useMemo(() => {
    const rounded = decimals > 0 ? Number(display.toFixed(decimals)) : Math.round(display);
    const body = grouped
      ? rounded.toLocaleString(undefined, {
          minimumFractionDigits: decimals,
          maximumFractionDigits: decimals,
        })
      : rounded.toFixed(decimals);
    return `${prefix}${body}${suffix}`;
  }, [display, decimals, grouped, prefix, suffix]);

  return (
    <Text
      style={style}

      accessibilityLabel={`${prefix}${value}${suffix}`}
      {...textProps}
    >
      {formatted}
    </Text>
  );
}

export interface PulseDotProps {

  color?: string;
  size?: number;

  active?: boolean;
  style?: StyleProp<ViewStyle>;
}

export function PulseDot({ color, size = 8, active = true, style }: PulseDotProps) {
  const theme = useTheme();
  const reduced = useReducedMotion();
  const pulse = useRef(new Animated.Value(0)).current;

  const dotColor = color ?? theme.colors.accent;
  const animating = active && reduced === false;

  useEffect(() => {
    if (!animating) {
      pulse.setValue(0);
      return;
    }

    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 1,
          duration: theme.motion.ambient.pulse,
          easing: Easing.out(Easing.ease),
          useNativeDriver: true,
        }),

        Animated.timing(pulse, { toValue: 0, duration: 0, useNativeDriver: true }),
      ]),
    );
    loop.start();

    return () => loop.stop();
  }, [animating, pulse, theme.motion.ambient.pulse]);

  const haloScale = pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 2.6] });
  const haloOpacity = pulse.interpolate({
    inputRange: [0, 1],

    outputRange: [0.35, 0],
  });

  return (
    <View style={[styles.pulseContainer, { width: size, height: size }, style]}>
      <Animated.View
        style={[
          styles.pulseHalo,
          {
            width: size,
            height: size,
            borderRadius: size / 2,
            backgroundColor: dotColor,
            opacity: animating ? haloOpacity : active ? 0.2 : 0,
            transform: animating ? [{ scale: haloScale }] : [{ scale: 1.8 }],
          },
        ]}
      />
      <View
        style={{
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: dotColor,
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  sweep: { position: 'absolute', top: 0, bottom: 0, left: 0 },
  pulseContainer: { alignItems: 'center', justifyContent: 'center' },
  pulseHalo: { position: 'absolute' },
});
