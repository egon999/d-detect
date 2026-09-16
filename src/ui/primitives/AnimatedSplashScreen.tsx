import React, { useEffect, useRef } from 'react';
import {
  Animated,
  Dimensions,
  Image,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';

import { FONT_FAMILY } from '../tokens';

const { width } = Dimensions.get('window');

interface AnimatedSplashScreenProps {
  isReady: boolean;
  onFinish: () => void;
}

/**
 * The launch screen.
 *
 * ## Why this is dark regardless of the app's theme
 *
 * The native splash configured in `app.json` is `#030712` for both light and dark. This
 * overlay hands off directly from it, so if it respected the light theme the user would see
 * a dark-to-white flash at the seam. It stays dark and matches the native background; the
 * app's real (possibly light) canvas appears only once this lifts.
 *
 * ## What this screen deliberately does not do
 *
 * An earlier version headlined "Find the Truth." — the exact framing the product is built to
 * avoid, since evidence is reported in graded states (supported, conflicting, insufficient),
 * never as a verdict. It also carried glowing halos, a "liquid glass" logo, and a row of
 * "AI Powered · Deterministic Rules · Evidence Graph" pills: decoration and feature-boasting
 * on the one screen a user cannot act on. All of it is gone. What is left is the mark, the
 * name, one honest line about what the app does, and a progress cue — with a single muted
 * gold accent, which is the brand's whole visual vocabulary.
 *
 * The colours are fixed hex rather than theme tokens on purpose: the theme resolves to white
 * surfaces in light mode, and this screen must not.
 */

// The muted brand gold — `gold500` / `gold300` from `src/ui/tokens.ts`, inlined because this
// screen must render dark before (and independently of) the theme provider's palette.
const GOLD = '#BEA860';
const GOLD_TEXT = '#D4C491';

export function AnimatedSplashScreen({ isReady, onFinish }: AnimatedSplashScreenProps) {
  const logoScale = useRef(new Animated.Value(0.82)).current;
  const logoOpacity = useRef(new Animated.Value(0)).current;
  const contentOpacity = useRef(new Animated.Value(0)).current;
  const contentTranslateY = useRef(new Animated.Value(18)).current;
  const progressScale = useRef(new Animated.Value(0.01)).current;
  const screenOpacity = useRef(new Animated.Value(1)).current;

  const hasFinishedRef = useRef(false);

  const safeFinish = () => {
    if (hasFinishedRef.current) return;
    hasFinishedRef.current = true;
    Animated.timing(screenOpacity, {
      toValue: 0,
      duration: 260,
      useNativeDriver: true,
    }).start(() => {
      onFinish();
    });
  };

  useEffect(() => {
    // 1. Entrance animation - ALL using useNativeDriver: true to prevent any React Native crash!
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
          useNativeDriver: true,
        }),
        Animated.timing(progressScale, {
          toValue: 1,
          duration: 700,
          useNativeDriver: true,
        }),
      ]),
    ]).start();

    // 2. Guaranteed Fail-Safe Dismissal
    const failsafeTimer = setTimeout(() => {
      safeFinish();
    }, 1100);

    return () => {
      clearTimeout(failsafeTimer);
    };
  }, []);

  useEffect(() => {
    if (isReady) {
      const settleTimer = setTimeout(() => {
        safeFinish();
      }, 650);
      return () => clearTimeout(settleTimer);
    }
  }, [isReady]);

  return (
    <Animated.View style={[styles.container, { opacity: screenOpacity }]}>
      {/* Dark royal blue foundation. Two near-black stops, a barely-there deepening rather
          than a decorative sweep — the same restraint the rest of the app applies to gradient. */}
      <LinearGradient
        colors={['#050B1E', '#0A1538']}
        style={StyleSheet.absoluteFillObject}
        start={{ x: 0.5, y: 0 }}
        end={{ x: 0.5, y: 1 }}
      />

      {/* Center Stage */}
      <View style={styles.centerStage}>
        {/* Logo — a plain rounded container with a hairline gold edge. No glow, no glass fill. */}
        <Animated.View
          style={[
            styles.logoContainer,
            {
              opacity: logoOpacity,
              transform: [{ scale: logoScale }],
            },
          ]}
        >
          <Image
            source={require('../../../assets/dd.png')}
            style={styles.logoImage}
            resizeMode="contain"
          />
        </Animated.View>

        {/* Wordmark + one honest line about what the app does. */}
        <Animated.View
          style={[
            styles.typographyBlock,
            {
              opacity: contentOpacity,
              transform: [{ translateY: contentTranslateY }],
            },
          ]}
        >
          <Text style={styles.brandTitle}>Ddetect</Text>
          <Text style={styles.brandTagline}>Where your evidence agrees — and where it doesn&apos;t</Text>
        </Animated.View>

        {/* Progress cue — a thin gold fill, the one accent this screen spends. */}
        <View style={styles.progressBarWrapper}>
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

      {/* 1-Tap Skip Bypass Button */}
      <TouchableOpacity activeOpacity={0.7} onPress={safeFinish} style={styles.skipButton}>
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
  logoContainer: {
    width: 110,
    height: 110,
    borderRadius: 28,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(190, 168, 96, 0.45)',
    backgroundColor: 'rgba(255, 255, 255, 0.04)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 28,
    overflow: 'hidden',
  },
  logoImage: {
    width: 84,
    height: 84,
  },
  typographyBlock: {
    alignItems: 'center',
    marginBottom: 28,
  },
  /**
   * The wordmark.
   *
   * Named family, no `fontWeight`. This ran as `fontWeight: '700'` on a bare RN `Text` with no
   * family at all, which on Android is Roboto Bold — so the very first thing a user saw was the
   * brand set in the system font, fading into an app set in Plus Jakarta Sans. Pairing a named
   * family *with* a weight is the other half of the same trap: the platform then synthesizes a
   * fake bold over an already-bold face, which is what `tokens.ts:661` documents.
   *
   * By the time this component mounts, `RootLayout` has already waited for the fonts to settle,
   * so the face is loaded. On the font-failure path it falls back to the system font — exactly
   * what it did before, and now only as a failure mode rather than always.
   */
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
    width: width * 0.44,
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
