import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import React, {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Animated,
  Keyboard,
  LayoutChangeEvent,
  Platform,
  RefreshControl,
  StyleSheet,
  View,
  type FlatListProps,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Icon, type IconName } from '../icon';
import { useTheme } from '../theme';
import { HIT_TARGET, LAYOUT, SPACING } from '../tokens';
import { IconButton } from './Button';
import { Row } from './Layout';
import { useReducedMotion } from './Motion';
import { Text } from './Text';

export const HANDOVER_START = 18;
export const HANDOVER_END = 62;

export type HandoverFrame = 'compact' | 'compactOffset' | 'rule' | 'masthead';

const HANDOVER_RAMPS: Record<
  HandoverFrame,
  { readonly inputRange: readonly [number, number]; readonly outputRange: readonly [number, number] }
> = {

  compact: { inputRange: [HANDOVER_START, HANDOVER_END], outputRange: [0, 1] },

  compactOffset: { inputRange: [HANDOVER_START, HANDOVER_END], outputRange: [7, 0] },

  rule: { inputRange: [4, HANDOVER_START], outputRange: [0, 1] },

  masthead: { inputRange: [0, HANDOVER_END * 0.78], outputRange: [1, 0] },
};

function ramp(y: number, from: number, to: number, start: number, end: number): number {
  const t = Math.min(1, Math.max(0, (y - from) / (to - from)));
  return start + (end - start) * t;
}

export function resolveHandover(scrollY: number): Record<HandoverFrame, number> {
  const at = (frame: HandoverFrame) => {
    const { inputRange, outputRange } = HANDOVER_RAMPS[frame];
    return ramp(scrollY, inputRange[0], inputRange[1], outputRange[0], outputRange[1]);
  };

  return {
    compact: at('compact'),
    compactOffset: at('compactOffset'),
    rule: at('rule'),

    masthead: Math.min(1, at('masthead')),
  };
}

export interface ScreenHandover {

  scrollY: Animated.Value;

  onScroll: ReturnType<typeof Animated.event>;

  compactOpacity: Animated.AnimatedInterpolation<number>;

  compactOffset: Animated.AnimatedInterpolation<number>;

  ruleOpacity: Animated.AnimatedInterpolation<number>;

  mastheadOpacity: Animated.AnimatedInterpolation<number>;
}

export function useScreenHandover(): ScreenHandover {
  const scrollY = useRef(new Animated.Value(0)).current;

  return useMemo(() => {
    const interpolate = (frame: HandoverFrame) =>
      scrollY.interpolate({
        inputRange: [...HANDOVER_RAMPS[frame].inputRange],
        outputRange: [...HANDOVER_RAMPS[frame].outputRange],
        extrapolate: 'clamp',
      });

    return {
      scrollY,
      onScroll: Animated.event([{ nativeEvent: { contentOffset: { y: scrollY } } }], {
        useNativeDriver: true,
      }),
      compactOpacity: interpolate('compact'),
      compactOffset: interpolate('compactOffset'),
      ruleOpacity: interpolate('rule'),
      mastheadOpacity: interpolate('masthead'),
    };
  }, [scrollY]);
}

export const READING_MAX_WIDTH = LAYOUT.maxContentWidth + LAYOUT.screenPadding * 2;

const HEADER_BLOCK = LAYOUT.headerHeight;

const FOOTER_ESTIMATE =
  SPACING.lg * 2 + HIT_TARGET + SPACING.giant;

const SPOTLIGHT_HOLD_MS = 900;

const SPOTLIGHT_FADE_MS = 600;

const SCROLL_RETRY_DELAY_MS = 150;

const SCROLL_MAX_ATTEMPTS = 2;

export interface ScreenListScroller {
  scrollToIndex: (params: { index: number; animated?: boolean; viewOffset?: number; viewPosition?: number }) => void;
  scrollToOffset: (params: { offset: number; animated?: boolean }) => void;
}

type AnimatedFlatListProps<T> = FlatListProps<T> & {
  onScroll?: ReturnType<typeof Animated.event>;
  ref?: React.Ref<ScreenListScroller>;
};

const AnimatedFlatList = Animated.FlatList as unknown as <T>(
  props: AnimatedFlatListProps<T>,
) => React.ReactElement;

