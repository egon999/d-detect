import React, { useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { MOTION, type Tone } from '../tokens';
import { useTheme } from '../theme';
import { useReducedMotion } from './Motion';

const TRACK_HEIGHT = { sm: 3, md: 6, lg: 9 } as const;

export interface ProgressBarProps {

  value: number;
  tone?: Tone;
  size?: keyof typeof TRACK_HEIGHT;

  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
}

export function ProgressBar({
  value,
  tone = 'accent',
  size = 'md',
  accessibilityLabel,
  style,
}: ProgressBarProps) {
  const theme = useTheme();
  const reduced = useReducedMotion();
  const clamped = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;

  const progress = useRef(new Animated.Value(clamped)).current;
  const [width, setWidth] = React.useState(0);

  useEffect(() => {
    if (reduced) {
      progress.setValue(clamped);
      return;
    }
    const animation = Animated.timing(progress, {
      toValue: clamped,
      duration: MOTION.duration.normal,
      easing: Easing.bezier(...MOTION.easeOut),
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [clamped, progress, reduced]);

  const palette = theme.tone(tone);
  const height = TRACK_HEIGHT[size];

  return (
    <View
      accessibilityRole="progressbar"
      accessibilityLabel={accessibilityLabel}
      accessibilityValue={{ min: 0, max: 100, now: Math.round(clamped * 100) }}
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      style={[
        styles.track,
        { height, borderRadius: height / 2, backgroundColor: theme.colors.surfaceSunken },
        style,
      ]}
    >
      <Animated.View
        style={[
          StyleSheet.absoluteFill,
          {
            backgroundColor: palette.solid,
            borderRadius: height / 2,
            transform: [
              { translateX: -width / 2 },
              { scaleX: progress },
              { translateX: width / 2 },
            ],
          },
        ]}
      />
    </View>
  );
}

export interface IndeterminateBarProps {
  tone?: Tone;
  size?: keyof typeof TRACK_HEIGHT;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
}

export function IndeterminateBar({
  tone = 'accent',
  size = 'sm',
  accessibilityLabel = 'Working',
  style,
}: IndeterminateBarProps) {
  const theme = useTheme();
  const reduced = useReducedMotion();
  const sweep = useRef(new Animated.Value(0)).current;
  const [width, setWidth] = React.useState(0);

  useEffect(() => {

    if (reduced || width === 0) return;

    const loop = Animated.loop(
      Animated.timing(sweep, {
        toValue: 1,
        duration: MOTION.ambient.shimmer + MOTION.ambient.shimmerGap,
        easing: Easing.bezier(...MOTION.easeInOut),
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [reduced, sweep, width]);

  const palette = theme.tone(tone);
  const height = TRACK_HEIGHT[size];
  const segment = Math.max(48, width * 0.35);

  return (
    <View
      accessibilityRole="progressbar"
      accessibilityLabel={accessibilityLabel}
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      style={[
        styles.track,
        { height, borderRadius: height / 2, backgroundColor: theme.colors.surfaceSunken },
        style,
      ]}
    >
      {reduced ? (
        <View
          style={[
            StyleSheet.absoluteFill,
            { backgroundColor: palette.bg, borderRadius: height / 2 },
          ]}
        />
      ) : (
        <Animated.View
          style={{
            width: segment,
            height,
            borderRadius: height / 2,
            backgroundColor: palette.solid,
            transform: [
              {
                translateX: sweep.interpolate({
                  inputRange: [0, 1],
                  outputRange: [-segment, width],
                }),
              },
            ],
          }}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  track: { width: '100%', overflow: 'hidden' },
});
