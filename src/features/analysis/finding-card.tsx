/**
 * The finding card.
 *
 * An `AnalysisResult` rendered so a reader can check the reasoning rather than take it on
 * trust. This is the component the product's central claim rests on.
 *
 * ## The rule this component follows
 *
 * A finding is never stated without the means to verify it. Every card carries:
 *
 *   - **What was compared.** `inputs` holds the exact values the rule looked at — two
 *     amounts, two dates, two document numbers. Each is shown at reading size under the name
 *     of the document it came off, because a reader checking "these two amounts differ" needs
 *     to see both amounts, not a sentence asserting that they differ. Its keys are
 *     reader-facing prose written by the rule (a document's name, "Shared reference"), never a
 *     field path.
 *
 *     Its *values* are not that safe, and this is where the card used to fail: a rule may
 *     put a stored constant in the table — `MATERIAL_AMOUNT_CONTRADICTION`, `OCR` — and a
 *     person disputing a bank charge was reading it verbatim, in mono, on the one artefact
 *     that is supposed to explain the problem to them. Every value now goes through
 *     `readableToken`, and only the ones it leaves untouched are set in mono; see
 *     `ComparedValue`.
 *   - **How strong the match is.** `confidence` is a deterministic grade, and it is stated
 *     rather than folded into the wording.
 *
 * `triggeredRuleIds` is deliberately *not* shown. It identifies the rule that fired
 * (`payment-status-conflict@1`), which is build identity and not something a reader can
 * act on; it stays on the record for support and export, where it is useful.
 *
 * ## What the wording may not say
 *
 * A finding describes a relationship between documents. It does not describe the world.
 * "These two documents record different amounts" is a fact about the documents; "the
 * invoice is fraudulent" is a legal conclusion this product does not draw and must never
 * appear to. The explanation text comes from the rule definitions, which are written to
 * that constraint; this component reinforces it by labelling the section "What was
 * compared" rather than "Proof".
 */

import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import type { AnalysisResult, UnconfirmedRead } from '@domain/models';
import {
  ANALYSIS_ICON,
  ANALYSIS_LABELS,
  BORDER_WIDTH,
  Button,
  Chip,
  CONFIDENCE_LABELS,
  CONFIDENCE_TONE,
  Divider,
  FINDING_STATUS_LABELS,
  FINDING_STATUS_TONE,
  Icon,
  Pressable,
  PROVISIONAL_FINDING,
  RADIUS,
  readableToken,
  Row,
  SEVERITY_TONE,
  SPACING,
  Surface,
  Text,
  TextField,
  useTheme,
} from '@ui';

import { confirmDestructive } from '@features/settings/confirm';

export interface FindingCardProps {
  finding: AnalysisResult;
  /** Opens the full finding screen, where the linked records can be visited. */
  onPress?: () => void;
  /** Starts collapsed in lists, expanded on the finding's own screen. */
  defaultExpanded?: boolean;
  /** Hides the status chip where the surrounding list is already filtered by status. */
  hideStatus?: boolean;
  /**
   * Confirms one unconfirmed image-read a *provisional* finding rests on. Supplying this is
   * what turns the card into the one-tap prompt the design calls for: the caller records the
   * reading as human-vouched and re-runs analysis, which stands the finding up or clears it.
   * Omitted on read-only surfaces, where the prompt still explains itself but offers no
   * action.
   */
  onConfirmReading?: (read: UnconfirmedRead) => void | Promise<void>;
  /** Opens the cited document so the reader can check a reading against the source. */
  onInspectEvidence?: (evidenceId: string) => void;
  /**
   * Records the reader's judgement on an open finding — that it has been read and
   * checked, or that it is being set aside. The caller commits it through the
   * `reviewFinding` mutation, which layers the judgement on top of the finding rather
   * than editing it, so the machine's output stays intact. Omitted on read-only
   * surfaces, where the review row does not appear.
   */
  onReview?: (
    finding: AnalysisResult,
    status: 'REVIEWED' | 'DISMISSED',
    note: string,
  ) => void | Promise<void>;
}

