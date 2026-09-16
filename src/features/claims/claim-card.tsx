/**
 * The claim card.
 *
 * A claim is an assertion a user makes about their own case — "I paid the deposit on
 * 3 March" — and its state is *derived*, never typed in. Evidence is linked to it; the
 * links determine whether it stands.
 *
 * ## The reasoning trace
 *
 * `ClaimStateEvaluation.trace` is a list of plain sentences describing how the state was
 * reached, produced by the same function that produced the state. Tapping "Why this state"
 * expands it.
 *
 * This is the app's answer to the question a reader of any automated conclusion should ask:
 * *on what basis?* The trace is not a summary written afterwards — it is emitted by the
 * evaluation itself, so it cannot drift from the logic it describes.
 *
 * ## Unsupported is not "false"
 *
 * `UNSUPPORTED` means nothing has been linked yet. It carries the neutral tone and a
 * hollow-circle glyph rather than anything red, and the card says so in words. A user
 * seeing their honest claim marked in red because they have not uploaded the receipt yet
 * would conclude the app had judged them — which it has not, and must not appear to.
 *
 * ## What a press covers
 *
 * One target, and it covers exactly what it reads: the state, the statement, the counts and
 * the paragraph about them. The trace toggle below carries its own press and stays outside.
 * This card used to wrap only the statement and its detail, so the state label, both count
 * chips and the "not a judgement" paragraph were dead zones in a card that visibly dimmed
 * when its middle third was touched — a user tapped the chip and nothing happened.
 *
 * The old wrapper was also `disabled={!onPress}`, and `@ui`'s `Pressable` renders a disabled
 * child at 42% opacity. On a screen that passes no `onPress` — the claim's own — the
 * statement this card exists to show would have been drawn faded out.
 *
 * ## What the counts may say
 *
 * Nothing, while `evaluation` is undefined. The card previously asserted "0 supporting" in a
 * settled neutral chip during the window where the workspace had not finished loading, which
 * is the one thing `tokens.ts` forbids outright: never style an uncertain finding so it looks
 * certain. Absent data renders as absent, not as a zero.
 */

import React, { useState } from 'react';
import { LayoutAnimation, Platform, StyleSheet, UIManager } from 'react-native';

import type { ClaimStateEvaluation } from '@domain/analysis/claim-state';
import type { Claim } from '@domain/models';
import {
  CLAIM_STATE_ICON,
  CLAIM_STATE_LABELS,
  CLAIM_STATE_TONE,
  Chip,
  Divider,
  Icon,
  Pressable,
  Row,
  SPACING,
  Stack,
  Surface,
  Text,
  useTheme,
} from '@ui';

// Android needs this enabled explicitly for LayoutAnimation to do anything. Guarded
// because the New Architecture enables it by default and calling the setter there logs a
// warning.
if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

export interface ClaimCardProps {
  claim: Claim;
  /** The derived state and its reasoning. Absent while the workspace is still loading. */
  evaluation?: ClaimStateEvaluation;
  onPress?: () => void;
  /** Expands the trace on mount, for the claim's own screen. */
  defaultExpanded?: boolean;
}

