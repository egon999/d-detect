import React, { useEffect, useRef } from 'react';
import { Animated, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useReducedMotion } from './Motion';

export interface AuroraBackgroundProps {
  children?: React.ReactNode;
  style?: StyleProp<ViewStyle>;

  primaryGlow?: string;

  secondaryGlow?: string;
}

export function AuroraBackground({
  children,
  style,
  primaryGlow = '#1E40AF',
  secondaryGlow = '#00F0FF',
}: AuroraBackgroundProps) {
  const reduced = useReducedMotion();
  const orb1Opacity = useRef(new Animated.Value(0.35)).current;
  const orb2Opacity = useRef(new Animated.Value(0.25)).current;
  const orb1Scale = useRef(new Animated.Value(1)).current;
  const orb2Scale = useRef(new Animated.Value(1.1)).current;

  useEffect(() => {
    if (reduced) return;

    const anim1 = Animated.loop(
      Animated.sequence([
        Animated.parallel([
          Animated.timing(orb1Opacity, {
            toValue: 0.6,
            duration: 6000,
            useNativeDriver: true,
          }),
          Animated.timing(orb1Scale, {
            toValue: 1.25,
            duration: 6000,
            useNativeDriver: true,
          }),
        ]),
        Animated.parallel([
          Animated.timing(orb1Opacity, {
            toValue: 0.35,
            duration: 6000,
            useNativeDriver: true,
          }),
          Animated.timing(orb1Scale, {
            toValue: 1,
            duration: 6000,
            useNativeDriver: true,
          }),
        ]),
      ]),
    );

    const anim2 = Animated.loop(
      Animated.sequence([
        Animated.parallel([
          Animated.timing(orb2Opacity, {
            toValue: 0.45,
            duration: 8000,
            useNativeDriver: true,
          }),
          Animated.timing(orb2Scale, {
            toValue: 0.9,
            duration: 8000,
            useNativeDriver: true,
          }),
        ]),
        Animated.parallel([
          Animated.timing(orb2Opacity, {
            toValue: 0.2,
            duration: 8000,
            useNativeDriver: true,
          }),
          Animated.timing(orb2Scale, {
            toValue: 1.15,
            duration: 8000,
            useNativeDriver: true,
          }),
        ]),
      ]),
    );

    anim1.start();
    anim2.start();

    return () => {
      anim1.stop();
      anim2.stop();
    };
  }, [reduced, orb1Opacity, orb2Opacity, orb1Scale, orb2Scale]);

  return (
    <View style={[styles.container, style]}>
      {}
      <LinearGradient
        colors={['#050A1A', '#08112A', '#0B1638']}
        start={{ x: 0.5, y: 0 }}
        end={{ x: 0.5, y: 1 }}
        style={StyleSheet.absoluteFillObject}
      />

      {}
      <Animated.View
        pointerEvents="none"
        style={[
          styles.orb,
          styles.orbTop,
          {
            backgroundColor: primaryGlow,
            opacity: orb1Opacity,
            transform: [{ scale: orb1Scale }],
          },
        ]}
      />

      {}
      <Animated.View
        pointerEvents="none"
        style={[
          styles.orb,
          styles.orbBottom,
          {
            backgroundColor: secondaryGlow,
            opacity: orb2Opacity,
            transform: [{ scale: orb2Scale }],
          },
        ]}
      />

      {}
      <View style={styles.content}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    position: 'relative',
    backgroundColor: '#050A1A',
  },
  content: {
    flex: 1,
    zIndex: 1,
  },
  orb: {
    position: 'absolute',
    borderRadius: 999,
  },
  orbTop: {
    width: 380,
    height: 380,
    top: -100,
    left: -80,
    filter: 'blur(60px)',
  },
  orbBottom: {
    width: 320,
    height: 320,
    bottom: 40,
    right: -60,
    filter: 'blur(70px)',
  },
});
