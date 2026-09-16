/**
 * A real bottom sheet.
 *
 * Replaces the full-screen `<Modal>` the composer used to be. A full-screen modal for a
 * compose action is the cheapest way to get a form on screen and it costs the user their
 * sense of place: the case they were reading vanishes, and what returns when they finish is
 * a screen they have to re-find their position in. A sheet keeps the case visible behind a
 * scrim, so the form reads as something laid *over* the case rather than as a different
 * place the app navigated to — which matters here, because the sentence being written only
 * makes sense against the case behind it.
 *
 * ## Why this is still a `Modal` underneath
 *
 * The sheet is a transparent RN `Modal`, not an absolutely-positioned view in the screen's
 * own tree. Three things come with the modal window and are genuinely hard to reproduce:
 * Android's hardware back button arriving at `onRequestClose`, the sheet sitting above the
 * tab bar and every `position: absolute` footer in the app without a z-index arms race, and
 * — the one that decides it — the Android soft keyboard. See the keyboard note below.
 *
 * ## Why the sheet translates instead of growing
 *
 * `height` cannot be driven by the native driver, and this sheet animates while a text input
 * is mounting and a keyboard is coming up, which is one of the busiest moments the JS thread
 * has. So the sheet is laid out at its natural height, measured, and translated up from
 * exactly that height — `translateY` and `opacity` only, native driver throughout. The
 * measurement is why the sheet is invisible for its first frame: before `onLayout` reports a
 * height there is no correct distance to hide it at, and guessing one shows a strip of form.
 *
 * ## Why `PanResponder`, and why only on the handle
 *
 * `react-native-gesture-handler` is autolinked in this project, but the part of it that would
 * be worth the switch — `useAnimatedGestureHandler` and friends — is Reanimated, which this
 * project does not have (see `Motion.tsx`). A plain `PanResponder` writing to an
 * `Animated.Value` is the whole requirement here.
 *
 * The responder is attached to the handle and header only, never to the body. A sheet whose
 * entire surface drags cannot contain a `ScrollView`: the two compete for the same vertical
 * gesture, and the loser is whichever one the user needed. Restricting the drag to the grab
 * area is what lets the composer scroll a long form inside a sheet that also drags away.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  Easing,
  KeyboardAvoidingView,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  StyleSheet,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { BORDER_WIDTH, MOTION } from '../tokens';
import { useTheme } from '../theme';
import { useReducedMotion } from './Motion';

/** Vertical movement, in points, before the handle claims the gesture from a tap. */
const DRAG_ACTIVATE = 6;
/** How far down a release dismisses. Roughly a thumb's comfortable travel. */
const DRAG_DISMISS_DISTANCE = 96;
/** Downward flick speed that dismisses regardless of distance. */
const DRAG_DISMISS_VELOCITY = 0.6;
/**
 * Resistance applied to an upward drag.
 *
 * The sheet does not expand, so up is not a real direction — but a handle that refuses to
 * move at all reads as broken rather than as bounded. A quarter of the finger's travel is
 * enough to say "this is as far as it goes".
 */
const DRAG_RUBBER_BAND = 0.25;
/** Travel used until `onLayout` reports the real height. Only ever hidden behind opacity. */
const FALLBACK_TRAVEL = 240;

export interface BottomSheetProps {
  visible: boolean;
  /**
   * Called for every dismissal route: backdrop tap, drag, and Android's hardware back.
   * The caller owns `visible`, so a sheet that must not close simply does not clear it.
   */
  onDismiss: () => void;
  children: React.ReactNode;
  /**
   * Rendered above `children`, inside the drag region.
   *
   * A sheet's title row is the natural thing to grab, so it is part of the handle rather
   * than part of the body. Interactive controls in here still work — the responder only
   * claims the gesture once the finger has moved vertically past `DRAG_ACTIVATE`.
   */
  header?: React.ReactNode;
  /**
   * Fraction of the screen the sheet may cover. The remainder is the canvas the user is
   * keeping their place in, so this is deliberately never 1.
   */
  maxHeightRatio?: number;
  /** The grabber. Off for a sheet that is not draggable by design. */
  showHandle?: boolean;
  /** Set false for a sheet holding work a stray tap must not discard. */
  dismissOnBackdropPress?: boolean;
}