export function FindingCard({
  finding,
  onPress,
  defaultExpanded = false,
  hideStatus = false,
  onConfirmReading,
  onInspectEvidence,
  onReview,
}: FindingCardProps) {
  const theme = useTheme();
  const [expanded, setExpanded] = useState(defaultExpanded);

  const tone = SEVERITY_TONE[finding.severity];
  const palette = theme.tone(tone);
  const inputs = Object.entries(finding.inputs);
  const dismissed = finding.status === 'DISMISSED';

  return (
    <Surface
      padding="xl"
      radius="lg"
      style={[
        { marginBottom: theme.spacing.lg },
        // A dismissed finding stays legible but stops competing for attention. It is not
        // hidden: a reviewer must be able to see what was set aside and why.
        dismissed && styles.dismissed,
      ]}
    >
      {/* The severity rule. Same device as ProvenanceValue's method rule, so a coloured
          left edge means "this has a classification" consistently across the app. */}
      <View style={[styles.severityRule, { backgroundColor: palette.fg }]} />

      {/* One press target, and it covers exactly what it reads: the classification, the
          headline and the explanation. Everything below carries its own controls, so it
          stays outside — a card that dimmed under a finger resting on its buttons would
          be promising a tap it does not handle. */}
      <Pressable
        onPress={onPress ?? (() => setExpanded((value) => !value))}
        pressScale={0}
        dimOnPress
        accessibilityRole="button"
        accessibilityLabel={`${ANALYSIS_LABELS[finding.resultType]}. ${finding.title}`}
        accessibilityState={onPress ? undefined : { expanded }}
      >
        <Row between align="flex-start" gap="lg">
          <Row gap="sm" align="center" style={styles.flex}>
            <Icon name={ANALYSIS_ICON[finding.resultType]} size={15} color={palette.fg} />
            {/* Sans, sentence case. `ANALYSIS_LABELS` is prose the app wrote — uppercased
                and set in mono it recreated the look of the enum member this card is
                careful never to show, and clipped it at one line doing so. */}
            <Text variant="label" tone={tone} numberOfLines={2} style={styles.flex}>
              {ANALYSIS_LABELS[finding.resultType]}
            </Text>
          </Row>

          <Row gap="xs" align="center">
            {/* Visible while the card is collapsed, so a hedged finding never reads as a
                settled one in a scrolled list. */}
            {finding.provisional ? (
              <Chip
                label={PROVISIONAL_FINDING.label}
                tone={PROVISIONAL_FINDING.tone}
                icon={PROVISIONAL_FINDING.icon}
                size="sm"
              />
            ) : null}

            {!hideStatus && finding.status !== 'OPEN' ? (
              <Chip
                label={FINDING_STATUS_LABELS[finding.status]}
                tone={FINDING_STATUS_TONE[finding.status]}
                size="sm"
              />
            ) : null}
          </Row>
        </Row>

        <Text variant="subheading" style={{ marginTop: theme.spacing.md }}>
          {finding.title}
        </Text>

        {/*
          Not clipped, and that is the change this card was waiting for.

          This used to be `numberOfLines={expanded ? undefined : 3}` over an explanation that
          ran 200–730 characters, because the rules wrote the observation, the hedge and the
          suggested next step into one paragraph. Three lines is about 150 characters, so on
          the most-read screen in the product the app's reasoning reached the reader cut off
          mid-sentence — and the part it cut was reliably the hedge, the one part that tells
          someone not to trust the finding.

          `explanation` is now the observation alone and is held to a budget by
          `tests/rule-copy.test.ts`. That is what makes showing it in full safe. The hedge
          moved to `caveat` below, where it gets a control of its own. See
          `docs/copy-doctrine.md`.
        */}
        <Text variant="bodySmall" colorToken="textSecondary" style={{ marginTop: theme.spacing.sm }}>
          {finding.explanation}
        </Text>
      </Pressable>

      {/*
        Only where the prompt is not already carrying it. A provisional finding renders
        `ProvisionalPrompt` immediately below, which states the same doubt in its own words
        beside the one tap that resolves it — showing both would put the warning on the card
        twice, which is exactly what the old concatenated explanation did.
      */}
      {finding.caveat && !finding.provisional ? <Caveat text={finding.caveat} /> : null}

      {finding.provisional ? (
        <ProvisionalPrompt
          finding={finding}
          onConfirmReading={onConfirmReading}
          onInspectEvidence={onInspectEvidence}
        />
      ) : null}

      {inputs.length > 0 ? (
        <>
          <Divider spacing="lg" />

          {/*
            Sentence case at caption rank, not the tracked-out uppercase eyebrow this was.

            The words stay because they are a guard rather than a heading: "What was compared"
            is what stops this block from reading as proof, and the constraint in this file's
            docblock depends on it. What goes is the shouting — an ALL-CAPS tracked label above
            every section is chrome that competes with the content it introduces, and there are
            four of them on this one card.
          */}
          <Text variant="caption" colorToken="textTertiary">
            What was compared
          </Text>

          <View style={{ marginTop: theme.spacing.md, gap: theme.spacing.lg }}>
            {(expanded ? inputs : inputs.slice(0, 2)).map(([key, value]) => (
              <ComparedValue key={key} label={key} value={value} />
            ))}
          </View>

          {!expanded && inputs.length > 2 ? (
            // At the foot of the list rather than beside the heading. "Show all 4" belongs
            // where what is shown runs out, and moving it there let the values above start at
            // the card's own left margin instead of sharing a line with a control.
            //
            // It was a bare `Text onPress` at caption size — a 17pt target against the app's
            // documented 44pt floor, with none of `Pressable`'s feedback.
            <Pressable
              onPress={() => setExpanded(true)}
              pressScale={1}
              accessibilityRole="button"
              accessibilityState={{ expanded: false }}
              accessibilityLabel={`Show all ${inputs.length} compared values`}
              style={styles.showAll}
            >
              <Row gap="xs" align="center">
                <Text variant="caption" tone="accent">
                  Show all {inputs.length}
                </Text>
                <Icon name="chevron-down" size={14} color={theme.tone('accent').fg} />
              </Row>
            </Pressable>
          ) : null}
        </>
      ) : null}

      {/* Named rather than left as a floating pill: "Exact" or "Needs review" on its own
          does not say what was graded. A `Divider` and a full-width rule for one 26pt chip
          is the section-header-over-one-item figure, so both are gone. */}
      <Row gap="sm" align="center" wrap style={{ marginTop: theme.spacing.lg }}>
        <Text variant="caption" colorToken="textTertiary">
          Strength of match
        </Text>
        <Chip
          label={CONFIDENCE_LABELS[finding.confidence]}
          tone={CONFIDENCE_TONE[finding.confidence]}
          size="sm"
        />
      </Row>

      {finding.reviewNote ? (
        <View style={{ marginTop: theme.spacing.lg }}>
          <Text variant="caption" colorToken="textTertiary">
            Review note
          </Text>
          <Text variant="bodySmall" style={{ marginTop: theme.spacing.xs }}>
            {finding.reviewNote}
          </Text>
        </View>
      ) : null}

      {finding.status === 'OPEN' && onReview ? (
        <ReviewRow finding={finding} onReview={onReview} />
      ) : null}
    </Surface>
  );
}

