import React, { useEffect, useRef } from 'react';
import {
  Animated,
  Platform,
  StyleSheet,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import * as Haptics from 'expo-haptics';

import { useTheme } from '../theme';
import { BORDER_WIDTH, CONTROL_SCALE_CAP, HIT_TARGET, RADIUS, SPACING } from '../tokens';
import { Icon } from '../icon';
import { Pressable, Row } from './Layout';
import { Text } from './Text';
import { useReducedMotion } from './Motion';

export interface CheckboxPillProps {

  checked: boolean;

  onToggle: (checked: boolean) => void;

  label: string;

  description?: string;

  disabled?: boolean;

  style?: StyleProp<ViewStyle>;

  labelStyle?: StyleProp<TextStyle>;

  accessibilityHint?: string;

  testID?: string;
}

export function CheckboxPill({
  checked,
  onToggle,
  label,
  description,
  disabled = false,
  style,
  labelStyle,
  accessibilityHint,
  testID,
}: CheckboxPillProps) {
  const theme = useTheme();
  const reduced = useReducedMotion();
  const checkAnim = useRef(new Animated.Value(checked ? 1 : 0)).current;

  useEffect(() => {
    if (reduced) {
      checkAnim.setValue(checked ? 1 : 0);
      return;
    }

    Animated.spring(checkAnim, {
      toValue: checked ? 1 : 0,
      damping: theme.motion.spring.snappy.damping,
      stiffness: theme.motion.spring.snappy.stiffness,
      mass: theme.motion.spring.snappy.mass,
      useNativeDriver: true,
    }).start();
  }, [checked, checkAnim, reduced, theme.motion.spring.snappy]);

  const handlePress = () => {
    if (disabled) return;
    if (Platform.OS !== 'web') {
      void Haptics.selectionAsync().catch(() => {});
    }
    onToggle(!checked);
  };

  const scale = checkAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [0.3, 1],
  });

  const opacity = checkAnim.interpolate({
    inputRange: [0, 0.2, 1],
    outputRange: [0, 0.4, 1],
  });

  return (
    <Pressable
      testID={testID}
      onPress={handlePress}
      disabled={disabled}
      pressScale={0.98}
      noDisabledOpacity
      focusRingRadius={RADIUS.pill}
      haptic={false}
      accessibilityRole="checkbox"
      accessibilityState={{ checked, disabled }}
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      style={[styles.hitTarget, disabled && styles.disabledContainer, style]}
    >
      <Row gap="md" align="center">
        <View
          style={[
            styles.box,
            {
              backgroundColor: checked ? theme.colors.cta : theme.colors.surfaceSunken,
              borderColor: checked ? theme.colors.cta : theme.colors.borderStrong,
            },
            disabled && {
              backgroundColor: theme.colors.disabledSurface,
              borderColor: theme.colors.disabledBorder,
            },
          ]}
        >
          <Animated.View style={{ transform: [{ scale }], opacity }}>
            <Icon
              name="check"
              size={15}
              color={disabled ? theme.colors.textDisabled : theme.colors.onCta}
            />
          </Animated.View>
        </View>

        <View style={styles.textContainer}>
          <Text
            variant="bodySmall"
            colorToken={disabled ? 'textDisabled' : checked ? 'text' : 'textSecondary'}
            style={[styles.label, labelStyle]}
            maxFontSizeMultiplier={CONTROL_SCALE_CAP}
          >
            {label}
          </Text>

          {description ? (
            <Text
              variant="caption"
              colorToken={disabled ? 'textDisabled' : 'textTertiary'}
              style={styles.description}
              maxFontSizeMultiplier={CONTROL_SCALE_CAP}
            >
              {description}
            </Text>
          ) : null}
        </View>
      </Row>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  hitTarget: {
    minHeight: HIT_TARGET,
    borderRadius: RADIUS.pill,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.xs,
    justifyContent: 'center',
    alignSelf: 'flex-start',
    backgroundColor: 'rgba(14, 29, 68, 0.45)',
    borderWidth: 1,
    borderColor: 'rgba(150, 178, 232, 0.12)',
  },
  disabledContainer: {
    opacity: 0.6,
  },
  box: {
    width: 22,
    height: 22,
    borderRadius: RADIUS.xs,
    borderWidth: BORDER_WIDTH.hairline * 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  textContainer: {
    justifyContent: 'center',
  },
  label: {
    letterSpacing: -0.1,
  },
  description: {
    marginTop: 1,
  },
});
