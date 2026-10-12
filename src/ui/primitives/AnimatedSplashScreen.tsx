import React, { useEffect, useRef } from 'react';
import {
  Animated,
  Easing,
  Image,
  StyleSheet,
  Text,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';

import {
  SPLASH_OVERLAY_CEILING_MS,
  SPLASH_OVERLAY_EXIT_MS,
  SPLASH_OVERLAY_SETTLE_MS,
} from '@services/auth/launch';
import { FONT_FAMILY } from '../tokens';
import { useReducedMotion } from './Motion';
import { DetectiveMascot } from './DetectiveMascot';

interface AnimatedSplashScreenProps {
  isReady: boolean;
  onFinish: () => void;
}

const GOLD = '#BEA860';
const GOLD_TEXT = '#D4C491';

export function AnimatedSplashScreen({ isReady, onFinish }: AnimatedSplashScreenProps) {

  const { width } = useWindowDimensions();

  const reducedMotion = useReducedMotion();

  const logoScale = useRef(new Animated.Value(1)).current;
  const logoOpacity = useRef(new Animated.Value(1)).current;
  const contentOpacity = useRef(new Animated.Value(1)).current;
  const contentTranslateY = useRef(new Animated.Value(0)).current;
  const progressScale = useRef(new Animated.Value(1)).current;
  const screenOpacity = useRef(new Animated.Value(1)).current;
  const pulseAnim = useRef(new Animated.Value(0)).current;

  const hasFinishedRef = useRef(false);
  const reducedMotionRef = useRef(reducedMotion);
  reducedMotionRef.current = reducedMotion;

  const safeFinish = () => {
    if (hasFinishedRef.current) return;
    hasFinishedRef.current = true;
    Animated.parallel([
      Animated.timing(screenOpacity, {
        toValue: 0,
        duration: SPLASH_OVERLAY_EXIT_MS,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(logoScale, {
        toValue: 1.12,
        duration: SPLASH_OVERLAY_EXIT_MS,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(contentOpacity, {
        toValue: 0,
        duration: SPLASH_OVERLAY_EXIT_MS * 0.8,
        useNativeDriver: true,
      }),
    ]).start(() => {
      onFinish();
    });
  };

  const safeFinishRef = useRef(safeFinish);
  safeFinishRef.current = safeFinish;

  useEffect(() => {
    if (reducedMotionRef.current !== false) return;

    logoOpacity.setValue(0);
    logoScale.setValue(0.82);
    contentOpacity.setValue(0);
    contentTranslateY.setValue(18);
    progressScale.setValue(0.01);

    Animated.sequence([
      Animated.parallel([
        Animated.timing(logoOpacity, {
          toValue: 1,
          duration: 380,
          useNativeDriver: true,
        }),
        Animated.spring(logoScale, {
          toValue: 1,
          friction: 6,
          tension: 50,
          useNativeDriver: true,
        }),
      ]),
      Animated.parallel([
        Animated.timing(contentOpacity, {
          toValue: 1,
          duration: 300,
          useNativeDriver: true,
        }),
        Animated.timing(contentTranslateY, {
          toValue: 0,
          duration: 300,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.timing(progressScale, {
          toValue: 1,
          duration: 1900,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
      ]),
    ]).start();

    const pulseLoop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, {
          toValue: 1,
          duration: 1600,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(pulseAnim, {
          toValue: 0,
          duration: 1600,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ]),
    );
    pulseLoop.start();

    return () => pulseLoop.stop();
  }, [contentOpacity, contentTranslateY, logoOpacity, logoScale, progressScale, pulseAnim]);

  useEffect(() => {
    const ceilingTimer = setTimeout(() => {
      safeFinishRef.current();
    }, SPLASH_OVERLAY_CEILING_MS);
    return () => clearTimeout(ceilingTimer);
  }, []);

  useEffect(() => {
    if (!isReady) return;
    const settle = reducedMotion === true ? 0 : SPLASH_OVERLAY_SETTLE_MS;
    const settleTimer = setTimeout(() => {
      safeFinishRef.current();
    }, settle);
    return () => clearTimeout(settleTimer);
  }, [isReady, reducedMotion]);

  return (
    <Animated.View style={[styles.container, { opacity: screenOpacity }]}>
      {}
      <LinearGradient
        colors={['#050B1E', '#0A1538']}
        style={StyleSheet.absoluteFillObject}
        start={{ x: 0.5, y: 0 }}
        end={{ x: 0.5, y: 1 }}
      />

      {}
      <View style={styles.centerStage}>
        {}
        <View style={styles.logoWrapper}>
          <Animated.View
            style={[
              styles.pulseHalo,
              {
                opacity: pulseAnim.interpolate({
                  inputRange: [0, 1],
                  outputRange: [0.15, 0.4],
                }),
                transform: [
                  {
                    scale: pulseAnim.interpolate({
                      inputRange: [0, 1],
                      outputRange: [0.96, 1.14],
                    }),
                  },
                ],
              },
            ]}
          />
          <Animated.View
            style={[
              styles.logoContainer,
              {
                opacity: logoOpacity,
                transform: [{ scale: logoScale }],
              },
            ]}
          >
            <DetectiveMascot size={136} animated={true} />
          </Animated.View>
        </View>

        {}
        <View style={[styles.progressBarWrapper, { width: width * 0.44 }]}>
          <Animated.View
            style={[
              styles.progressBarFill,
              {
                transform: [{ scaleX: progressScale }],
              },
            ]}
          />
        </View>
      </View>

      {}
      <TouchableOpacity
        activeOpacity={0.7}
        onPress={safeFinish}
        style={styles.skipButton}

        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        accessibilityRole="button"

        accessibilityLabel="Skip the opening animation"
      >
        <Text style={styles.skipButtonText}>Skip ›</Text>
      </TouchableOpacity>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 99999,
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 56,
  },
  centerStage: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 24,
  },
  logoWrapper: {
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 28,
  },
  pulseHalo: {
    position: 'absolute',
    width: 126,
    height: 126,
    borderRadius: 36,
    backgroundColor: 'rgba(190, 168, 96, 0.22)',
  },
  logoContainer: {
    width: 124,
    height: 124,
    alignItems: 'center',
    justifyContent: 'center',
  },
  typographyBlock: {
    alignItems: 'center',
    marginBottom: 28,
  },

  brandTitle: {
    fontFamily: FONT_FAMILY.sansExtraBold,
    fontSize: 34,
    color: '#FFFFFF',
    letterSpacing: 0.5,
    marginBottom: 10,
  },
  brandTagline: {
    fontFamily: FONT_FAMILY.sansMedium,
    fontSize: 14,
    color: GOLD_TEXT,
    textAlign: 'center',
    maxWidth: 300,
    lineHeight: 20,
  },
  progressBarWrapper: {
    height: 3,
    borderRadius: 999,
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
    overflow: 'hidden',
  },
  progressBarFill: {
    width: '100%',
    height: '100%',
    borderRadius: 999,
    backgroundColor: GOLD,
  },
  skipButton: {
    position: 'absolute',
    top: 52,
    right: 22,
    paddingHorizontal: 14,
    paddingVertical: 7,
  },
  skipButtonText: {
    fontSize: 12.5,
    fontWeight: '600',
    color: 'rgba(255, 255, 255, 0.6)',
  },
});