export function BottomSheet({
  visible,
  onDismiss,
  children,
  header,
  maxHeightRatio = 0.92,
  showHandle = true,
  dismissOnBackdropPress = true,
}: BottomSheetProps) {
  const theme = useTheme();
  const reduced = useReducedMotion();
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();

  // Kept mounted through the exit animation: unmounting on `visible` alone would cut the
  // sheet off mid-slide, which is the bug that makes a dismissal feel like a crash.
  const [mounted, setMounted] = useState(visible);
  const [measured, setMeasured] = useState(0);

  // 0 is offscreen, 1 is settled. One driver for the entrance and the exit, so the scrim and
  // the sheet cannot drift out of phase.
  const progress = useRef(new Animated.Value(0)).current;
  const drag = useRef(new Animated.Value(0)).current;

  // True when a drag has already thrown the sheet offscreen, so the exit that follows the
  // caller clearing `visible` does not animate a sheet that is no longer on screen.
  const flung = useRef(false);
  // Guards the entrance against replaying on an open sheet. The effect depends on `reduced`,
  // which resolves asynchronously and can change mid-session when the user toggles the
  // setting from Control Centre — without this, a sheet with a half-written form in it would
  // slide up again under the keyboard.
  const entered = useRef(false);

  const travel = Math.max(measured, FALLBACK_TRAVEL);

  // Entrance.
  useEffect(() => {
    if (!visible) {
      entered.current = false;
      return;
    }
    if (entered.current) return;
    entered.current = true;

    flung.current = false;
    drag.setValue(0);
    setMounted(true);

    // Reduced motion — and the brief window before it is known — get the settled state.
    // See `Motion.tsx`: starting settled means a failed accessibility query costs the
    // animation, never the content.
    if (reduced === null || reduced) {
      progress.setValue(1);
      return;
    }

    progress.setValue(0);
    const animation = Animated.timing(progress, {
      toValue: 1,
      duration: MOTION.duration.slow,
      easing: Easing.bezier(...MOTION.easeOut),
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [visible, reduced, progress, drag]);

  // Exit.
  useEffect(() => {
    if (visible || !mounted) return;

    if (reduced || flung.current) {
      setMounted(false);
      return;
    }

    const animation = Animated.timing(progress, {
      toValue: 0,
      // Quicker than the entrance. Something arriving deserves a moment; something the user
      // has already dismissed is just in the way.
      duration: MOTION.duration.normal,
      easing: Easing.bezier(...MOTION.easeIn),
      useNativeDriver: true,
    });
    animation.start(({ finished }) => {
      if (finished) setMounted(false);
    });
    return () => animation.stop();
  }, [visible, mounted, reduced, progress]);

  const pan = useMemo(
    () =>
      PanResponder.create({
        // Never claims on touch-down: the header holds a close button, and a responder that
        // grabs the first touch would swallow its press.
        onStartShouldSetPanResponder: () => false,
        onMoveShouldSetPanResponder: (_event, gesture) =>
          Math.abs(gesture.dy) > DRAG_ACTIVATE && Math.abs(gesture.dy) > Math.abs(gesture.dx),
        // `setValue`, not `Animated.event`: the native driver cannot read a `PanResponder`
        // callback, but it accepts a value pushed to it from JS.
        onPanResponderMove: (_event, gesture) =>
          drag.setValue(gesture.dy > 0 ? gesture.dy : gesture.dy * DRAG_RUBBER_BAND),
        onPanResponderRelease: (_event, gesture) => {
          const thrown =
            gesture.dy > DRAG_DISMISS_DISTANCE || gesture.vy > DRAG_DISMISS_VELOCITY;

          if (!thrown) {
            Animated.spring(drag, {
              toValue: 0,
              damping: MOTION.spring.snappy.damping,
              stiffness: MOTION.spring.snappy.stiffness,
              mass: MOTION.spring.snappy.mass,
              useNativeDriver: true,
            }).start();
            return;
          }

          // Continues from wherever the finger left it — `drag` holds its position and
          // `progress` adds the remaining travel, so the sheet keeps moving in one line
          // rather than snapping back to be re-animated out.
          flung.current = true;
          Animated.timing(progress, {
            toValue: 0,
            duration: MOTION.duration.fast,
            easing: Easing.bezier(...MOTION.easeIn),
            useNativeDriver: true,
          }).start(({ finished }) => {
            if (finished) onDismiss();
          });
        },
        onPanResponderTerminate: () => {
          Animated.spring(drag, {
            toValue: 0,
            damping: MOTION.spring.snappy.damping,
            stiffness: MOTION.spring.snappy.stiffness,
            mass: MOTION.spring.snappy.mass,
            useNativeDriver: true,
          }).start();
        },
      }),
    [drag, progress, onDismiss],
  );

  const handleLayout = useCallback((height: number) => {
    // Only on a real change: `onLayout` fires on every keyboard resize and rotation, and
    // setting identical state each time would re-render the sheet on each one.
    setMeasured((current) => (Math.abs(current - height) > 0.5 ? height : current));
  }, []);

  if (!mounted) return null;

  const translateY = Animated.add(
    progress.interpolate({ inputRange: [0, 1], outputRange: [travel, 0] }),
    drag,
  );

  // The scrim fades with the drag as well as with the entrance, so dragging the sheet down
  // reveals the case underneath progressively — the gesture shows its own outcome.
  const scrimOpacity = Animated.multiply(
    progress,
    drag.interpolate({ inputRange: [0, travel], outputRange: [1, 0], extrapolate: 'clamp' }),
  );

  return (
    <Modal
      visible
      transparent
      // The sheet runs its own entrance, so the platform's would be a second animation on
      // top of it.
      animationType="none"
      onRequestClose={onDismiss}
      /*
        Left at the default `false` on purpose, and it is the keyboard that decides it.

        React Native's Android modal sets `SOFT_INPUT_ADJUST_RESIZE` on the dialog window
        unconditionally, but the resize only moves anything while the dialog also has
        `fitsSystemWindows` — which `ReactModalHostView` applies exactly when
        `statusBarTranslucent` is false. Turning it on to let the scrim paint under the
        status bar would buy a few points of tint at the cost of the sheet's own text
        inputs sitting behind the keyboard, which is the one failure this component exists
        to avoid. The strip of unscrimmed status bar on Android is the accepted price.
      */
      statusBarTranslucent={false}
    >
      <Animated.View
        style={[
          StyleSheet.absoluteFill,
          { backgroundColor: theme.colors.overlay, opacity: scrimOpacity },
        ]}
        pointerEvents="none"
      />

      {/*
        The backdrop is deliberately invisible to screen readers. It spans the whole screen,
        so announcing it as a button puts an unlabelled full-screen target in the reading
        order ahead of the sheet's content. Callers are expected to give the sheet its own
        visible close control — the composer's header does — which is the affordance a
        non-visual user gets instead.
      */}
      <Pressable
        style={StyleSheet.absoluteFill}
        // Spread rather than `onPress={… : undefined}`, matching the house pattern: an
        // explicit `undefined` on an optional prop is an error under
        // `exactOptionalPropertyTypes`, and a `Pressable` with no handler at all is also
        // the clearer statement of "this backdrop does nothing".
        {...(dismissOnBackdropPress ? { onPress: onDismiss } : {})}
        accessible={false}
        importantForAccessibility="no-hide-descendants"
      />

      <KeyboardAvoidingView
        style={styles.anchor}
        // `box-none` so the empty space above the sheet stays the backdrop's, not this
        // view's — otherwise the tap that should dismiss lands on a transparent container.
        pointerEvents="box-none"
        // Android needs nothing here: the modal window is already resizing (see the
        // `statusBarTranslucent` note above), and adding padding on top of that resize
        // pushes the sheet up twice.
        {...(Platform.OS === 'ios' ? { behavior: 'padding' as const } : {})}
      >
        <Animated.View
          onLayout={(event) => handleLayout(event.nativeEvent.layout.height)}
          style={[
            styles.lift,
            theme.elevation.high,
            {
              maxHeight: windowHeight * maxHeightRatio,
              // Hidden until the real height is known — see the file header.
              opacity: measured > 0 ? 1 : 0,
              transform: [{ translateY }],
            },
          ]}
          // iOS reads everything behind a transparent modal unless told the sheet is modal.
          accessibilityViewIsModal
        >
          <View
            style={[
              styles.sheet,
              {
                backgroundColor: theme.colors.surface,
                borderColor: theme.colors.border,
                // Top corners only. A sheet rounded at the bottom is a floating card that
                // happens to be low on the screen, which loses the "attached to the edge"
                // reading that makes it a sheet.
                borderTopLeftRadius: theme.radius.xl,
                borderTopRightRadius: theme.radius.xl,
              },
            ]}
          >
            <View {...pan.panHandlers}>
              {showHandle ? (
                <View style={[styles.handleArea, { paddingVertical: theme.spacing.lg }]}>
                  <View
                    style={[styles.handle, { backgroundColor: theme.colors.borderStrong }]}
                    // Decoration for a pointer user and noise for everyone else: the drag
                    // it advertises has no screen-reader equivalent, and the close control
                    // in the header does.
                    accessibilityElementsHidden
                    importantForAccessibility="no"
                  />
                </View>
              ) : null}
              {header}
            </View>

            {children}

            {/*
              The bottom safe area, painted by the sheet rather than left to the caller.
              Without it the sheet's own background stops above the home indicator and the
              canvas shows through under it.
            */}
            <View style={{ height: insets.bottom }} pointerEvents="none" />
          </View>
        </Animated.View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  anchor: { flex: 1, justifyContent: 'flex-end' },
  // The transform and the shadow live out here; the clipping lives inside. Android clips a
  // shadow to the same bounds as the content when `overflow: 'hidden'` is on the shadowed
  // view, so a single view would round its corners and lose its elevation.
  lift: { flexShrink: 1 },
  sheet: {
    flexShrink: 1,
    overflow: 'hidden',
    borderTopWidth: BORDER_WIDTH.hairline,
    borderLeftWidth: BORDER_WIDTH.hairline,
    borderRightWidth: BORDER_WIDTH.hairline,
  },
  handleArea: { alignItems: 'center' },
  handle: { width: 36, height: 4, borderRadius: 2 },
});
