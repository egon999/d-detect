import React, { useRef } from 'react';
import {
  ActivityIndicator,
  Animated,
  Platform,
  StyleSheet,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';

import { useTheme } from '../theme';
import { CONTROL_SCALE_CAP, FONT_FAMILY, RADIUS, SPACING } from '../tokens';
import { Icon, type IconName } from '../icon';
import { Pressable, Row } from './Layout';
import { Text } from './Text';
import { useReducedMotion } from './Motion';

export interface GradientPillButtonProps {

  title?: string;

  label?: string;

  onPress: () => void;

  loading?: boolean;

  disabled?: boolean;

  icon?: React.ReactNode;

  iconName?: IconName;

  iconPosition?: 'leading' | 'trailing';

  fullWidth?: boolean;

  gradientColors?: readonly [string, string, ...string[]];

  style?: StyleProp<ViewStyle>;

  textStyle?: StyleProp<TextStyle>;

  accessibilityLabel?: string;

  accessibilityHint?: string;

  testID?: string;
}

export function GradientPillButton({
  title,
  label,
  onPress,
  loading = false,
  disabled = false,
  icon,
  iconName,
  iconPosition = 'leading',
  fullWidth = true,
  gradientColors,
  style,
  textStyle,
  accessibilityLabel,
  accessibilityHint,
  testID,
}: GradientPillButtonProps) {
  const theme = useTheme();
  const reduced = useReducedMotion();
  const scaleAnim = useRef(new Animated.Value(1)).current;

  const buttonText = title ?? label ?? '';

  const handlePressIn = () => {
    if (disabled || loading) return;
    if (Platform.OS !== 'web') {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    }
    if (reduced) return;
    Animated.timing(scaleAnim, {
      toValue: 0.96,
      duration: theme.motion.duration.instant,
      useNativeDriver: true,
    }).start();
  };

  const handlePressOut = () => {
    if (reduced) return;
    Animated.spring(scaleAnim, {
      toValue: 1,
      damping: theme.motion.spring.snappy.damping,
      stiffness: theme.motion.spring.snappy.stiffness,
      mass: theme.motion.spring.snappy.mass,
      useNativeDriver: true,
    }).start();
  };

  const colors = gradientColors ?? ([theme.colors.cta, '#1E40AF', '#13285D'] as const);

  const iconElement = icon
    ? (React.isValidElement(icon) ? icon : null)
    : iconName
    ? (
      <Icon
        name={iconName}
        size={18}
        color={disabled ? theme.colors.textDisabled : theme.colors.onCta}
      />
    )
    : null;

  return (
    <Animated.View
      style={[
        fullWidth ? styles.fullWidth : styles.fitContent,
        { transform: [{ scale: scaleAnim }] },
        style,
      ]}
    >
      <Pressable
        testID={testID}
        onPress={onPress}
        onPressIn={handlePressIn}
        onPressOut={handlePressOut}
        disabled={disabled || loading}
        pressScale={0}
        noDisabledOpacity
        focusRingRadius={RADIUS.pill}
        haptic={false}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel ?? buttonText}
        accessibilityHint={accessibilityHint}
        accessibilityState={{ disabled: disabled || loading, busy: loading }}
        style={[
          styles.container,
          disabled && {
            backgroundColor: theme.colors.disabledSurface,
            borderColor: theme.colors.disabledBorder,
          },
        ]}
      >
        {!disabled ? (
          <LinearGradient
            colors={colors}
            start={{ x: 0, y: 0.5 }}
            end={{ x: 1, y: 0.5 }}
            style={StyleSheet.absoluteFillObject}
          />
        ) : null}

        {}
        {!disabled ? <View style={styles.specularTopSheen} pointerEvents="none" /> : null}

        {}
        <Row
          gap="sm"
          align="center"
          justify="center"
          style={loading ? styles.hiddenContent : undefined}
        >
          {iconPosition === 'leading' ? iconElement : null}

          <Text
            variant="bodyMedium"
            style={[
              styles.labelText,
              { color: disabled ? theme.colors.textDisabled : theme.colors.onCta },
              textStyle,
            ]}
            maxFontSizeMultiplier={CONTROL_SCALE_CAP}
          >
            {buttonText}
          </Text>

          {iconPosition === 'trailing' ? iconElement : null}
        </Row>

        {loading ? (
          <View style={StyleSheet.absoluteFillObject} pointerEvents="none">
            <View style={styles.spinnerContainer}>
              <ActivityIndicator
                size="small"
                color={theme.colors.onCta}
                accessibilityLabel="Loading"
              />
            </View>
          </View>
        ) : null}
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  fullWidth: {
    width: '100%',
  },
  fitContent: {
    alignSelf: 'flex-start',
  },
  container: {
    height: 54,
    minHeight: 54,
    borderRadius: RADIUS.pill,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: SPACING.xl,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.22)',
    shadowColor: '#2B5FD9',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.35,
    shadowRadius: 10,
    elevation: 6,
  },
  specularTopSheen: {
    position: 'absolute',
    top: 0,
    left: 20,
    right: 20,
    height: 1,
    backgroundColor: 'rgba(255, 255, 255, 0.35)',
  },
  labelText: {
    fontFamily: FONT_FAMILY.sansBold,
    letterSpacing: 0.3,
  },
  hiddenContent: {
    opacity: 0,
  },
  spinnerContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
