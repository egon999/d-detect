/**
 * ProvenanceValue — the component the whole design language is built around.
 *
 * The product's promise is that a user can always tell *what a document said* from *what
 * the system concluded*. That promise is easy to state and easy to lose: it only takes one
 * screen rendering an extracted amount in the same style as a typed one.
 *
 * So every extracted value in the app renders through this component, and it encodes
 * provenance in three independent channels at once:
 *
 *   1. **Typeface.** Machine values are monospace, human values are sans. Readable at a
 *      glance and impossible to miss, even in a screenshot.
 *   2. **A leading rule.** A 2pt bar tinted by method: accent for a confirmed human
 *      value, neutral for a deterministic read, amber for a value recognised from an
 *      image, violet for an AI suggestion.
 *   3. **A tappable source line.** The "where did this come from?" affordance, which
 *      opens the exact snippet the value was read from.
 *
 * Three channels rather than one because each fails in a different context. The typeface
 * survives greyscale; the colour survives a font fallback; the source line is the only one
 * that survives a user who does not trust either and wants to see the document.
 */

import React, { useState } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import type { Provenance } from '@domain/models';
import type { ExtractionMethod } from '@domain/enums';
import { EXTRACTION_METHOD_ICON, EXTRACTION_METHOD_LABELS, EXTRACTION_METHOD_TONE } from '../semantics';
import { Icon } from '../icon';
import { BORDER_WIDTH, SPACING, type Tone } from '../tokens';
import { useTheme } from '../theme';
import { describeProvenance } from '../format';
import { IconButton } from './Button';
import { Excerpt } from './Excerpt';
import { Pressable, Row } from './Layout';
import { Text } from './Text';

/** The 2pt rule width. Thick enough to carry colour, thin enough not to read as a border. */
const RULE_WIDTH = 2;

export interface ProvenanceValueProps {
  /** The value as it should be read, already formatted for display. */
  value: string;
  /**
   * The provenance record. When absent the value is treated as human-authored, which is
   * the correct default: anything a person typed into the app is theirs.
   */
  provenance?: Provenance | null;
  /** A short field name shown above the value, e.g. "Invoice number". */
  label?: string;
  /** Renders larger — for the primary values on a detail screen. */
  emphasis?: boolean;
  /**
   * Show the "as written in the document" original beneath the normalized value. On for
   * dates and amounts, where normalization changes what the reader sees.
   */
  originalValue?: string | null;
  /** A warning attached to this value, e.g. an ambiguous date. Rendered in amber. */
  caveat?: string | null;
  /** Called when the user taps the source line. Omit to hide the affordance. */
  onPressSource?: () => void;
  /** Overrides the monospace default — for a value that is prose rather than a datum. */
  forceSans?: boolean;
  style?: StyleProp<ViewStyle>;
}

export function ProvenanceValue({
  value,
  provenance,
  label,
  emphasis = false,
  originalValue,
  caveat,
  onPressSource,
  forceSans = false,
  style,
}: ProvenanceValueProps) {
  const theme = useTheme();
  const method: ExtractionMethod = provenance?.method ?? 'MANUAL';
  const tone: Tone = EXTRACTION_METHOD_TONE[method];
  const palette = theme.tone(tone);

  // A value a person typed or confirmed is prose-like and reads better in sans; a value
  // read out of a document is a datum and reads better in mono. This is the typeface
  // channel described in the file header.
  const useMono = !forceSans && method !== 'MANUAL';

  return (
    <View style={[styles.container, style]}>
      <View style={[styles.rule, { backgroundColor: palette.fg, width: RULE_WIDTH }]} />

      <View style={styles.body}>
        {/*
          Sentence case at caption rank, not the tracked-out uppercase eyebrow this was.

          This one line was the app's single most repeated piece of template chrome: every
          extracted value on every screen carried an ALL-CAPS tracked label over it, so a screen
          listing eight fields off an invoice shouted eight times before the reader got to a
          figure. A field name is a quiet locator for the value under it, which is what a
          caption is for.
        */}
        {label ? (
          <Text variant="caption" colorToken="textTertiary">
            {label}
          </Text>
        ) : null}

        <Row gap="md" align="flex-start">
          {/*
            `monoValue` is the floor, not the ceiling.

            This read `emphasis ? 'monoValue' : 'mono'`, which put every extracted value that did
            not opt in at `mono` — 13.5pt, the rank paired with `label`. The value is the thing
            the reader came to this screen for: an amount off a bank statement, a date on an
            invoice. Setting it a point and a half below the prose explaining it inverts the
            hierarchy, and it is the largest single contributor to the finding that most typed
            elements in this app sit near the bottom of the scale. So the default is the
            body-paired rank and `emphasis` steps *up* to a figure, rather than the default
            sitting small and `emphasis` merely reaching normal.
          */}
          <Text
            variant={emphasis ? 'statValue' : 'monoValue'}
            mono={useMono}
            style={styles.value}
            selectable
          >
            {value}
          </Text>
        </Row>

        {originalValue && originalValue !== value ? (
          <Text variant="monoSmall" colorToken="textTertiary" selectable>
            {`as written: ${originalValue}`}
          </Text>
        ) : null}

        {caveat ? (
          <Row gap="xs" align="flex-start" style={{ marginTop: SPACING.xxs }}>
            <Icon name="alert-circle-outline" size={13} color={theme.tone('warn').fg} />
            <Text variant="caption" tone="warn" style={styles.caveat}>
              {caveat}
            </Text>
          </Row>
        ) : null}

        <SourceLine
          provenance={provenance}
          method={method}
          mark={originalValue ?? value}
          onPress={onPressSource}
        />
      </View>
    </View>
  );
}

