import React, { useMemo, useRef } from 'react';
import {
  Animated,
  PanResponder,
  Platform,
  StyleSheet,
  View,
  type GestureResponderEvent,
  type PanResponderGestureState,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';

import { useTheme } from '../theme';
import { MOTION } from '../tokens';
import { useReducedMotion } from './Motion';

export interface DraggableBannerProps {

  children?: React.ReactNode;

  mascot?: React.ReactNode;

  maxDragY?: number;

  maxDragX?: number;

  onDragStart?: () => void;

  onDragEnd?: () => void;

  style?: StyleProp<ViewStyle>;

  testID?: string;
}

const DRAG_ACTIVATE_DISTANCE = 4;
const DEFAULT_MAX_DRAG_Y = 60;
const DEFAULT_MAX_DRAG_X = 48;
const PARALLAX_MASCOT_MULTIPLIER = 1.35;

export function DraggableBanner({
  children,
  mascot,
  maxDragY = DEFAULT_MAX_DRAG_Y,
  maxDragX = DEFAULT_MAX_DRAG_X,
  onDragStart,
  onDragEnd,
  style,
  testID,
}: DraggableBannerProps) {
  const theme = useTheme();
  const reduced = useReducedMotion();

  const dragX = useRef(new Animated.Value(0)).current;
  const dragY = useRef(new Animated.Value(0)).current;
  const isDragging = useRef(new Animated.Value(0)).current;

  const computeElastic = (raw: number, limit: number, stiffnessFactor: number) => {
    if (raw === 0) return 0;
    const sign = Math.sign(raw);
    const abs = Math.abs(raw);

    return sign * (limit * (abs / (limit + abs * stiffnessFactor)));
  };

  const panResponder = useMemo(
    () =>
      PanResponder.create({

        onStartShouldSetPanResponder: () => false,

        onMoveShouldSetPanResponder: (_event, gesture) => {
          if (reduced) return false;
          return (
            Math.abs(gesture.dx) > DRAG_ACTIVATE_DISTANCE ||
            Math.abs(gesture.dy) > DRAG_ACTIVATE_DISTANCE
          );
        },

        onPanResponderGrant: () => {
          onDragStart?.();
          Animated.timing(isDragging, {
            toValue: 1,
            duration: MOTION.duration.instant,
            useNativeDriver: true,
          }).start();
        },

        onPanResponderMove: (_event, gesture) => {

          const elasticX = computeElastic(gesture.dx, maxDragX, 0.4);
          const elasticY = computeElastic(gesture.dy, maxDragY, 0.35);

          dragX.setValue(elasticX);
          dragY.setValue(elasticY);
        },

        onPanResponderRelease: (_event, gesture) => {
          onDragEnd?.();

          Animated.parallel([
            Animated.spring(dragX, {
              toValue: 0,
              velocity: gesture.vx * 0.4,
              damping: MOTION.spring.snappy.damping,   
              stiffness: MOTION.spring.snappy.stiffness, 
              mass: MOTION.spring.snappy.mass,           
              useNativeDriver: true,
            }),
            Animated.spring(dragY, {
              toValue: 0,
              velocity: gesture.vy * 0.4,
              damping: MOTION.spring.snappy.damping,   
              stiffness: MOTION.spring.snappy.stiffness, 
              mass: MOTION.spring.snappy.mass,           
              useNativeDriver: true,
            }),
            Animated.timing(isDragging, {
              toValue: 0,
              duration: MOTION.duration.fast,
              useNativeDriver: true,
            }),
          ]).start();
        },

        onPanResponderTerminate: () => {
          onDragEnd?.();
          Animated.parallel([
            Animated.spring(dragX, {
              toValue: 0,
              damping: MOTION.spring.snappy.damping,
              stiffness: MOTION.spring.snappy.stiffness,
              mass: MOTION.spring.snappy.mass,
              useNativeDriver: true,
            }),
            Animated.spring(dragY, {
              toValue: 0,
              damping: MOTION.spring.snappy.damping,
              stiffness: MOTION.spring.snappy.stiffness,
              mass: MOTION.spring.snappy.mass,
              useNativeDriver: true,
            }),
            Animated.timing(isDragging, {
              toValue: 0,
              duration: MOTION.duration.fast,
              useNativeDriver: true,
            }),
          ]).start();
        },
      }),
    [dragX, dragY, isDragging, maxDragX, maxDragY, onDragStart, onDragEnd, reduced],
  );

  const bannerRotateZ = dragX.interpolate({
    inputRange: [-maxDragX, 0, maxDragX],
    outputRange: ['-6deg', '0deg', '6deg'],
    extrapolate: 'clamp',
  });

  const bannerRotateX = dragY.interpolate({
    inputRange: [-maxDragY, 0, maxDragY],
    outputRange: ['5deg', '0deg', '-5deg'],
    extrapolate: 'clamp',
  });

  const bannerRotateY = dragX.interpolate({
    inputRange: [-maxDragX, 0, maxDragX],
    outputRange: ['-5deg', '0deg', '5deg'],
    extrapolate: 'clamp',
  });

  const bannerScale = dragY.interpolate({
    inputRange: [-maxDragY, 0, maxDragY],
    outputRange: [0.985, 1.0, 0.985],
    extrapolate: 'clamp',
  });

  const mascotTranslateX = dragX.interpolate({
    inputRange: [-maxDragX, 0, maxDragX],
    outputRange: [-maxDragX * PARALLAX_MASCOT_MULTIPLIER, 0, maxDragX * PARALLAX_MASCOT_MULTIPLIER],
    extrapolate: 'clamp',
  });

  const mascotTranslateY = dragY.interpolate({
    inputRange: [-maxDragY, 0, maxDragY],
    outputRange: [-maxDragY * PARALLAX_MASCOT_MULTIPLIER, 0, maxDragY * PARALLAX_MASCOT_MULTIPLIER],
    extrapolate: 'clamp',
  });

  const mascotRotateZ = dragX.interpolate({
    inputRange: [-maxDragX, 0, maxDragX],
    outputRange: ['-8.1deg', '0deg', '8.1deg'],
    extrapolate: 'clamp',
  });

  const bannerTransformStyle = reduced
    ? {}
    : {
        transform: [
          { perspective: 800 },
          { translateX: dragX },
          { translateY: dragY },
          { rotateZ: bannerRotateZ },
          { rotateX: bannerRotateX },
          { rotateY: bannerRotateY },
          { scale: bannerScale },
        ],
      };

  const mascotTransformStyle = reduced
    ? {}
    : {
        transform: [
          { translateX: mascotTranslateX },
          { translateY: mascotTranslateY },
          { rotateZ: mascotRotateZ },
        ],
      };

  return (
    <View testID={testID} style={[styles.outerWrapper, style]}>
      {}
      <Animated.View
        style={[styles.bannerContainer, bannerTransformStyle]}
        {...panResponder.panHandlers}
      >
        {}
        <LinearGradient
          colors={['#0E1D44', '#0A1530', '#070D21']}
          start={{ x: 0.5, y: 0 }}
          end={{ x: 0.5, y: 1 }}
          style={StyleSheet.absoluteFillObject}
        />

        {}
        <LinearGradient
          colors={['rgba(168, 198, 255, 0.08)', 'rgba(168, 198, 255, 0.015)', 'transparent']}
          start={{ x: 0.5, y: 0 }}
          end={{ x: 0.5, y: 0.7 }}
          style={StyleSheet.absoluteFillObject}
          pointerEvents="none"
        />

        {}
        <View style={styles.contentRow}>
          {}
          {mascot && (
            <Animated.View style={[styles.mascotWrapper, mascotTransformStyle]}>
              {mascot}
            </Animated.View>
          )}

          {}
          <View style={styles.childrenWrapper}>{children}</View>
        </View>

        {}
        <View style={styles.bottomHairline} pointerEvents="none" />

        {}
        <View style={styles.handleContainer} pointerEvents="none">
          <View style={styles.handlePill} />
        </View>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  outerWrapper: {
    width: '100%',
    overflow: 'visible',
    zIndex: 10,
  },
  bannerContainer: {
    width: '100%',
    borderBottomLeftRadius: 36,
    borderBottomRightRadius: 36,
    overflow: 'hidden',
    paddingTop: 16,
    paddingBottom: 22,
    paddingHorizontal: 20,
    borderWidth: 1,
    borderTopWidth: 0,
    borderColor: 'rgba(160, 188, 240, 0.22)',

    ...Platform.select({
      ios: {
        shadowColor: '#000000',
        shadowOffset: { width: 0, height: 12 },
        shadowOpacity: 0.5,
        shadowRadius: 18,
      },
      android: {
        elevation: 10,
      },
      default: {},
    }),
  },
  contentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
  },
  mascotWrapper: {
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 2,
  },
  childrenWrapper: {
    flex: 1,
    justifyContent: 'center',
    zIndex: 1,
  },
  bottomHairline: {
    position: 'absolute',
    bottom: 0,
    left: 24,
    right: 24,
    height: 1.5,
    backgroundColor: 'rgba(196, 218, 255, 0.25)',
  },
  handleContainer: {
    position: 'absolute',
    bottom: 6,
    left: 0,
    right: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  handlePill: {
    width: 32,
    height: 3.5,
    borderRadius: 2,
    backgroundColor: 'rgba(168, 198, 255, 0.28)',
  },
});
