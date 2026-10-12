import React, { useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { Icon, type IconName } from '../icon';
import { BORDER_WIDTH, SPACING } from '../tokens';
import { useTheme } from '../theme';
import { Button } from './Button';
import { Pressable, Row, Stack } from './Layout';
import { useReducedMotion } from './Motion';
import { Text } from './Text';

export interface SkeletonProps {
  width?: number | `${number}%`;
  height?: number;
  radius?: keyof ReturnType<typeof useTheme>['radius'];
  style?: StyleProp<ViewStyle>;
}

export function Skeleton({ width = '100%', height = 14, radius = 'xs', style }: SkeletonProps) {
  const theme = useTheme();
  const reduced = useReducedMotion() === true;
  const pulse = useRef(new Animated.Value(0.45)).current;

  useEffect(() => {

    if (reduced) {
      pulse.setValue(1);
      return;
    }

    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 1,
          duration: 900,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 0.45,
          duration: 900,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ]),
    );
    animation.start();
    return () => animation.stop();
  }, [pulse, reduced]);

  return (
    <Animated.View
      style={[
        {
          width,
          height,
          borderRadius: theme.radius[radius],
          backgroundColor: theme.colors.skeleton,
          opacity: pulse,
        },
        style,
      ]}
    />
  );
}

export function SkeletonCard({ lines = 3 }: { lines?: number }) {
  const theme = useTheme();
  return (
    <View
      style={{
        backgroundColor: theme.colors.surface,
        borderRadius: theme.radius.lg,
        borderWidth: BORDER_WIDTH.hairline,
        borderColor: theme.colors.border,
        padding: theme.spacing.xl,
        gap: theme.spacing.md,
      }}
    >
      <Skeleton width="42%" height={12} />
      <Skeleton width="86%" height={18} />
      <View style={{ gap: theme.spacing.sm, marginTop: theme.spacing.xs }}>
        {Array.from({ length: Math.max(0, lines - 2) }).map((_, index) => (
          <Skeleton key={index} width={index % 2 === 0 ? '100%' : '72%'} height={12} />
        ))}
      </View>
    </View>
  );
}

export function SkeletonList({ count = 3 }: { count?: number }) {
  return (
    <Stack gap="lg">
      {Array.from({ length: count }).map((_, index) => (
        <SkeletonCard key={index} />
      ))}
    </Stack>
  );
}

export interface EmptyStateProps {
  icon: IconName;
  title: string;

  message: string;

  action?: { label: string; onPress: () => void; icon?: IconName };

  secondaryAction?: { label: string; onPress: () => void; icon?: IconName };

  compact?: boolean;
}

export function EmptyState({ icon, title, message, action, secondaryAction, compact = false }: EmptyStateProps) {
  const theme = useTheme();

  return (
    <View
      style={[
        styles.stateContainer,
        {
          paddingVertical: compact ? theme.spacing.xxxl : theme.spacing.colossal,
          paddingHorizontal: theme.spacing.xl,
          gap: theme.spacing.md,
        },
      ]}
    >
      <View
        style={[
          styles.stateIcon,
          {
            backgroundColor: theme.colors.surfaceSunken,
            borderRadius: theme.radius.xl,
            borderWidth: BORDER_WIDTH.hairline,
            borderColor: theme.colors.border,
          },
        ]}
      >
        <Icon name={icon} size={compact ? 20 : 26} color={theme.colors.textTertiary} />
      </View>

      <Text variant={compact ? 'subheading' : 'heading'} center>
        {title}
      </Text>

      <Text variant="bodySmall" center colorToken="textSecondary" style={styles.stateMessage}>
        {message}
      </Text>

      {action || secondaryAction ? (
        <Row gap="sm" align="center" style={{ marginTop: theme.spacing.xs }}>
          {action ? (
            <Button
              label={action.label}
              onPress={action.onPress}
              icon={action.icon}
              variant="primary"
              size={compact ? 'sm' : 'md'}
            />
          ) : null}
          {secondaryAction ? (
            <Button
              label={secondaryAction.label}
              onPress={secondaryAction.onPress}
              icon={secondaryAction.icon}
              variant="secondary"
              size={compact ? 'sm' : 'md'}
            />
          ) : null}
        </Row>
      ) : null}
    </View>
  );
}

export interface ErrorStateProps {
  title?: string;

  message: string;
  onRetry?: () => void;
  retryLabel?: string;

  detail?: string | null;
  compact?: boolean;
}

