/**
 * First-run introduction.
 *
 * Three slides that explain what the app is for before asking for an account. Shown once,
 * on the first launch, then the preference is written to device storage so subsequent
 * launches go straight to sign-in.
 *
 * ## Why this exists as a separate route
 *
 * `app/index.tsx` checks whether the flag has been set and redirects here when it has not.
 * That keeps the routing decision in one place and lets sign-in stay focused on credentials
 * rather than doubling as an introduction. The onboarding screen writes the flag itself,
 * on any path to sign-in, so a user who taps Skip still does not see it again.
 *
 * ## Nothing interactive here
 *
 * The slides are read-only. There are no sign-in fields, no permissions prompts, and no data
 * collection. The only choices are to advance through the slides or to skip straight to the
 * end. Both paths write the same flag.
 *
 * ## Why this screen is a real carousel
 *
 * This is the first thing a user ever sees, and it used to hard-cut between slides with a
 * pair of Next/Previous buttons — which told the user, before they had read a word, that the
 * product was assembled rather than built. It is now a horizontally paged scroll view, so
 * the slides are *swipeable*: the gesture a phone user already reaches for works, and the
 * page position is a continuous number rather than an integer that jumps.
 *
 * That continuous number is the whole design. One `Animated.Value` tracks the scroll offset
 * and everything on screen is derived from it by interpolation — the page dots, the icon's
 * parallax lag, the text fade, the card's recede. Nothing reads an index to decide how to
 * look, so there is no frame at which two states are both half-applied, and a half-finished
 * swipe is drawn exactly half-finished rather than snapping to whichever slide won.
 *
 * ## The one animation that is not on the native driver, and why
 *
 * `Motion.tsx` sets the rule the rest of the app follows: `useNativeDriver: true`, and
 * therefore only `opacity` and `transform` are ever animated. Every effect here obeys it —
 * the parallax, the fades, the scales — and runs on the UI thread from `scrollX`.
 *
 * The page dots are the exception, because their *width* is what expands, and width is a
 * layout property the native animated module cannot touch. The alternatives were both worse:
 * `scaleX` on a pill squashes its corner radius along with it, so an 8pt dot ends up a
 * rounded rectangle rather than a circle, and a translated fixed-width layer (the `Shimmer`
 * trick) cannot change the slot's own width. So a second, JS-driven value — `dotsX` — is fed
 * from the same scroll event through `Animated.event`'s `listener`, and drives the widths.
 *
 * The cost is bounded and small: three interpolated widths updated at the scroll event rate,
 * on a screen with no list virtualisation, no network activity and nothing else competing
 * for the JS thread. That is the opposite of the situation the native-driver rule exists to
 * protect, which is why the exception is safe *here* and should not be copied into a list row.
 *
 * ## Reduced motion
 *
 * Handled the way `Motion.tsx` handles it — `useReducedMotion()`, and the settled state is
 * what renders until the async query has come back `false`. Every interpolation below is
 * gated on that, so a user who asked for no motion gets flat pages with no parallax, no
 * fades and no recede, and dots that simply mark the page they are on. The swipe itself
 * still works: reduce-motion means "do not animate at me", not "take the gesture away".
 */

