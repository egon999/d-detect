/**
 * Evidence rows.
 *
 * A piece of evidence is the one record in this app that is genuinely in motion — it
 * uploads, queues, gets read, gets analysed, and sometimes fails. So its row is built
 * around state rather than around content: the title tells you which document it is, but
 * the state tells you whether what the app says about it can be relied on yet.
 *
 * ## Why the state chip is never omitted
 *
 * A half-processed document that looks finished is the worst failure this product can have.
 * If extraction is still running, the fields on the detail screen are incomplete, and a
 * user comparing two invoices could reach a conclusion from a value that has not been read
 * yet. Every row carries its state, including the successful ones — consistency is what
 * makes the state legible at a glance rather than something to hunt for.
 *
 * ## One state, one appearance
 *
 * Both renderers below now state it through the same `Chip`. They did not: the row drew its
 * own icon-plus-caption pair and the card used the real primitive, so a document that read
 * "Needs review" as a calm grey line in one list read as a warn-toned pill in the other.
 * A state whose appearance depends on which screen you are looking at is not information,
 * and the inline copy also skipped `Chip`'s single `accessibilityLabel`, so a screen reader
 * announced the glyph and the label as two separate stops.
 *
 * ## The row rhythm
 *
 * `paddingVertical: SPACING.lg` with the gap on an inner `Row`. This is the rhythm the case
 * and claim rows were brought onto — they were padding by 10 and 11, one point apart, in
 * scroll views that show both.
 */

import React from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import type { Evidence } from '@domain/models';
import {
  BORDER_WIDTH,
  Chip,
  errorDetail,
  formatBytes,
  formatRelativeTime,
  Icon,
  isProcessingInFlight,
  LAYOUT,
  needsHumanAction,
  Notice,
  Pressable,
  PROCESSING_ICON,
  PROCESSING_STATE_LABELS,
  PROCESSING_TONE,
  readableError,
  Row,
  SPACING,
  Stack,
  Surface,
  Text,
  useTheme,
  type IconName,
  type Tone,
} from '@ui';

/** The glyph for a document's own type, distinct from its processing state. */
const KIND_ICON: Record<Evidence['kind'], IconName> = {
  PDF: 'file-pdf-box',
  IMAGE: 'image-outline',
  TEXT: 'text-box-outline',
  EMAIL: 'email-outline',
  NOTE: 'note-text-outline',
  SPREADSHEET: 'file-table-outline',
  AUDIO: 'waveform',
  VIDEO: 'video-outline',
  DOCUMENT: 'file-document-outline',
  OTHER: 'file-outline',
};

/**
 * The leading tile.
 *
 * `IconTile`'s geometry and fill, reproduced here for the one thing the primitive cannot do:
 * a document that is still uploading or being read shows a spinner where the glyph goes, and
 * `IconTile` takes an icon name. What this no longer reproduces is the hairline it used to
 * draw *on top of* the pastel fill. No `IconTile` in the app has one, so the leading tile on
 * the evidence list was the only outlined tile in the product — and inside `EvidenceCard` it
 * was a bordered box inside a bordered card, which is the shape `Surface`'s docblock names as
 * the largest single contributor to the app reading as cheap. The fill states the tone; the
 * outline was only ever repeating the edge.
 *
 * What `@ui` actually wants is a `busy` prop on `IconTile`; until it has one, this matches the
 * primitive in every respect except the spinner.
 */
function StateBadge({ icon, tone, busy }: { icon: IconName; tone: Tone; busy: boolean }) {
  const theme = useTheme();
  const palette = theme.tone(tone);

  return (
    <View style={[styles.badge, { backgroundColor: palette.bg, borderRadius: theme.radius.md }]}>
      {busy ? (
        <ActivityIndicator size="small" color={palette.fg} />
      ) : (
        // No `size`: `Icon` documents 18 as the dense-list default and states it "sits
        // correctly against 13–15px text", which is exactly this row.
        <Icon name={icon} color={palette.fg} />
      )}
    </View>
  );
}

export interface EvidenceRowProps {
  record: Evidence;
  onPress: () => void;
  /** Adds the file size. Off inside dense pickers. */
  detailed?: boolean;
}

