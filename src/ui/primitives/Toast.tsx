import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  AccessibilityInfo,
  Animated,
  Easing,
  PanResponder,
  Platform,
  StyleSheet,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Icon, type IconName } from '../icon';
import { BORDER_WIDTH, LAYOUT, MOTION, SPACING, type Tone } from '../tokens';
import { useTheme } from '../theme';
import { useReducedMotion } from './Motion';
import { Text } from './Text';

export const TOAST_DURATION = {
  min: 3000,
  max: 7000,
  base: 1600,
  perCharacter: 55,
} as const;

const SWIPE_DISMISS_DISTANCE = 72;

const SWIPE_DISMISS_VELOCITY = 0.45;

const SWIPE_EXIT_DISTANCE = 480;

const SWIPE_FADE_DISTANCE = 140;
const SWIPE_FADE_TO = 0.15;

const TAP_SLOP = 6;

const TOAST_TRAVEL = 16;

export type ToastPlacement = 'top' | 'bottom';

export interface ToastOptions {

  message: string;

  tone?: Tone;

  title?: string;

  icon?: IconName;

  duration?: number;

  placement?: ToastPlacement;
}

export interface ToastEntry {
  id: string;
  message: string;
  tone: Tone;
  title: string | null;
  icon: IconName;
  duration: number;
  placement: ToastPlacement;
}

export const TOAST_ICON: Record<Tone, IconName> = {
  neutral: 'information-outline',
  accent: 'information-outline',
  info: 'information-outline',
  ok: 'check-circle-outline',
  warn: 'alert-outline',
  danger: 'alert-octagon-outline',
  ai: 'auto-fix',
};

export function toastDuration(message: string, title?: string | null): number {
  const characters = message.length + (title ? title.length + 2 : 0);
  const estimate = TOAST_DURATION.base + characters * TOAST_DURATION.perCharacter;
  return Math.min(TOAST_DURATION.max, Math.max(TOAST_DURATION.min, Math.round(estimate)));
}

export function createToast(
  options: ToastOptions,
  id: string,
  placement: ToastPlacement,
): ToastEntry {
  const tone = options.tone ?? 'neutral';
  const title = options.title ?? null;
  return {
    id,
    message: options.message,
    tone,
    title,
    icon: options.icon ?? TOAST_ICON[tone],
    duration: options.duration ?? toastDuration(options.message, title),
    placement: options.placement ?? placement,
  };
}

export function findToastDuplicate(
  queue: readonly ToastEntry[],
  options: ToastOptions,
): ToastEntry | null {
  const tone = options.tone ?? 'neutral';
  const title = options.title ?? null;
  return (
    queue.find(
      (entry) => entry.message === options.message && entry.tone === tone && entry.title === title,
    ) ?? null
  );
}

export function enqueueToast(queue: readonly ToastEntry[], entry: ToastEntry): ToastEntry[] {
  return [...queue, entry];
}

export function activeToast(queue: readonly ToastEntry[]): ToastEntry | null {
  return queue[0] ?? null;
}

export function dropToast(queue: readonly ToastEntry[], id: string): ToastEntry[] {
  return queue.filter((entry) => entry.id !== id);
}

export interface ToastController {

  show: (options: ToastOptions) => string;

  dismiss: (id?: string) => void;

  clear: () => void;
}

const ToastContext = createContext<ToastController | null>(null);

export function useToast(): ToastController {
  const controller = useContext(ToastContext);
  if (!controller) {
    throw new Error('useToast must be used inside <ToastProvider>. Wrap the root layout.');
  }
  return controller;
}

export interface ToastProviderProps {
  children: React.ReactNode;

  placement?: ToastPlacement;
}