export function ErrorState({
  title = 'Something went wrong',
  message,
  onRetry,
  retryLabel = 'Try again',
  detail,
  compact = false,
}: ErrorStateProps) {
  const theme = useTheme();
  const tone = theme.tone('danger');

  return (
    <View
      style={[
        styles.stateContainer,
        {
          paddingVertical: compact ? theme.spacing.xxxl : theme.spacing.colossal,
          paddingHorizontal: theme.spacing.xl,
          gap: theme.spacing.md,
        },
      ]}
    >
      <View
        style={[
          styles.stateIcon,
          {
            backgroundColor: tone.bg,
            borderRadius: theme.radius.xl,
            borderWidth: BORDER_WIDTH.hairline,
            borderColor: tone.border,
          },
        ]}
      >
        <Icon name="alert-circle-outline" size={compact ? 20 : 26} color={tone.fg} />
      </View>

      <Text variant={compact ? 'subheading' : 'heading'} center>
        {title}
      </Text>

      <Text variant="bodySmall" center colorToken="textSecondary" style={styles.stateMessage}>
        {message}
      </Text>

      {detail ? <DisclosureNotes detail={detail} /> : null}

      {onRetry ? (
        <Button
          label={retryLabel}
          onPress={onRetry}
          icon="refresh"
          variant="secondary"
          size={compact ? 'sm' : 'md'}
          style={{ marginTop: theme.spacing.xs }}
        />
      ) : null}
    </View>
  );
}

function DisclosureNotes({ detail }: { detail: string }) {
  const theme = useTheme();
  const [open, setOpen] = React.useState(false);

  return (
    <View style={{ alignItems: 'center', gap: theme.spacing.sm, alignSelf: 'stretch' }}>
      <Pressable
        onPress={() => setOpen((value) => !value)}
        pressScale={1}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={open ? 'Less about this' : 'More about this'}
        style={styles.detailToggle}
      >
        <Text variant="caption" colorToken="textTertiary">
          {open ? 'Less' : 'More about this'}
        </Text>
      </Pressable>

      {open ? (
        <View
          style={{
            backgroundColor: theme.colors.surfaceSunken,
            borderRadius: theme.radius.sm,
            borderWidth: BORDER_WIDTH.hairline,
            borderColor: theme.colors.border,
            padding: theme.spacing.lg,
            alignSelf: 'stretch',
          }}
        >
          <Text variant="bodySmall" colorToken="textSecondary">
            {detail}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

export interface NoticeProps {
  tone?: 'info' | 'warn' | 'danger' | 'accent' | 'ai' | 'ok' | 'neutral';
  icon?: IconName;
  title?: string;
  message: string;

  detail?: string | null;

  onDismiss?: () => void;
  style?: StyleProp<ViewStyle>;
}

export function Notice({ tone = 'info', icon, title, message, detail, onDismiss, style }: NoticeProps) {
  const theme = useTheme();
  const palette = theme.tone(tone);

  return (
    <View
      style={[
        styles.notice,
        {
          backgroundColor: palette.bg,
          borderColor: palette.border,
          borderRadius: theme.radius.md,
          borderWidth: BORDER_WIDTH.hairline,
          padding: theme.spacing.lg,
          gap: theme.spacing.md,
        },
        style,
      ]}
      accessibilityRole="summary"
    >
      {icon ? (
        <View style={{ paddingTop: 1 }}>
          <Icon name={icon} size={16} color={palette.fg} />
        </View>
      ) : null}

      <View style={{ flex: 1, gap: SPACING.xxs }}>
        {title ? (
          <Text variant="label" style={{ color: palette.fg }}>
            {title}
          </Text>
        ) : null}
        <Text variant="bodySmall" colorToken="textSecondary">
          {message}
        </Text>
        {}
        {detail ? (
          <View style={{ alignItems: 'flex-start', marginTop: SPACING.xs }}>
            <DisclosureNotes detail={detail} />
          </View>
        ) : null}
      </View>

      {onDismiss ? (
        <Pressable
          onPress={onDismiss}
          pressScale={0.9}
          accessibilityRole="button"
          accessibilityLabel="Dismiss"
          style={styles.noticeDismiss}
        >
          <Icon name="close" size={16} color={theme.colors.textTertiary} />
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  stateContainer: { alignItems: 'center', justifyContent: 'center' },

  stateIcon: { width: 56, height: 56, alignItems: 'center', justifyContent: 'center' },
  stateMessage: { maxWidth: 340 },
  detailToggle: { minHeight: 32, paddingHorizontal: SPACING.md },
  notice: { flexDirection: 'row', alignItems: 'flex-start' },
  noticeDismiss: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 0,
  },
});
