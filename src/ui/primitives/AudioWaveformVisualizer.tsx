import React, { useCallback, useEffect, useRef } from 'react';
import { Animated, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useReducedMotion } from './Motion';

export interface AudioWaveformVisualizerProps {

  isActive?: boolean;

  metering?: number;

  barCount?: number;

  maxHeight?: number;

  tone?: 'accent' | 'danger' | 'ok';

  style?: StyleProp<ViewStyle>;
}

const TONE_GRADIENTS = {
  accent: ['#00F0FF', '#3A86FF', '#1E40AF'],
  danger: ['#FCA5A5', '#EF4444', '#B91C1C'],
  ok: ['#6EE7B7', '#10B981', '#047857'],
} as const;

export const AudioWaveformVisualizer = React.memo(function AudioWaveformVisualizer({
  isActive = true,
  metering,
  barCount = 20,
  maxHeight = 56,
  tone = 'accent',
  style,
}: AudioWaveformVisualizerProps) {
  const reduced = useReducedMotion();
  const anims = useRef<Animated.Value[]>([]);
  const smoothedLevel = useRef(0.15);
  const activeLoops = useRef<Animated.CompositeAnimation[]>([]);

  if (anims.current.length !== barCount) {
    anims.current = Array.from({ length: barCount }, () => new Animated.Value(0.15));
  }

  const stopAmbientLoops = useCallback(() => {
    if (activeLoops.current.length > 0) {
      activeLoops.current.forEach((loop) => loop.stop());
      activeLoops.current = [];
    }
  }, []);

  useEffect(() => {
    if (!isActive || reduced) {
      stopAmbientLoops();
      anims.current.forEach((anim) => {
        Animated.timing(anim, {
          toValue: 0.12,
          duration: 160,
          useNativeDriver: true,
        }).start();
      });
      return;
    }

    if (metering !== undefined) {
      stopAmbientLoops();

      const rawLevel =
        metering > 1 ? 1 : metering < -100 ? 0.05 : metering < 0 ? Math.max(0.08, (metering + 60) / 60) : Math.max(0.08, metering);
      smoothedLevel.current = smoothedLevel.current * 0.35 + rawLevel * 0.65;
      const normalizedLevel = smoothedLevel.current;

      const centerIndex = (barCount - 1) / 2;
      const animations = anims.current.map((anim, index) => {

        const distance = Math.abs(index - centerIndex) / (centerIndex || 1);
        const weight = Math.max(0.35, 1 - distance * 0.65);
        const harmonic = Math.sin((index / (barCount || 1)) * Math.PI) * 0.15;
        const jitter = (index % 3 === 0 ? 0.08 : index % 2 === 0 ? -0.06 : 0.03);
        const targetScale = Math.min(
          1,
          Math.max(0.12, normalizedLevel * weight + harmonic * normalizedLevel + jitter * normalizedLevel * 0.5),
        );

        return Animated.timing(anim, {
          toValue: targetScale,
          duration: 65,
          useNativeDriver: true,
        });
      });

      Animated.parallel(animations).start();
      return;
    }

    stopAmbientLoops();
    const loops = anims.current.map((anim, i) => {
      const centerFactor = 1 - Math.abs(i - barCount / 2) / (barCount / 2);
      const minAmp = 0.14 + centerFactor * 0.08;
      const maxAmp = 0.38 + centerFactor * 0.52;
      const duration = 280 + ((i * 71) % 220);

      return Animated.loop(
        Animated.sequence([
          Animated.timing(anim, {
            toValue: maxAmp,
            duration,
            useNativeDriver: true,
          }),
          Animated.timing(anim, {
            toValue: minAmp,
            duration,
            useNativeDriver: true,
          }),
        ]),
      );
    });

    activeLoops.current = loops;
    loops.forEach((l) => l.start());

    return () => {
      stopAmbientLoops();
    };
  }, [isActive, metering, reduced, barCount, stopAmbientLoops]);

  const gradientColors = TONE_GRADIENTS[tone] ?? TONE_GRADIENTS.accent;

  return (
    <View
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={isActive ? 'Audio recording active' : 'Audio recording idle'}
      style={[styles.container, { height: maxHeight }, style]}
    >
      {anims.current.map((anim, index) => (
        <View key={index} style={styles.barSlot}>
          <Animated.View
            style={[
              styles.bar,
              {
                height: maxHeight,
                transform: [{ scaleY: anim }],
              },
            ]}
          >
            <LinearGradient
              colors={gradientColors as any}
              start={{ x: 0, y: 0 }}
              end={{ x: 0, y: 1 }}
              style={StyleSheet.absoluteFillObject}
            />
          </Animated.View>
        </View>
      ))}
    </View>
  );
});

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3.5,
    paddingHorizontal: 6,
  },
  barSlot: {
    height: '100%',
    justifyContent: 'center',
    alignItems: 'center',
    width: 4,
  },
  bar: {
    width: 3.5,
    borderRadius: 2,
    overflow: 'hidden',
    backgroundColor: '#3A86FF',
  },
});