export function ToastProvider({ children, placement = 'top' }: ToastProviderProps) {

  const reduced = useReducedMotion();
  const [queue, setQueue] = useState<readonly ToastEntry[]>([]);

  const [closing, setClosing] = useState(false);

  const queueRef = useRef<readonly ToastEntry[]>([]);
  const counter = useRef(0);

  const write = useCallback((next: readonly ToastEntry[]) => {
    queueRef.current = next;
    setQueue(next);
  }, []);

  const show = useCallback(
    (options: ToastOptions): string => {
      const duplicate = findToastDuplicate(queueRef.current, options);
      if (duplicate) return duplicate.id;

      counter.current += 1;
      const entry = createToast(options, `toast-${counter.current}`, placement);
      write(enqueueToast(queueRef.current, entry));
      return entry.id;
    },
    [placement, write],
  );

  const dismiss = useCallback(
    (id?: string) => {
      const visible = activeToast(queueRef.current);
      const target = id ?? visible?.id;
      if (!target) return;

      if (visible && target === visible.id) setClosing(true);
      else write(dropToast(queueRef.current, target));
    },
    [write],
  );

  const clear = useCallback(() => {
    const visible = activeToast(queueRef.current);
    write(visible ? [visible] : []);
    if (visible) setClosing(true);
  }, [write]);

  const handleClosed = useCallback(() => {
    const visible = activeToast(queueRef.current);
    setClosing(false);
    if (visible) write(dropToast(queueRef.current, visible.id));
  }, [write]);

  const controller = useMemo<ToastController>(
    () => ({ show, dismiss, clear }),
    [show, dismiss, clear],
  );

  const entry = activeToast(queue);

  return (
    <ToastContext.Provider value={controller}>
      {children}
      {entry ? (

        <ToastHost
          key={entry.id}
          entry={entry}
          reduced={reduced}
          closing={closing}
          onRequestClose={dismiss}
          onClosed={handleClosed}
        />
      ) : null}
    </ToastContext.Provider>
  );
}

interface ToastHostProps {
  entry: ToastEntry;

  reduced: boolean | null;
  closing: boolean;
  onRequestClose: (id: string) => void;
  onClosed: () => void;
}

