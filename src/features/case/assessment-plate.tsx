/**
 * The assessment plate.
 *
 * One claim, the position the evidence puts it in, and what is missing — in that order,
 * because that is the order a person asks the questions in. It is the element this product
 * exists to render: everything upstream of it (extraction, normalisation, comparison, the
 * rule engine, the model) is machinery for filling in three lines of it honestly.
 *
 * ## Why a plate and not a card with a chip
 *
 * The obvious build is a `Surface` with a status `Chip` in the corner. That was rejected for a
 * specific reason: a chip is chrome. It sits at the size of a timestamp and reads as metadata
 * about the card, so the card's subject stays the claim sentence and the assessment becomes a
 * label on it. Here the assessment *is* the subject — it is the only thing on the screen the
 * app produced rather than received — so it is set at `title`, in its tone, against a rule.
 * The claim sentence above it is the quieter element, in sans, because those are the user's
 * own words and the app has no business emphasising them.
 *
 * The leading rule is `BORDER_WIDTH.thick`, the same 2pt used by `ProvenanceValue`'s rule.
 * That is deliberate reuse of an existing device rather than a new one: in this app a short
 * vertical rule already means "this value has an origin, and here it is". An assessment has
 * an origin too — the cited passages counted on the line underneath.
 *
 * ## Why the status word cross-fades through zero
 *
 * When a new analysis lands, the word changes. Interpolating the colour from the old tone to
 * the new one would force `useNativeDriver: false` on a view inside a scrolling list, which is
 * the one place this codebase refuses to put a JS-driven animation. Fading out, swapping, and
 * fading back in keeps the animation to opacity and translateY — both native — and has the
 * side effect of making the colour change free, because it happens at zero opacity where no
 * one can see it interpolate. The motion says "this changed"; it does not attempt to depict
 * the change.
 *
 * The plate does not animate its own arrival. `Stagger` on the case screen already does that,
 * and two entrance animations on one element read as a stutter.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Animated, Easing, StyleSheet, View } from 'react-native';

import { ASSESSMENT_LABELS } from '@domain/analysis/case-report';
import type { Claim } from '@domain/models';
import {
  BORDER_WIDTH,
  Disclosure,
  Icon,
  MOTION,
  Pressable,
  Row,
  SPACING,
  Text,
  useReducedMotion,
  useTheme,
} from '@ui';

import { ASSESSMENT_READING, type AssessmentStatus, type CitationBasis } from './assessment';

/**
 * How far the incoming status word travels, in points.
 *
 * Half of `MOTION.enterDistance`, because a status changing in place is not content arriving
 * on screen. The full 12pt reads as a new element flying in; six reads as the same element
 * settling into a new value, which is what actually happened.
 */
const SWAP_RISE = MOTION.enterDistance / 2;

export interface AssessmentPlateProps {
  claim: Claim;
  /** `null` when no current assessment covers this claim's present wording. */
  status: AssessmentStatus | null;
  /** What the assessment rests on, recounted against the live workspace. */
  basis: CitationBasis | null;
  /** Gaps the assessment named. First one is shown; the rest are counted. */
  missing: readonly string[];
  onPress: () => void;
}

