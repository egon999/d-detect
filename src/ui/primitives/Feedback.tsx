/**
 * Loading, empty and error states.
 *
 * The spec asks for all three, and the reason they are single shared components rather
 * than per-screen markup is consistency of tone: an empty case list and an empty
 * evidence list should not explain themselves in two different voices.
 *
 * The copy here is written to be specific. "No results" tells a user nothing; "No
 * evidence matches these filters" tells them the filters are the reason. Every empty
 * state in this file names what is missing and, where there is one, the action that
 * fixes it.
 */

import React, { useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { Icon, type IconName } from '../icon';
import { BORDER_WIDTH, SPACING } from '../tokens';
import { useTheme } from '../theme';
import { Button } from './Button';
import { Pressable, Stack } from './Layout';
import { useReducedMotion } from './Motion';
import { Text } from './Text';

// ---------------------------------------------------------------------------
// Skeleton
// ---------------------------------------------------------------------------

export interface SkeletonProps {
  width?: number | `${number}%`;
  height?: number;
  radius?: keyof ReturnType<typeof useTheme>['radius'];
  style?: StyleProp<ViewStyle>;
}

/**
 * A single shimmering placeholder block.
 *
 * Uses a *pulse*, not a travelling sheen. A gradient sweep needs a masked animated layer
 * and reads as decoration; a slow opacity pulse communicates "content is coming" with one
 * animated value and no gradient. The pulse is also slower than most apps use — at 900ms
 * it reads as calm, where a 400ms pulse reads as an alarm.
 */
export function Skeleton({ width = '100%', height = 14, radius = 'xs', style }: SkeletonProps) {
  const theme = useTheme();
  const reduced = useReducedMotion() === true;
  const pulse = useRef(new Animated.Value(0.45)).current;

  useEffect(() => {
    /**
     * An unbounded loop is the one animation shape reduced motion exists to stop.
     *
     * Everything else in this app animates once and settles; this pulses for as long as the
     * content takes to arrive, which on a slow connection is the whole time the user is looking
     * at the screen. Held at the top of its range rather than the bottom, so the placeholder
     * still reads as a placeholder — a block at 0.45 opacity looks like a rendering fault.
     */
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

/**
 * A skeleton shaped like the content it replaces.
 *
 * Shaped placeholders matter more than they look: a list of generic grey bars causes a
 * visible jump when real content arrives with a different rhythm, while a placeholder
 * that matches the real layout keeps the scroll position and reading position stable.
 */
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

/** A stack of `SkeletonCard`s, for a list that is loading for the first time. */
export function SkeletonList({ count = 3 }: { count?: number }) {
  return (
    <Stack gap="lg">
      {Array.from({ length: count }).map((_, index) => (
        <SkeletonCard key={index} />
      ))}
    </Stack>
  );
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

export interface EmptyStateProps {
  icon: IconName;
  title: string;
  /** One or two sentences. Say why it is empty, not just that it is. */
  message: string;
  /** Optional action that resolves the emptiness. */
  action?: { label: string; onPress: () => void; icon?: IconName };
  /** Compact variant for an empty section inside a card that already has a header. */
  compact?: boolean;
}

export function EmptyState({ icon, title, message, action, compact = false }: EmptyStateProps) {
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

      {action ? (
        <Button
          label={action.label}
          onPress={action.onPress}
          icon={action.icon}
          variant="primary"
          size={compact ? 'sm' : 'md'}
          style={{ marginTop: theme.spacing.xs }}
        />
      ) : null}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Error state
// ---------------------------------------------------------------------------

export interface ErrorStateProps {
  title?: string;
  /** The message shown to the user. Never a raw stack trace or SDK error string. */
  message: string;
  onRetry?: () => void;
  retryLabel?: string;
  /** Technical detail, shown only behind a disclosure. */
  detail?: string | null;
  compact?: boolean;
}

/**
 * A recoverable error.
 *
 * Deliberately worded as recoverable. `detail` is separated from `message` so the
 * actionable sentence stays readable and the technical string — which is for a developer
 * or a support message, not for the person using the app — can be kept out of the way.
 */
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

      {detail ? <ExpandableDetail detail={detail} /> : null}

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

/**
 * A disclosure for a technical string.
 *
 * Collapsed by default, and collapsed is the important part: an exception message shown
 * openly leads a user to believe the app is broken, when the app is working and one
 * operation failed.
 */
function ExpandableDetail({ detail }: { detail: string }) {
  const theme = useTheme();
  const [open, setOpen] = React.useState(false);

  return (
    <View style={{ alignItems: 'center', gap: theme.spacing.sm, alignSelf: 'stretch' }}>
      <Pressable
        onPress={() => setOpen((value) => !value)}
        pressScale={1}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={open ? 'Hide technical details' : 'Show technical details'}
        style={styles.detailToggle}
      >
        <Text variant="caption" colorToken="textTertiary">
          {open ? 'Hide technical details' : 'Show technical details'}
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
          <Text variant="monoSmall" colorToken="textTertiary" selectable>
            {detail}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Notice
// ---------------------------------------------------------------------------

export interface NoticeProps {
  tone?: 'info' | 'warn' | 'danger' | 'accent' | 'ai' | 'ok' | 'neutral';
  icon?: IconName;
  title?: string;
  message: string;
  /**
   * The raw message behind a disclosure, for a failure the user may need to report.
   *
   * The same slot `ErrorState` has, and it exists here for the same reason: `readableError`
   * replaces a provider string with a sentence the screen author wrote, which is right for the
   * person reading it and throws away the one string that would identify the fault to whoever
   * is helping them. Pass `errorDetail(caught)` to keep it — collapsed, so a working app never
   * looks broken, and reachable when someone needs to read it out.
   */
  detail?: string | null;
  /** Renders as a dismissible inline bar rather than a block. */
  onDismiss?: () => void;
  style?: StyleProp<ViewStyle>;
}

/**
 * An inline explanation attached to a result.
 *
 * This is the component the product's honesty requirement lives in. Every analysis
 * finding, every AI suggestion and every ambiguous value is explained through a Notice
 * that says what the system did and did not establish — which is why the visual weight is
 * deliberately calm even for `danger`. These are observations about evidence, not alarms.
 */
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
        {/* Left-aligned here, unlike in `ErrorState` — a notice is a block of text in a column,
            not a centred empty-state, and a centred disclosure under left-aligned prose reads
            as a stray control. */}
        {detail ? (
          <View style={{ alignItems: 'flex-start', marginTop: SPACING.xs }}>
            <ExpandableDetail detail={detail} />
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
  // 56 with `radius.xl` — the icon tile sits above a `heading` now, so it went up with it.
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