function ToastHost({ entry, reduced, closing, onRequestClose, onClosed }: ToastHostProps) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const palette = theme.tone(entry.tone);

  const progress = useRef(new Animated.Value(1)).current;
  const drag = useRef(new Animated.Value(0)).current;

  const played = useRef(false);

  const [held, setHeld] = useState(false);

  const closed = useRef(false);
  const finish = useCallback(() => {
    if (closed.current) return;
    closed.current = true;
    onClosed();
  }, [onClosed]);

  const requestClose = useCallback(() => onRequestClose(entry.id), [entry.id, onRequestClose]);

  useEffect(() => {
    if (reduced === null || reduced || played.current) return;
    played.current = true;

    progress.setValue(0);
    const animation = Animated.timing(progress, {
      toValue: 1,
      duration: MOTION.duration.normal,
      easing: Easing.bezier(...MOTION.easeOut),
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [reduced, progress]);

  useEffect(() => {
    if (!closing) return;
    if (reduced) {
      finish();
      return;
    }

    const animation = Animated.timing(progress, {
      toValue: 0,
      duration: MOTION.duration.fast,
      easing: Easing.bezier(...MOTION.easeIn),
      useNativeDriver: true,
    });
    animation.start(({ finished }) => {
      if (finished) finish();
    });
    return () => animation.stop();
  }, [closing, reduced, progress, finish]);

  useEffect(() => {
    if (entry.duration <= 0 || closing || held) return;
    const timer = setTimeout(requestClose, entry.duration);
    return () => clearTimeout(timer);
  }, [entry.duration, closing, held, requestClose]);

  useEffect(() => {
    if (Platform.OS !== 'ios') return;
    AccessibilityInfo.announceForAccessibility(
      entry.title ? `${entry.title}. ${entry.message}` : entry.message,
    );
  }, [entry]);

  const pan = useMemo(
    () =>
      PanResponder.create({

        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: (_event, gesture) =>
          Math.abs(gesture.dx) > TAP_SLOP && Math.abs(gesture.dx) > Math.abs(gesture.dy),
        onPanResponderGrant: () => setHeld(true),

        onPanResponderMove: (_event, gesture) => drag.setValue(gesture.dx),
        onPanResponderRelease: (_event, gesture) => {
          setHeld(false);

          if (Math.hypot(gesture.dx, gesture.dy) < TAP_SLOP) {
            requestClose();
            return;
          }

          const thrown =
            Math.abs(gesture.dx) > SWIPE_DISMISS_DISTANCE ||
            Math.abs(gesture.vx) > SWIPE_DISMISS_VELOCITY;

          if (!thrown) {
            Animated.spring(drag, {
              toValue: 0,
              damping: MOTION.spring.snappy.damping,
              stiffness: MOTION.spring.snappy.stiffness,
              mass: MOTION.spring.snappy.mass,
              useNativeDriver: true,
            }).start();
            return;
          }

          const direction = (gesture.dx !== 0 ? gesture.dx : gesture.vx) >= 0 ? 1 : -1;
          Animated.timing(drag, {
            toValue: direction * SWIPE_EXIT_DISTANCE,
            duration: MOTION.duration.fast,
            easing: Easing.bezier(...MOTION.easeIn),
            useNativeDriver: true,
          }).start(({ finished }) => {
            if (finished) finish();
          });
        },
        onPanResponderTerminate: () => {
          setHeld(false);
          Animated.spring(drag, {
            toValue: 0,
            damping: MOTION.spring.snappy.damping,
            stiffness: MOTION.spring.snappy.stiffness,
            mass: MOTION.spring.snappy.mass,
            useNativeDriver: true,
          }).start();
        },
      }),
    [drag, finish, requestClose],
  );

  const atTop = entry.placement === 'top';

  const translateY = progress.interpolate({
    inputRange: [0, 1],
    outputRange: [atTop ? -TOAST_TRAVEL : TOAST_TRAVEL, 0],
  });
  const opacity = Animated.multiply(
    progress,
    drag.interpolate({
      inputRange: [-SWIPE_FADE_DISTANCE, 0, SWIPE_FADE_DISTANCE],
      outputRange: [SWIPE_FADE_TO, 1, SWIPE_FADE_TO],
      extrapolate: 'clamp',
    }),
  );

  return (
    <View

      pointerEvents="box-none"
      style={[
        styles.host,
        { paddingHorizontal: theme.layout.screenPadding },
        atTop
          ? { top: insets.top + theme.spacing.md }
          : { bottom: insets.bottom + theme.spacing.md },
      ]}
    >
      <Animated.View
        {...pan.panHandlers}
        accessibilityRole="alert"

        accessibilityLiveRegion="polite"
        accessibilityLabel={entry.title ? `${entry.title}. ${entry.message}` : entry.message}
        accessibilityHint="Double tap to dismiss"
        style={[
          styles.card,
          theme.elevation.high,
          {

            backgroundColor: theme.colors.surfaceRaised,
            borderColor: palette.border,
            borderRadius: theme.radius.md,
            paddingVertical: theme.spacing.lg,
            paddingHorizontal: theme.spacing.xl,
            gap: theme.spacing.md,
            maxWidth: LAYOUT.maxContentWidth,
            opacity,
            transform: [{ translateX: drag }, { translateY }],
          },
        ]}
      >
        <View style={styles.glyph}>
          <Icon name={entry.icon} size={18} color={palette.fg} />
        </View>

        <View style={styles.body}>
          {entry.title ? (
            <Text variant="label" style={{ color: palette.fg }}>
              {entry.title}
            </Text>
          ) : null}
          <Text variant="bodySmall" colorToken="text">
            {entry.message}
          </Text>
        </View>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  host: {
    position: 'absolute',
    left: 0,
    right: 0,
    alignItems: 'center',

    zIndex: 100,
  },
  card: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'flex-start',
    borderWidth: BORDER_WIDTH.hairline,
  },

  glyph: { paddingTop: SPACING.xxs },
  body: { flex: 1, gap: SPACING.xxs },
});
