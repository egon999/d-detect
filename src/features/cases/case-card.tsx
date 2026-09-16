/**
 * The case card.
 *
 * One row of the case list, and the first thing anyone sees in this app.
 *
 * ## What it can honestly show
 *
 * A `Case` record holds its own title, category, status and timestamps — it does not hold
 * counts of the evidence or findings inside it. That is deliberate: a denormalised count is
 * a number that can drift from the thing it counts, and in a product whose entire claim is
 * that its numbers are traceable, a stale badge reading "3 findings" over a case with five
 * would be worse than no badge at all. Counts appear on the case screen, computed from the
 * records themselves.
 *
 * So this card shows what the record knows, and makes the most of the one genuinely
 * actionable signal in it: whether the case has changed since it was last analysed.
 *
 * ## The staleness line
 *
 * `updatedAt > lastAnalyzedAt` means evidence has arrived, or a claim has been edited, since
 * the rule engine last ran. The conclusions on the case screen are therefore describing an
 * older version of the case. That is exactly the thing a user needs told before they act on
 * a finding, and it is the reason this card has a footer at all.
 *
 * ## Why the category is no longer in monospace
 *
 * `category` is free text the user typed (`src/domain/models.ts` — `z.string().max(80)`).
 * Monospace in this app means one thing, stated in `tokens.ts` and again in `Chip.tsx`: this
 * string came off a document. A category did not. Rendering it `monoOverline uppercase` also
 * put an arbitrary 80-character user string in the costume an enum member wears — the exact
 * appearance the product is careful never to show a reader.
 */

import { useRouter } from 'expo-router';
import React from 'react';
import { StyleSheet } from 'react-native';

import type { Case } from '@domain/models';
import {
  CASE_STATUS_LABELS,
  CASE_STATUS_TONE,
  Chip,
  Divider,
  formatRelativeTime,
  Icon,
  Pressable,
  Row,
  SPACING,
  Stack,
  Surface,
  Text,
  useTheme,
} from '@ui';

/**
 * Whether the case has changed since the analysis last ran.
 *
 * A small tolerance absorbs the ordinary case where the analysis run is itself the thing
 * that bumped `updatedAt` — without it, every freshly analysed case would immediately
 * report itself stale by a few milliseconds.
 */
const STALENESS_TOLERANCE_MS = 2_000;

export function isAnalysisStale(record: Case): boolean {
  if (record.lastAnalyzedAt === null) return false;
  return record.updatedAt > record.lastAnalyzedAt + STALENESS_TOLERANCE_MS;
}

export interface CaseCardProps {
  record: Case;
  /** Overrides navigation, for the picker sheets that select a case rather than open it. */
  onPress?: () => void;
}

/**
 * The footer's right-hand line: how the analysis stands relative to the case.
 *
 * Three states, each paired with a word so colour is never the sole carrier. "Analysed" on
 * its own said that the pipeline had run and left the reader to work out whether that was
 * still true of what they are looking at, which is the one thing this line exists to answer.
 */
function AnalysisLine({ record }: { record: Case }) {
  const theme = useTheme();

  /*
    The glyph is sized from a type rank rather than picked. `Icon`'s own default is 18 and its
    docblock places that against 13–15pt text, which is the dense-list case; here the glyph
    sits beside a `label` at 13.5, and the body rank is the nearest thing the scale has to the
    15 every sibling card uses. The point is that it moves when the scale moves.
  */
  const glyph = theme.type.body.fontSize;

  if (isAnalysisStale(record)) {
    return (
      <Row gap="xs" align="center">
        <Icon name="alert-circle-outline" size={glyph} color={theme.tone('warn').fg} />
        <Text variant="label" tone="warn">
          Analysis out of date
        </Text>
      </Row>
    );
  }

  if (record.lastAnalyzedAt === null) {
    return (
      <Text variant="label" colorToken="textTertiary">
        Not analysed yet
      </Text>
    );
  }

  return (
    <Row gap="xs" align="center">
      <Icon name="check" size={glyph} color={theme.colors.textTertiary} />
      <Text variant="label" colorToken="textTertiary">
        Analysis up to date
      </Text>
    </Row>
  );
}