export function EvidenceRow({ record, onPress, detailed = true }: EvidenceRowProps) {
  const theme = useTheme();
  const tone = PROCESSING_TONE[record.state];
  const inFlight = isProcessingInFlight(record.state);
  const needsAction = needsHumanAction(record.state);

  return (
    <Pressable
      onPress={onPress}
      dimOnPress
      pressScale={0}
      accessibilityRole="button"
      accessibilityLabel={`${record.title}. ${PROCESSING_STATE_LABELS[record.state]}.`}
      style={[styles.row, { minHeight: theme.layout.rowHeight }]}
    >
      {/* `Pressable` hands every child to one animated view that carries the press
          transform, so a `flexDirection` on the style above had a single child to lay out:
          the tile, the title and the chevron were stacking in a column. The row's own
          direction and gap belong on an inner container. */}
      <Row gap="lg" align="center">
        {/* Tinted only when the state is the user's to act on, or still moving. A list where
            every settled document also carries a coloured tile spends the tone scale on the
            rows that need nothing. */}
        <StateBadge
          icon={KIND_ICON[record.kind]}
          tone={needsAction || inFlight ? tone : 'neutral'}
          busy={inFlight}
        />

        <Stack gap="xs" style={styles.flex}>
          <Text variant="bodyMedium" numberOfLines={1}>
            {record.title}
          </Text>

          <Row gap="sm" align="center">
            <Chip
              label={PROCESSING_STATE_LABELS[record.state]}
              tone={tone}
              icon={PROCESSING_ICON[record.state]}
              size="sm"
            />

            {detailed && record.sizeBytes !== null ? (
              // Mono: a size is read off the file, not a phrase the app chose.
              <Text variant="monoSmall" colorToken="textTertiary">
                {formatBytes(record.sizeBytes)}
              </Text>
            ) : null}
          </Row>
        </Stack>

        <Icon name="chevron-right" color={theme.colors.textTertiary} />
      </Row>
    </Pressable>
  );
}

/**
 * The card variant, for the evidence grid on the case screen.
 *
 * Carries the failure reason inline. A failed document with no stated reason sends the user
 * to a support channel; a failed document that says "the PDF has no extractable text — it
 * may be a scan" tells them to re-upload it as an image and move on.
 */
export function EvidenceCard({ record, onPress }: { record: Evidence; onPress: () => void }) {
  const theme = useTheme();
  const tone = PROCESSING_TONE[record.state];
  const inFlight = isProcessingInFlight(record.state);

  return (
    <Pressable
      onPress={onPress}
      pressScale={0.99}
      haptic
      accessibilityRole="button"
      accessibilityLabel={`${record.title}. ${PROCESSING_STATE_LABELS[record.state]}.`}
      accessibilityHint="Opens the document and everything read from it."
      style={{ marginBottom: theme.spacing.lg }}
    >
      <Surface padding="lg" radius="lg">
        {/* One `Stack` rather than a `marginTop` per child. The card previously set its own
            spacing four times, at three different values, inside a padding it did not use. */}
        <Stack gap="lg">
          <Row gap="lg" align="flex-start">
            <StateBadge icon={KIND_ICON[record.kind]} tone={tone} busy={inFlight} />

            <Stack gap="xxs" style={styles.flex}>
              <Text variant="bodyMedium" numberOfLines={2}>
                {record.title}
              </Text>

              {record.fileName ? (
                // Mono, and correctly so: a file name is the document's own string.
                <Text variant="monoSmall" colorToken="textTertiary" numberOfLines={1}>
                  {record.fileName}
                </Text>
              ) : null}
            </Stack>
          </Row>

          <Row gap="sm" align="center" wrap>
            <Chip
              label={PROCESSING_STATE_LABELS[record.state]}
              tone={tone}
              icon={PROCESSING_ICON[record.state]}
              size="sm"
            />
            {/* Sans. `formatRelativeTime` writes "Yesterday" and "2 days ago" — the app's own
                words about its own record of the file, so the monospace face this carried was
                claiming a document provenance it never had. Mono is the product's signal that
                a string came off a document; spending it here blunts it where it is true. */}
            <Text variant="caption" colorToken="textTertiary">
              {formatRelativeTime(record.updatedAt, Date.now())}
            </Text>
          </Row>

          {record.state === 'FAILED' ? (
            /* `Notice`, not a hand-rolled tinted box. The copy of it here had no icon, no
               title and no disclosure, so a failure read as a bare coloured paragraph — and
               it printed `failureReason` raw, which `src/services/ai/case-analysis.ts:677`
               fills from `error.message`. `readableError` shows the pipeline's own sentence
               when it wrote one and this one otherwise; the raw string stays one tap away.
               A `FAILED` record with no reason stored now says something rather than nothing. */
            <Notice
              tone="danger"
              icon="alert-octagon-outline"
              title="This document could not be read"
              message={readableError(
                record.failureReason,
                'Open it to try reading it again, or add the original file to the case again.',
              )}
              detail={errorDetail(record.failureReason)}
              style={styles.borderless}
            />
          ) : null}
        </Stack>
      </Surface>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  // Only the padding belongs on the pressable itself; see the comment at the call site.
  row: { paddingVertical: SPACING.lg },
  // `LAYOUT.tileSize` rather than a literal 38, so this badge and every `IconTile` in the
  // app stay the same size when that token moves.
  badge: {
    width: LAYOUT.tileSize,
    height: LAYOUT.tileSize,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // The card's `Surface` already draws the edge in both schemes. `Notice` draws its own
  // hairline, which inside a bordered card is the second border on one box; the tone fill
  // says everything the outline was saying.
  borderless: { borderWidth: BORDER_WIDTH.none },
});
