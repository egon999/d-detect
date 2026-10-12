import React, { useEffect, useRef } from 'react';
import {
  Animated,
  StyleSheet,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { FONT_FAMILY } from '../tokens';
import { useReducedMotion } from './Motion';

export interface BlurTextProps {

  text: string;

  delay?: number;

  animateBy?: 'words' | 'letters';

  direction?: 'top' | 'bottom';

  textStyle?: StyleProp<TextStyle>;

  style?: StyleProp<ViewStyle>;

  onAnimationComplete?: () => void;
}

export function BlurText({
  text,
  delay = 60,
  animateBy = 'words',
  direction = 'bottom',
  textStyle,
  style,
  onAnimationComplete,
}: BlurTextProps) {
  const reduced = useReducedMotion();
  const elements = animateBy === 'words' ? text.split(' ') : text.split('');
  const anims = useRef(elements.map(() => new Animated.Value(0))).current;

  useEffect(() => {
    if (reduced) {
      anims.forEach((anim) => anim.setValue(1));
      onAnimationComplete?.();
      return;
    }

    const animations = elements.map((_, i) =>
      Animated.timing(anims[i]!, {
        toValue: 1,
        duration: 380,
        delay: i * delay,
        useNativeDriver: true,
      }),
    );

    Animated.stagger(delay, animations).start(({ finished }) => {
      if (finished) onAnimationComplete?.();
    });
  }, [reduced, elements.length, delay, anims, onAnimationComplete]);

  const yOffset = direction === 'top' ? -18 : 18;

  return (
    <View
      accessible
      accessibilityRole="text"
      accessibilityLabel={text}
      style={[styles.container, style]}
    >
      {elements.map((item, index) => {
        const opacity = anims[index] ?? new Animated.Value(1);
        const translateY = opacity.interpolate({
          inputRange: [0, 1],
          outputRange: [yOffset, 0],
        });

        return (
          <Animated.Text
            key={`${item}-${index}`}
            style={[
              styles.text,
              textStyle,
              {
                opacity,
                transform: [{ translateY }],
              },
            ]}
          >
            {item}
            {animateBy === 'words' && index < elements.length - 1 ? ' ' : ''}
          </Animated.Text>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
  },
  text: {
    fontFamily: FONT_FAMILY.sansMedium,
    color: '#FFFFFF',
  },
});
