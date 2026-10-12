import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Easing,
  StyleSheet,
  View,
  type LayoutChangeEvent,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import { Icon, type IconName } from '../icon';
import { BORDER_WIDTH, CONTROL_SCALE_CAP, HIT_TARGET, MOTION, SPACING, type Tone } from '../tokens';
import { useTheme } from '../theme';
import { Pressable } from './Layout';
import { useReducedMotion } from './Motion';
import { Text } from './Text';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps {
  label: string;
  onPress: () => void;
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: IconName;

  iconTrailing?: boolean;
  loading?: boolean;
  disabled?: boolean;

  fullWidth?: boolean;
  style?: StyleProp<ViewStyle>;
  accessibilityHint?: string;
}

interface VariantSkin {
  background: string;
  border: string;
  label: string;
  icon: string;
}

const DIMENSIONS = {
  sm: {
    height: 40,
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.sm,
    gap: SPACING.sm,
    icon: 16,
  },
  md: {
    height: 48,
    paddingHorizontal: SPACING.xl,
    paddingVertical: SPACING.md,
    gap: SPACING.sm,
    icon: 18,
  },
  lg: {
    height: 56,
    paddingHorizontal: SPACING.xxl,
    paddingVertical: SPACING.lg,
    gap: SPACING.md,
    icon: 20,
  },
};

export function Button({
  label,
  onPress,
  variant = 'secondary',
  size = 'md',
  icon,
  iconTrailing = false,
  loading = false,
  disabled = false,
  fullWidth = false,
  style,
  accessibilityHint,
}: ButtonProps) {
  const theme = useTheme();

  const skin = skinFor(variant, theme, disabled);
  const inert = disabled || loading;
  const dimensions = DIMENSIONS[size];

  const textVariant = size === 'sm' ? 'bodyMedium' : 'subheading';

  const borderRadius = size === 'sm' ? theme.radius.sm : theme.radius.pill;

  const content = (
    <>
      {icon && !iconTrailing ? (
        <Icon name={icon} size={dimensions.icon} color={skin.icon} />
      ) : null}

      <Text
        variant={textVariant}
        style={[styles.label, { color: skin.label }]}

        numberOfLines={2}

        maxFontSizeMultiplier={CONTROL_SCALE_CAP}
      >
        {label}
      </Text>

      {icon && iconTrailing ? (
        <Icon name={icon} size={dimensions.icon} color={skin.icon} />
      ) : null}
    </>
  );

  const inner = {

    minHeight: dimensions.height,
    paddingHorizontal: dimensions.paddingHorizontal,
    paddingVertical: dimensions.paddingVertical,
    borderRadius,
  };

  return (
    <Pressable
      onPress={onPress}
      disabled={inert}
      noDisabledOpacity
      haptic={!inert && (variant === 'danger' || variant === 'primary')}
      pressScale={0.975}

      focusRingRadius={borderRadius}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: inert, busy: loading }}
      style={[
        { borderRadius, alignSelf: fullWidth ? 'stretch' : 'flex-start' },
        fullWidth ? styles.fullWidth : null,

        variant === 'primary' && !disabled ? theme.elevation.medium : null,
        style,
      ]}
    >
      <View
        style={[
          styles.button,
          inner,
          {
            backgroundColor: skin.background,
            borderWidth: variant === 'ghost' ? 0 : BORDER_WIDTH.hairline,
            borderColor: skin.border,
          },
        ]}
      >
        <View style={[styles.contentRow, { gap: dimensions.gap }, loading ? styles.loadingHidden : null]}>
          {content}
        </View>

        {loading ? (

          <View style={styles.loadingOverlay} pointerEvents="none">
            <ActivityIndicator
              size="small"
              color={skin.label}

              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
            />
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}

function skinFor(
  variant: ButtonVariant,
  theme: ReturnType<typeof useTheme>,
  disabled = false,
): VariantSkin {
  if (disabled) {
    return {
      background: variant === 'ghost' ? 'transparent' : theme.colors.disabledSurface,
      border: variant === 'ghost' ? 'transparent' : theme.colors.disabledBorder,
      label: theme.colors.textDisabled,
      icon: theme.colors.textDisabled,
    };
  }

  switch (variant) {
    case 'primary':
      return {
        background: theme.colors.cta,
        border: theme.colors.cta,
        label: theme.colors.onCta,
        icon: theme.colors.onCta,
      };
    case 'danger': {
      const tone = theme.tone('danger');
      return { background: tone.bg, border: tone.border, label: tone.fg, icon: tone.fg };
    }
    case 'ghost':
      return {
        background: 'transparent',
        border: 'transparent',
        label: theme.colors.textAccent,
        icon: theme.colors.textAccent,
      };
    case 'secondary':
    default:
      return {
        background: theme.colors.surfaceRaised,
        border: theme.colors.border,
        label: theme.colors.text,
        icon: theme.colors.textSecondary,
      };
  }
}

export interface IconButtonProps {
  icon: IconName;
  onPress: () => void;

  accessibilityLabel: string;
  tone?: Tone;
  size?: number;

  filled?: boolean;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
}

export function IconButton({
  icon,
  onPress,
  accessibilityLabel,
  tone = 'neutral',
  size = 20,
  filled = false,
  disabled = false,
  style,
}: IconButtonProps) {
  const theme = useTheme();
  const palette = theme.tone(tone);

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      noDisabledOpacity
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled }}
      pressScale={0.9}

      focusRingRadius={theme.radius.pill}
      style={[styles.iconButton, { borderRadius: theme.radius.pill }, style]}
    >
      <View
        style={[
          styles.iconButtonInner,
          filled
            ? {
                backgroundColor: tone === 'neutral' ? theme.colors.surface : palette.bg,
                borderWidth: BORDER_WIDTH.hairline,
                borderColor: tone === 'neutral' ? theme.colors.border : palette.border,
              }
            : null,
        ]}
      >
        <Icon name={icon} size={size} color={palette.fg} disabled={disabled} />
      </View>
    </Pressable>
  );
}

