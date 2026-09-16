/**
 * Transient confirmations.
 *
 * Built because every "that worked" message in the app was a `<Notice>` — a block that takes
 * real layout space, pushes the content under it down when it appears, and then stays until
 * some other state change happens to clear it. For a persistent explanation attached to a
 * result that is exactly right, and `Notice` remains the component for that. For "Your
 * statement is saved" it is wrong twice over: the page moves under the user's eyes at the
 * moment they are looking for confirmation, and a message about something that already
 * finished sits on screen as though it were still true.
 *
 * A toast is the opposite shape. It is an overlay, so nothing reflows. It leaves on its own,
 * so nothing has to remember to clear it. And it is addressed from anywhere via a hook, so a
 * screen five levels deep does not have to thread a callback up to whoever owns the banner.
 *
 * ## Queued, not stacked
 *
 * Only `queue[0]` is ever rendered. That is the whole mechanism — there is no z-ordering, no
 * per-toast offset, no "collapse after three". Two saves a frame apart produce two entries
 * and the second waits, because a stack of toasts is a stack of things the user cannot read:
 * the eye goes to movement, and three overlapping cards animating in sequence means each one
 * is legible for less time than one card would have been.
 *
 * A duplicate message already in the queue is folded into the existing one rather than
 * appended. Firing the same sentence twice is nearly always a double-tap or a retry, and
 * showing "Saved" for eight seconds because it was saved twice is not more informative.
 *
 * ## Reduced motion means appear, not slide-fast
 *
 * Same rule as `Motion.tsx`: the animated value is created at its *resting* position and only
 * moved back to the start once motion is known to be allowed. A user who asked for no motion
 * gets the toast placed and visible, and — critically — if the accessibility query ever fails
 * the failure mode is "no animation", never "no message".
 *
 * ## Why `PanResponder` and not `react-native-gesture-handler`
 *
 * Gesture-handler is autolinked here, but its animated integration is Reanimated, which this
 * project does not have (see `Motion.tsx`). Driving a plain `Animated.Value` from
 * `PanResponder` callbacks costs nothing at this scale: one view, a horizontal drag, and a
 * value the native driver still owns for the composited transform.
 */

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

// ---------------------------------------------------------------------------
// Timing and gesture constants
// ---------------------------------------------------------------------------

/**
 * How long a toast stays up, derived from how long it takes to read.
 *
 * A fixed duration is wrong at both ends of the range: four seconds is an eternity for
 * "Saved" and not enough for a two-clause sentence a user has to parse. `perCharacter` is
 * tuned to roughly half of comfortable prose reading speed, on the assumption that a toast
 * is read in peripheral vision by someone who was looking at something else.
 *
 * The floor exists because anything shorter is gone before the eye arrives. The ceiling
 * exists because past it the toast stops reading as transient and starts reading as
 * furniture the user is waiting on — and a message that long should have been a `Notice`.
 */
export const TOAST_DURATION = {
  min: 3000,
  max: 7000,
  base: 1600,
  perCharacter: 55,
} as const;

/** Horizontal travel, in points, past which a release dismisses rather than springs back. */
const SWIPE_DISMISS_DISTANCE = 72;
/** Flick speed that dismisses regardless of distance, so a short fast swipe still works. */
const SWIPE_DISMISS_VELOCITY = 0.45;
/** Where a dismissed toast is thrown to. Beyond any phone's half-width, so it clears. */
const SWIPE_EXIT_DISTANCE = 480;
/** Drag distance at which the toast has faded to `SWIPE_FADE_TO`. */
const SWIPE_FADE_DISTANCE = 140;
const SWIPE_FADE_TO = 0.15;
/** Movement below this on release is a tap, not a swipe. */
const TAP_SLOP = 6;
/** Entrance travel. Deliberately shorter than `MOTION.enterDistance` is for content. */
const TOAST_TRAVEL = 16;

// ---------------------------------------------------------------------------
// The queue, as plain data
// ---------------------------------------------------------------------------

export type ToastPlacement = 'top' | 'bottom';

export interface ToastOptions {
  /** The sentence. Written as something that already happened, not as an instruction. */
  message: string;
  /** Defaults to `neutral` — deliberately not `ok`, which would claim success unasked. */
  tone?: Tone;
  /** A short lead-in, for the rare message that needs one. Most toasts want none. */
  title?: string;
  /** Overrides the tone's default glyph. */
  icon?: IconName;
  /** Milliseconds. Defaults to `toastDuration(message)`. `0` stays up until dismissed. */
  duration?: number;
  /** Overrides the provider's placement for this one message. */
  placement?: ToastPlacement;
}

