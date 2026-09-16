/**
 * Motion primitives.
 *
 * Entrance transitions, ambient loops and the counter, built on React Native's own
 * `Animated`. There is no Reanimated in this project and these must not introduce it: the
 * app has no `babel.config.js` registering its plugin, so an import here would fail at
 * runtime rather than at build time — the worst possible place to find out.
 *
 * ## Two rules every component in this file follows
 *
 * **1. `useNativeDriver: true`, always.** Only `opacity` and `transform` are animated
 * anywhere below, which is exactly the set the native driver supports. This is not a
 * micro-optimisation: a JS-driven animation shares the thread with list virtualisation,
 * Firestore snapshot handling and JSON parsing, so on a mid-range Android phone it stutters
 * precisely when the app is busiest — during the entrance animation of a list that is still
 * loading. That stutter is what "cheap" feels like. Width, height and colour are therefore
 * never animated here; where a width *appears* to animate (`Shimmer`) it is a fixed-width
 * layer being translated instead.
 *
 * **2. Reduce-motion is honoured by rendering the finished state, not by animating fast.**
 * Every component here starts its animated values at their *resting* position and only
 * moves them backwards to the start once it knows motion is allowed. A component that
 * started at `opacity: 0` and waited for the async accessibility check would flash invisible
 * content at a user who asked for no motion — and if that check ever failed, the content
 * would stay invisible permanently. Starting settled means the failure mode is "no
 * animation", never "no content".
 */

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

// ---------------------------------------------------------------------------
// Reduced motion
// ---------------------------------------------------------------------------

/**
 * Whether the OS is asking for reduced motion.
 *
 * Returns `null` until the first async query resolves. Callers must treat `null` as "not
 * known yet" and hold the settled state — see the file header for why guessing `false`
 * here would flash hidden content at exactly the users who opted out of motion.
 *
 * The subscription matters as much as the initial read: the setting is toggled from
 * Control Centre on iOS without restarting the app, and a long-lived screen that cached
 * the boolean at mount would keep animating for the rest of the session.
 */
