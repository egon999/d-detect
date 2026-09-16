/**
 * Screen chrome.
 *
 * The frame every screen sits in, and the place the app's navigation personality lives.
 *
 * ## The header
 *
 * Two titles, not one. A compact bar is pinned at the top holding the back affordance and
 * the screen's actions; the *real* title sits below it in the scrolling content, set large.
 * As the content scrolls, the large title fades out and the compact one rises into the bar
 * to take its place, and a hairline appears under the bar to separate it from what is now
 * moving beneath it.
 *
 * This is the iOS large-title pattern, built by hand rather than taken from the native
 * stack header. Three reasons that is the right trade here:
 *
 *   - It behaves identically on Android, where the native equivalent does not exist.
 *   - The title can be set in the app's own type scale, which a native header will not do.
 *   - The bar can hold things a native header cannot — a monospace case reference, a live
 *     processing indicator — which this product needs.
 *
 * The scroll position drives the animation through `useNativeDriver`, so the fade runs on
 * the UI thread and holds 60fps while the list underneath is still rendering rows.
 *
 * ## Why the title is in the content
 *
 * A screen's title is information, not decoration: "Payment dispute — Meridian Supplies"
 * is the longest string on the screen and needs two lines to be read. A fixed header would
 * have to truncate it. Putting it in the content means it gets the room it needs, and the
 * compact version — which *is* truncated, because by then the user has read it — is what
 * survives scrolling.
 */

import { useRouter } from 'expo-router';
import React, { useMemo, useRef } from 'react';
import {
  Animated,
  RefreshControl,
  StyleSheet,
  View,
  type FlatListProps,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Icon, type IconName } from '../icon';
import { useTheme } from '../theme';
import { SPACING } from '../tokens';
import { IconButton } from './Button';
import { Row } from './Layout';
import { Text } from './Text';

/**
 * How far the content scrolls before the handover between titles completes.
 *
 * Short enough that a flick finishes it, long enough that a one-line correction scroll does
 * not flicker the header. The fade starts a third of the way in so the two titles are never
 * both at full opacity.
 */
const HANDOVER_START = 18;
const HANDOVER_END = 62;

/**
 * `Animated.FlatList` under an unresolved generic.
 *
 * React Native types `Animated.FlatList`'s props as `AnimatedProps<FlatListProps<T>>`,
 * which maps every value to `WithAnimatedValue<…>`. When `T` is still an unresolved type
 * parameter — as it is inside the generic `ScreenList` below — TypeScript cannot prove
 * `T[]` is assignable to `WithAnimatedValue<T>[]`, so the call fails to typecheck even
 * though no animated value is ever passed as data.
 *
 * Re-declaring the component with the plain `FlatListProps<T>` it actually receives, plus
 * the scroll handler, is the narrow fix: the only prop that carries an animated value here
 * is `onScroll`, and it is typed as what `Animated.event` returns. Casting at each prop
 * instead would spread the same workaround across five call sites and hide which one is
 * load-bearing.
 */
const AnimatedFlatList = Animated.FlatList as unknown as <T>(
  props: FlatListProps<T> & {
    onScroll?: ReturnType<typeof Animated.event>;
    ref?: React.Ref<unknown>;
  },
) => React.ReactElement;

export interface ScreenAction {
  icon: IconName;
  /**
   * Required. An icon on its own is not a label — this is what a screen reader announces,
   * and the component will not let you omit it.
   */
  label: string;
  onPress: () => void;
  disabled?: boolean;
}

// ---------------------------------------------------------------------------
// The pinned bar
// ---------------------------------------------------------------------------