export function indexOfKey<T>(
  data: readonly T[],
  keyExtractor: (item: T, index: number) => string,
  key: string,
): number {
  if (!key) return -1;
  for (let index = 0; index < data.length; index += 1) {
    if (keyExtractor(data[index] as T, index) === key) return index;
  }
  return -1;
}

export function listRowCount(hasHeader: boolean, hasFooter: boolean, dataLength: number): number {

  if (dataLength === 0) return 1;
  return dataLength + (hasHeader ? 1 : 0) + (hasFooter ? 1 : 0);
}

export type ScrollRequest = { animated?: boolean; viewPosition?: number };

export function scrollViewOffset(
  options: ScrollRequest | undefined,
  topInset: number,
): number | undefined {
  if (options?.viewPosition !== undefined) return undefined;
  return topInset + HEADER_BLOCK + SPACING.md;
}

export type ScrollRetry =
  | { action: 'scroll'; offset: number }
  | { action: 'wait' }
  | { action: 'give-up' };

export function planScrollRetry(
  info: { index: number; averageItemLength: number },
  attempt: number,
): ScrollRetry {
  if (attempt >= SCROLL_MAX_ATTEMPTS) return { action: 'give-up' };
  if (!(info.averageItemLength > 0)) return { action: 'wait' };
  return { action: 'scroll', offset: Math.max(0, info.index * info.averageItemLength) };
}

export interface ScreenAction {
  icon: IconName;

  label: string;
  onPress: () => void;
  disabled?: boolean;
}

interface HeaderBarProps {
  title: string;

  titleOpacity?: Animated.AnimatedInterpolation<number>;
  titleOffset?: Animated.AnimatedInterpolation<number>;

  ruleOpacity?: Animated.AnimatedInterpolation<number>;
  back?: boolean;
  onBack?: () => void;
  actions?: ScreenAction[];

  accessory?: React.ReactNode;
}

export function ScreenHeaderBar({
  title,
  titleOpacity,
  titleOffset,
  ruleOpacity,
  back = false,
  onBack,
  actions,
  accessory,
}: HeaderBarProps) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();

  const goBack = () => {
    if (onBack) {
      onBack();
      return;
    }

    if (router.canGoBack()) router.back();
    else router.replace('/(tabs)/cases');
  };

  return (
    <View
      style={[
        styles.bar,
        {
          paddingTop: insets.top,

          paddingLeft: insets.left,
          paddingRight: insets.right,
          backgroundColor: theme.colors.backdrop.barFill,
        },
      ]}
    >
      {}
      <Row style={[styles.barRow, styles.readingWidth, { height: theme.layout.headerHeight }]} gap="xs">
        {back ? (
          <IconButton icon="chevron-left" accessibilityLabel="Go back" onPress={goBack} size={22} />
        ) : null}

        <Animated.View
          style={[
            styles.barTitle,
            {
              opacity: titleOpacity ?? 1,
              transform: titleOffset ? [{ translateY: titleOffset }] : undefined,

              paddingLeft: back ? 0 : theme.spacing.xs,
            },
          ]}

          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        >
          <Text variant="subheading" numberOfLines={1}>
            {title}
          </Text>
        </Animated.View>

        {actions?.length ? (
          <Row gap="none">
            {actions.map((action) => (
              <IconButton
                key={action.label}
                icon={action.icon}
                accessibilityLabel={action.label}
                onPress={action.onPress}
                disabled={action.disabled}
              />
            ))}
          </Row>
        ) : null}
      </Row>

      {accessory}

      <Animated.View
        style={[
          styles.rule,
          {
            backgroundColor: theme.colors.border,
            opacity: ruleOpacity ?? 0,
          },
        ]}
      />
    </View>
  );
}

export interface MastheadProps {
  title: string;

  overline?: string;

  subtitle?: string;

  meta?: React.ReactNode;
  opacity?: Animated.AnimatedInterpolation<number>;
}

export function Masthead({ title, overline, subtitle, meta, opacity }: MastheadProps) {
  const theme = useTheme();

  return (
    <Animated.View style={[styles.masthead, { opacity: opacity ?? 1 }]}>
      {overline ? (
        <Text variant="monoOverline" tone="accent" uppercase style={styles.overline}>
          {overline}
        </Text>
      ) : null}

      <Text variant="display" accessibilityRole="header">
        {title}
      </Text>

      {subtitle ? (
        <Text variant="body" colorToken="textSecondary" style={{ marginTop: theme.spacing.sm }}>
          {subtitle}
        </Text>
      ) : null}

      {meta ? <View style={{ marginTop: theme.spacing.lg }}>{meta}</View> : null}
    </Animated.View>
  );
}

