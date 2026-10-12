import React, { useEffect, useRef } from 'react';
import {
  Animated,
  Easing,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';

import { useTheme } from '../theme';
import { Icon } from '../icon';
import { useReducedMotion } from './Motion';

export interface DetectiveMascotProps {
  size?: number;
  interactive?: boolean;
  animated?: boolean;
  dragOffset?: {
    x: Animated.Value;
    y: Animated.Value;
  };
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function DetectiveMascot({
  size = 100,
  interactive = false,
  animated = true,
  dragOffset,
  style,
  testID,
}: DetectiveMascotProps) {
  const theme = useTheme();
  const reduced = useReducedMotion();

  const safeSize = Math.max(0, Math.min(size, 2000));
  const scale = safeSize / 100;

  const breatheAnim = useRef(new Animated.Value(0)).current;
  const glintAnim = useRef(new Animated.Value(0)).current;
  const twinkleAnim = useRef(new Animated.Value(0.4)).current;
  const blinkAnim = useRef(new Animated.Value(1)).current;
  const eyeSquashAnim = useRef(new Animated.Value(1)).current;
  const hatWobbleAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {

    if (!animated || reduced !== false) {
      breatheAnim.setValue(0);
      glintAnim.setValue(0);
      twinkleAnim.setValue(0.7);
      blinkAnim.setValue(1);
      eyeSquashAnim.setValue(1);
      hatWobbleAnim.setValue(0);
      return;
    }

    const breathingLoop = Animated.loop(
      Animated.sequence([
        Animated.timing(breatheAnim, {
          toValue: 1,
          duration: 1600,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(breatheAnim, {
          toValue: 0,
          duration: 1600,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ])
    );

    const glintLoop = Animated.loop(
      Animated.sequence([
        Animated.timing(glintAnim, {
          toValue: 1,
          duration: 1200,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(glintAnim, {
          toValue: 0,
          duration: 1400,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
      ])
    );

    const twinkleLoop = Animated.loop(
      Animated.sequence([
        Animated.timing(twinkleAnim, {
          toValue: 1,
          duration: 900,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(twinkleAnim, {
          toValue: 0.3,
          duration: 900,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
      ])
    );

    const hatWobbleLoop = Animated.sequence([
      Animated.delay(250),
      Animated.timing(hatWobbleAnim, {
        toValue: -1,
        duration: 130,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }),
      Animated.timing(hatWobbleAnim, {
        toValue: 0.72,
        duration: 150,
        easing: Easing.inOut(Easing.quad),
        useNativeDriver: true,
      }),
      Animated.timing(hatWobbleAnim, {
        toValue: -0.42,
        duration: 130,
        easing: Easing.inOut(Easing.quad),
        useNativeDriver: true,
      }),
      Animated.timing(hatWobbleAnim, {
        toValue: 0.22,
        duration: 110,
        easing: Easing.inOut(Easing.quad),
        useNativeDriver: true,
      }),
      Animated.timing(hatWobbleAnim, {
        toValue: 0,
        duration: 90,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }),
    ]);

    breathingLoop.start();
    glintLoop.start();
    twinkleLoop.start();
    hatWobbleLoop.start();

    let active = true;
    let currentBlink: Animated.CompositeAnimation | null = null;

    const scheduleBlink = (initialDelay = 1200) => {
      if (!active) return;
      currentBlink = Animated.sequence([
        Animated.delay(initialDelay),

        Animated.parallel([
          Animated.timing(eyeSquashAnim, {
            toValue: 1.08,
            duration: 40,
            easing: Easing.out(Easing.quad),
            useNativeDriver: true,
          }),
          Animated.timing(blinkAnim, {
            toValue: 0.9,
            duration: 40,
            useNativeDriver: true,
          }),
        ]),

        Animated.parallel([
          Animated.timing(blinkAnim, {
            toValue: 0.05,
            duration: 65,
            easing: Easing.bezier(0.4, 0, 0.2, 1),
            useNativeDriver: true,
          }),
          Animated.timing(eyeSquashAnim, {
            toValue: 1.15,
            duration: 65,
            useNativeDriver: true,
          }),
        ]),

        Animated.delay(35),

        Animated.parallel([
          Animated.timing(blinkAnim, {
            toValue: 1.14,
            duration: 85,
            easing: Easing.out(Easing.back(1.8)),
            useNativeDriver: true,
          }),
          Animated.timing(eyeSquashAnim, {
            toValue: 0.94,
            duration: 85,
            useNativeDriver: true,
          }),
        ]),

        Animated.parallel([
          Animated.timing(blinkAnim, {
            toValue: 1.0,
            duration: 60,
            easing: Easing.out(Easing.quad),
            useNativeDriver: true,
          }),
          Animated.timing(eyeSquashAnim, {
            toValue: 1.0,
            duration: 60,
            useNativeDriver: true,
          }),
        ]),

        Animated.delay(180),
        Animated.timing(blinkAnim, {
          toValue: 0.08,
          duration: 50,
          easing: Easing.in(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(blinkAnim, {
          toValue: 1.0,
          duration: 75,
          easing: Easing.out(Easing.quad),
          useNativeDriver: true,
        }),
      ]);

      currentBlink.start(({ finished }) => {
        if (finished && active) {
          scheduleBlink(2800);
        }
      });
    };

    scheduleBlink(900);

    return () => {
      active = false;
      breathingLoop.stop();
      glintLoop.stop();
      twinkleLoop.stop();
      hatWobbleLoop.stop();
      if (currentBlink) {
        currentBlink.stop();
      }
    };
  }, [animated, blinkAnim, breatheAnim, eyeSquashAnim, glintAnim, hatWobbleAnim, reduced, twinkleAnim]);

  const parallaxX = dragOffset ? Animated.multiply(dragOffset.x, 0.4) : 0;
  const parallaxY = dragOffset ? Animated.multiply(dragOffset.y, 0.4) : 0;
  const rotateZ = dragOffset
    ? dragOffset.x.interpolate({
        inputRange: [-100, 0, 100],
        outputRange: ['-8deg', '0deg', '8deg'],
        extrapolate: 'clamp',
      })
    : '0deg';

  const breathTranslate = breatheAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [0, -3],
  });

  if (safeSize <= 0) {
    return <View testID={testID} style={{ width: 0, height: 0 }} />;
  }

  return (
    <Animated.View
      testID={testID}
      accessibilityRole="image"
      accessibilityLabel="Animated Detective Mascot"
      style={[
        styles.root,
        {
          width: safeSize,
          height: safeSize,
          transform: [
            { translateX: parallaxX },
            { translateY: parallaxY },
            { translateY: breathTranslate },
            { rotate: rotateZ },
            { scale },
          ],
        },
        style,
      ]}
    >
      {}
      <Animated.View
        style={[
          styles.neuronHalo,
          {
            opacity: twinkleAnim,
            transform: [
              {
                scale: breatheAnim.interpolate({
                  inputRange: [0, 1],
                  outputRange: [0.95, 1.08],
                }),
              },
            ],
          },
        ]}
      />

      {}
      <View style={styles.wireContainer} pointerEvents="none">
        <View style={[styles.wireLine, styles.wire1]} />
        <View style={[styles.wireLine, styles.wire2]} />
        <View style={[styles.wireLine, styles.wire3]} />
        <View style={[styles.wireLine, styles.wire4]} />

        {}
        <Animated.View style={[styles.neuronNode, styles.nodeA, { opacity: twinkleAnim }]} />
        <Animated.View style={[styles.neuronNode, styles.nodeB, { opacity: twinkleAnim }]} />
        <Animated.View style={[styles.neuronNode, styles.nodeC, { opacity: twinkleAnim }]} />
        <Animated.View style={[styles.neuronNode, styles.nodeD, { opacity: twinkleAnim }]} />
        <Animated.View style={[styles.neuronNode, styles.nodeE, { opacity: twinkleAnim }]} />
      </View>

      {}
      <View style={styles.shieldBase}>
        <LinearGradient
          colors={['#101C48', '#0A122E', '#060B1C']}
          start={{ x: 0.1, y: 0 }}
          end={{ x: 0.9, y: 1 }}
          style={StyleSheet.absoluteFillObject}
        />

        {}
        <View style={styles.shieldBorder} />

        {}
        <View style={styles.catHeadContainer}>
          {}
          <View style={[styles.catEar, styles.catEarLeft]} />
          <View style={[styles.catEar, styles.catEarRight]} />

          {}
          <Animated.View
            style={[
              styles.fedoraCrown,
              {
                transform: [
                  {
                    rotate: hatWobbleAnim.interpolate({
                      inputRange: [-1, 0, 1],
                      outputRange: ['-4.5deg', '0deg', '4.5deg'],
                    }),
                  },
                  {
                    translateY: hatWobbleAnim.interpolate({
                      inputRange: [-1, 0, 1],
                      outputRange: [-1.2, 0, -1.2],
                    }),
                  },
                ],
              },
            ]}
          >
            <LinearGradient
              colors={['#242738', '#161824', '#0E0F17']}
              style={styles.hatCrownShape}
            />
            <View style={styles.hatGoldRibbon}>
              <View style={styles.magnifyingGlassPin}>
                <View style={styles.glassCircle} />
                <View style={styles.glassHandle} />
              </View>
            </View>
            <View style={styles.hatBrimShape} />
          </Animated.View>

          {}
          <View style={styles.catFaceSilhouette}>
            {}
            <View style={styles.catEyesRow}>
              <Animated.View
                style={[
                  styles.catEyeCute,
                  styles.catEyeLeft,
                  {
                    transform: [
                      { scaleY: blinkAnim },
                      { scaleX: eyeSquashAnim },
                    ],
                  },
                ]}
              >
                <View style={styles.eyePupil}>
                  <View style={styles.eyeSparklePrimary} />
                  <View style={styles.eyeSparkleSecondary} />
                </View>
              </Animated.View>
              <Animated.View
                style={[
                  styles.catEyeCute,
                  styles.catEyeRight,
                  {
                    transform: [
                      { scaleY: blinkAnim },
                      { scaleX: eyeSquashAnim },
                    ],
                  },
                ]}
              >
                <View style={styles.eyePupil}>
                  <View style={styles.eyeSparklePrimary} />
                  <View style={styles.eyeSparkleSecondary} />
                </View>
              </Animated.View>
            </View>
            {}
            <View style={styles.catNose} />
          </View>
        </View>

        {}
        <View style={styles.cipherCenter}>
          <Icon name="shield-key-outline" size={16} color="#D4AF37" />
        </View>

        {}
        <Animated.View
          style={[
            styles.specularGlint,
            {
              opacity: glintAnim,
              transform: [
                {
                  translateX: glintAnim.interpolate({
                    inputRange: [0, 1],
                    outputRange: [-40, 40],
                  }),
                },
              ],
            },
          ]}
        />
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  root: {
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
  },
  neuronHalo: {
    position: 'absolute',
    width: 96,
    height: 96,
    borderRadius: 48,
    backgroundColor: 'rgba(212, 175, 55, 0.12)',
    borderWidth: 1,
    borderColor: 'rgba(212, 175, 55, 0.28)',
  },
  wireContainer: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  wireLine: {
    position: 'absolute',
    backgroundColor: 'rgba(212, 196, 145, 0.45)',
    height: 1,
  },
  wire1: {
    width: 60,
    top: 25,
    transform: [{ rotate: '25deg' }],
  },
  wire2: {
    width: 70,
    top: 50,
    transform: [{ rotate: '-30deg' }],
  },
  wire3: {
    width: 55,
    bottom: 25,
    transform: [{ rotate: '45deg' }],
  },
  wire4: {
    width: 65,
    bottom: 35,
    transform: [{ rotate: '-15deg' }],
  },
  neuronNode: {
    position: 'absolute',
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#D4AF37',
    shadowColor: '#D4AF37',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.8,
    shadowRadius: 4,
    elevation: 3,
  },
  nodeA: { top: 18, left: 24 },
  nodeB: { top: 28, right: 20 },
  nodeC: { top: 58, left: 16 },
  nodeD: { bottom: 22, right: 24 },
  nodeE: { bottom: 15, left: 45 },
  shieldBase: {
    width: 72,
    height: 82,
    borderRadius: 20,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1.5,
    borderColor: '#D4AF37',
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.45,
    shadowRadius: 10,
    elevation: 6,
  },
  shieldBorder: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.12)',
  },
  catHeadContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
    top: 4,
    zIndex: 2,
  },
  catEar: {
    position: 'absolute',
    width: 15,
    height: 15,
    backgroundColor: '#181A28',
    borderWidth: 1.2,
    borderColor: '#2D324D',
    top: -3,
    zIndex: 1,
  },
  catEarLeft: {
    left: 6,
    borderTopLeftRadius: 7,
    transform: [{ rotate: '-25deg' }],
  },
  catEarRight: {
    right: 6,
    borderTopRightRadius: 7,
    transform: [{ rotate: '25deg' }],
  },
  catFaceSilhouette: {
    width: 48,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#181A28',
    borderWidth: 1.2,
    borderColor: '#2D324D',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: -2,
    zIndex: 3,
  },
  catEyesRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: 32,
    marginTop: -1,
  },
  catEyeCute: {
    width: 13,
    height: 13,
    borderRadius: 6.5,
    backgroundColor: '#FFBE26',
    borderWidth: 1.2,
    borderColor: '#FFD768',
    shadowColor: '#FFAE19',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.98,
    shadowRadius: 7,
    elevation: 5,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  eyePupil: {
    width: 9,
    height: 9,
    borderRadius: 4.5,
    backgroundColor: '#1E1815',
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
  },
  eyeSparklePrimary: {
    position: 'absolute',
    top: 1,
    left: 1.5,
    width: 3.5,
    height: 3.5,
    borderRadius: 1.75,
    backgroundColor: '#FFFFFF',
  },
  eyeSparkleSecondary: {
    position: 'absolute',
    bottom: 1.5,
    right: 1.5,
    width: 2,
    height: 2,
    borderRadius: 1,
    backgroundColor: '#FFF7D6',
  },
  catEyeLeft: {
    transform: [{ rotate: '4deg' }],
  },
  catEyeRight: {
    transform: [{ rotate: '-4deg' }],
  },
  catNose: {
    width: 3,
    height: 2,
    borderRadius: 1,
    backgroundColor: '#E2D1A6',
    marginTop: 1,
  },
  fedoraCrown: {
    position: 'relative',
    alignItems: 'center',
    zIndex: 4,
  },
  hatCrownShape: {
    width: 34,
    height: 17,
    borderTopLeftRadius: 9,
    borderTopRightRadius: 9,
    borderWidth: 1,
    borderColor: '#2A2D3D',
  },
  hatGoldRibbon: {
    width: 35,
    height: 3.5,
    backgroundColor: '#E5C268',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    position: 'relative',
  },
  magnifyingGlassPin: {
    position: 'absolute',
    right: 3,
    top: -2.5,
    flexDirection: 'row',
    alignItems: 'center',
  },
  glassCircle: {
    width: 6,
    height: 6,
    borderRadius: 3,
    borderWidth: 1.2,
    borderColor: '#E5C268',
    backgroundColor: 'rgba(229, 194, 104, 0.3)',
  },
  glassHandle: {
    width: 3.5,
    height: 1.2,
    backgroundColor: '#E5C268',
    transform: [{ rotate: '45deg' }],
    marginLeft: -0.5,
    marginTop: 3,
  },
  hatBrimShape: {
    width: 46,
    height: 4.5,
    borderRadius: 2.5,
    backgroundColor: '#161824',
    marginTop: 0.5,
  },
  cipherCenter: {
    position: 'absolute',
    bottom: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  specularGlint: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: 20,
    backgroundColor: 'rgba(255, 255, 255, 0.15)',
    transform: [{ skewX: '-25deg' }],
  },
});
