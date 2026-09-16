/**
 * A setting row with a switch.
 *
 * ## Why this is not React Native's `Switch`
 *
 * The stock control exposes `trackColor` and `thumbColor` and nothing else. Its height, its
 * corner radius, its thumb shadow and — on Android — its Material ripple belong to the
 * platform, so sitting inside a bordered `Surface` at `radius.lg` it reads as a control
 * lifted out of the OS settings app rather than part of this one. It also cannot be given
 * the app's motion tokens: its transition is whatever the platform's is.
 *
 * The stock control's other cost is the accessible name. `Switch` carries no visible label,
 * so every use has to repeat the row's text in `accessibilityLabel` and keep the two in step
 * by hand. Here the label *is* the accessible name, because the row is the control.
 *
 * ## Why the whole row is the target
 *
 * A 46×28 pill is a small thing to hit one-handed, and the label beside it is dead space that
 * reads as tappable to everyone anyway. Making the row the control gives a target the width
 * of the panel, which is also what makes it usable at a large OS font scale — the text grows,
 * the target grows with it, and the pill stays the size a thumb expects.
 *
 * ## Why the animation runs on the JS driver
 *
 * `translateX` alone would run natively, but the track colour has to move with it, and
 * `Animated` can only interpolate a colour string off the native driver. Splitting it into
 * two values — one native for the thumb, one JS for the track — would be two animations that
 * can drift apart under load, and on a control this small that is visible as the thumb
 * arriving before the colour does. One 150ms interpolation is cheap enough that the driver
 * is not worth the split.
 */

import React, { useEffect, useRef } from 'react';
import { Animated, Easing, View } from 'react-native';

import { BORDER_WIDTH, Pressable, Row, Text, useReducedMotion, useTheme } from '@ui';

/**
 * The pill's geometry.
 *
 * Derived rather than chosen independently: the thumb is the track's height less twice its
 * inset, and its travel is the track's width less the track's height. Writing the
 * relationships down instead of three unrelated numbers is what keeps the shape correct if
 * the size ever changes.
 *
 * These are not tokens because no other control in the app has a track and a thumb — a
 * `SWITCH_WIDTH` entry in `tokens.ts` would have exactly one consumer, and the token set is
 * shared with three other people's screens.
 */
const TRACK_WIDTH = 46;
const TRACK_HEIGHT = 28;
const THUMB_INSET = 3;
const THUMB_SIZE = TRACK_HEIGHT - THUMB_INSET * 2;
const THUMB_TRAVEL = TRACK_WIDTH - TRACK_HEIGHT;

export interface SettingToggleProps {
  label: string;
  /** What the setting does, in the user's terms. Announced after the label. */
  hint?: string;
  value: boolean;
  onValueChange: (next: boolean) => void;
  disabled?: boolean;
}

export function SettingToggle({
  label,
  hint,
  value,
  onValueChange,
  disabled = false,
}: SettingToggleProps) {
  const theme = useTheme();
  const reducedMotion = useReducedMotion();

  // Created once and mutated. Re-creating it per render would restart the travel on every
  // parent update, so the thumb would jump back and slide again when an unrelated piece of
  // the screen changed.
  const progress = useRef(new Animated.Value(value ? 1 : 0)).current;

  useEffect(() => {
    Animated.timing(progress, {
      toValue: value ? 1 : 0,
      // Reduced motion removes the travel, not the destination. A slower animation would be
      // the wrong reading of the setting, and no animation at all would leave the thumb
      // lying about the state it represents.
      duration: reducedMotion === true ? 0 : theme.motion.duration.fast,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start();
  }, [value, progress, reducedMotion, theme.motion.duration.fast]);

  // `accent` and `onAccent` are a defined pair in every scheme, which is the reason to use
  // them here rather than picking a colour that looks like "on": the contrast of the thumb
  // against the filled track is guaranteed by the token set instead of by eye. In dark mode
  // that pair is the app's gold, which is intentional — this is the accent, not a signal.
  const trackColor = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [theme.colors.surfaceSunken, theme.colors.accent],
  });
  const trackBorder = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [theme.colors.borderStrong, theme.colors.accent],
  });
  const thumbColor = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [theme.colors.textTertiary, theme.colors.onAccent],
  });
  const thumbOffset = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [0, THUMB_TRAVEL],
  });

  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityLabel={label}
      {...(hint ? { accessibilityHint: hint } : {})}
      accessibilityState={{ checked: value, disabled }}
      disabled={disabled}
      haptic
      // The ripple is rectangular and would be drawn across a pill and its label. The thumb
      // travel and the press scale are the feedback here.
      noFeedback
      pressScale={0.985}
      onPress={() => onValueChange(!value)}
      style={{ paddingVertical: theme.spacing.sm }}
    >
      <Row gap="lg" align="center">
        <View style={{ flex: 1 }}>
          <Text variant="bodyMedium">{label}</Text>
          {hint ? (
            <Text variant="caption" colorToken="textSecondary" style={{ marginTop: theme.spacing.xxs }}>
              {hint}
            </Text>
          ) : null}
        </View>

        <Animated.View
          style={{
            width: TRACK_WIDTH,
            height: TRACK_HEIGHT,
            borderRadius: theme.radius.pill,
            borderWidth: BORDER_WIDTH.hairline,
            backgroundColor: trackColor,
            borderColor: trackBorder,
            padding: THUMB_INSET,
            justifyContent: 'center',
          }}
        >
          <Animated.View
            style={{
              width: THUMB_SIZE,
              height: THUMB_SIZE,
              borderRadius: theme.radius.pill,
              backgroundColor: thumbColor,
              transform: [{ translateX: thumbOffset }],
            }}
          />
        </Animated.View>
      </Row>
    </Pressable>
  );
}