function ScrolledToRow({
  tint,
  ring,
  onDone,
  children,
}: {
  tint: string;
  ring: string;
  onDone: () => void;
  children: React.ReactNode;
}) {
  const reduced = useReducedMotion();
  const highlight = useRef(new Animated.Value(1)).current;
  const theme = useTheme();

  const finish = useCallback(() => onDone(), [onDone]);

  useEffect(() => {

    if (reduced === null) return;

    if (reduced) {
      const timer = setTimeout(finish, SPOTLIGHT_HOLD_MS);
      return () => clearTimeout(timer);
    }

    const fade = Animated.timing(highlight, {
      toValue: 0,
      duration: SPOTLIGHT_FADE_MS,
      delay: SPOTLIGHT_HOLD_MS,
      useNativeDriver: true,
    });
    fade.start(({ finished }) => {

      if (finished) finish();
    });

    return () => fade.stop();
  }, [reduced, highlight, finish]);

  return (
    <View style={styles.spotlightHost}>
      {children}
      <Animated.View
        pointerEvents="none"
        style={[
          StyleSheet.absoluteFill,
          {
            borderRadius: theme.radius.md,
            backgroundColor: tint,
            borderColor: ring,
            borderWidth: StyleSheet.hairlineWidth,
            opacity: highlight,
          },
        ]}
      />
    </View>
  );
}

const SPARKLE_CYCLE_MS = 7200;

const SPARKLE_CURVE: readonly (readonly [number, number])[] = [
  [0, 0.18],
  [0.25, 1],
  [0.5, 0.18],
  [0.75, 0.5],
];

function curveAt(position: number): number {
  const at = ((position % 1) + 1) % 1;
  for (let index = 0; index < SPARKLE_CURVE.length; index += 1) {
    const [from, value] = SPARKLE_CURVE[index] as readonly [number, number];
    const next = SPARKLE_CURVE[(index + 1) % SPARKLE_CURVE.length] as readonly [number, number];
    const to = index + 1 === SPARKLE_CURVE.length ? 1 : next[0];
    if (at >= from && at <= to) {
      const travelled = to === from ? 0 : (at - from) / (to - from);
      return value + (next[1] - value) * travelled;
    }
  }
  return (SPARKLE_CURVE[0] as readonly [number, number])[1];
}

export function sparkleRamp(phase: number): { inputRange: number[]; outputRange: number[] } {
  const shift = ((phase % 1) + 1) % 1;
  const boundary = curveAt(shift);

  const keyframes = SPARKLE_CURVE.map(([at, value]) => {
    const moved = (((at - shift) % 1) + 1) % 1;
    return [moved, value] as const;
  })

    .filter(([at]) => at > 0 && at < 1)
    .sort((left, right) => left[0] - right[0]);

  return {
    inputRange: [0, ...keyframes.map(([at]) => at), 1],
    outputRange: [boundary, ...keyframes.map(([, value]) => value), boundary],
  };
}

export const SPARKLE_STILL_OPACITY = 0.5;

const SPARKLES: readonly { x: `${number}%`; y: `${number}%`; size: number; phase: number }[] = [
  { x: '12%', y: '8%', size: 2.5, phase: 0 },
  { x: '78%', y: '5%', size: 2, phase: 0.42 },
  { x: '44%', y: '15%', size: 1.5, phase: 0.71 },
  { x: '88%', y: '22%', size: 2.5, phase: 0.18 },
  { x: '6%', y: '31%', size: 2, phase: 0.56 },
  { x: '62%', y: '38%', size: 1.5, phase: 0.9 },
  { x: '28%', y: '49%', size: 2, phase: 0.33 },
  { x: '83%', y: '58%', size: 1.5, phase: 0.64 },
  { x: '18%', y: '71%', size: 2, phase: 0.08 },
];

export const SPARKLE_FIELD = SPARKLES;