import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import React, { useCallback, useMemo, useRef, useState } from 'react';
import {
  Animated,
  Image,
  ScrollView,
  StyleSheet,
  useWindowDimensions,
  View,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { markOnboardingSeen } from '@services/preferences';
import {
  BORDER_WIDTH,
  Button,
  FadeIn,
  GlassSurface,
  Gradient,
  Icon,
  LAYOUT,
  RADIUS,
  Row,
  SPACING,
  SlideUpIn,
  Text,
  useReducedMotion,
  useTheme,
  type IconName,
} from '@ui';

interface Slide {
  id: string;
  title: string;
  subtitle: string;
  icon: IconName;
}

const SLIDES: ReadonlyArray<Slide> = [
  {
    id: '1',
    title: 'Start with a claim',
    subtitle:
      'Describe what you want to check. Add the people involved and the specific statements that need evidence.',
    icon: 'file-document-multiple-outline',
  },
  {
    id: '2',
    title: 'Add your evidence',
    subtitle:
      'Screenshots, documents, recordings or written accounts. Each one is read for the dates, amounts and names it contains, and you can see exactly what was read.',
    icon: 'scale-balance',
  },
  {
    id: '3',
    title: 'See what the evidence shows',
    subtitle:
      'Each claim comes back supported, contradicted, or somewhere in between — with the quotes behind it and what is still missing. It is a reading for you to check, not a verdict.',
    icon: 'text-box-search-outline',
  },
  /*
    Slide 3 used to promise "Supported, Contradicted or Unsupported". Two things were wrong
    with that. "Unsupported" is a `ClaimStateEnum` value (`@domain/enums`), which is a different
    vocabulary from the one a report actually shows a reader; the report's six outcomes live in
    `ASSESSMENT_LABELS` (`@domain/analysis/case-report`) and include "Partially supported",
    "Disputed", "Insufficient evidence" and "Unresolved". And the "X, Y or Z" shape read as the
    complete set, so a reader who then saw "Disputed" would meet a word the app had told them
    did not exist. Naming the two poles and leaving the middle open is true at three outcomes
    and at six; the about page enumerates all of them, which is the right place for a list.

    The hedge that followed it has been cut to its last clause. It ran to forty words across
    two semicolons — "Consistency checks run on every case; AI readings are optional and always
    need your review — they are not a verdict" — which is a settings page and a disclaimer
    wedged into the third sentence a person ever reads about this product. What a reader needs
    here is that the result is theirs to check. Which parts are optional, and what they cost,
    is a question they can only have after they have seen one.
  */
];

// ---------------------------------------------------------------------------
// Motion tuning
// ---------------------------------------------------------------------------

/**
 * Parallax rates, as a fraction of the page width.
 *
 * Both layers *lag* the page rather than lead it — an element that travels slower than the
 * surface carrying it is what the eye reads as "further away", and two different rates are
 * what turn a sliding rectangle into a scene with depth. The icon lags hard because it is
 * the background of the composition; the text barely lags, because it is what the user is
 * trying to read and anything more makes it feel unmoored from its own card.
 *
 * `TEXT_LAG` is also bounded by a layout fact rather than taste. Pages are not clipped, so
 * a lagging element can drift into the neighbouring page: at the halfway point of a swipe
 * the drift is half these values, and the gutter between two cards is `PAGE_PADDING` twice
 * over (40pt). 0.07 of a 390pt page is 27pt of drift, 13pt at the halfway point, comfortably
 * inside that gutter. The icon may lag far more because it is small and centred, so even
 * 0.3 of a page leaves it well inside its own card.
 */
const ICON_LAG = 0.3;
const TEXT_LAG = 0.07;

/** How far a neighbouring card sits back, as a scale factor, and how much it dims. */
const CARD_RECEDE = 0.93;
const CARD_DIM = 0.55;

/** The incoming icon's scale. Low enough that the icon reads as *arriving*, not as sliding. */
const ICON_ENTER_SCALE = 0.72;

const DOT_SIZE = SPACING.sm;
/** The active dot's width. A pill rather than a bigger circle: length reads as progress. */
const DOT_WIDTH_ACTIVE = SPACING.xxl;
const DOT_OPACITY_IDLE = 0.28;

/**
 * Horizontal breathing room inside a page. Also, doubled, the gutter between two cards.
 *
 * `LAYOUT.screenPadding`, not a second copy of its value. This was a literal 20 declared
 * here, which is the same gutter every other screen in the app takes from the token — so
 * onboarding would have kept its own margin the day that token moved.
 */
const PAGE_PADDING = LAYOUT.screenPadding;

/**
 * The hero glyph's ring, and the glyph inside it.
 *
 * Derived from the spacing scale rather than typed as 84 and 42: the diameter is two of the
 * scale's largest step, the radius is half of that by definition, and the glyph is one step,
 * so the ring keeps exactly half its width as air on each side at every text size.
 */
const ICON_RING = SPACING.huge * 2;
const ICON_GLYPH = SPACING.huge;

// ---------------------------------------------------------------------------
// A slide
// ---------------------------------------------------------------------------

interface SlideViewProps {
  slide: Slide;
  index: number;
  /** The shared, native-driven scroll offset every interpolation below derives from. */
  scrollX: Animated.Value;
  pageWidth: number;
  /** False under reduced motion *and* while the setting is still unknown. */
  animate: boolean;
  /** Left and right safe-area insets, which matter in landscape on a notched device. */
  edgeInset: number;
}

/**
 * One page of the carousel.
 *
 * A component rather than a mapped fragment so each page can build its own interpolations
 * in a hook. All three are mounted at once — with three slides there is nothing to
 * virtualise, and keeping them mounted is what lets the parallax be correct for the page
 * being left as well as the one being entered.
 *
 * The content sits in its own vertical scroll view, centred while it fits and scrollable
 * when it does not. That is not defensive padding for the copy as written — it is what keeps
 * the screen usable at a large accessibility text size, where the longest slide's subtitle
 * is taller than the phone.
 */
function SlideView({
  slide,
  index,
  scrollX,
  pageWidth,
  animate,
  edgeInset,
}: SlideViewProps) {
  const theme = useTheme();

  const motion = useMemo(() => {
    // Guarded because an interpolation's input range must strictly increase, and the very
    // first render can in principle see a zero width before layout has been measured.
    const width = Math.max(1, pageWidth);
    // The page before this one, this one, the page after. Every output below is read as
    // "off to the left, centred, off to the right".
    const inputRange = [(index - 1) * width, index * width, (index + 1) * width];
    const ramp = (from: number, to: number) =>
      scrollX.interpolate({
        inputRange,
        outputRange: [from, to, from],
        extrapolate: 'clamp',
      });

    return {
      cardScale: ramp(CARD_RECEDE, 1),
      cardOpacity: ramp(CARD_DIM, 1),
      // Negative when the page is off to the left, positive when it is off to the right:
      // the element ends up displaced *against* the page's travel, which is the lag.
      iconShift: scrollX.interpolate({
        inputRange,
        outputRange: [-width * ICON_LAG, 0, width * ICON_LAG],
        extrapolate: 'clamp',
      }),
      iconScale: ramp(ICON_ENTER_SCALE, 1),
      iconOpacity: ramp(0, 1),
      textShift: scrollX.interpolate({
        inputRange,
        outputRange: [-width * TEXT_LAG, 0, width * TEXT_LAG],
        extrapolate: 'clamp',
      }),
      textOpacity: ramp(0, 1),
    };
  }, [scrollX, index, pageWidth]);

  return (
    <View
      style={[styles.page, { width: pageWidth, paddingHorizontal: PAGE_PADDING + edgeInset }]}
      // One accessible element per page, carrying the slide's whole text. A screen reader
      // then advances slide by slide instead of fragment by fragment, and because the
      // element spans the full page the platform's scroll-to-focus lands on a page boundary
      // rather than halfway between two.
      accessible
      accessibilityLabel={`${slide.title}. ${slide.subtitle}`}
    >
      <ScrollView
        contentContainerStyle={styles.pageContent}
        showsVerticalScrollIndicator={false}
        // The horizontal pager owns the fling. An inner bounce competing with it on a
        // diagonal swipe is the kind of detail that reads as unfinished.
        bounces={false}
      >
        <Animated.View
          style={
            animate
              ? { opacity: motion.cardOpacity, transform: [{ scale: motion.cardScale }] }
              : null
          }
        >
          <GlassSurface
            variant="hero"
            radius="xl"
            elevation="medium"
            // Deliberately not `translucent`. Every contrast ratio in `tokens.ts` is
            // verified against `canvas`, `surface` and `surfaceRaised`; a translucent
            // composite is none of those, and this card carries the only prose on the
            // screen a user has not yet decided to trust.
            style={styles.card}
            contentStyle={styles.cardContent}
          >
            <Animated.View
              style={
                animate
                  ? {
                      opacity: motion.iconOpacity,
                      transform: [
                        { translateX: motion.iconShift },
                        { scale: motion.iconScale },
                      ],
                    }
                  : null
              }
            >
              <View
                style={[
                  styles.iconCircle,
                  {
                    backgroundColor: theme.colors.accentSurface,
                    borderColor: theme.colors.accent,
                  },
                ]}
              >
                <Icon name={slide.icon} size={ICON_GLYPH} color={theme.colors.accent} />
              </View>
            </Animated.View>

            <Animated.View
              style={[
                styles.copy,
                animate
                  ? {
                      opacity: motion.textOpacity,
                      transform: [{ translateX: motion.textShift }],
                    }
                  : null,
              ]}
            >
              <Text variant="title" center style={{ color: theme.colors.text }}>
                {slide.title}
              </Text>

              {/* No `lineHeight` override. `TYPE.body` sets 23.5 for this rank and this
                  style used to pull it back to 22, which tightens the only paragraph of
                  prose on the screen below the leading the type scale was measured at. */}
              <Text
                variant="body"
                colorToken="textSecondary"
                center
                style={{ marginTop: theme.spacing.lg }}
              >
                {slide.subtitle}
              </Text>
            </Animated.View>
          </GlassSurface>
        </Animated.View>
      </ScrollView>
    </View>
  );
}

// ---------------------------------------------------------------------------
// The screen
// ---------------------------------------------------------------------------

export default function OnboardingScreen() {
  const router = useRouter();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const reduced = useReducedMotion();
  const dimensions = useWindowDimensions();

  const scrollRef = useRef<ScrollView | null>(null);

  /**
   * The scroll offset, twice over.
   *
   * `scrollX` is handed to the native animated module and drives every transform and
   * opacity on the screen. `dotsX` is its JS-side twin and drives only the dot widths,
   * which the native driver cannot animate — see this file's header for why that trade is
   * the right one on this screen specifically.
   */
  const scrollX = useRef(new Animated.Value(0)).current;
  const dotsX = useRef(new Animated.Value(0)).current;

  /**
   * Page width, seeded from the window and then confirmed by layout.
   *
   * The seed means the first paint already has a usable width, so nothing flashes at zero
   * size; the `onLayout` confirmation means the pager is still correct if this screen is
   * ever not exactly as wide as the window — on a tablet, on web, or mid-rotation.
   */
  const [pageWidth, setPageWidth] = useState(dimensions.width);
  // The scroll listener needs the width too, and must not be rebuilt when it changes:
  // re-creating the handler mid-gesture would detach and re-attach the native scroll event.
  const pageWidthRef = useRef(pageWidth);

  /**
   * The settled page.
   *
   * Drives the CTA's label and the step caption — content decisions, which genuinely are
   * discrete. Nothing *visual* reads this: the dots, the parallax and the fades all come
   * off the scroll offset, which is the point of the rebuild.
   */
  const [activeIndex, setActiveIndex] = useState(0);
  const activeIndexRef = useRef(0);

  const lastIndex = SLIDES.length - 1;
  const isLast = activeIndex === lastIndex;
  // `null` means the accessibility query has not come back yet. Treating it as "no motion"
  // is the same conservative default `Motion.tsx` takes: the failure mode is a flat screen,
  // never a blank one.
  const animate = reduced === false;

  /**
   * Marks onboarding as seen and navigates to sign-in.
   *
   * A failed write is swallowed: the onboarding flow has completed regardless, and the
   * worst outcome of a failed write is that the user sees the slides again next launch —
   * far better than a broken navigation.
   */
  const finish = useCallback(() => {
    void markOnboardingSeen().catch(() => {});
    router.replace('/sign-in');
  }, [router]);

  /**
   * Runs on every scroll frame, alongside the native mapping.
   *
   * Deliberately free of changing dependencies — it reads the page width from a ref and
   * writes through setters that never change identity — so the `Animated.event` built
   * around it is created once and the native scroll binding is never torn down.
   */
  const handleScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const offset = event.nativeEvent.contentOffset.x;
      dotsX.setValue(offset);

      const width = pageWidthRef.current;
      if (width <= 0) return;

      // Rounding means the page "changes" as it crosses the halfway point, which is where
      // the eye has already committed to the new slide. Waiting for the fling to settle
      // would land the haptic after the movement it is supposed to accompany.
      const next = Math.min(lastIndex, Math.max(0, Math.round(offset / width)));
      if (next === activeIndexRef.current) return;

      activeIndexRef.current = next;
      setActiveIndex(next);
      // Fire-and-forget, exactly as `Pressable` does it: a haptic that fails must never
      // interfere with the gesture that triggered it.
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    },
    [dotsX, lastIndex],
  );

  const onScroll = useMemo(
    () =>
      Animated.event<NativeScrollEvent>(
        [{ nativeEvent: { contentOffset: { x: scrollX } } }],
        { useNativeDriver: true, listener: handleScroll },
      ),
    [scrollX, handleScroll],
  );

  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    const next = event.nativeEvent.layout.width;
    // Only on a real change: `onLayout` fires on every parent resize, and writing identical
    // state each time would re-run every page's interpolation memo for nothing.
    if (next <= 0) return;
    pageWidthRef.current = next;
    setPageWidth((current) => (Math.abs(current - next) > 0.5 ? next : current));
  }, []);

  const handleNext = useCallback(() => {
    if (isLast) {
      finish();
      return;
    }
    scrollRef.current?.scrollTo({
      x: (activeIndexRef.current + 1) * pageWidthRef.current,
      // Under reduced motion the page is replaced rather than slid. The scroll listener
      // still fires, so the dots and the label keep up either way.
      animated: animate,
    });
  }, [isLast, finish, animate]);

  return (
    <View style={[styles.root, { backgroundColor: theme.colors.canvas }]}>
      {/*
        The app's one ambient wash, used for exactly what its token documents: the top of a
        scrolling surface. It gives the canvas behind the glass card somewhere to be lit
        from, which is what keeps the card reading as a sheet rather than as a shape.
      */}
      <Gradient
        colors={theme.colors.gradientWash}
        start={{ x: 0.5, y: 0 }}
        end={{ x: 0.5, y: 1 }}
        style={styles.wash}
        pointerEvents="none"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      />

      {/*
        Entrance. Three steps, and none of them touches the carousel's own motion.

        The bar is anchored to the top, so it travels *down* into place — a positive slide
        would start it below its own resting position and read as the header rising out of the
        content. The pager then fades rather than slides: it already carries a scroll-driven
        parallax, and a second translation underneath that would make the first swipe feel like
        it had two things moving at once. The footer follows last, which is also reading order.

        The carousel wrapper takes `flex` so the pager keeps the height it had when the bar and
        footer were its siblings; the `Animated.ScrollView` inside still measures itself through
        `onLayout`, so the page width is unaffected.
      */}
      <SlideUpIn distance={-theme.motion.enterDistance}>
        {/* Top bar */}
        <Row
          between
          align="center"
          style={[
            styles.topBar,
            {
              paddingTop: insets.top + theme.spacing.xl,
              paddingLeft: PAGE_PADDING + insets.left,
              paddingRight: PAGE_PADDING + insets.right,
            },
          ]}
        >
          <Row align="center" gap="sm">
            <View
              style={[
                styles.logoBadge,
                {
                  backgroundColor: theme.colors.surfaceRaised,
                  borderColor: theme.colors.border,
                },
              ]}
            >
              <Image
                source={require('../assets/dd.png')}
                style={styles.logoImage}
                resizeMode="contain"
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
              />
            </View>
            <Text variant="heading" style={{ color: theme.colors.text }}>
              Ddetect
            </Text>
          </Row>

          {/*
            A real `Button`, not a `Pressable` wrapped round a caption ending in a raw `›`.

            That glyph is a typed character, so it took the body face rather than the icon
            font, did not flip under a right-to-left locale, and was read aloud by a screen
            reader as "single right-pointing angle quotation mark". The app has one chevron
            and it comes from the icon set. `size="md"` because the ghost `sm` is 40pt tall,
            under the 44pt minimum this control used to get from `Pressable`'s own floor.
          */}
          <Button
            label="Skip"
            icon="chevron-right"
            iconTrailing
            variant="ghost"
            size="md"
            onPress={finish}
            accessibilityHint="Goes straight to sign in"
          />
        </Row>
      </SlideUpIn>

      {/* The carousel. Faded, not slid: the pager already carries a scroll-driven parallax,
          and a second translation under it would read as two things moving during the first
          swipe. */}
      <FadeIn flex>
        <Animated.ScrollView
          ref={scrollRef}
          horizontal
          pagingEnabled
          snapToInterval={pageWidth}
          decelerationRate="fast"
          disableIntervalMomentum
          showsHorizontalScrollIndicator={false}
          onScroll={onScroll}
          // 16ms keeps the JS-side dot widths in step with the native-side parallax. Anything
          // coarser and the dots visibly trail the card they are describing.
          scrollEventThrottle={16}
          onLayout={handleLayout}
          style={styles.carousel}
        >
          {SLIDES.map((slide, index) => (
            <SlideView
              key={slide.id}
              slide={slide}
              index={index}
              scrollX={scrollX}
              pageWidth={pageWidth}
              animate={animate}
              edgeInset={Math.max(insets.left, insets.right)}
            />
          ))}
        </Animated.ScrollView>
      </FadeIn>

      {/* Last, and one beat behind the pager. Dots, caption and the CTA are one control
          group, so they arrive together rather than as three separate elements. */}
      <SlideUpIn delay={theme.motion.stagger * 2}>
        {/* Bottom navigation */}
        <View
          style={[
            styles.footer,
            {
              paddingLeft: PAGE_PADDING + insets.left,
              paddingRight: PAGE_PADDING + insets.right,
              paddingBottom: insets.bottom + theme.spacing.xxxl,
            },
          ]}
        >
          {/*
            The page position, stated once.

            It was stated three times inside about 100pt of footer: these dots, a caption
            reading "Step 1 of 3" directly under them, and a primary button that relabelled
            itself from "Next" to "Get started" on the last page. Three readouts of one
            integer, on the screen that is a person's first impression of whether anyone
            thought about this product.

            The dots are the one that stays. They are continuous — read straight off the
            scroll offset, so a half-finished swipe is drawn half-finished — which is
            information the caption could not carry, and they are the convention every phone
            user already reads without being taught. The caption is gone. The button's label
            stays, because on the last page it is not a position: it names a different
            action, which finishes the introduction and leaves for sign-in.

            Its accessibility moved here with it. The dots used to be hidden from screen
            readers precisely because the caption said the same thing in words, so removing
            the caption without this would have removed the position for anyone not looking
            at the screen. `progressbar` with a value is how that is said once, to everyone.
          */}
          <Row
            align="center"
            justify="center"
            gap="sm"
            style={{ marginBottom: theme.spacing.xxl }}
            accessible
            accessibilityRole="progressbar"
            accessibilityLabel="Introduction"
            accessibilityValue={{
              min: 1,
              max: SLIDES.length,
              now: activeIndex + 1,
              text: `Slide ${activeIndex + 1} of ${SLIDES.length}`,
            }}
            accessibilityLiveRegion="polite"
          >
            {SLIDES.map((slide, index) => (
              <PageDot
                key={slide.id}
                index={index}
                dotsX={dotsX}
                pageWidth={pageWidth}
                animate={animate}
                active={index === activeIndex}
              />
            ))}
          </Row>

          <Button
            label={isLast ? 'Get started' : 'Next'}
            icon={isLast ? 'check' : 'arrow-right'}
            iconTrailing
            variant="primary"
            size="lg"
            fullWidth
            onPress={handleNext}
            accessibilityHint={
              isLast ? 'Finishes the introduction and goes to sign in' : 'Shows the next slide'
            }
          />
        </View>
      </SlideUpIn>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Page dots
// ---------------------------------------------------------------------------

interface PageDotProps {
  index: number;
  dotsX: Animated.Value;
  pageWidth: number;
  animate: boolean;
  /** Only consulted under reduced motion, where the dot marks the settled page instead. */
  active: boolean;
}

/**
 * One page dot: an 8pt circle that stretches into a 24pt pill as its page arrives.
 *
 * Width and opacity are both read straight off the scroll offset, so a half-finished swipe
 * leaves the dot half-stretched — the dots are a readout of the gesture rather than a
 * summary of its outcome, which is the difference between an indicator that feels attached
 * to the user's thumb and one that blinks after the fact.
 *
 * The colour stays `accent` throughout and opacity alone separates the current page from the
 * others. One colour family reads as a single control; swapping hue *and* width would be two
 * signals for one piece of information.
 */
function PageDot({ index, dotsX, pageWidth, animate, active }: PageDotProps) {
  const theme = useTheme();

  const motion = useMemo(() => {
    const width = Math.max(1, pageWidth);
    const inputRange = [(index - 1) * width, index * width, (index + 1) * width];
    return {
      width: dotsX.interpolate({
        inputRange,
        outputRange: [DOT_SIZE, DOT_WIDTH_ACTIVE, DOT_SIZE],
        extrapolate: 'clamp',
      }),
      opacity: dotsX.interpolate({
        inputRange,
        outputRange: [DOT_OPACITY_IDLE, 1, DOT_OPACITY_IDLE],
        extrapolate: 'clamp',
      }),
    };
  }, [dotsX, index, pageWidth]);

  return (
    <Animated.View
      style={[
        styles.dot,
        { backgroundColor: theme.colors.accent },
        animate
          ? { width: motion.width, opacity: motion.opacity }
          : {
              width: active ? DOT_WIDTH_ACTIVE : DOT_SIZE,
              opacity: active ? 1 : DOT_OPACITY_IDLE,
            },
      ]}
    />
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  // Tall enough to give the card a lit region to sit in, short enough that it never reaches
  // the body text — a gradient behind prose shifts the contrast ratio across the line.
  wash: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: '46%',
  },
  topBar: {
    paddingBottom: SPACING.xxs,
  },
  logoBadge: {
    width: LAYOUT.tileSize,
    height: LAYOUT.tileSize,
    borderRadius: RADIUS.sm,
    borderWidth: BORDER_WIDTH.hairline,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  logoImage: {
    width: SPACING.xxxl,
    height: SPACING.xxxl,
  },
  carousel: { flex: 1 },
  page: {
    justifyContent: 'center',
  },
  pageContent: {
    flexGrow: 1,
    justifyContent: 'center',
    paddingVertical: SPACING.md,
  },
  // Half the app's content width. The card is a single column of prose, and prose stops
  // being readable long before 720pt — the same reason the home screen's first-run block
  // takes the same measure.
  card: {
    width: '100%',
    maxWidth: LAYOUT.maxContentWidth / 2,
    alignSelf: 'center',
  },
  cardContent: {
    alignItems: 'center',
    paddingVertical: SPACING.xxxl,
    paddingHorizontal: SPACING.xxl,
  },
  iconCircle: {
    width: ICON_RING,
    height: ICON_RING,
    borderRadius: ICON_RING / 2,
    borderWidth: BORDER_WIDTH.hairline,
    justifyContent: 'center',
    alignItems: 'center',
  },
  copy: {
    marginTop: SPACING.xl,
    width: '100%',
  },
  footer: {
    paddingTop: SPACING.md,
  },
  dot: {
    height: DOT_SIZE,
    borderRadius: DOT_SIZE / 2,
  },
});