export function AssessmentPlate({
  claim,
  status,
  basis,
  missing,
  onPress,
}: AssessmentPlateProps) {
  const theme = useTheme();
  const reduced = useReducedMotion();

  /**
   * The status currently painted, which lags `status` for the length of the cross-fade.
   *
   * Held in a ref as well as in state: the ref is what the effect compares against, so a
   * re-render caused by anything other than a status change cannot restart the animation.
   */
  const [painted, setPainted] = useState<AssessmentStatus | null>(status);
  const paintedRef = useRef<AssessmentStatus | null>(status);

  const opacity = useRef(new Animated.Value(1)).current;
  const rise = useRef(new Animated.Value(0)).current;

  const paint = useCallback(
    (next: AssessmentStatus | null) => {
      paintedRef.current = next;
      setPainted(next);
    },
    [],
  );

  useEffect(() => {
    if (status === paintedRef.current) return;

    // `null` means the reduced-motion setting has not been read yet. Swapping instantly is
    // the safe branch: the worst case is a user who wanted motion missing one transition,
    // against a user who asked for no motion getting one.
    if (reduced !== false) {
      paint(status);
      opacity.setValue(1);
      rise.setValue(0);
      return;
    }

    let cancelled = false;

    Animated.timing(opacity, {
      toValue: 0,
      duration: MOTION.duration.fast,
      easing: Easing.bezier(...MOTION.easeIn),
      useNativeDriver: true,
    }).start(({ finished }) => {
      if (cancelled || !finished) return;
      paint(status);
      rise.setValue(SWAP_RISE);
      Animated.parallel([
        Animated.timing(opacity, {
          toValue: 1,
          duration: MOTION.duration.normal,
          easing: Easing.bezier(...MOTION.easeOut),
          useNativeDriver: true,
        }),
        Animated.timing(rise, {
          toValue: 0,
          duration: MOTION.duration.normal,
          easing: Easing.bezier(...MOTION.easeOut),
          useNativeDriver: true,
        }),
      ]).start();
    });

    return () => {
      cancelled = true;
    };
  }, [status, reduced, opacity, rise, paint]);

  const reading = painted ? ASSESSMENT_READING[painted] : null;
  const palette = theme.tone(reading?.tone ?? 'neutral');
  const label = painted ? ASSESSMENT_LABELS[painted] : 'Not assessed yet';

  /**
   * What the assessment rests on, in machine figures.
   *
   * Mono because these are counted, not written, and the app's typographic rule reserves the
   * mono face for values that came off a document or out of a computation. `documents` is
   * reported next to `passages` because four quotes from one file is a materially weaker
   * basis than four from four, and a single "4 citations" would hide that.
   */
  const basisLine = describeBasis(painted, basis);

  const remainingGaps = missing.length > 1 ? missing.length - 1 : 0;
  const firstGap = missing[0];

  return (
    <Pressable
      onPress={onPress}
      // A full-width surface dims rather than scales. `Pressable`'s own guidance: scaling a
      // 400pt-wide plate is a visible jump, not a response to a finger.
      pressScale={0}
      dimOnPress
      accessibilityRole="button"
      accessibilityLabel={`${claim.statement}. ${label}.`}
      accessibilityHint="Opens the claim, its cited passages and its gaps."
      style={[
        styles.plate,
        {
          backgroundColor: theme.colors.surface,
          borderColor: theme.colors.border,
          borderRadius: theme.radius.md,
          padding: theme.spacing.xl,
        },
      ]}
    >
      {/*
        `Pressable` wraps its children in one animated view to carry the press transform, so
        a `gap` on the pressable itself would have a single child to space. The spacing lives
        on this inner column instead.
      */}
      <View style={{ gap: theme.spacing.lg }}>
        <Row gap="lg" align="flex-start">
          {/*
            The user's own sentence. Sans, and not emphasised — see the file header.

            Three lines, because `claimSchema` accepts two thousand characters and people use
            them: a claim written as a paragraph set the plate forty lines tall, pushed its own
            assessment off the bottom of the screen, and turned a list of claims into a list of
            essays with no way to see the second one. Three lines is where the codebase already
            clamps a body of user text (`finding-card`), and it holds enough of any sentence to
            recognise which claim this is, which is all this element has to do — the statement
            is rendered whole, unclamped, on the claim screen this plate opens.

            The clamp is safe only because `accessibilityLabel` above is written out rather than
            inferred from the children: a screen reader gets the entire statement and the status
            word, not the three lines that happened to fit.
          */}
          <Text variant="subheading" numberOfLines={3} style={styles.flex}>
            {claim.statement}
          </Text>
          <View style={styles.chevron}>
            <Disclosure />
          </View>
        </Row>

        <Animated.View
          style={[styles.verdict, { opacity, transform: [{ translateY: rise }] }]}
          // Android announces the new status when it swaps. iOS has no equivalent for a
          // passive change, so the value is also part of the pressable's label above.
          accessibilityLiveRegion="polite"
        >
          <View
            style={[
              styles.rule,
              {
                width: BORDER_WIDTH.thick,
                borderRadius: BORDER_WIDTH.thick,
                backgroundColor: reading ? palette.fg : theme.colors.border,
              },
            ]}
          />

          <View style={[styles.flex, { gap: theme.spacing.xs }]}>
            <Row gap="sm" align="center">
              <Icon
                name={reading?.icon ?? 'circle-outline'}
                size={17}
                color={reading ? palette.fg : theme.colors.textTertiary}
              />
              <Text
                variant="title"
                style={{ color: reading ? palette.fg : theme.colors.textTertiary }}
              >
                {label}
              </Text>
            </Row>

            <Text variant="monoSmall" colorToken="textTertiary">
              {basisLine}
            </Text>
          </View>
        </Animated.View>

        {/*
          The caveat sits outside the animated block. It is a property of the status, so it
          changes with it, but fading a sentence out and back in every time a report lands
          makes the plate flicker at the size of a paragraph rather than at the size of a word.
        */}
        <Text variant="caption" colorToken="textSecondary">
          {reading
            ? reading.caveat
            : 'This claim has not been checked against the sources in its current wording.'}
        </Text>

        {firstGap ? (
          <Row gap="sm" align="flex-start">
            <View style={styles.gapGlyph}>
              <Icon name="file-question-outline" size={14} color={theme.colors.tones.warn.fg} />
            </View>
            <Text variant="bodySmall" colorToken="textSecondary" style={styles.flex}>
              {firstGap}
              {remainingGaps > 0 ? (
                <Text variant="bodySmall" colorToken="textTertiary">
                  {` +${remainingGaps} more ${remainingGaps === 1 ? 'gap' : 'gaps'}`}
                </Text>
              ) : null}
            </Text>
          </Row>
        ) : null}
      </View>
    </Pressable>
  );
}