function Sparkles() {
  const theme = useTheme();
  const reduced = useReducedMotion();
  const cycle = useRef(new Animated.Value(0)).current;
  const moving = reduced === false;

  useEffect(() => {

    if (!moving) return;

    const loop = Animated.loop(
      Animated.timing(cycle, {
        toValue: 1,
        duration: SPARKLE_CYCLE_MS,
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [moving, cycle]);

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      {SPARKLES.map((mote) => (
        <Animated.View
          key={`${mote.x}-${mote.y}`}
          style={{
            position: 'absolute',
            left: mote.x,
            top: mote.y,
            width: mote.size,
            height: mote.size,
            borderRadius: mote.size / 2,
            backgroundColor: theme.colors.backdrop.sparkle,
            opacity: moving
              ? cycle.interpolate({ ...sparkleRamp(mote.phase), extrapolate: 'clamp' })
              : SPARKLE_STILL_OPACITY,
          }}
        />
      ))}
    </View>
  );
}

export function AmbientBackdrop() {
  const theme = useTheme();

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      <LinearGradient
        colors={theme.colors.backdrop.wash}
        start={{ x: 0.5, y: 0 }}
        end={{ x: 0.5, y: 1 }}

        style={[StyleSheet.absoluteFill, styles.backdropWash]}
      />
      <LinearGradient
        colors={theme.colors.backdrop.pool}

        start={{ x: 0.88, y: 0 }}
        end={{ x: 0.1, y: 0.72 }}
        style={[StyleSheet.absoluteFill, styles.backdropPool]}
      />
      {}
      <Sparkles />
    </View>
  );
}

function useRefreshControl(onRefresh: (() => void) | undefined, refreshing: boolean, topOffset: number) {
  const theme = useTheme();
  if (!onRefresh) return undefined;

  return (
    <RefreshControl
      refreshing={refreshing}
      onRefresh={onRefresh}
      tintColor={theme.colors.accent}
      colors={[theme.colors.accent]}
      progressBackgroundColor={theme.colors.surface}
      progressViewOffset={topOffset}
    />
  );
}

export interface ScreenProps {
  children: React.ReactNode;

  bleed?: boolean;
  style?: StyleProp<ViewStyle>;
}

export function Screen({ children, bleed = false, style }: ScreenProps) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();

  return (
    <View
      style={[
        styles.fill,
        {
          backgroundColor: theme.colors.canvas,

          paddingLeft: bleed ? 0 : Math.max(theme.layout.screenPadding, insets.left),
          paddingRight: bleed ? 0 : Math.max(theme.layout.screenPadding, insets.right),
        },
        style,
      ]}
    >
      <AmbientBackdrop />
      {children}
    </View>
  );
}

export interface ScreenScrollProps extends MastheadProps {
  children: React.ReactNode;
  back?: boolean;
  onBack?: () => void;
  actions?: ScreenAction[];

  headerAccessory?: React.ReactNode;
  onRefresh?: () => void;
  refreshing?: boolean;

  footer?: React.ReactNode;
  bleed?: boolean;
  contentStyle?: StyleProp<ViewStyle>;
}

export function ScreenScroll({
  title,
  overline,
  subtitle,
  meta,
  children,
  back,
  onBack,
  actions,
  headerAccessory,
  onRefresh,
  refreshing,
  footer,
  bleed = false,
  contentStyle,
}: ScreenScrollProps) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const handover = useScreenHandover();
  const refreshControl = useRefreshControl(onRefresh, Boolean(refreshing), insets.top);
  const [footerHeight, setFooterHeight] = useState<number | null>(null);

  const padding = bleed ? 0 : theme.layout.screenPadding;
  const bottomPadding = footer
    ? (footerHeight ?? insets.bottom + FOOTER_ESTIMATE)
    : insets.bottom + theme.spacing.giant;

  return (
    <View style={[styles.fill, { backgroundColor: theme.colors.canvas }]}>
      <AmbientBackdrop />
      <Animated.ScrollView
        onScroll={handover.onScroll}
        scrollEventThrottle={16}
        refreshControl={refreshControl}
        contentContainerStyle={[
          styles.readingWidth,
          {
            paddingHorizontal: padding,

            paddingTop: insets.top + HEADER_BLOCK,
            paddingBottom: bottomPadding,
          },
          contentStyle,
        ]}
        keyboardShouldPersistTaps="handled"

        automaticallyAdjustKeyboardInsets

        style={{ paddingLeft: insets.left, paddingRight: insets.right }}

        showsVerticalScrollIndicator={Platform.OS === 'web'}
      >
        <Masthead
          title={title}
          overline={overline}
          subtitle={subtitle}
          meta={meta}
          opacity={handover.mastheadOpacity}
        />
        {children}
      </Animated.ScrollView>

      <ScreenHeaderBar
        title={title}
        titleOpacity={handover.compactOpacity}
        titleOffset={handover.compactOffset}
        ruleOpacity={handover.ruleOpacity}
        back={back}
        onBack={onBack}
        actions={actions}
        accessory={headerAccessory}
      />

      {footer ? <ScreenFooter onHeight={setFooterHeight}>{footer}</ScreenFooter> : null}
    </View>
  );
}