export function useReducedMotion(): boolean | null {
  const [reduced, setReduced] = useState<boolean | null>(null);

  useEffect(() => {
    let active = true;

    AccessibilityInfo.isReduceMotionEnabled()
      .then((value) => {
        if (active) setReduced(value);
      })
      // On a platform where the query is unsupported, assume motion is fine rather than
      // leaving every animated component pinned in its resting state forever.
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

// ---------------------------------------------------------------------------
// Entrance transitions
// ---------------------------------------------------------------------------

export interface FadeInProps {
  children?: React.ReactNode;
  /** Milliseconds before this element starts. `Stagger` supplies it for a list. */
  delay?: number;
  duration?: number;
  style?: StyleProp<ViewStyle>;
  /** Stretch to fill the parent, for a fading full-screen container. */
  flex?: boolean;
}

/**
 * Fades its children in on mount.
 *
 * The fade runs *from* transparent, but the animated value is created at `1`: it is set to
 * `0` in the effect, in the same frame the animation starts. That ordering is what makes
 * the reduced-motion path free — when motion is off the effect simply never touches the
 * value, and the content was already visible from the first paint.
 */
export function FadeIn({ children, delay = 0, duration, style, flex = false }: FadeInProps) {
  const theme = useTheme();
  const reduced = useReducedMotion();
  const opacity = useRef(new Animated.Value(1)).current;
  // Guards against re-running the entrance when `delay` changes on a re-render, which
  // would make an element already on screen fade in a second time.
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

    // Stopping on unmount leaves the value wherever it was, which is correct: the node is
    // going away, and settling it first would be a wasted frame.
    return () => animation.stop();
  }, [reduced, delay, ms, opacity]);

  return (
    <Animated.View style={[flex ? styles.flex : null, { opacity }, style]}>{children}</Animated.View>
  );
}

export interface SlideUpInProps extends FadeInProps {
  /**
   * How far the element travels, in points. Defaults to `MOTION.enterDistance`.
   * Negative values slide *down* into place, for anything anchored to the top of a screen.
   */
  distance?: number;
}

/**
 * Fades and lifts its children into place — the app's standard entrance.
 *
 * Opacity and translation run as one `Animated.parallel` on a single driver, and the
 * distance is small by default (12pt). A long slide reads as a page transition and implies
 * the content came from somewhere; a short one just says it arrived, which is all an
 * entrance in a data tool should claim.
 */
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

  // One driver, two outputs. Interpolating a single 0→1 value rather than animating two
  // values in parallel keeps the fade and the lift exactly in phase — if they drift by even
  // a frame the element appears to arrive twice.
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

// ---------------------------------------------------------------------------
// Stagger
// ---------------------------------------------------------------------------

export interface StaggerProps {
  children?: React.ReactNode;
  /** Milliseconds added per child. Defaults to `MOTION.stagger` (45ms). */
  step?: number;
  /** Delay applied to the whole group, before the per-child step. */
  delay?: number;
  /** `slide` (default) uses `SlideUpIn`; `fade` uses `FadeIn`, for already-moving content. */
  variant?: 'slide' | 'fade';
  /** Per-child travel distance, forwarded to `SlideUpIn`. */
  distance?: number;
  /**
   * Vertical space between children.
   *
   * Present because this component inserts a wrapper element around each child, which
   * silently breaks the `gap` of a `Stack` it replaces — the gap would apply to the one
   * wrapper `View` instead of to the items. Setting it here keeps the swap from `Stack` to
   * `Stagger` a one-word change.
   */
  gap?: keyof ReturnType<typeof useTheme>['spacing'];
  style?: StyleProp<ViewStyle>;
}

/**
 * Wraps each child in an entrance whose delay increases down the list.
 *
 * The cascade is the point: a group of cards appearing together reads as one repaint,
 * while the same cards arriving 45ms apart read as a list being *composed*, which is the
 * impression this product wants at the top of a case.
 *
 * Two limits keep it honest. The accumulated delay is clamped at `MOTION.staggerCap`
 * (300ms), so a long list cascades at the top and is simply present below rather than
 * dribbling in for two seconds. And this is for a *small, known* group — a `FlatList` must
 * not wrap its rows in one of these, because recycled rows would replay the entrance on
 * every scroll. `ScreenList` passes its row index to `SlideUpIn` directly for that case.
 */
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
  // `Children.toArray` drops nulls and flattens fragments, so a conditionally rendered
  // child does not leave a gap in the timing sequence.
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

/**
 * Reuses a child's own key when it has one.
 *
 * Falling back to the index for every child would make React re-key the whole group when
 * one item is removed, remounting the wrappers and replaying every entrance animation.
 */
function keyFor(child: React.ReactNode, index: number): string {
  if (React.isValidElement(child) && child.key != null) return String(child.key);
  return `stagger-${index}`;
}

// ---------------------------------------------------------------------------
// Shimmer
// ---------------------------------------------------------------------------

export interface ShimmerProps {
  /** Defaults to filling the parent's width. */
  width?: number | `${number}%`;
  height?: number;
  radius?: keyof ReturnType<typeof useTheme>['radius'];
  style?: StyleProp<ViewStyle>;
}

/**
 * A skeleton block with a gradient sweep travelling across it.
 *
 * The sweep is a fixed-width gradient layer translated from one edge to the other with
 * `useNativeDriver`, clipped by the parent's `overflow: 'hidden'`. The obvious
 * implementation — animating the gradient's `locations`, or the layer's `width` — cannot
 * use the native driver and would run this loop on the JS thread for as long as the screen
 * is loading, which is exactly when the JS thread is busy fetching the content it is
 * standing in for.
 *
 * `Skeleton` in `Feedback.tsx` is the calmer opacity pulse and remains the right default
 * for a dense list. Use `Shimmer` for the few large blocks where a pulse across a big area
 * reads as flicker, and where the sweep's direction usefully implies "left to right,
 * still filling in".
 */
export function Shimmer({ width = '100%', height = 14, radius = 'xs', style }: ShimmerProps) {
  const theme = useTheme();
  const reduced = useReducedMotion();
  const travel = useRef(new Animated.Value(0)).current;
  // Measured rather than assumed: the sweep has to cross the block's real pixel width, and
  // a percentage width is not known until layout. Until then the sweep stays parked.
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
        // A pause between sweeps. Without it the sweep re-enters the moment it exits and
        // reads as a spinner — a continuous machine — rather than as periodic progress.
        Animated.delay(theme.motion.ambient.shimmerGap),
        Animated.timing(travel, { toValue: 0, duration: 0, useNativeDriver: true }),
      ]),
    );
    loop.start();

    return () => loop.stop();
  }, [reduced, measured, travel, theme.motion.ambient.shimmer, theme.motion.ambient.shimmerGap]);

  // The sweep is a little over half the block wide, so the highlight is a passing band
  // rather than a wash over the whole surface.
  const sweepWidth = Math.max(48, measured * 0.55);
  const translateX = travel.interpolate({
    inputRange: [0, 1],
    outputRange: [-sweepWidth, measured],
  });

  return (
    <View
      onLayout={(event) => {
        const next = event.nativeEvent.layout.width;
        // Only grow-or-change, and only on a real value: `onLayout` fires on every parent
        // resize, and setting identical state each time would re-render the loop's deps.
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
          // Positioned explicitly rather than with `absoluteFillObject` plus a width: that
          // combination sets `left`, `right` *and* `width` at once, which is contradictory,
          // and Yoga's resolution of it is not something to rely on for a moving layer.
          style={[styles.sweep, { width: sweepWidth, transform: [{ translateX }] }]}
          pointerEvents="none"
        >
          <LinearGradient
            // Transparent at both ends so the band has no hard edge — a visible rectangle
            // sliding across a placeholder looks like a rendering artefact.
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

// ---------------------------------------------------------------------------
// Animated counter
// ---------------------------------------------------------------------------

export interface AnimatedCounterProps extends Omit<TextProps, 'children'> {
  value: number;
  /** Milliseconds for the full count. Defaults to `MOTION.duration.deliberate`. */
  duration?: number;
  /** Decimal places. `0` (default) keeps counts as integers while they tick. */
  decimals?: number;
  prefix?: string;
  suffix?: string;
  /** Thousands separators, via `toLocaleString`. On by default. */
  grouped?: boolean;
  style?: StyleProp<TextStyle>;
}

/**
 * A number that counts up to its value.
 *
 * Uses an `Animated.Value` with a listener rather than a `setInterval` of `setState`. The
 * interval version this replaces re-rendered the whole subtree on a fixed 18-step timer,
 * which both dropped frames on a slow render and produced visibly chunky counting on a
 * fast one. Driving from an animated value means the easing curve is sampled at the display
 * rate, and only this component's `setState` runs per tick.
 *
 * `useNativeDriver` is `false` here and cannot be otherwise: the value is read back into JS
 * to format a string, and the native driver keeps the value on the UI thread where the
 * listener would never see it. This is the one animation in the app that legitimately runs
 * on the JS thread — it is short, it is one value, and there is no transform equivalent for
 * "render different text".
 *
 * Counting is suppressed entirely under reduced motion, where it renders the final figure.
 * A number that animates is a number that is briefly *wrong*, which in a product reporting
 * evidence counts is worth being conservative about.
 */
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
  // The figure the last run animated to, so a re-render with an unchanged value does not
  // restart the count, and a genuine change counts from where it currently is.
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
      // Removing the listener is not optional: `Animated.Value` holds it strongly, so a
      // counter unmounted mid-count would keep calling `setState` on a dead component.
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
      // The final value is what matters to a screen reader; announcing every intermediate
      // figure would read a stat tile aloud as a stream of numbers.
      accessibilityLabel={`${prefix}${value}${suffix}`}
      {...textProps}
    >
      {formatted}
    </Text>
  );
}

// ---------------------------------------------------------------------------
// Pulse dot
// ---------------------------------------------------------------------------

export interface PulseDotProps {
  /** The dot's colour. Defaults to the accent — pass a tone's `solid` for status. */
  color?: string;
  size?: number;
  /** Stops the halo and renders a static dot. For a status that has settled. */
  active?: boolean;
  style?: StyleProp<ViewStyle>;
}

/**
 * A small dot with a halo breathing outward — the app's "this is live" marker.
 *
 * The halo scales and fades on the native driver; the core dot never moves. That split is
 * deliberate: a pulsing *core* draws the eye continuously and competes with the content,
 * while a core that holds still with motion only in its surround registers peripherally as
 * activity and can be ignored while reading.
 *
 * Under reduced motion the halo renders at rest — a dot with a faint ring — so the "live"
 * affordance still exists visually rather than disappearing along with its animation.
 */
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
        // Reset instantly rather than easing back: the halo has already faded to zero, so
        // animating its return would just be a slow invisible shrink.
        Animated.timing(pulse, { toValue: 0, duration: 0, useNativeDriver: true }),
      ]),
    );
    loop.start();

    return () => loop.stop();
  }, [animating, pulse, theme.motion.ambient.pulse]);

  const haloScale = pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 2.6] });
  const haloOpacity = pulse.interpolate({
    inputRange: [0, 1],
    // Starts low. A halo that begins at full strength flashes on every cycle rather than
    // breathing out of the dot.
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