/**
 * The source line.
 *
 * Always present, even for a manually entered value, because "you typed this" is a
 * provenance fact too — and one worth stating, since it tells the reader the value is not
 * something the system found.
 *
 * Tapping it expands the quoted snippet inline rather than navigating away. The question a
 * user has here is "where did this number come from?", and answering it in place keeps
 * them on the screen they were reading.
 */
function SourceLine({
  provenance,
  method,
  mark,
  onPress,
}: {
  provenance?: Provenance | null;
  method: ExtractionMethod;
  /** The value to highlight inside the quote — the document's own wording where there is one. */
  mark?: string | null;
  onPress?: () => void;
}) {
  const theme = useTheme();
  const [expanded, setExpanded] = useState(false);
  const palette = theme.tone(EXTRACTION_METHOD_TONE[method]);

  const label = EXTRACTION_METHOD_LABELS[method];
  const hasQuote = Boolean(provenance?.sourceQuote);
  const expandable = hasQuote && !onPress;

  const content = (
    <>
      <Icon name={EXTRACTION_METHOD_ICON[method]} size={12} color={palette.fg} />
      {/*
        The method, and nothing else.

        This appended ` · ${provenance.model}` — so a reader looking at an amount on their own
        bank statement was shown the name and version of the model that read it. A model name is
        a fact about our plumbing: it does not help anyone judge the value, it dates the screen
        the moment the model changes, and `EXTRACTION_METHOD_LABELS` already says the thing that
        matters ("Read by AI, unconfirmed"). The field is still stored, because provenance is
        worth keeping; it is simply not the reader's business.
      */}
      <Text variant="caption" style={{ color: palette.fg, flexShrink: 1 }} numberOfLines={1}>
        {label}
      </Text>
      {expandable ? (
        <Icon
          name={expanded ? 'chevron-up' : 'chevron-down'}
          size={12}
          color={theme.colors.textTertiary}
        />
      ) : null}
    </>
  );

  return (
    <View style={{ marginTop: SPACING.xs }}>
      <Pressable
        onPress={onPress ?? (() => setExpanded((value) => !value))}
        pressScale={1}
        haptic={false}
        accessibilityRole="button"
        accessibilityState={expandable ? { expanded } : undefined}
        accessibilityLabel={
          expandable
            ? `${label}. Tap to see the source text.`
            : onPress
              ? `${label}. Tap to open the evidence.`
              : label
        }
        style={styles.sourceLine}
      >
        {content}
      </Pressable>

      {/*
        The answer to "where did this number come from?", and until now the weakest thing on
        the screen: the document's own line, truncated at 220 characters, set at 12pt in
        secondary grey behind a coloured rule — indistinguishable from a caption the app wrote,
        with nothing indicating which characters in it were the value.

        It is a sheet of the reader's document now, with the value marked. `Excerpt` takes no
        `method` here because the line the reader just tapped already states it, and stamping
        it again inside the sheet would be the app saying the same thing twice on the smallest
        surface it says anything on.
      */}
      {expanded && provenance?.sourceQuote ? (
        <Excerpt
          quote={provenance.sourceQuote}
          value={mark}
          tone={EXTRACTION_METHOD_TONE[method]}
          style={{ marginTop: theme.spacing.sm }}
        />
      ) : null}
    </View>
  );
}