export type ScreenListHandle = {

  scrollToKey: (key: string, options?: ScrollRequest) => boolean;

  scrollToTop: (animated?: boolean) => void;
};

export interface ScreenListProps<T> extends MastheadProps {
  data: readonly T[];
  renderItem: (item: T, index: number) => React.ReactElement | null;
  keyExtractor: (item: T, index: number) => string;

  empty?: React.ReactNode;

  listHeader?: React.ReactNode;
  listFooter?: React.ReactNode;
  separator?: boolean;
  back?: boolean;
  actions?: ScreenAction[];
  headerAccessory?: React.ReactNode;
  onRefresh?: () => void;
  refreshing?: boolean;
  footer?: React.ReactNode;

  initialScrollIndex?: number;

  ref?: React.Ref<ScreenListHandle>;
}

export function ScreenList<T>({
  data,
  renderItem,
  keyExtractor,
  empty,
  listHeader,
  listFooter,
  separator = false,
  title,
  overline,
  subtitle,
  meta,
  back,
  actions,
  headerAccessory,
  onRefresh,
  refreshing,
  footer,
  initialScrollIndex,
  ref,
}: ScreenListProps<T>) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const handover = useScreenHandover();
  const [footerHeight, setFooterHeight] = useState<number | null>(null);

  const listRef = useRef<ScreenListScroller | null>(null);

  const laidOut = useRef(false);

  const pending = useRef<{ key: string; options?: ScrollRequest } | null>(null);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attempt = useRef(0);
  const [highlightKey, setHighlightKey] = useState<string | null>(null);

  const refreshControl = useRefreshControl(onRefresh, Boolean(refreshing), insets.top);
  const bottomPadding = footer
    ? (footerHeight ?? insets.bottom + FOOTER_ESTIMATE)
    : insets.bottom + theme.spacing.giant;

  const renderSeparator = useMemo(
    () =>
      separator
        ? () => (
            <View
              style={{
                height: StyleSheet.hairlineWidth,
                backgroundColor: theme.colors.border,
              }}
            />
          )
        : undefined,
    [separator, theme.colors.border],
  );

  const cancelRetry = useCallback(() => {
    if (retryTimer.current) clearTimeout(retryTimer.current);
    retryTimer.current = null;
  }, []);

  const scrollToKeyImpl = useRef<(key: string, options?: ScrollRequest) => boolean>(() => false);

  scrollToKeyImpl.current = (key, options) => {
    const index = indexOfKey(data, keyExtractor, key);
    if (index < 0) {

      pending.current = null;
      return false;
    }

    if (!laidOut.current || !listRef.current) {

      pending.current = { key, options };
      return true;
    }

    const scroller = listRef.current;
    if (typeof scroller.scrollToIndex !== 'function') return false;

    attempt.current = 0;
    const viewOffset = scrollViewOffset(options, insets.top);
    scroller.scrollToIndex({
      index,
      animated: options?.animated ?? false,
      viewPosition: options?.viewPosition ?? 0,
      ...(viewOffset === undefined ? {} : { viewOffset }),
    });

    setHighlightKey(key);
    return true;
  };

  const handleScrollToIndexFailed = useCallback(
    (info: { index: number; averageItemLength: number; highestMeasuredFrameIndex: number }) => {
      const retry = planScrollRetry(info, attempt.current);
      if (retry.action === 'give-up') {
        pending.current = null;
        return;
      }

      attempt.current += 1;

      if (retry.action === 'wait') {
        laidOut.current = false;
        return;
      }

      const scroller = listRef.current;
      if (!scroller || typeof scroller.scrollToOffset !== 'function') return;

      scroller.scrollToOffset({ offset: retry.offset, animated: false });
      cancelRetry();
      retryTimer.current = setTimeout(() => {
        retryTimer.current = null;
        const request = pending.current;
        if (request) scrollToKeyImpl.current(request.key, request.options);
      }, SCROLL_RETRY_DELAY_MS);
    },
    [cancelRetry],
  );

  const flushPending = useCallback(() => {
    const request = pending.current;
    if (!request) return;
    pending.current = null;
    scrollToKeyImpl.current(request.key, request.options);
  }, []);

  const handleListLayout = useCallback(
    (_event: LayoutChangeEvent) => {
      laidOut.current = true;
      flushPending();
    },
    [flushPending],
  );

  const handleContentSizeChange = useCallback(() => {
    if (pending.current && listRef.current) {
      laidOut.current = true;
      flushPending();
    }
  }, [flushPending]);

  useEffect(() => cancelRetry, [cancelRetry]);

  useImperativeHandle(
    ref,
    () => ({
      scrollToKey: (key, options) => scrollToKeyImpl.current(key, options),
      scrollToTop: (animated = true) => {
        pending.current = null;
        cancelRetry();
        const scroller = listRef.current;
        if (scroller && typeof scroller.scrollToOffset === 'function') {
          scroller.scrollToOffset({ offset: 0, animated });
        }
      },
    }),
    [cancelRetry],
  );

  const header = (
    <>
      <Masthead
        title={title}
        overline={overline}
        subtitle={subtitle}
        meta={meta}
        opacity={handover.mastheadOpacity}
      />
      {listHeader}
    </>
  );

  const safeInitialIndex =
    typeof initialScrollIndex === 'number' &&
    Number.isInteger(initialScrollIndex) &&
    initialScrollIndex > 0 &&
    initialScrollIndex < listRowCount(true, Boolean(listFooter), data.length)
      ? initialScrollIndex
      : undefined;

  return (
    <View style={[styles.fill, { backgroundColor: theme.colors.canvas }]}>
      <AmbientBackdrop />
      <AnimatedFlatList<T>
        ref={listRef}
        data={data as T[]}
        renderItem={({ item, index }) => {
          const row = renderItem(item, index);
          const key = keyExtractor(item, index);
          if (row === null) return null;
          if (key !== highlightKey) return row;

          return (

            <ScrolledToRow
              key={`spotlight-${key}`}
              tint={theme.colors.tones.accent.bg}
              ring={theme.colors.tones.accent.border}
              onDone={() => setHighlightKey((current) => (current === key ? null : current))}
            >
              {row}
            </ScrolledToRow>
          );
        }}
        keyExtractor={(item, index) => keyExtractor(item, index)}
        extraData={highlightKey}
        ListHeaderComponent={header}

        ListEmptyComponent={empty ? <View>{empty}</View> : null}
        ListFooterComponent={listFooter ? <>{listFooter}</> : null}
        ItemSeparatorComponent={renderSeparator}
        onScroll={handover.onScroll}
        scrollEventThrottle={16}
        refreshControl={refreshControl}
        onLayout={handleListLayout}
        onContentSizeChange={handleContentSizeChange}

        onScrollToIndexFailed={handleScrollToIndexFailed}
        initialScrollIndex={safeInitialIndex}
        contentContainerStyle={{
          ...styles.readingWidth,
          paddingHorizontal: theme.layout.screenPadding,
          paddingTop: insets.top + HEADER_BLOCK,
          paddingBottom: bottomPadding,
        }}

        style={{ paddingLeft: insets.left, paddingRight: insets.right }}
        keyboardShouldPersistTaps="handled"

        automaticallyAdjustKeyboardInsets
        showsVerticalScrollIndicator={Platform.OS === 'web'}

        initialNumToRender={12}
        maxToRenderPerBatch={10}
        windowSize={11}

        removeClippedSubviews={Platform.OS === 'android'}
      />

      <ScreenHeaderBar
        title={title}
        titleOpacity={handover.compactOpacity}
        titleOffset={handover.compactOffset}
        ruleOpacity={handover.ruleOpacity}
        back={back}
        actions={actions}
        accessory={headerAccessory}
      />

      {footer ? <ScreenFooter onHeight={setFooterHeight}>{footer}</ScreenFooter> : null}
    </View>
  );
}

