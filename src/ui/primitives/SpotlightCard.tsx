import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Animated,
  Platform,
  Pressable,
  StyleSheet,
  View,
  type GestureResponderEvent,
  type LayoutChangeEvent,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import { useReducedMotion } from './Motion';

export interface SpotlightCardProps {
  children?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  onPress?: () => void;

  glowColor?: string;

  edgeColor?: string;

  ambient?: boolean;

  borderRadius?: number;

  disablePressScale?: boolean;

  accessibilityLabel?: string;
}

export function SpotlightCard({
  children,
  style,
  onPress,
  glowColor = 'rgba(58, 134, 255, 0.4)',
  edgeColor = 'rgba(0, 240, 255, 0.35)',
  ambient = true,
  borderRadius = 20,
  disablePressScale = false,
  accessibilityLabel,
}: SpotlightCardProps) {
  const reduced = useReducedMotion();
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });

  const spotX = useRef(new Animated.Value(0)).current;
  const spotY = useRef(new Animated.Value(0)).current;
  const spotOpacity = useRef(new Animated.Value(0.38)).current;
  const scaleAnim = useRef(new Animated.Value(1)).current;
  const tiltPitch = useRef(new Animated.Value(0)).current;
  const tiltRoll = useRef(new Animated.Value(0)).current;
  const ambientAnim = useRef<Animated.CompositeAnimation | null>(null);

  const onLayout = useCallback((e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    setDimensions({ width, height });
    spotX.setValue(width * 0.5);
    spotY.setValue(height * 0.4);
  }, [spotX, spotY]);

  useEffect(() => {
    if (reduced || !ambient || dimensions.width === 0) return;

    spotX.setValue(dimensions.width * 0.5);
    spotY.setValue(dimensions.height * 0.38);

    const pulseLoop = Animated.loop(
      Animated.sequence([
        Animated.timing(spotOpacity, {
          toValue: 0.52,
          duration: 2600,
          useNativeDriver: false,
        }),
        Animated.timing(spotOpacity, {
          toValue: 0.32,
          duration: 2600,
          useNativeDriver: false,
        }),
      ]),
    );

    ambientAnim.current = pulseLoop;
    pulseLoop.start();

    return () => pulseLoop.stop();
  }, [reduced, ambient, dimensions, spotX, spotY, spotOpacity]);

  const handlePressIn = (e: GestureResponderEvent) => {
    if (ambientAnim.current) ambientAnim.current.stop();
    const { locationX, locationY } = e.nativeEvent;
    spotX.setValue(locationX);
    spotY.setValue(locationY);

    const normX = dimensions.width > 0 ? (locationX / dimensions.width - 0.5) * 2 : 0;
    const normY = dimensions.height > 0 ? (locationY / dimensions.height - 0.5) * 2 : 0;

    Animated.parallel([
      Animated.timing(spotOpacity, {
        toValue: 0.85,
        duration: 120,
        useNativeDriver: false,
      }),
      Animated.spring(tiltPitch, {
        toValue: normY,
        damping: 18,
        stiffness: 280,
        useNativeDriver: true,
      }),
      Animated.spring(tiltRoll, {
        toValue: -normX,
        damping: 18,
        stiffness: 280,
        useNativeDriver: true,
      }),
      !disablePressScale
        ? Animated.spring(scaleAnim, {
            toValue: 0.985,
            friction: 8,
            tension: 400,
            useNativeDriver: true,
          })
        : Animated.delay(0),
    ]).start();

    if (Platform.OS !== 'web') {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    }
  };

  const handlePressOut = () => {
    Animated.parallel([
      Animated.timing(spotOpacity, {
        toValue: 0.38,
        duration: 300,
        useNativeDriver: false,
      }),
      Animated.spring(tiltPitch, {
        toValue: 0,
        damping: 18,
        stiffness: 260,
        useNativeDriver: true,
      }),
      Animated.spring(tiltRoll, {
        toValue: 0,
        damping: 18,
        stiffness: 260,
        useNativeDriver: true,
      }),
      !disablePressScale
        ? Animated.spring(scaleAnim, {
            toValue: 1,
            friction: 8,
            tension: 300,
            useNativeDriver: true,
          })
        : Animated.delay(0),
    ]).start();
  };

  const CardWrapper = onPress ? Pressable : View;

  const tiltTransform = reduced
    ? [{ scale: scaleAnim }]
    : [
        { perspective: 900 },
        { scale: scaleAnim },
        {
          rotateX: tiltPitch.interpolate({
            inputRange: [-1, 0, 1],
            outputRange: ['3deg', '0deg', '-3deg'],
          }),
        },
        {
          rotateY: tiltRoll.interpolate({
            inputRange: [-1, 0, 1],
            outputRange: ['-3deg', '0deg', '3deg'],
          }),
        },
      ];

  return (
    <Animated.View
      style={[
        styles.outerContainer,
        { transform: tiltTransform },
      ]}
    >
      <CardWrapper
        onLayout={onLayout}
        onPress={onPress}
        onPressIn={onPress ? handlePressIn : undefined}
        onPressOut={onPress ? handlePressOut : undefined}
        accessible
        accessibilityRole={onPress ? 'button' : undefined}
        accessibilityLabel={accessibilityLabel}
        style={[
          styles.card,
          { borderRadius },
          style,
        ]}
      >
        {}
        <LinearGradient
          colors={['#0C1635', '#081026', '#060B1C']}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={[StyleSheet.absoluteFillObject, { borderRadius }]}
        />

        {}
        {dimensions.width > 0 && (
          <Animated.View
            pointerEvents="none"
            style={[
              styles.spotlight,
              {
                width: dimensions.width * 1.3,
                height: dimensions.width * 1.3,
                left: Animated.subtract(spotX, dimensions.width * 0.65),
                top: Animated.subtract(spotY, dimensions.width * 0.65),
                opacity: spotOpacity,
              },
            ]}
          >
            <LinearGradient
              colors={[glowColor, edgeColor, 'transparent']}
              start={{ x: 0.5, y: 0.5 }}
              end={{ x: 1, y: 1 }}
              style={StyleSheet.absoluteFillObject}
            />
          </Animated.View>
        )}

        {}
        <Animated.View
          pointerEvents="none"
          style={[
            styles.edgeRing,
            {
              borderRadius,
              borderColor: glowColor,
              opacity: spotOpacity.interpolate({
                inputRange: [0.3, 0.85],
                outputRange: [0.35, 0.75],
                extrapolate: 'clamp',
              }),
            },
          ]}
        />

        {}
        <LinearGradient
          pointerEvents="none"
          colors={['rgba(255, 255, 255, 0.15)', 'rgba(58, 134, 255, 0.08)', 'transparent']}
          start={{ x: 0, y: 0 }}
          end={{ x: 0, y: 1 }}
          style={[styles.specularTop, { borderTopLeftRadius: borderRadius, borderTopRightRadius: borderRadius }]}
        />

        {}
        <View style={styles.content}>{children}</View>
      </CardWrapper>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  outerContainer: {
    width: '100%',
    alignSelf: 'stretch',
    maxWidth: '100%',
  },
  card: {
    position: 'relative',
    overflow: 'hidden',
    backgroundColor: '#0A1329',
    width: '100%',
  },
  content: {
    position: 'relative',
    zIndex: 2,
    width: '100%',
  },
  spotlight: {
    position: 'absolute',
    borderRadius: 999,
    zIndex: 0,
  },
  edgeRing: {
    ...StyleSheet.absoluteFillObject,
    borderWidth: 1,
    zIndex: 1,
  },
  specularTop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 1.5,
    zIndex: 3,
  },
});