/**
 * The same provenance encoding, collapsed into a single row for dense lists.
 *
 * Provided so a list can honour the typeface rule without paying for the full component's
 * vertical space — the alternative is that lists quietly stop distinguishing machine
 * values, which is exactly the failure this design exists to prevent.
 */
export function ProvenanceRow({
  label,
  value,
  method = 'DETERMINISTIC',
  onPress,
  style,
}: {
  label: string;
  value: string;
  method?: ExtractionMethod;
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
}) {
  const theme = useTheme();
  const palette = theme.tone(EXTRACTION_METHOD_TONE[method]);

  const row = (
    <Row gap="lg" align="center" between style={style}>
      <Text variant="bodySmall" colorToken="textSecondary" numberOfLines={1} style={styles.rowLabel}>
        {label}
      </Text>
      <Row gap="sm" align="center" style={styles.rowValue}>
        {/* Flag the two unconfirmed, machine-guessed tiers (AI, OCR) even in a dense row:
            the mono typeface separates machine from human, but not a text-layer read from a
            pixel read, and an OCR value is the one a reader most needs nudged to check. */}
        {method === 'AI' || method === 'OCR' ? (
          <Icon name={EXTRACTION_METHOD_ICON[method]} size={12} color={palette.fg} />
        ) : null}
        <Text variant="monoSmall" mono={method !== 'MANUAL'} numberOfLines={1} style={{ flexShrink: 1 }}>
          {value}
        </Text>
        {onPress ? (
          <Icon name="chevron-right" size={14} color={theme.colors.textTertiary} />
        ) : null}
      </Row>
    </Row>
  );

  if (!onPress) return <View style={styles.rowPadding}>{row}</View>;

  return (
    <Pressable onPress={onPress} pressScale={1} accessibilityRole="button" accessibilityLabel={`${label}: ${value}`}>
      <View style={styles.rowPadding}>{row}</View>
    </Pressable>
  );
}

/**
 * A section header for a group of extracted fields, with the group's dominant provenance
 * shown once rather than repeated on every row.
 */
export function ExtractionSectionHeader({
  title,
  method,
  count,
  action,
}: {
  title: string;
  method?: ExtractionMethod;
  count?: number;
  action?: React.ReactNode;
}) {
  const theme = useTheme();
  return (
    <Row between align="center" style={{ marginBottom: theme.spacing.md }}>
      <Row gap="sm" align="center">
        {/*
          Sentence case at `label` rank, not the uppercase tracked overline this was. A group
          header is a header — the rank exists for exactly this — and shouting it was the same
          template chrome the field labels above carried, repeated once per section.
        */}
        <Text variant="label" colorToken="textSecondary">
          {title}
        </Text>
        {typeof count === 'number' ? (
          <Text variant="monoSmall" colorToken="textTertiary">
            {String(count)}
          </Text>
        ) : null}
        {method ? (
          <Icon
            name={EXTRACTION_METHOD_ICON[method]}
            size={11}
            color={theme.tone(EXTRACTION_METHOD_TONE[method]).fg}
          />
        ) : null}
      </Row>
      {action}
    </Row>
  );
}

export { IconButton };

const styles = StyleSheet.create({
  container: { flexDirection: 'row', gap: SPACING.lg },
  rule: { borderRadius: RULE_WIDTH / 2, alignSelf: 'stretch', minHeight: 20 },
  body: { flex: 1, gap: SPACING.xxs },
  value: { flexShrink: 1 },
  caveat: { flex: 1 },
  sourceLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
    minHeight: 24,
    alignSelf: 'flex-start',
    maxWidth: '100%',
  },
  rowLabel: { flexShrink: 1 },
  rowValue: { flexShrink: 1, justifyContent: 'flex-end' },
  rowPadding: { paddingVertical: SPACING.sm },
});