export interface ScreenFooterProps {
  children: React.ReactNode;

  onHeight?: (height: number) => void;
}

export function ScreenFooter({ children, onHeight }: ScreenFooterProps) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const [keyboardOffset, setKeyboardOffset] = useState(0);

  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';

    const onShow = (event: any) => {
      const height = event?.endCoordinates?.height ?? 0;
      setKeyboardOffset(height);
    };
    const onHide = () => {
      setKeyboardOffset(0);
    };

    const subShow = Keyboard.addListener(showEvent, onShow);
    const subHide = Keyboard.addListener(hideEvent, onHide);

    return () => {
      subShow.remove();
      subHide.remove();
    };
  }, []);

  const bottomInset = keyboardOffset > 0 ? keyboardOffset : 0;

  return (
    <View
      onLayout={(event) => onHeight?.(event.nativeEvent.layout.height)}
      style={[
        styles.footer,
        {
          backgroundColor: theme.colors.canvas,
          borderTopColor: theme.colors.border,
          bottom: bottomInset,
          paddingBottom: keyboardOffset > 0 ? theme.spacing.sm : insets.bottom + theme.spacing.lg,
          paddingTop: theme.spacing.sm,
          paddingLeft: Math.max(theme.layout.screenPadding, insets.left),
          paddingRight: Math.max(theme.layout.screenPadding, insets.right),
        },
      ]}
    >
      {}
      <View style={styles.readingWidth}>{children}</View>
    </View>
  );
}

