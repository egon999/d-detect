/**
 * Determinate and indeterminate progress.
 *
 * Built because the upload screen was rendering real, measured progress — the byte
 * callback from the file transfer, a genuine 0→1 — as the *string* `Storing original 47%`.
 * The number was accurate and the presentation threw away everything that makes progress
 * legible: whether it is moving, how fast, and how much is left. On a slow connection a
 * percentage that updates every few seconds is indistinguishable from a frozen screen.
 *
 * ## Why the fill is a transform, not a width
 *
 * Animating `width` runs on the JS thread, and this bar is on screen during exactly the
 * work that saturates it — hashing a file, streaming bytes, parsing a PDF. A bar that
 * stutters while the app is busy is worse than no bar, because the stutter reads as the
 * app having hung. So the fill is a full-width layer that is `scaleX`-ed from the left,
 * which the native driver can drive on its own thread.
 *
 * `scaleX` scales about the centre by default, so the track is offset by half its width,
 * scaled, and shifted back — the standard trick, kept here rather than in the caller.
 *
 * ## Indeterminate is a different component, not a flag
 *
 * A determinate bar that does not know its value is not "a bar at 0%": it has to say
 * *working, duration unknown*, which is a looping sweep rather than a fill. Conflating
 * them behind `value?: number` produced call sites that silently rendered an empty bar
 * when a fetch forgot to report progress.
 */

import React, { useEffect, useMemo, useRef } from 'react';
import { Animated, Easing, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { MOTION, BORDER_WIDTH, SPACING, type Tone } from '../tokens';
import { useTheme } from '../theme';
import { useReducedMotion } from './Motion';

const TRACK_HEIGHT = { sm: 3, md: 6, lg: 9 } as const;

export interface ProgressBarProps {
  /** 0–1. Values outside the range are clamped rather than overflowing the track. */
  value: number;
  tone?: Tone;
  size?: keyof typeof TRACK_HEIGHT;
  /** Announced to screen readers. Progress with no label is noise to a non-visual user. */
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

  // Starts at the real value so a bar mounted mid-transfer does not animate up from zero,
  // which would misreport progress for the length of the animation.
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

/**
 * Work of unknown duration.
 *
 * A sweep that crosses the track and repeats. Deliberately slower than a spinner: this
 * sits under a header while a case analyses, and anything quicker reads as urgency the
 * situation does not have.
 */
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
    // Reduced motion gets a static, dimmed track rather than a loop. A user who asked for
    // no motion still needs to know something is running, which the tone conveys.
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

export interface StepDotsProps {
  count: number;
  index: number;
  tone?: Tone;
  style?: StyleProp<ViewStyle>;
}

/**
 * Discrete step indicator for a multi-part form.
 *
 * Separate from the carousel's scroll-driven dots: those interpolate from a continuous
 * offset, these snap between whole steps. Sharing one component would have meant a prop
 * that switches between two different animation models.
 */
export function StepDots({ count, index, tone = 'accent', style }: StepDotsProps) {
  const theme = useTheme();
  const palette = theme.tone(tone);
  const dots = useMemo(() => Array.from({ length: Math.max(0, count) }, (_, i) => i), [count]);

  return (
    <View
      style={[styles.dots, style]}
      accessibilityRole="progressbar"
      accessibilityLabel={`Step ${Math.min(index + 1, count)} of ${count}`}
    >
      {dots.map((dot) => {
        const done = dot <= index;
        return (
          <View
            key={dot}
            style={{
              height: 4,
              flex: 1,
              borderRadius: 2,
              backgroundColor: done ? palette.solid : theme.colors.surfaceSunken,
              borderWidth: done ? 0 : BORDER_WIDTH.hairline,
              borderColor: theme.colors.border,
            }}
          />
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  track: { width: '100%', overflow: 'hidden' },
  dots: { flexDirection: 'row', gap: SPACING.sm, width: '100%' },
});
