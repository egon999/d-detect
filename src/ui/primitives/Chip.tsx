import React from 'react';
import { ActivityIndicator, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { Icon, type IconName } from '../icon';
import { BORDER_WIDTH, CONTROL_SCALE_CAP, SPACING, type Tone } from '../tokens';
import { useTheme } from '../theme';
import { Text } from './Text';

export interface ChipProps {
  label: string;
  tone?: Tone;

  icon?: IconName;
  size?: 'sm' | 'md';

  emphasis?: 'soft' | 'outline' | 'solid' | 'filled';

  dot?: boolean;

  shrink?: boolean;

  accessibilityLabel?: string;

  accessibilityHint?: string;
  style?: StyleProp<ViewStyle>;
}

export function Chip({
  label,
  tone = 'neutral',
  icon,
  size = 'sm',
  emphasis = 'soft',
  dot = false,
  shrink = false,
  accessibilityLabel,
  accessibilityHint,
  style,
}: ChipProps) {
  const theme = useTheme();
  const palette = theme.tone(tone);

  const compact = size === 'sm';

  const height = compact ? 26 : 32;
  const paddingHorizontal = compact ? SPACING.md : SPACING.lg;

  const solid = emphasis === 'solid';

  const soft = emphasis === 'soft' || emphasis === 'filled';

  const background = solid ? palette.solid : soft ? palette.bg : 'transparent';

  const foreground = solid ? palette.onSolid : palette.fg;

  return (
    <View

      accessible
      accessibilityRole="text"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityHint={accessibilityHint}
      style={[
        styles.chip,
        {

          minHeight: height,
          paddingHorizontal,
          borderRadius: theme.radius.pill,
          backgroundColor: background,
          borderWidth: soft || solid ? 0 : BORDER_WIDTH.hairline,
          borderColor: palette.border,
          alignSelf: 'flex-start',
          maxWidth: shrink ? '100%' : undefined,
        },
        style,
      ]}
    >
      {dot ? (
        <View
          style={{
            width: 6,
            height: 6,
            borderRadius: 3,
            backgroundColor: solid ? palette.onSolid : palette.solid,
          }}
        />
      ) : icon ? (
        <Icon name={icon} size={compact ? 12 : 14} color={foreground} />
      ) : null}

      <Text
        variant="caption"
        style={[{ color: foreground }, shrink ? styles.shrinkText : null]}
        numberOfLines={1}

        maxFontSizeMultiplier={CONTROL_SCALE_CAP}
      >
        {label}
      </Text>
    </View>
  );
}

export function ProgressChip({
  label,
  tone = 'info',
  accessibilityLabel,
}: {
  label: string;
  tone?: Tone;

  accessibilityLabel?: string;
}) {
  const theme = useTheme();
  const palette = theme.tone(tone);
  return (
    <View

      accessible
      accessibilityRole="text"
      accessibilityLabel={accessibilityLabel ?? label}
      style={[
        styles.chip,
        {

          minHeight: 26,
          paddingHorizontal: SPACING.md,
          borderRadius: theme.radius.pill,
          backgroundColor: palette.bg,
          alignSelf: 'flex-start',
        },
      ]}
    >
      <ActivityIndicator size="small" color={palette.fg} style={styles.spinner} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" />
      <Text variant="caption" style={{ color: palette.fg }} maxFontSizeMultiplier={CONTROL_SCALE_CAP}>
        {label}
      </Text>
    </View>
  );
}

export interface CountBadgeProps {
  count: number;
  tone?: Tone;

  max?: number;

  solid?: boolean;

  accessibilityLabel?: string;
}

export function CountBadge({
  count,
  tone = 'neutral',
  max = 99,
  solid = false,
  accessibilityLabel,
}: CountBadgeProps) {
  const theme = useTheme();
  const palette = theme.tone(tone);
  const label = count > max ? `${max}+` : String(count);
  return (
    <View

      accessible
      accessibilityRole="text"
      accessibilityLabel={accessibilityLabel ?? label}
      style={[
        styles.countBadge,
        {
          backgroundColor: solid ? palette.solid : palette.bg,
          borderRadius: theme.radius.pill,
        },
      ]}
    >
      <Text
        variant="caption"

        style={{ color: solid ? palette.onSolid : palette.fg }}

        maxFontSizeMultiplier={CONTROL_SCALE_CAP}
      >
        {label}
      </Text>
    </View>
  );
}

export function ToneDot({ tone, size = 8 }: { tone: Tone; size?: number }) {
  const theme = useTheme();
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: theme.tone(tone).solid,
      }}
    />
  );
}

const styles = StyleSheet.create({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    flexShrink: 0,
  },
  shrinkText: { flexShrink: 1 },
  spinner: { transform: [{ scale: 0.7 }], width: 12, height: 12 },
  countBadge: {
    minWidth: 24,

    minHeight: 22,
    paddingHorizontal: SPACING.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