export interface SectionHeaderProps {
  title: string;

  count?: number;

  hint?: string;
  action?: { label: string; onPress: () => void; icon?: IconName };
}

export function SectionHeader({ title, count, hint, action }: SectionHeaderProps) {
  const theme = useTheme();

  return (
    <View style={{ marginBottom: theme.spacing.lg }}>
      <Row between align="center" gap="md">
        <Row gap="sm" align="center" style={styles.flex}>
          <Text variant="heading" accessibilityRole="header">
            {title}
          </Text>
          {typeof count === 'number' ? (
            <Text variant="monoValue" colorToken="textTertiary">
              {count}
            </Text>
          ) : null}
        </Row>

        {action ? (
          <Text
            variant="label"
            tone="accent"
            onPress={action.onPress}
            accessibilityRole="button"
            suppressHighlighting
          >
            {action.label}
          </Text>
        ) : null}
      </Row>

      {hint ? (
        <Text
          variant="bodySmall"
          colorToken="textSecondary"
          style={{ marginTop: theme.spacing.xs }}
        >
          {hint}
        </Text>
      ) : null}
    </View>
  );
}

export interface SectionProps extends SectionHeaderProps {
  children: React.ReactNode;

  first?: boolean;
}

export function Section({ children, first = false, ...header }: SectionProps) {
  const theme = useTheme();

  return (
    <View style={{ marginTop: first ? 0 : theme.spacing.huge }}>
      <SectionHeader {...header} />
      {children}
    </View>
  );
}

export interface DisclosureProps {
  children: React.ReactNode;
}

export function Disclosure() {
  const theme = useTheme();
  return <Icon name="chevron-right" size={18} color={theme.colors.textTertiary} />;
}

const styles = StyleSheet.create({
  readingWidth: { width: '100%', maxWidth: READING_MAX_WIDTH, alignSelf: 'center' },
  fill: { flex: 1 },
  flex: { flex: 1 },
  backdropWash: { bottom: '34%' },
  backdropPool: { bottom: '28%' },
  bar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
  },
  barRow: {
    alignItems: 'center',
    paddingHorizontal: SPACING.sm,
  },
  barTitle: {
    flex: 1,
  },
  rule: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: StyleSheet.hairlineWidth,
  },

  masthead: {
    paddingTop: SPACING.xl,
    paddingBottom: SPACING.xxxl,
  },
  overline: {
    marginBottom: SPACING.sm,
  },

  spotlightHost: {
    position: 'relative',
  },
  footer: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
});