/** An enqueued toast, with every default already resolved. */
export interface ToastEntry {
  id: string;
  message: string;
  tone: Tone;
  title: string | null;
  icon: IconName;
  duration: number;
  placement: ToastPlacement;
}

/**
 * Default glyphs per tone.
 *
 * `neutral`, `accent` and `info` share the informational glyph on purpose. They mean the
 * same thing to a reader — *here is a fact* — and differ only in how much the app wants the
 * eye drawn to them, which the tone colour already says. Inventing three distinct icons for
 * one meaning would be decoration, and decoration in this product costs the icon set the
 * ability to mean anything.
 */
export const TOAST_ICON: Record<Tone, IconName> = {
  neutral: 'information-outline',
  accent: 'information-outline',
  info: 'information-outline',
  ok: 'check-circle-outline',
  warn: 'alert-outline',
  danger: 'alert-octagon-outline',
  ai: 'auto-fix',
};

/** Reading time for a message, clamped to the floor and ceiling above. */
export function toastDuration(message: string, title?: string | null): number {
  const characters = message.length + (title ? title.length + 2 : 0);
  const estimate = TOAST_DURATION.base + characters * TOAST_DURATION.perCharacter;
  return Math.min(TOAST_DURATION.max, Math.max(TOAST_DURATION.min, Math.round(estimate)));
}

/** Resolves every default, so nothing downstream has to re-derive them per render. */
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

/**
 * An already-queued toast saying the same thing, if there is one.
 *
 * Matched on the words and the tone rather than on an identifier, because the callers that
 * produce duplicates are the ones that do not know they are duplicating: a double-tapped
 * save button, a retry, two listeners reacting to one write.
 */
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

/** Appends. The queue is strictly first-in-first-out; nothing jumps it. */
export function enqueueToast(queue: readonly ToastEntry[], entry: ToastEntry): ToastEntry[] {
  return [...queue, entry];
}

/** The one toast that is on screen. Everything after it is waiting. */
export function activeToast(queue: readonly ToastEntry[]): ToastEntry | null {
  return queue[0] ?? null;
}

