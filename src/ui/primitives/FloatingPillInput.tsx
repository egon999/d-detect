import React, { forwardRef, useCallback, useRef, useState } from 'react';
import {
  Animated,
  Platform,
  StyleSheet,
  TextInput,
  View,
  type StyleProp,
  type TextStyle,
  type TextInputProps,
  type ViewStyle,
} from 'react-native';
import * as Haptics from 'expo-haptics';

import { useTheme } from '../theme';
import { BORDER_WIDTH, CONTROL_SCALE_CAP, FONT_FAMILY, RADIUS, SPACING } from '../tokens';
import { Icon, type IconName } from '../icon';
import { IconButton } from './Button';
import { Text } from './Text';
import { Row } from './Layout';
import { useReducedMotion } from './Motion';

type FocusHandler = NonNullable<TextInputProps['onFocus']>;
type BlurHandler = NonNullable<TextInputProps['onBlur']>;

export interface FloatingPillInputProps extends Omit<TextInputProps, 'style'> {

  label?: string;

  iconName?: IconName;

  error?: string | null;

  hint?: string;

  secureToggle?: boolean;

  trailing?: React.ReactNode;

  containerStyle?: StyleProp<ViewStyle>;

  pillStyle?: StyleProp<ViewStyle>;

  inputStyle?: StyleProp<TextStyle>;

  testID?: string;
}

export const FloatingPillInput = forwardRef<TextInput, FloatingPillInputProps>(
  function FloatingPillInput(
    {
      label,
      iconName,
      error,
      hint,
      secureToggle = false,
      secureTextEntry = false,
      trailing,
      placeholder,
      value,
      onChangeText,
      onFocus,
      onBlur,
      containerStyle,
      pillStyle,
      inputStyle,
      editable = true,
      testID,
      ...rest
    },
    ref,
  ) {
    const theme = useTheme();
    const reduced = useReducedMotion();
    const [focused, setFocused] = useState(false);
    const [hidden, setHidden] = useState(secureTextEntry);

    const glowAnim = useRef(new Animated.Value(0)).current;

    const handleFocus = useCallback<FocusHandler>(
      (e) => {
        setFocused(true);
        if (reduced) {
          glowAnim.setValue(1);
        } else {
          Animated.timing(glowAnim, {
            toValue: 1,
            duration: theme.motion.duration.fast,
            useNativeDriver: false,
          }).start();
        }
        onFocus?.(e);
      },
      [glowAnim, onFocus, reduced, theme.motion.duration.fast],
    );

    const handleBlur = useCallback<BlurHandler>(
      (e) => {
        setFocused(false);
        if (reduced) {
          glowAnim.setValue(0);
        } else {
          Animated.timing(glowAnim, {
            toValue: 0,
            duration: theme.motion.duration.fast,
            useNativeDriver: false,
          }).start();
        }
        onBlur?.(e);
      },
      [glowAnim, onBlur, reduced, theme.motion.duration.fast],
    );

    const toggleSecure = useCallback(() => {
      if (Platform.OS !== 'web') {
        void Haptics.selectionAsync().catch(() => {});
      }
      setHidden((prev) => !prev);
    }, []);

    const hasError = typeof error === 'string' && error.trim().length > 0;

    const borderColor = hasError
      ? theme.tone('danger').border
      : focused
      ? theme.colors.focusRing
      : theme.colors.glass.border;

    const glowScale = glowAnim.interpolate({
      inputRange: [0, 1],
      outputRange: [0.98, 1.01],
    });

    const glowOpacity = glowAnim.interpolate({
      inputRange: [0, 1],
      outputRange: [0, 0.45],
    });

    return (
      <View style={[styles.wrapper, containerStyle]}>
        {label ? (
          <Text variant="label" colorToken="textSecondary" style={styles.label}>
            {label}
          </Text>
        ) : null}

        <View style={styles.pillContainer}>
          {}
          <Animated.View
            pointerEvents="none"
            style={[
              styles.glowRing,
              {
                borderColor: hasError ? theme.tone('danger').border : theme.colors.focusRing,
                opacity: hasError ? 0 : glowOpacity,
                transform: [{ scale: glowScale }],
              },
            ]}
          />

          <View
            style={[
              styles.pill,
              {
                backgroundColor: theme.colors.surfaceSunken,
                borderColor,
                borderWidth: focused || hasError ? 1.5 : BORDER_WIDTH.hairline,
              },
              pillStyle,
            ]}
          >
            {iconName ? (
              <View style={styles.iconSlot}>
                <Icon
                  name={iconName}
                  size={20}
                  color={focused ? theme.colors.accent : theme.colors.textTertiary}
                />
              </View>
            ) : null}

            <TextInput
              ref={ref}
              testID={testID}
              value={value}
              onChangeText={onChangeText}
              onFocus={handleFocus}
              onBlur={handleBlur}
              editable={editable}
              placeholder={placeholder}
              placeholderTextColor={theme.colors.textTertiary}
              secureTextEntry={secureToggle ? hidden : secureTextEntry}
              style={[
                styles.input,
                {
                  color: theme.colors.text,
                },
                inputStyle,
              ]}
              maxFontSizeMultiplier={CONTROL_SCALE_CAP}
              selectionColor={theme.colors.accent}
              cursorColor={theme.colors.accent}
              {...rest}
            />

            {trailing}

            {secureToggle ? (
              <IconButton
                icon={hidden ? 'eye-outline' : 'eye-off-outline'}
                accessibilityLabel={hidden ? 'Show password' : 'Hide password'}
                size={20}
                tone="neutral"
                onPress={toggleSecure}
                style={styles.eyeButton}
              />
            ) : null}
          </View>
        </View>

        {hasError ? (
          <Row gap="xs" align="center" style={styles.errorRow}>
            <Icon name="alert-circle-outline" size={14} color={theme.tone('danger').fg} />
            <Text variant="caption" tone="danger" numberOfLines={2} style={styles.errorText}>
              {error}
            </Text>
          </Row>
        ) : hint ? (
          <Text variant="caption" colorToken="textTertiary" style={styles.hintText}>
            {hint}
          </Text>
        ) : null}
      </View>
    );
  },
);

const styles = StyleSheet.create({
  wrapper: {
    width: '100%',
    position: 'relative',
    marginVertical: SPACING.xxs,
  },
  label: {
    marginBottom: SPACING.xs,
    marginLeft: SPACING.sm,
  },
  pillContainer: {
    position: 'relative',
    width: '100%',
  },
  glowRing: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: RADIUS.pill,
    borderWidth: 2,
    margin: -3,
  },
  pill: {
    height: 54,
    minHeight: 54,
    borderRadius: RADIUS.pill,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: SPACING.lg,
    borderWidth: 1,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15,
    shadowRadius: 6,
    elevation: 3,
  },
  iconSlot: {
    marginRight: SPACING.sm,
    justifyContent: 'center',
    alignItems: 'center',
  },
  input: {
    flex: 1,
    height: '100%',
    fontFamily: FONT_FAMILY.sansRegular,
    fontSize: 16,
    paddingVertical: 0,
  },
  eyeButton: {
    marginLeft: SPACING.xs,
  },
  errorRow: {
    marginTop: SPACING.xs,
    paddingHorizontal: SPACING.sm,
  },
  errorText: {
    flex: 1,
  },
  hintText: {
    marginTop: SPACING.xs,
    paddingHorizontal: SPACING.sm,
  },
});