export function CaseCard({ record, onPress }: CaseCardProps) {
  const theme = useTheme();
  const router = useRouter();
  const stale = isAnalysisStale(record);

  const open = () => {
    if (onPress) onPress();
    else router.push({ pathname: '/case/[caseId]', params: { caseId: record.id } });
  };

  return (
    <Pressable
      onPress={open}
      pressScale={0.99}
      haptic
      accessibilityRole="button"
      accessibilityLabel={`${record.title}. ${CASE_STATUS_LABELS[record.status]}.${
        stale ? ' Analysis out of date.' : ''
      }`}
      style={{ marginBottom: theme.spacing.lg }}
    >
      <Surface padding="xl" radius="lg">
        {/* One `Stack` for the whole card. This was four hand-applied `marginTop`s and a
            `Divider spacing="lg"` — five elements at four different vertical rhythms inside
            a single padding. `lg` between blocks, `sm` inside the one block that is a unit. */}
        <Stack gap="lg">
          {/* `justify`, not an empty `<View />` used as a layout shim. With no category the
              chip is simply the only thing on the line and belongs at its end. */}
          <Row gap="lg" align="center" justify={record.category ? 'space-between' : 'flex-end'}>
            {record.category ? (
              <Text
                variant="caption"
                colorToken="textTertiary"
                numberOfLines={1}
                style={styles.flex}
              >
                {record.category}
              </Text>
            ) : null}

            <Chip
              label={CASE_STATUS_LABELS[record.status]}
              tone={CASE_STATUS_TONE[record.status]}
              size="sm"
            />
          </Row>

          <Stack gap="sm">
            <Text variant="heading" numberOfLines={2}>
              {record.title}
            </Text>

            {record.description ? (
              <Text variant="bodySmall" colorToken="textSecondary" numberOfLines={2}>
                {record.description}
              </Text>
            ) : null}
          </Stack>

          {/* No `spacing` prop: the enclosing `Stack` already puts `lg` on both sides of it,
              and a divider that carries its own margins inside a gapped stack is spaced twice. */}
          <Divider />

          <Row between align="center" gap="md">
            {/* Sans. `formatRelativeTime` returns the app's own phrasing — "Yesterday",
                "2 days ago" — about its own record of the case. Monospace would claim it had
                been read off a document, which is the one thing it certainly was not. */}
            <Text variant="caption" colorToken="textTertiary">
              {formatRelativeTime(record.updatedAt, Date.now())}
            </Text>

            <AnalysisLine record={record} />
          </Row>
        </Stack>
      </Surface>
    </Pressable>
  );
}

/**
 * The compact variant, for lists inside a case (e.g. "related cases") and for pickers.
 *
 * Same information hierarchy, one line each, no footer — a picker needs to be scannable
 * rather than informative, and the staleness signal is not actionable while choosing.
 */
export function CaseRow({ record, onPress }: CaseCardProps) {
  const theme = useTheme();
  const router = useRouter();

  const open = () => {
    if (onPress) onPress();
    else router.push({ pathname: '/case/[caseId]', params: { caseId: record.id } });
  };

  return (
    <Pressable
      onPress={open}
      dimOnPress
      pressScale={0}
      accessibilityRole="button"
      accessibilityLabel={record.title}
      style={[styles.row, { minHeight: theme.layout.rowHeight }]}
    >
      {/* `Pressable` hands every child to one animated view that carries the press transform,
          so the `flexDirection: 'row'` and `gap: 12` this style used to hold were laying out a
          single child: the title block and the chevron stacked in a column and the gap spaced
          nothing. The row's own direction belongs on an inner container. */}
      <Row gap="lg" align="center">
        <Stack gap="xxs" style={styles.flex}>
          <Text variant="bodyMedium" numberOfLines={1}>
            {record.title}
          </Text>
          <Text variant="caption" colorToken="textTertiary" numberOfLines={1}>
            {record.category || CASE_STATUS_LABELS[record.status]}
          </Text>
        </Stack>

        {/* No `size`: 18 is `Icon`'s documented default for dense lists. */}
        <Icon name="chevron-right" color={theme.colors.textTertiary} />
      </Row>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  // `SPACING.lg`, matching `EvidenceRow` and `ClaimRow`. This was `paddingVertical: 10`,
  // which is not on the 4pt scale, and sat one point away from the claim row's 11 in scroll
  // views that show both — two list rows a point apart for no reason anyone could state.
  row: { paddingVertical: SPACING.lg },
});
