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

const DRAG_ACTIVATE = 6;

const DRAG_DISMISS_DISTANCE = 96;

const DRAG_DISMISS_VELOCITY = 0.6;

const DRAG_RUBBER_BAND = 0.25;

const FALLBACK_TRAVEL = 240;

export interface BottomSheetProps {
  visible: boolean;

  onDismiss: () => void;
  children: React.ReactNode;

  header?: React.ReactNode;

  maxHeightRatio?: number;

  showHandle?: boolean;

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

  const [mounted, setMounted] = useState(visible);
  const [measured, setMeasured] = useState(0);

  const progress = useRef(new Animated.Value(0)).current;
  const drag = useRef(new Animated.Value(0)).current;

  const flung = useRef(false);

  const entered = useRef(false);

  const travel = Math.max(measured, FALLBACK_TRAVEL);

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

  useEffect(() => {
    if (visible || !mounted) return;

    if (reduced || flung.current) {
      setMounted(false);
      return;
    }

    const animation = Animated.timing(progress, {
      toValue: 0,

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

        onStartShouldSetPanResponder: () => false,
        onMoveShouldSetPanResponder: (_event, gesture) =>
          Math.abs(gesture.dy) > DRAG_ACTIVATE && Math.abs(gesture.dy) > Math.abs(gesture.dx),

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

    setMeasured((current) => (Math.abs(current - height) > 0.5 ? height : current));
  }, []);

  if (!mounted) return null;

  const translateY = Animated.add(
    progress.interpolate({ inputRange: [0, 1], outputRange: [travel, 0] }),
    drag,
  );

  const scrimOpacity = Animated.multiply(
    progress,
    drag.interpolate({ inputRange: [0, travel], outputRange: [1, 0], extrapolate: 'clamp' }),
  );

  return (
    <Modal
      visible
      transparent

      animationType="none"
      onRequestClose={onDismiss}

      statusBarTranslucent={false}
    >
      <Animated.View
        style={[
          StyleSheet.absoluteFill,
          { backgroundColor: theme.colors.overlay, opacity: scrimOpacity },
        ]}
        pointerEvents="none"
      />

      {}
      <Pressable
        style={StyleSheet.absoluteFill}

        {...(dismissOnBackdropPress ? { onPress: onDismiss } : {})}
        accessible={false}
        importantForAccessibility="no-hide-descendants"
      />

      <KeyboardAvoidingView
        style={styles.anchor}

        pointerEvents="box-none"

        {...(Platform.OS === 'ios' ? { behavior: 'padding' as const } : {})}
      >
        <Animated.View
          onLayout={(event) => handleLayout(event.nativeEvent.layout.height)}
          style={[
            styles.lift,
            theme.elevation.high,
            {
              maxHeight: windowHeight * maxHeightRatio,

              opacity: measured > 0 ? 1 : 0,
              transform: [{ translateY }],
            },
          ]}

          accessibilityViewIsModal
        >
          <View
            style={[
              styles.sheet,
              {
                backgroundColor: theme.colors.surface,
                borderColor: theme.colors.border,

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

                    accessibilityElementsHidden
                    importantForAccessibility="no"
                  />
                </View>
              ) : null}
              {header}
            </View>

            {children}

            {}
            <View style={{ height: insets.bottom }} pointerEvents="none" />
          </View>
        </Animated.View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  anchor: { flex: 1, justifyContent: 'flex-end' },

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
