import React, { useEffect, useRef, useState } from 'react';
import {
  Animated,
  Easing,
  StyleSheet,
  View,
  type LayoutChangeEvent,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';

import { useTheme } from '../theme';
import { FONT_FAMILY, type TypeToken } from '../tokens';
import { Text } from './Text';
import { useReducedMotion } from './Motion';

export interface ShinyTextProps {

  children?: React.ReactNode;

  text?: string;

  suffix?: string;

  variant?: TypeToken;

  shineColor?: string;

  duration?: number;

  speedMs?: number;

  pauseDuration?: number;

  shimmerWidthRatio?: number;

  colorToken?: 'text' | 'textSecondary' | 'onCta' | 'accent';

  style?: StyleProp<TextStyle>;

  containerStyle?: StyleProp<ViewStyle>;

  disabled?: boolean;

  accessibilityLabel?: string;

  testID?: string;
}

export function ShinyText({
  children,
  text,
  suffix,
  variant = 'heading',
  shineColor,
  duration,
  speedMs,
  pauseDuration = 1600,
  shimmerWidthRatio = 0.42,
  colorToken = 'text',
  style,
  containerStyle,
  disabled = false,
  accessibilityLabel,
  testID,
}: ShinyTextProps) {
  const theme = useTheme();
  const reduced = useReducedMotion();
  const [measuredWidth, setMeasuredWidth] = useState(0);
  const travel = useRef(new Animated.Value(0)).current;

  const sweepDuration = duration ?? speedMs ?? 2000;
  const content = children ?? text ?? '';
  const specularColor = shineColor ?? theme.colors.focusRing ?? '#FFFFFF';

  const bandWidth = Math.max(48, Math.min(160, measuredWidth * shimmerWidthRatio));

  const isAnimating = !disabled && reduced === false && measuredWidth > 0;

  useEffect(() => {
    if (!isAnimating) {
      travel.setValue(0);
      return;
    }

    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(travel, {
          toValue: 1,
          duration: sweepDuration,
          easing: Easing.bezier(0.16, 1, 0.3, 1),
          useNativeDriver: true,
        }),
        Animated.delay(pauseDuration),
        Animated.timing(travel, {
          toValue: 0,
          duration: 0,
          useNativeDriver: true,
        }),
      ]),
    );

    loop.start();
    return () => loop.stop();
  }, [isAnimating, sweepDuration, pauseDuration, travel]);

  const handleLayout = (e: LayoutChangeEvent) => {
    const width = e.nativeEvent.layout.width;
    if (Math.abs(width - measuredWidth) > 0.5) {
      setMeasuredWidth(width);
    }
  };

  const translateX = travel.interpolate({
    inputRange: [0, 1],
    outputRange: [-bandWidth, measuredWidth],
  });

  const counterTranslateX = travel.interpolate({
    inputRange: [0, 1],
    outputRange: [bandWidth, -measuredWidth],
  });

  const apertureOpacity = travel.interpolate({
    inputRange: [0, 0.12, 0.88, 1],
    outputRange: [0, 1, 1, 0],
  });

  const a11yText = accessibilityLabel ?? (typeof content === 'string' ? `${content}${suffix ?? ''}` : undefined);

  return (
    <View
      testID={testID}
      style={[styles.container, containerStyle]}
      onLayout={handleLayout}
      accessibilityRole="header"
      accessibilityLabel={a11yText}
    >
      {}
      <Text
        variant={variant}
        colorToken={colorToken}
        style={[styles.baseText, style]}
      >
        {content}
        {suffix ? (
          <Text variant={variant} colorToken="accent" style={styles.suffixText}>
            {suffix}
          </Text>
        ) : null}
      </Text>

      {}
      {isAnimating ? (
        <Animated.View
          pointerEvents="none"
          accessible={false}
          aria-hidden={true}
          style={[
            styles.aperture,
            {
              width: bandWidth,
              opacity: apertureOpacity,
              transform: [{ translateX }],
            },
          ]}
        >
          {}
          <Animated.View
            style={[
              styles.counterContainer,
              {
                width: measuredWidth,
                transform: [{ translateX: counterTranslateX }],
              },
            ]}
          >
            <Text
              variant={variant}
              style={[
                styles.baseText,
                style,
                { color: specularColor },
              ]}
              accessible={false}
              aria-hidden={true}
            >
              {content}
              {suffix ? (
                <Text
                  variant={variant}
                  style={[styles.suffixText, { color: specularColor }]}
                  accessible={false}
                  aria-hidden={true}
                >
                  {suffix}
                </Text>
              ) : null}
            </Text>
          </Animated.View>

          {}
          <LinearGradient
            colors={['transparent', 'rgba(255, 255, 255, 0.22)', 'transparent']}
            start={{ x: 0, y: 0.5 }}
            end={{ x: 1, y: 0.5 }}
            style={StyleSheet.absoluteFillObject}
            pointerEvents="none"
          />
        </Animated.View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'relative',
    alignSelf: 'flex-start',
    overflow: 'hidden',
  },
  baseText: {
    fontFamily: FONT_FAMILY.sansBold,
    letterSpacing: -0.5,
  },
  suffixText: {
    fontFamily: FONT_FAMILY.sansBold,
  },
  aperture: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    overflow: 'hidden',
  },
  counterContainer: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
  },
});