interface HeaderBarProps {
  title: string;
  /** Opacity and offset for the compact title, driven by scroll. */
  titleOpacity?: Animated.AnimatedInterpolation<number>;
  titleOffset?: Animated.AnimatedInterpolation<number>;
  /** Opacity for the hairline under the bar. */
  ruleOpacity?: Animated.AnimatedInterpolation<number>;
  back?: boolean;
  onBack?: () => void;
  actions?: ScreenAction[];
  /** Rendered under the title row, inside the bar. Used for the case reference line. */
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
    // `canGoBack` guards the case where the screen was deep-linked into and there is no
    // history to pop — dismissing to the case list is better than doing nothing.
    if (router.canGoBack()) router.back();
    else router.replace('/cases');
  };

  return (
    <View
      style={[
        styles.bar,
        {
          paddingTop: insets.top,
          backgroundColor: theme.colors.canvas,
        },
      ]}
    >
      <Row style={[styles.barRow, { height: theme.layout.headerHeight }]} gap="xs">
        {back ? (
          <IconButton icon="chevron-left" accessibilityLabel="Go back" onPress={goBack} size={22} />
        ) : null}

        <Animated.View
          style={[
            styles.barTitle,
            {
              opacity: titleOpacity ?? 1,
              transform: titleOffset ? [{ translateY: titleOffset }] : undefined,
              // Without a back button the title starts at the content margin, so it lines
              // up with the large title below rather than floating.
              paddingLeft: back ? 0 : theme.spacing.xs,
            },
          ]}
          // The large title below carries the same string, so announcing this one too
          // would read the screen name twice.
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

// ---------------------------------------------------------------------------
// The large title block
// ---------------------------------------------------------------------------

export interface MastheadProps {
  title: string;
  /** Small uppercase line above the title. The record's type, usually. */
  overline?: string;
  /** One line under the title. Keep it factual — this is not a tagline. */
  subtitle?: string;
  /** Chips, counts or metadata. Sits under the subtitle. */
  meta?: React.ReactNode;
  opacity?: Animated.AnimatedInterpolation<number>;
}

function Masthead({ title, overline, subtitle, meta, opacity }: MastheadProps) {
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

// ---------------------------------------------------------------------------
// Shared scroll wiring
// ---------------------------------------------------------------------------

/**
 * Builds the interpolations both scrolling containers need.
 *
 * Extracted so `ScreenScroll` and `ScreenList` animate identically — if the fade distance
 * differed between a scroll view and a list, moving between two screens would feel like
 * moving between two apps.
 */
function useHandover() {
  const scrollY = useRef(new Animated.Value(0)).current;

  return useMemo(() => {
    const compactIn = scrollY.interpolate({
      inputRange: [HANDOVER_START, HANDOVER_END],
      outputRange: [0, 1],
      extrapolate: 'clamp',
    });

    return {
      scrollY,
      onScroll: Animated.event([{ nativeEvent: { contentOffset: { y: scrollY } } }], {
        useNativeDriver: true,
      }),
      /** The compact title's opacity: absent until the large title is on its way out. */
      compactOpacity: compactIn,
      /** The compact title rises the last few pixels into place rather than just appearing. */
      compactOffset: scrollY.interpolate({
        inputRange: [HANDOVER_START, HANDOVER_END],
        outputRange: [7, 0],
        extrapolate: 'clamp',
      }),
      /** The hairline arrives slightly before the title, so the bar reads as attached first. */
      ruleOpacity: scrollY.interpolate({
        inputRange: [4, HANDOVER_START],
        outputRange: [0, 1],
        extrapolate: 'clamp',
      }),
      /** The large title is gone by the time the compact one is fully in. */
      mastheadOpacity: scrollY.interpolate({
        inputRange: [0, HANDOVER_END * 0.78],
        outputRange: [1, 0],
        extrapolate: 'clamp',
      }),
    };
  }, [scrollY]);
}

function useRefreshControl(onRefresh?: () => void, refreshing = false) {
  const theme = useTheme();
  if (!onRefresh) return undefined;

  return (
    <RefreshControl
      refreshing={refreshing}
      onRefresh={onRefresh}
      tintColor={theme.colors.accent}
      colors={[theme.colors.accent]}
      progressBackgroundColor={theme.colors.surface}
    />
  );
}

// ---------------------------------------------------------------------------
// Screen: plain container
// ---------------------------------------------------------------------------

export interface ScreenProps {
  children: React.ReactNode;
  /** Drops the horizontal padding, for full-bleed content like the graph canvas. */
  bleed?: boolean;
  style?: StyleProp<ViewStyle>;
}

/**
 * A screen that manages its own scrolling — or does not scroll at all.
 *
 * The graph canvas uses this: it pans and zooms, so it must own the gesture surface
 * completely rather than compete with a scroll view for it.
 */
export function Screen({ children, bleed = false, style }: ScreenProps) {
  const theme = useTheme();

  return (
    <View
      style={[
        styles.fill,
        {
          backgroundColor: theme.colors.canvas,
          paddingHorizontal: bleed ? 0 : theme.layout.screenPadding,
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}

// ---------------------------------------------------------------------------
// ScreenScroll: the default
// ---------------------------------------------------------------------------

export interface ScreenScrollProps extends MastheadProps {
  children: React.ReactNode;
  back?: boolean;
  onBack?: () => void;
  actions?: ScreenAction[];
  /** Rendered inside the pinned bar, under the title row. */
  headerAccessory?: React.ReactNode;
  onRefresh?: () => void;
  refreshing?: boolean;
  /** Pinned to the bottom, above the safe area. For a primary action on a long screen. */
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
  const handover = useHandover();
  const refreshControl = useRefreshControl(onRefresh, refreshing);

  const padding = bleed ? 0 : theme.layout.screenPadding;

  return (
    <View style={[styles.fill, { backgroundColor: theme.colors.canvas }]}>
      <Animated.ScrollView
        onScroll={handover.onScroll}
        scrollEventThrottle={16}
        refreshControl={refreshControl}
        contentContainerStyle={[
          {
            paddingHorizontal: padding,
            // Room for the pinned bar at the top, and for the footer plus home indicator
            // at the bottom.
            paddingTop: insets.top + theme.layout.headerHeight,
            paddingBottom: insets.bottom + theme.spacing.giant + (footer ? 72 : 0),
          },
          contentStyle,
        ]}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
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

      {footer ? <ScreenFooter>{footer}</ScreenFooter> : null}
    </View>
  );
}

// ---------------------------------------------------------------------------
// ScreenList: the same chrome, over a FlatList
// ---------------------------------------------------------------------------

export interface ScreenListProps<T> extends MastheadProps {
  data: readonly T[];
  renderItem: (item: T, index: number) => React.ReactElement | null;
  keyExtractor: (item: T, index: number) => string;
  /** Shown in place of the list when `data` is empty. */
  empty?: React.ReactNode;
  /** Between the masthead and the first row. Filters and search live here. */
  listHeader?: React.ReactNode;
  listFooter?: React.ReactNode;
  separator?: boolean;
  back?: boolean;
  actions?: ScreenAction[];
  headerAccessory?: React.ReactNode;
  onRefresh?: () => void;
  refreshing?: boolean;
  footer?: React.ReactNode;
}

/**
 * The list screen.
 *
 * A real `FlatList` rather than a mapped array inside a scroll view, because the evidence
 * list on a well-used case runs to hundreds of rows and windowing is the difference between
 * a screen that opens instantly and one that hitches.
 */
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
}: ScreenListProps<T>) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const handover = useHandover();
  const refreshControl = useRefreshControl(onRefresh, refreshing);

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

  return (
    <View style={[styles.fill, { backgroundColor: theme.colors.canvas }]}>
      <AnimatedFlatList<T>
        data={data as T[]}
        renderItem={({ item, index }) => renderItem(item, index)}
        keyExtractor={(item, index) => keyExtractor(item, index)}
        ListHeaderComponent={header}
        // The empty slot is a `View` where the header and footer are fragments, and the
        // asymmetry is load-bearing. `VirtualizedList` wraps the header and footer in a `View`
        // of its own to hang `onLayout` on, so a fragment in either is never written to. The
        // empty slot gets no such wrapper: it `cloneElement`s whatever it is handed with
        // `onLayout` and `style`, and a fragment accepts neither. That is where "Invalid prop
        // `onLayout` supplied to `React.Fragment`" came from — on *every* list screen, because
        // every one of them is empty while it loads, so the warning fired constantly and buried
        // real ones. React Native 0.83 guards that path against fragments; react-native-web,
        // which is what Expo web runs, does not, so this stops depending on either.
        //
        // Plain and unstyled on purpose. It sits directly in the scroll view's content
        // container, which is already a stretch-aligned column, and `EmptyState`, `ErrorState`
        // and `SkeletonList` all size themselves — so it adds a level of nesting and no
        // geometry. The masthead is deliberately left inside its fragment: the header is the
        // one slot whose height the handover fade is measured against, and it does not need
        // changing.
        ListEmptyComponent={empty ? <View>{empty}</View> : null}
        ListFooterComponent={listFooter ? <>{listFooter}</> : null}
        ItemSeparatorComponent={
          separator
            ? () => <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: theme.colors.border }} />
            : undefined
        }
        onScroll={handover.onScroll}
        scrollEventThrottle={16}
        refreshControl={refreshControl}
        contentContainerStyle={{
          paddingHorizontal: theme.layout.screenPadding,
          paddingTop: insets.top + theme.layout.headerHeight,
          paddingBottom: insets.bottom + theme.spacing.giant + (footer ? 72 : 0),
        }}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        // Tuned for rows of roughly `rowHeight`. Windowing too aggressively shows blank
        // space on a fast flick; too loosely and the first paint does unnecessary work.
        initialNumToRender={12}
        maxToRenderPerBatch={10}
        windowSize={11}
        removeClippedSubviews
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

      {footer ? <ScreenFooter>{footer}</ScreenFooter> : null}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Footer
// ---------------------------------------------------------------------------

/**
 * The pinned action bar.
 *
 * Opaque rather than translucent. A blurred bar over a list of monospace figures makes the
 * digits behind it ambiguous, and in this product an ambiguous digit is a real problem.
 */
export function ScreenFooter({ children }: { children: React.ReactNode }) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();

  return (
    <View
      style={[
        styles.footer,
        {
          backgroundColor: theme.colors.canvas,
          borderTopColor: theme.colors.border,
          paddingBottom: insets.bottom + theme.spacing.lg,
          paddingHorizontal: theme.layout.screenPadding,
          paddingTop: theme.spacing.lg,
        },
      ]}
    >
      {children}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Section
// ---------------------------------------------------------------------------

export interface SectionHeaderProps {
  title: string;
  /** A count, shown in mono next to the title. Machine-counted, so set in mono. */
  count?: number;
  /** One line explaining what the section contains, when the title is not enough. */
  hint?: string;
  action?: { label: string; onPress: () => void; icon?: IconName };
}

/**
 * The header above a section of a screen.
 *
 * ## Why the title is a `heading` and not an `overline`
 *
 * It used to be `overline`: 10.5pt, tracked out, uppercased, in *tertiary* text. That is a
 * label style, and using it for a section title inverted the hierarchy of every screen that
 * has sections — the title of a section was the smallest and faintest text in it, set
 * smaller than the body copy it introduced. A reader scanning for structure found nothing
 * to catch on, which is most of what "nothing has hierarchy" means in practice.
 *
 * A section title is now a real rank: `heading`, 22pt Bold, in primary text. That gives an
 * ordinary screen a three-step structure without the screen asking for one —
 * `display` 36 (the screen) → `heading` 22 (the section) → `body` 15.5 (the content) — which
 * is the whole point of fixing this here rather than screen by screen.
 *
 * The contrast improves as a side effect of the colour going with it: on the light canvas
 * the title moves from 4.91:1 to 16.91:1, and on the dark canvas from 6.34:1 to 17.39:1.
 * Both passed AA before; the title is now simply the thing your eye lands on.
 *
 * The `hint` moved from `caption` (12) to `bodySmall` (14) in secondary text for the same
 * reason. These hints are full sentences carrying the product's own hedging — "A grade is a
 * reading of the evidence, not a verdict" — so they are prose to be read, not a caption.
 */
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
  /** Extra space above. Sections after the first want it; the first does not. */
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

// ---------------------------------------------------------------------------
// Row of a list
// ---------------------------------------------------------------------------

export interface DisclosureProps {
  children: React.ReactNode;
}

/** The chevron on a tappable row. Separate so every row uses the same one. */
export function Disclosure() {
  const theme = useTheme();
  return <Icon name="chevron-right" size={18} color={theme.colors.textTertiary} />;
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  flex: { flex: 1 },
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
  /*
    The large title needs room around it to read as a masthead rather than as the first row
    of content. The bottom gap is the larger of the two on purpose: it separates the title
    block from the first section, which is the one boundary on the screen that most wants
    to be unambiguous.
  */
  masthead: {
    paddingTop: SPACING.xl,
    paddingBottom: SPACING.xxxl,
  },
  overline: {
    marginBottom: SPACING.sm,
  },
  footer: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
});