export function ClaimCard({ claim, evaluation, onPress, defaultExpanded = false }: ClaimCardProps) {
  const theme = useTheme();
  const [showTrace, setShowTrace] = useState(defaultExpanded);

  // The cached `state` on the record is what the list renders before the evaluation
  // arrives; the live evaluation wins once it does.
  const state = evaluation?.state ?? claim.state;
  const tone = CLAIM_STATE_TONE[state];
  const palette = theme.tone(tone);

  const toggleTrace = () => {
    LayoutAnimation.configureNext(
      LayoutAnimation.create(
        theme.motion.duration.fast,
        LayoutAnimation.Types.easeInEaseOut,
        LayoutAnimation.Properties.opacity,
      ),
    );
    setShowTrace((value) => !value);
  };

  const supporting = evaluation?.independentSupport.length ?? 0;
  const contradicting = evaluation?.contradicting.length ?? 0;

  // Sized from a type rank rather than picked, so the glyph moves when the scale moves.
  const glyph = theme.type.body.fontSize;

  /* One `Stack` for the readable block, replacing four hand-applied `marginTop`s at three
     different values. `md` between the parts, `sm` inside the statement and its detail —
     which are one unit and should read as one. */
  const body = (
    <Stack gap="md">
      <Row gap="sm" align="center">
        <Icon name={CLAIM_STATE_ICON[state]} size={glyph} color={palette.fg} />
        {/* Sans, sentence case. `CLAIM_STATE_LABELS` is prose the app wrote, and monospace in
            this product means one thing: the string came off a document. Uppercased, tracked
            and set in mono, an app-assigned label wore the exact costume of the enum member
            this card is careful never to show — and the same value was already rendered in
            sans `caption` by `ClaimRow` below, so one label had two treatments in one file. */}
        <Text variant="label" tone={tone} numberOfLines={2} style={styles.flex}>
          {CLAIM_STATE_LABELS[state]}
        </Text>
      </Row>

      <Stack gap="sm">
        {/* The claim is the user's own sentence, so it is set in sans — never mono. The
            typographic split is the app's promise about where a value came from. */}
        <Text variant="subheading">{claim.statement}</Text>

        {claim.detail ? (
          <Text
            variant="bodySmall"
            colorToken="textSecondary"
            numberOfLines={showTrace ? undefined : 2}
          >
            {claim.detail}
          </Text>
        ) : null}
      </Stack>

      {/* Only once there is an evaluation to count, and only for counts above zero: a
          "0 supporting" pill says the app looked and found nothing, which is a different
          claim from the app not having looked yet. The paragraph below carries that case. */}
      {evaluation && (supporting > 0 || contradicting > 0) ? (
        <Row gap="sm" align="center" wrap>
          {supporting > 0 ? (
            <Chip
              label={supporting === 1 ? '1 supporting document' : `${supporting} supporting documents`}
              tone="ok"
              icon="link-variant"
              size="sm"
            />
          ) : null}

          {contradicting > 0 ? (
            /* "Disagrees", not "contradicts". The app reports that two documents do not
               agree and leaves the judgement to the reader — the same wording rule that
               makes `ENTITY_KIND_LABELS.conflict` read "Disagreement". */
            <Chip
              label={contradicting === 1 ? '1 document disagrees' : `${contradicting} documents disagree`}
              tone="danger"
              icon="arrow-top-right"
              size="sm"
            />
          ) : null}
        </Row>
      ) : null}

      {state === 'UNSUPPORTED' ? (
        <Text variant="caption" colorToken="textTertiary">
          Nothing is linked to this claim yet. That is not a judgement about whether it is
          true — link a document to show what backs it.
        </Text>
      ) : null}
    </Stack>
  );

  return (
    <Surface padding="xl" radius="lg" style={{ marginBottom: theme.spacing.lg }}>
      <Stack gap="lg">
        {onPress ? (
          <Pressable
            onPress={onPress}
            pressScale={0}
            dimOnPress
            accessibilityRole="button"
            accessibilityLabel={`${claim.statement}. ${CLAIM_STATE_LABELS[state]}.`}
            accessibilityHint="Opens the claim and what is linked to it."
          >
            {body}
          </Pressable>
        ) : (
          body
        )}

        {evaluation ? (
          <>
            {/* No `spacing`: the enclosing `Stack` already puts `lg` on both sides. */}
            <Divider />

            <Pressable
              onPress={toggleTrace}
              pressScale={0}
              accessibilityRole="button"
              accessibilityState={{ expanded: showTrace }}
              accessibilityLabel="Why this state"
            >
              <Row between align="center">
                <Text variant="label" tone="accent">
                  Why this state
                </Text>
                <Icon
                  name={showTrace ? 'chevron-up' : 'chevron-down'}
                  size={glyph}
                  color={theme.colors.textAccent}
                />
              </Row>
            </Pressable>

            {showTrace ? (
              <Stack gap="md">
                {evaluation.trace.map((line, index) => (
                  <Row key={`${index}-${line.slice(0, 12)}`} gap="md" align="flex-start">
                    {/* Numbered because the trace is genuinely a sequence — each step
                        narrows what the state can be. */}
                    <Text variant="monoSmall" colorToken="textTertiary" style={styles.step}>
                      {String(index + 1).padStart(2, '0')}
                    </Text>
                    <Text variant="bodySmall" colorToken="textSecondary" style={styles.flex}>
                      {line}
                    </Text>
                  </Row>
                ))}
              </Stack>
            ) : null}
          </>
        ) : null}
      </Stack>
    </Surface>
  );
}

/** The one-line variant, for pickers and for the claim list on the case screen. */
export function ClaimRow({
  claim,
  evaluation,
  onPress,
}: {
  claim: Claim;
  evaluation?: ClaimStateEvaluation;
  onPress: () => void;
}) {
  const theme = useTheme();
  const state = evaluation?.state ?? claim.state;
  const tone = CLAIM_STATE_TONE[state];
  const palette = theme.tone(tone);

  return (
    <Pressable
      onPress={onPress}
      dimOnPress
      pressScale={0}
      accessibilityRole="button"
      accessibilityLabel={`${claim.statement}. ${CLAIM_STATE_LABELS[state]}.`}
      style={[styles.row, { minHeight: theme.layout.rowHeight }]}
    >
      {/* `Pressable` hands every child to one animated view that carries the press transform,
          so the `flexDirection: 'row'` and `gap: 12` this style used to hold were laying out a
          single child: the glyph, the statement and the chevron stacked in a column and the
          gap spaced nothing. The row's own direction belongs on an inner container. */}
      <Row gap="lg" align="center">
        {/* No `size`: 18 is `Icon`'s documented default for dense lists. */}
        <Icon name={CLAIM_STATE_ICON[state]} color={palette.fg} />

        <Stack gap="xxs" style={styles.flex}>
          <Text variant="bodySmall" numberOfLines={2}>
            {claim.statement}
          </Text>
          <Text variant="caption" tone={tone}>
            {CLAIM_STATE_LABELS[state]}
          </Text>
        </Stack>

        <Icon name="chevron-right" color={theme.colors.textTertiary} />
      </Row>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  // `minWidth`, not `width`. At the OS large-text settings two mono digits exceed a fixed 18
  // and clip, which breaks the numbering of the one element this file calls the app's answer
  // to "on what basis?". This column grows instead.
  step: { minWidth: SPACING.xl },
  // `SPACING.lg`, matching `EvidenceRow` and `CaseRow`. This was `paddingVertical: 11` — not
  // on the 4pt scale, not even on a 2pt grid, and one point off the case row's 10 in scroll
  // views that show both.
  row: { paddingVertical: SPACING.lg },
});