/**
 * The basis line, in words a count can be checked against.
 *
 * Three states, all of which have to be distinguishable: never assessed, assessed with
 * grounds, and assessed with grounds that no longer resolve. The third is the one worth the
 * code — an assessment whose citations have gone stale looks identical to a fresh one unless
 * the screen says so.
 *
 * Written as a phrase rather than as counts joined by middle dots. `6 passages · 2 documents ·
 * 1 stale` made the reader supply the relationship between three numbers; "from" states it, and
 * "from 2 documents" is the whole reason the document count is reported at all — four quotes
 * out of one file is a materially weaker basis than four out of four.
 */
function describeBasis(status: AssessmentStatus | null, basis: CitationBasis | null): string {
  if (!status || !basis) return 'no assessment on record';
  if (basis.passages === 0) {
    return basis.stale > 0
      ? `no passages check out; ${basis.stale} no longer resolve`
      : '0 cited passages';
  }
  const documents = `${basis.documents} ${basis.documents === 1 ? 'document' : 'documents'}`;
  const passages = `${basis.passages} ${basis.passages === 1 ? 'passage' : 'passages'}`;
  return basis.stale > 0
    ? `${passages} from ${documents}, ${basis.stale} stale`
    : `${passages} from ${documents}`;
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  plate: { borderWidth: BORDER_WIDTH.hairline },
  verdict: { flexDirection: 'row', gap: SPACING.lg },
  // `alignSelf: 'stretch'` makes the rule the height of the two lines beside it, so it
  // brackets the whole verdict rather than sitting next to the word like a bullet.
  rule: { alignSelf: 'stretch' },
  // Nudges the glyph onto the first line's baseline. `align="flex-start"` on the row aligns
  // box tops, and a 14pt icon against a 20pt line box sits high without this.
  gapGlyph: { paddingTop: SPACING.xxs },
  chevron: { paddingTop: SPACING.xxs },
});