/**
 * The caveat, behind a control.
 *
 * ## Why this is a disclosure and not just more body text
 *
 * Every hedge in this product used to be sentences three and four of the finding's
 * explanation, in the same grey at the same size as the observation, inside a block the card
 * clipped at three lines. So the doubt was both the least visible thing on the card and the
 * first thing truncation removed. A reader skimming eight findings saw eight confident-looking
 * statements and none of the reasons not to believe them.
 *
 * Collapsing it looks like demoting it and is the opposite. A named control a reader can find
 * and open — with a count of nothing, no badge, no colour competing with the severity rule — is
 * more reachable than a sentence that was never on screen. The label asks the question the
 * reader has, so opening it is a decision rather than a guess.
 *
 * It is not tone-coloured. A hedge tinted amber would read as a second severity, and the card
 * already has one signal for "how much should this worry you"; a second one saying something
 * different is how a card stops being scannable.
 */
function Caveat({ text }: { text: string }) {
  const theme = useTheme();
  const [open, setOpen] = useState(false);

  return (
    <View style={{ marginTop: theme.spacing.md }}>
      <Pressable
        onPress={() => setOpen((value) => !value)}
        pressScale={1}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityHint="Explains what this finding assumes and why the reading could be wrong."
        style={styles.showAll}
      >
        <Row gap="xs" align="center">
          <Icon name="help-circle-outline" size={14} color={theme.colors.textTertiary} />
          <Text variant="caption" colorToken="textTertiary">
            Why this might be wrong
          </Text>
          <Icon
            name={open ? 'chevron-up' : 'chevron-down'}
            size={14}
            color={theme.colors.textTertiary}
          />
        </Row>
      </Pressable>

      {open ? (
        <Text variant="bodySmall" colorToken="textSecondary" style={{ marginTop: theme.spacing.xs }}>
          {text}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * The review row: an open finding in the reader's hands.
 *
 * The rule engine can only report; whether a finding has been read and dealt with is a
 * fact about a person, and this is where that fact is recorded. "Mark reviewed" leaves
 * the finding and its reasoning exactly as they are and adds the judgement on top.
 * "Dismiss" sets the finding aside — confirmed first, because nothing in the app reopens
 * a dismissed finding, and quietly setting evidence aside should not be a free tap. The
 * note, if any, is kept with the finding so the next reader can see why.
 */
function ReviewRow({
  finding,
  onReview,
}: {
  finding: AnalysisResult;
  onReview: (
    finding: AnalysisResult,
    status: 'REVIEWED' | 'DISMISSED',
    note: string,
  ) => void | Promise<void>;
}) {
  const theme = useTheme();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<'REVIEWED' | 'DISMISSED' | null>(null);

  const run = async (status: 'REVIEWED' | 'DISMISSED') => {
    setBusy(status);
    try {
      await onReview(finding, status, note);
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <Divider spacing="lg" />

      <TextField
        label="Review note"
        labelHint="optional"
        value={note}
        onChangeText={setNote}
        maxLength={1000}
        editable={busy === null}
        accessibilityHint="Kept with the finding, so a later reader can see why you reviewed it."
      />

      <Row gap="sm" wrap style={{ marginTop: theme.spacing.md }}>
        <Button
          label="Mark reviewed"
          icon="check"
          variant="secondary"
          size="sm"
          loading={busy === 'REVIEWED'}
          disabled={busy !== null}
          accessibilityHint="Records that you read and checked this finding. The finding itself is not changed."
          onPress={() => void run('REVIEWED')}
        />
        <Button
          label="Dismiss"
          variant="ghost"
          size="sm"
          disabled={busy !== null}
          accessibilityHint="Sets this finding aside. It stays in the record, dimmed, with your note."
          onPress={() =>
            confirmDestructive({
              title: 'Dismiss this finding?',
              message:
                'It stays in the record, dimmed, with your review note, and the analysis itself is not changed. A dismissed finding cannot be reopened from the app.',
              confirmLabel: 'Dismiss',
              onConfirm: () => void run('DISMISSED'),
            })
          }
        />
      </Row>
    </>
  );
}

/**
 * The provisional prompt — the finding turned into a question.
 *
 * This is the visible half of the OCR quarantine. A rule that compares two values may only
 * raise a *confident* contradiction when a person has vouched for both; where one side was
 * recognised from pixels, the finding is still shown — suppressing it would be its own kind
 * of lie — but it is shown hedged, and the card carries the one tap that resolves it.
 *
 * Why the prompt lives on the finding rather than on the field: there are far fewer findings
 * than extracted fields, and only a finding can say *why* a particular value is worth a
 * person's attention. Asking a user to confirm every amount an OCR pass produced would be
 * O(fields) busywork that trains them to tap "confirm" without looking — which would defeat
 * the entire mechanism.
 *
 * Confirming records the reading as human-vouched *as it stands*; it does not assert the
 * finding is correct. If the reading is wrong, "Check the document" leads to the evidence
 * screen where it can be corrected instead — which is the path that makes a false
 * contradiction disappear.
 */
export function ProvisionalPrompt({
  finding,
  onConfirmReading,
  onInspectEvidence,
}: {
  finding: AnalysisResult;
  onConfirmReading?: (read: UnconfirmedRead) => void | Promise<void>;
  onInspectEvidence?: (evidenceId: string) => void;
}) {
  const theme = useTheme();
  const palette = theme.tone(PROVISIONAL_FINDING.tone);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const reads = finding.unconfirmedReads;
  // A provisional finding with no single field to confirm — an AI reading of a whole
  // document, say. The document itself is then what has to be looked at.
  const fallbackEvidenceId = finding.supportingEvidenceIds[0];

  const confirm = async (read: UnconfirmedRead) => {
    if (!onConfirmReading) return;
    const key = `${read.evidenceId}:${read.path}`;
    setBusyKey(key);
    try {
      await onConfirmReading(read);
    } finally {
      setBusyKey(null);
    }
  };

  return (
    // A tinted ground, no border. The tone's fill is enough to group the prompt inside a
    // card that already states its own edge; a hairline here made a box inside a box on
    // the most-read card in the product.
    <View
      style={[
        styles.provisional,
        { backgroundColor: palette.bg },
        { marginTop: theme.spacing.lg, padding: theme.spacing.lg, gap: theme.spacing.md },
      ]}
    >
      <Row gap="sm" align="flex-start">
        <Icon name={PROVISIONAL_FINDING.icon} size={16} color={palette.fg} />
        {/*
          The finding's own caveat, not a second wording of it.

          These two strings used to be written independently and shown together: the quarantine
          glued a sentence naming the unconfirmed reads onto `explanation`, and this box stated
          the same warning in different words directly underneath. A reader met the doubt twice
          on one card, once truncated. The caveat is now a field, so the box says whatever the
          finding actually carries — including anything the *rule* knew about its own weakness,
          which this hard-coded line could never say.

          The fallbacks remain for a finding stored before `caveat` existed, and for the AI
          layer, which can mark a finding provisional without producing one.
        */}
        <Text variant="bodySmall" colorToken="textSecondary" style={styles.flex}>
          {finding.caveat ||
            (reads.length > 0
              ? 'One of the values compared here was read from an image, and nobody has checked it yet. Characters can be misread, so this is shown as a question rather than a conclusion.'
              : 'This rests on a reading nobody has checked yet, so it is shown as a question rather than a conclusion.')}
        </Text>
      </Row>

      {reads.length > 0 ? (
        <View style={{ gap: theme.spacing.md }}>
          {reads.map((read) => {
            const key = `${read.evidenceId}:${read.path}`;
            return (
              <View key={key} style={{ gap: theme.spacing.xs }}>
                <Row between align="center" gap="md">
                  <Text
                    variant="caption"
                    colorToken="textTertiary"
                    uppercase
                    numberOfLines={1}
                    style={styles.flex}
                  >
                    {read.label}
                  </Text>
                  {/* Mono, because this is a machine reading and the reader is being asked
                      to compare it character by character with the original. */}
                  <Text variant="mono" numberOfLines={1} selectable style={styles.readingValue}>
                    {read.reading}
                  </Text>
                </Row>

                <Row gap="sm" align="center">
                  {onConfirmReading ? (
                    <Button
                      label={PROVISIONAL_FINDING.prompt}
                      icon="check"
                      variant="secondary"
                      size="sm"
                      loading={busyKey === key}
                      disabled={busyKey !== null}
                      accessibilityHint={`Records ${read.reading} as checked by you, then re-runs the analysis.`}
                      onPress={() => void confirm(read)}
                    />
                  ) : null}
                  {onInspectEvidence ? (
                    <Button
                      label="Check the document"
                      variant="ghost"
                      size="sm"
                      disabled={busyKey !== null}
                      onPress={() => onInspectEvidence(read.evidenceId)}
                    />
                  ) : null}
                </Row>
              </View>
            );
          })}
        </View>
      ) : onInspectEvidence && fallbackEvidenceId ? (
        <Button
          label="Check the document"
          variant="ghost"
          size="sm"
          onPress={() => onInspectEvidence(fallbackEvidenceId)}
        />
      ) : null}
    </View>
  );
}

/**
 * The em-dash-joined parts of one compared value, each made readable on its own.
 *
 * `readableToken` is total, but it works on a whole string, and several rules compose a
 * value out of a stored constant and a suffix — `response-overdue.ts:124` writes
 * `` `${method} — unconfirmed` ``, which arrives here as `OCR — unconfirmed` and survives
 * the whitespace test in one piece. Splitting on the separator the rules actually use
 * hands each part to the map that knows it, so the row reads "Read from an image —
 * unconfirmed". Nothing else is at risk: a date, an amount, a document title or a claim
 * sentence comes back byte-identical, because `readableToken` only reshapes a string that
 * is an identifier and nothing else.
 */
const VALUE_PART_SEPARATOR = ' — ';

function readableValue(value: string): string {
  return value
    .split(VALUE_PART_SEPARATOR)
    .map((part) => readableToken(part) || part)
    .join(VALUE_PART_SEPARATOR);
}

/**
 * Where a lifted value stops being a figure and starts being a sentence.
 *
 * `readableValue` tells the app's own vocabulary apart from material read off a document, but
 * it says nothing about *shape*: the material it leaves alone is `₹1,80,000` and `14 March
 * 2024` on one card and `Invoice from Pixelwave Studio.pdf` on the next. Both are quoted
 * material; only the first kind is a figure a reader compares at a glance, and setting a
 * thirty-character title at figure size would be shouting a filename.
 */
const FIGURE_MAX_CHARS = 28;

/**
 * One compared value.
 *
 * ## What this used to be
 *
 *     Invoice INV-2291 ......................... ₹1,80,000
 *     Payment screenshot ....................... ₹1,20,000
 *
 * A right-aligned key/value list — the shape of a settings screen — carrying the two figures
 * a whole dispute turns on, at 13.5pt, under a tracked-out uppercase eyebrow. The values were
 * the smallest thing in the block and the furthest from the reader's eye, and a reader who had
 * just been told two records disagree had to hunt to the right margin to find out how.
 *
 * They are now stacked and left-aligned under their own source, at reading size. Same data,
 * same two strings, in the order a person actually asks for them: whose figure, then what it
 * was.
 *
 * ## What stayed
 *
 * The label is reader-facing prose supplied by the rule — usually the name of the document the
 * value was read from, so that the rows of a comparison identify their own sources. It is set
 * in the sans face because it is the app's own word for the row.
 *
 * The value is set in mono *only when mono is true*. Mono is this app's one claim that a string
 * came off a document, and it holds for what a rule quoted or computed — an amount, a date, a
 * reference — but not for the stored constants a rule also puts in this table. `readableValue`
 * is the only thing that can tell those apart: it rewrites a constant and leaves content alone,
 * so a value it changed is the app's vocabulary and goes in sans, and a value it left is
 * material from the document and keeps the mono it has earned.
 */
function ComparedValue({ label, value }: { label: string; value: string }) {
  const spoken = readableValue(value);
  const lifted = spoken === value;
  const shown = spoken || value;
  const figure = lifted && shown.length <= FIGURE_MAX_CHARS;

  return (
    <View style={styles.compared}>
      <Text variant="caption" colorToken="textTertiary" numberOfLines={2}>
        {readableToken(label) || label}
      </Text>
      <Text
        variant={figure ? 'heading' : lifted ? 'monoValue' : 'bodyMedium'}
        mono={figure}
        numberOfLines={3}
        selectable={lifted}
      >
        {shown}
      </Text>
    </View>
  );
}

/**
 * The one-line variant, for the dashboard and for lists inside a case screen.
 *
 * Drops the reasoning rather than summarising it — a shortened explanation would be an
 * assertion without its basis, which is the thing this product does not do. Tapping opens
 * the full card.
 */
export function FindingRow({ finding, onPress }: { finding: AnalysisResult; onPress: () => void }) {
  const theme = useTheme();
  const tone = SEVERITY_TONE[finding.severity];
  const palette = theme.tone(tone);

  return (
    <Pressable
      onPress={onPress}
      dimOnPress
      pressScale={0}
      accessibilityRole="button"
      accessibilityLabel={`${ANALYSIS_LABELS[finding.resultType]}. ${finding.title}`}
      style={[styles.findingRow, { minHeight: theme.layout.rowHeight }]}
    >
      <View style={[styles.rowRule, { backgroundColor: palette.fg }]} />

      <View style={styles.flex}>
        <Text variant="label" tone={tone} numberOfLines={1}>
          {ANALYSIS_LABELS[finding.resultType]}
        </Text>
        <Text variant="bodySmall" numberOfLines={2} style={{ marginTop: theme.spacing.xxs }}>
          {finding.title}
        </Text>
      </View>

      <Icon name="chevron-right" size={18} color={theme.colors.textTertiary} />
    </Pressable>
  );
}

/**
 * How far a dismissed card is quieted.
 *
 * The app's press-dim value, reused deliberately: there were three near-identical
 * disabled-ish opacities in the layer meaning three different things, and a dismissed
 * finding wants exactly what this one already says — present, legible, not competing.
 */
const DISMISSED_OPACITY = 0.62;

const styles = StyleSheet.create({
  flex: { flex: 1 },
  dismissed: { opacity: DISMISSED_OPACITY },
  severityRule: {
    position: 'absolute',
    left: 0,
    // Inset to the card's own `padding="xl"`, so the rule marks the content it runs
    // beside rather than overshooting it by 6pt at both ends.
    top: SPACING.xl,
    bottom: SPACING.xl,
    width: BORDER_WIDTH.thick,
    borderTopRightRadius: BORDER_WIDTH.thick,
    borderBottomRightRadius: BORDER_WIDTH.thick,
  },
  // The source and the value it carried, tight enough to read as one statement. The `lg`
  // between two of these blocks is set by the container, so a card comparing three documents
  // reads as three answers rather than six lines.
  compared: { gap: SPACING.xxs },
  provisional: { borderRadius: RADIUS.md },
  readingValue: { flexShrink: 1, textAlign: 'right' },
  // Left-aligned now that it sits under the list rather than beside a heading, and padded to
  // a real target: `paddingVertical` is what takes a caption-sized control off 17pt.
  showAll: { paddingVertical: SPACING.sm, alignSelf: 'flex-start' },
  findingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.md,
    paddingVertical: SPACING.md,
  },
  rowRule: {
    width: BORDER_WIDTH.thick,
    alignSelf: 'stretch',
    borderRadius: BORDER_WIDTH.thick,
    marginVertical: SPACING.xs,
  },
});