export interface SegmentedControlProps<T extends string> {
  options: ReadonlyArray<{ value: T; label: string; icon?: IconName }>;
  value: T;
  onChange: (next: T) => void;

  fill?: boolean;
}

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  fill = true,
}: SegmentedControlProps<T>) {
  const theme = useTheme();
  const reduced = useReducedMotion() === true;

  const [boxes, setBoxes] = useState<Record<string, { x: number; width: number }>>({});

  const measure = useCallback((key: string, event: LayoutChangeEvent) => {
    const { x, width } = event.nativeEvent.layout;
    setBoxes((current) => {
      const previous = current[key];

      if (previous && Math.abs(previous.x - x) < 0.5 && Math.abs(previous.width - width) < 0.5) {
        return current;
      }
      return { ...current, [key]: { x, width } };
    });
  }, []);

  const target = boxes[value];

  const left = useRef(new Animated.Value(target?.x ?? 0)).current;
  const width = useRef(new Animated.Value(target?.width ?? 0)).current;
  const settled = useRef(false);

  useEffect(() => {
    if (!target) return;

    const immediate = !settled.current || reduced;
    settled.current = true;

    if (immediate) {
      left.setValue(target.x);
      width.setValue(target.width);
      return;
    }

    const timing = (node: Animated.Value, toValue: number) =>
      Animated.timing(node, {
        toValue,
        duration: theme.motion.duration.normal,
        easing: Easing.bezier(...MOTION.easeOut),
        useNativeDriver: false,
      });

    Animated.parallel([timing(left, target.x), timing(width, target.width)]).start();
  }, [target, reduced, left, width, theme.motion.duration.normal]);

  return (
    <View
      style={[
        styles.segmented,
        {
          backgroundColor: theme.colors.surfaceSunken,
          borderRadius: theme.radius.pill,
        },
      ]}
      accessibilityRole="tablist"
    >
      {}
      <View style={styles.segmentTrack}>
        {target ? (
          <Animated.View
            pointerEvents="none"
            style={[
              styles.segmentThumb,
              theme.elevation.low,
              {
                left,
                width,
                backgroundColor: theme.colors.surface,
                borderRadius: theme.radius.pill,
              },
            ]}
          />
        ) : null}

        {options.map((option) => {
          const selected = option.value === value;
          return (
            <Pressable
              key={option.value}
              onPress={() => onChange(option.value)}
              onLayout={(event) => measure(option.value, event)}
              pressScale={1}
              haptic
              noFeedback
              focusRingRadius={theme.radius.pill}
              accessibilityRole="tab"
              accessibilityState={{ selected }}
              accessibilityLabel={option.label}
              style={[styles.segment, fill ? styles.segmentFill : null]}
            >
              {option.icon ? (
                <Icon
                  name={option.icon}
                  size={15}
                  color={selected ? theme.colors.textAccent : theme.colors.textTertiary}
                />
              ) : null}
              <Text
                variant="label"

                style={{ color: selected ? theme.colors.text : theme.colors.textTertiary }}
                numberOfLines={1}

                maxFontSizeMultiplier={CONTROL_SCALE_CAP}
              >
                {option.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 0,
    overflow: 'hidden',
  },

  contentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 1,
  },

  loadingHidden: { opacity: 0 },
  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  fullWidth: { alignSelf: 'stretch' },

  label: { flexShrink: 1, textAlign: 'center' },
  iconButton: {
    width: HIT_TARGET,
    height: HIT_TARGET,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 0,
  },
  iconButtonInner: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  segmented: { padding: SPACING.xs },
  segmentTrack: { flexDirection: 'row', gap: SPACING.xs },

  segmentThumb: { position: 'absolute', top: 0, bottom: 0 },
  segment: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: SPACING.sm,

    minHeight: 40,
    paddingHorizontal: SPACING.lg,
  },
  segmentFill: { flex: 1 },
});