/** Removes by id, whether it is the visible one or still waiting. */
export function dropToast(queue: readonly ToastEntry[], id: string): ToastEntry[] {
  return queue.filter((entry) => entry.id !== id);
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export interface ToastController {
  /** Queues a message. Returns its id, so a caller can dismiss it early. */
  show: (options: ToastOptions) => string;
  /** Dismisses one toast, or the visible one when called with no argument. */
  dismiss: (id?: string) => void;
  /** Drops everything still waiting and closes the visible one. */
  clear: () => void;
}

const ToastContext = createContext<ToastController | null>(null);

/**
 * The toast controller.
 *
 * Throws outside the provider rather than returning a no-op, for the same reason `useTheme`
 * does: a `show()` that silently does nothing is a bug that survives to production, because
 * the only symptom is a confirmation nobody noticed was missing.
 */
export function useToast(): ToastController {
  const controller = useContext(ToastContext);
  if (!controller) {
    throw new Error('useToast must be used inside <ToastProvider>. Wrap the root layout.');
  }
  return controller;
}

export interface ToastProviderProps {
  children: React.ReactNode;
  /**
   * Where toasts appear. `top` by default, and that default is about the tab bar rather
   * than about taste: this app puts a tab bar and an absolutely-positioned `ScreenFooter`
   * at the bottom of most screens, and a bottom toast would cover the primary action of
   * the very screen that just fired it. A caller who knows its screen has no bottom
   * furniture can pass `bottom` per toast.
   */
  placement?: ToastPlacement;
}

/**
 * Mounts the toast host and provides `useToast()`.
 *
 * Belongs inside `SafeAreaProvider` and `ThemeProvider` — it reads both — and above the
 * navigator, so one host serves every route and a toast survives a screen transition.
 */
export function ToastProvider({ children, placement = 'top' }: ToastProviderProps) {
  /**
   * Read here rather than inside the toast.
   *
   * `useReducedMotion` returns `null` until an async query resolves, and a toast mounts and
   * is gone inside a few seconds. Asking at mount would mean the first toast of a session
   * reliably raced that query and appeared without its entrance. The provider lives for the
   * life of the app, so by the time anything calls `show()` the answer has long arrived.
   */
  const reduced = useReducedMotion();
  const [queue, setQueue] = useState<readonly ToastEntry[]>([]);
  // `closing` is separate from the queue so a dismissed toast can animate out before it is
  // removed. Dropping it from the queue directly would unmount the view mid-transition.
  const [closing, setClosing] = useState(false);

  // The queue is mirrored in a ref because `show` has to answer *synchronously* whether a
  // duplicate is already pending — it returns an id — and a `setState` updater cannot hand
  // a value back out to the caller.
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

      // The visible one is asked to leave; a waiting one never appeared, so it just goes.
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

  /** Called once the exit animation has finished, so the next toast can take the slot. */
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
        // Keyed by id so each toast mounts fresh: the animated values start at their
        // resting position on every new message rather than carrying the last one's state.
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

// ---------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------

interface ToastHostProps {
  entry: ToastEntry;
  /** Resolved by the provider, so no toast races the accessibility query. `null` is unknown. */
  reduced: boolean | null;
  closing: boolean;
  onRequestClose: (id: string) => void;
  onClosed: () => void;
}

function ToastHost({ entry, reduced, closing, onRequestClose, onClosed }: ToastHostProps) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const palette = theme.tone(entry.tone);

  // 1 is settled. See the file header for why it is created settled rather than at 0.
  const progress = useRef(new Animated.Value(1)).current;
  const drag = useRef(new Animated.Value(0)).current;
  // Guards the entrance against replaying if the reduce-motion setting is toggled while the
  // toast is on screen — same guard `FadeIn` uses, for the same reason.
  const played = useRef(false);

  // True while a finger is down. Suspends the auto-dismiss timer: a toast must not vanish
  // out from under the thumb that is in the middle of swiping it away.
  const [held, setHeld] = useState(false);

  // The exit can be reached from three places — the timer, a tap, a fling — and the two
  // animated ones can both land after the component has already reported itself closed.
  const closed = useRef(false);
  const finish = useCallback(() => {
    if (closed.current) return;
    closed.current = true;
    onClosed();
  }, [onClosed]);

  const requestClose = useCallback(() => onRequestClose(entry.id), [entry.id, onRequestClose]);

  // Entrance.
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

  // Exit. Under reduced motion the toast is simply gone, which is what "no motion" means
  // for something leaving — a fast slide is still a slide.
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

  // Auto-dismiss. Restarted rather than resumed after a drag: a user who grabbed the toast
  // and put it back has just re-read it, and the extra second costs nothing.
  useEffect(() => {
    if (entry.duration <= 0 || closing || held) return;
    const timer = setTimeout(requestClose, entry.duration);
    return () => clearTimeout(timer);
  }, [entry.duration, closing, held, requestClose]);

  /**
   * Announced explicitly on iOS only.
   *
   * Android gets the announcement from `accessibilityLiveRegion` on the card below, and
   * calling both there would read the message twice. iOS has no live-region equivalent, so
   * without this a VoiceOver user gets a confirmation that is never spoken — the toast
   * appears and leaves entirely inside a visual channel they are not using.
   */
  useEffect(() => {
    if (Platform.OS !== 'ios') return;
    AccessibilityInfo.announceForAccessibility(
      entry.title ? `${entry.title}. ${entry.message}` : entry.message,
    );
  }, [entry]);

  const pan = useMemo(
    () =>
      PanResponder.create({
        // Claims the touch immediately so a tap is also a dismissal, and so the timer is
        // suspended the moment the finger lands rather than once it has moved.
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: (_event, gesture) =>
          Math.abs(gesture.dx) > TAP_SLOP && Math.abs(gesture.dx) > Math.abs(gesture.dy),
        onPanResponderGrant: () => setHeld(true),
        // `setValue` rather than `Animated.event`: the native driver cannot read a
        // `PanResponder` callback, but it is perfectly happy to be told a new value.
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

          // Continues the direction of travel. Falling back to the velocity's sign covers
          // the flick that registers speed with almost no displacement.
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

  // One driver for the entrance, one for the drag, combined into transform and opacity —
  // all of which the native driver owns. Nothing here animates a layout property, so the
  // toast cannot shift the content it is floating over.
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
      // `box-none` so the host itself is transparent to touch: it spans the width of the
      // screen, and anything under it — a header action, a list row — must stay tappable.
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
        // Android speaks this on mount. iOS is handled by the announce effect above.
        accessibilityLiveRegion="polite"
        accessibilityLabel={entry.title ? `${entry.title}. ${entry.message}` : entry.message}
        accessibilityHint="Double tap to dismiss"
        style={[
          styles.card,
          theme.elevation.high,
          {
            // Opaque, unlike `Notice`'s tone wash. A toast floats over arbitrary content —
            // a photograph, a graph, a column of monospace figures — and a translucent card
            // over any of those makes its own text the least readable thing on screen.
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
    // Android composites by elevation rather than by tree order, so the shadow token alone
    // is not enough to keep the toast above a raised card on the screen below it.
    zIndex: 100,
  },
  card: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'flex-start',
    borderWidth: BORDER_WIDTH.hairline,
  },
  // Nudged down so the glyph sits on the first line's optical centre rather than its box.
  glyph: { paddingTop: SPACING.xxs },
  body: { flex: 1, gap: SPACING.xxs },
});
