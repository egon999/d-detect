/**
 * Side-by-side comparison.
 *
 * The screen that answers the question people actually arrive with: *I have a bill and I
 * have a screenshot of the payment — do they say the same thing?*
 *
 * ## Why this is a separate screen and not part of the analysis list
 *
 * Findings are exceptions. They fire when something is wrong, and an empty findings list is
 * ambiguous in the worst possible way: "nothing disagrees" and "nothing could be compared"
 * render identically, and they are opposites. This screen shows the comparison itself, so
 * agreement is visible and so is the absence of it.
 *
 * ## Why the rows are stacked rather than a grid
 *
 * A matrix of documents across and fields down is the obvious shape and the wrong one for a
 * phone. Four documents at a legible font size do not fit across 390 points, and the fix —
 * horizontal scrolling — hides exactly the column a reader is trying to compare against.
 * So each field is a card, and the documents are listed down it. Two documents is the
 * overwhelmingly common case, and for two, stacked rows read better than a grid anyway.
 *
 * ## Nothing here is a verdict on the evidence
 *
 * Every row states what each document said and whether those statements agree. The screen
 * never says a document is honest or a transaction happened. A difference between two figures
 * is reported as a difference, with the reminder that a partial payment, a fee or a misread
 * digit are all ordinary explanations for one.
 */

import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';

import {
  buildComparisonTables,
  type ComparisonCell,
  type ComparisonRow,
  type ComparisonTable,
  type RowAgreement,
} from '@domain/analysis/comparison';
import { buildRuleContext } from '@domain/rules/engine';
import { comparisonGroups } from '@domain/rules/support';
import { EVIDENCE_KIND_LABELS } from '@domain/enums';
import { useSession } from '@services';
import { useCaseRecord, useWorkspace } from '@services/use-case-store';
import {
  Chip,
  clampQuote,
  CONFIDENCE_LABELS,
  CONFIDENCE_TONE,
  Divider,
  EmptyState,
  errorDetail,
  ErrorState,
  Excerpt,
  EXTRACTION_METHOD_ICON,
  EXTRACTION_METHOD_LABELS,
  EXTRACTION_METHOD_TONE,
  FadeIn,
  HIT_TARGET,
  Icon,
  routeParam,
  type IconName,
  Notice,
  Pressable,
  RADIUS,
  Row,
  ScreenScroll,
  SkeletonList,
  SPACING,
  Stagger,
  Surface,
  Text,
  type Tone,
  useTheme,
} from '@ui';

/**
 * How each verdict reads.
 *
 * `DIFFERS` is `warn`, never `danger`. A difference between two documents is something for a
 * person to look at, not an error — and on a screen a user reaches while trying to work out
 * what happened, red would be the app telling them the answer before they have read it.
 *
 * Local to this screen rather than in `@ui/semantics`, because `RowAgreement` is this
 * module's own vocabulary and the semantics file deliberately maps only domain enums.
 */
const AGREEMENT: Record<RowAgreement, { tone: Tone; icon: IconName; label: string }> = {
  AGREES: { tone: 'ok', icon: 'check-circle-outline', label: 'Agrees' },
  DIFFERS: { tone: 'warn', icon: 'alert-circle-outline', label: 'Differs' },
  UNCOMPARED: { tone: 'neutral', icon: 'minus-circle-outline', label: 'Only one source' },
};

const FIELD_ICON: Record<ComparisonRow['field'], IconName> = {
  amount: 'cash',
  date: 'calendar-blank-outline',
  organization: 'domain',
  person: 'account-outline',
  identifier: 'pound',
};

export default function CompareScreen() {
  const theme = useTheme();
  const router = useRouter();
  const caseId = routeParam(useLocalSearchParams<{ caseId?: string | string[] }>().caseId);
  const { user } = useSession();

  // `error` is taken alongside `reload` because the empty state below is a positive claim:
  // it tells the reader that nothing about their documents can be compared. On a failed
  // load that claim is made about data that was never read, so a failure is reported as one.
  const { workspace, loading, refreshing, error, reload } = useWorkspace(user?.id ?? null, caseId ?? null);
  const targetCase = useCaseRecord(workspace, caseId ?? null);

  /**
   * The tables, derived on every workspace change.
   *
   * Built from the same `buildRuleContext` the analysis engine uses, so the extractions here
   * are the effective ones — a value a person has corrected is the value compared, not the
   * machine's original reading of it.
   *
   * Guarded on `targetCase`, not the route param: `useWorkspace` starts from an empty
   * workspace while it loads, so on the first render the case named by the URL is not in it
   * yet and `buildRuleContext` would throw straight into the error boundary.
   */
  const tables = useMemo<ComparisonTable[]>(() => {
    if (!workspace || !caseId || !targetCase) return [];
    const context = buildRuleContext(workspace, caseId);
    return buildComparisonTables(comparisonGroups(context), (id) => context.extractionOf(id));
  }, [workspace, caseId, targetCase]);

  const evidenceCount = useMemo(() => {
    if (!workspace || !caseId) return 0;
    return workspace.evidence.filter((item) => item.caseId === caseId && !item.deletedAt).length;
  }, [workspace, caseId]);

  const totals = useMemo(
    () =>
      tables.reduce(
        (accumulator, table) => ({
          agreeing: accumulator.agreeing + table.agreeing,
          differing: accumulator.differing + table.differing,
        }),
        { agreeing: 0, differing: 0 },
      ),
    [tables],
  );

  return (
    <ScreenScroll
      title="Compare"
      // The case title goes in `subtitle`, not `overline`: the overline is set in mono and
      // uppercased, which took whatever the user had named their case — "Rent deposit,
      // flat 3B" — and shouted it back at them in the typeface this app reserves for
      // values machine-read out of a document.
      {...(targetCase?.title ? { subtitle: targetCase.title } : {})}
      back
      onRefresh={reload}
      refreshing={refreshing}
      meta={
        tables.length > 0 ? (
          <Row gap="sm" wrap>
            <Chip
              tone="neutral"
              icon="file-multiple-outline"
              label={tables.length === 1 ? '1 comparison' : `${tables.length} comparisons`}
              size="sm"
            />
            {totals.agreeing > 0 && (
              <Chip tone="ok" icon="check-circle-outline" label={`${totals.agreeing} agreeing`} size="sm" />
            )}
            {totals.differing > 0 && (
              <Chip tone="warn" icon="alert-circle-outline" label={`${totals.differing} differing`} size="sm" />
            )}
          </Row>
        ) : null
      }
    >
      {error ? (
        <ErrorState
          title="These documents could not be loaded"
          message="The connection to your stored cases failed, so nothing could be compared. This does not mean your documents disagree, or that there is nothing to compare."
          detail={errorDetail(error)}
          onRetry={reload}
        />
      ) : loading && tables.length === 0 ? (
        <SkeletonList count={2} />
      ) : tables.length === 0 ? (
        <EmptyState
          icon="compare-horizontal"
          title={evidenceCount < 2 ? 'Two documents are needed to compare' : 'Nothing links these documents yet'}
          message={
            evidenceCount < 2
              ? 'Add at least two files about the same situation. A bill and a screenshot of the payment for it is the shape this works best on.'
              : 'Comparison is only offered when something concrete connects two documents — a shared reference number, the same organisation, or the same date. None of the files here have that in common yet, so nothing is being compared. Correcting a misread date or amount on the evidence screen often reveals the link.'
          }
          {...(evidenceCount < 2
            ? {
                action: {
                  label: 'Add evidence',
                  onPress: () => router.push(`/case/${caseId}/upload`),
                },
              }
            : {})}
        />
      ) : (
        <Stagger gap="xl" delay={60}>
          {tables.map((table) => (
            <ComparisonCard
              key={table.group.key}
              table={table}
              onOpenEvidence={(evidenceId) => router.push(`/case/${caseId}/evidence/${evidenceId}`)}
            />
          ))}
        </Stagger>
      )}

      {tables.length > 0 && (
        <FadeIn delay={240}>
          <Row gap="md" align="flex-start" style={styles.footnote}>
            <Icon name="scale-balance" size={16} color={theme.colors.textTertiary} />
            <Text variant="caption" colorToken="textTertiary" style={styles.flex}>
              Agreement between documents does not settle anything on its own. Two records can
              agree because both are right, because both came from the same place, or because one
              was copied from the other. Every row here reports what the documents say — deciding
              what that means is yours.
            </Text>
          </Row>
        </FadeIn>
      )}
    </ScreenScroll>
  );
}

/** One comparison: the grounds it rests on, then a card per field. */function ComparisonCard({
  table,
  onOpenEvidence,
}: {
  table: ComparisonTable;
  onOpenEvidence: (evidenceId: string) => void;
}) {
  const theme = useTheme();

  return (
    <View>
      {/*
        The grounds come first, and they are a sentence rather than a badge. A reader has to
        be able to reject the comparison — "both are dated 12 May" is a fair reason to
        compare two receipts and a terrible one if the user knows they were separate
        purchases. Hiding that behind a chip labelled "Strong grounds" would present the
        app's inference as the premise.
      */}
      <Row gap="sm" align="center" style={styles.groundsRow}>
        <Chip
          tone={CONFIDENCE_TONE[table.group.confidence]}
          label={CONFIDENCE_LABELS[table.group.confidence]}
          size="sm"
        />
        <Text variant="caption" colorToken="textSecondary" style={styles.flex}>
          Compared because {table.group.reason}.
        </Text>
      </Row>

      <Surface elevation="low" style={styles.card}>
        {/*
          The documents in this comparison, tappable through to their own screens.

          They used to be numbered, and each field below referred back to them as "1" and "2".
          That legend is gone: a reader working out whether their invoice and their payment
          screenshot agree should not also be holding a key in their head, and the numbers
          implied a sequence — first document, second document — that two pieces of evidence
          about the same event do not have. Every row below names its own documents instead.
        */}
        {table.documents.map((document) => (
          <Pressable
            key={document.id}
            onPress={() => onOpenEvidence(document.id)}
            accessibilityRole="button"
            accessibilityLabel={`Open ${document.title || document.fileName}`}
          >
            <Row gap="md" align="center" style={styles.documentRow}>
              <Text variant="bodyMedium" numberOfLines={1} style={styles.flex}>
                {document.title || document.fileName}
              </Text>
              <Chip tone="neutral" label={EVIDENCE_KIND_LABELS[document.kind]} size="sm" />
              <Icon name="chevron-right" size={16} color={theme.colors.textTertiary} />
            </Row>
          </Pressable>
        ))}

        <Divider spacing="lg" />

        {table.rows.map((row, index) => (
          <View key={row.key}>
            {index > 0 ? <Divider spacing="md" /> : null}
            <FieldRow row={row} documents={table.documents} />
          </View>
        ))}

        {table.uncompared > 0 && (
          <View style={styles.incomplete}>
            <Notice
              tone="info"
              icon="information-outline"
              title={
                table.uncompared === 1
                  ? 'One value could not be compared'
                  : `${table.uncompared} values could not be compared`
              }
              message="Only one document carries them, so there is nothing to check them against. That is not a conflict, and it is not support either — it is a gap you may be able to close with another file."
            />
          </View>
        )}
      </Surface>
    </View>
  );
}

/**
 * One field, with what each document said about it.
 *
 * ## What changed here, and why it was the whole problem
 *
 * This row used to render as a settings list:
 *
 *     Amount                              [Differs]
 *     1   ₹1,80,000            [Read from the document]
 *     2   ₹1,20,000                  [Suggested by AI]
 *
 * Two small monospace strings, a legend to hold in your head, and the app's word for it. The
 * reader was being asked to accept a conclusion about their own evidence on the strength of a
 * chip. Nothing on the row could be taken to a landlord, a bank or an ombudsman and pointed at.
 *
 * Meanwhile the extractor had already kept, for every one of these values, the line of the
 * document it came off — `ComparisonCell.sourceQuote`. This function read it into a variable
 * and dropped it on the floor. That single unrendered string is the difference between software
 * asserting a discrepancy and a person seeing one.
 *
 * So the row is now a confrontation: each document's figure at reading size, and under it the
 * document's own line with that figure marked, the way a person builds a case on paper. The
 * app's voice is confined to the verdict chip and the note; everything between them is quoted.
 */
function FieldRow({
  row,
  documents,
}: {
  row: ComparisonRow;
  documents: ComparisonTable['documents'];
}) {
  const theme = useTheme();
  const verdict = AGREEMENT[row.agreement];

  return (
    <View>
      <Row gap="sm" align="center" justify="space-between">
        <Row gap="sm" align="center" style={styles.flex}>
          <Icon name={FIELD_ICON[row.field]} size={15} color={theme.colors.textTertiary} />
          <Text variant="label">{row.label}</Text>
        </Row>
        <Chip tone={verdict.tone} icon={verdict.icon} label={verdict.label} size="sm" />
      </Row>

      <View style={styles.cells}>
        {row.cells.map((cell, index) => (
          <FieldCell
            key={cell.evidenceId}
            cell={cell}
            document={documents[index]}
            tone={verdict.tone}
          />
        ))}
      </View>

      <Text variant="caption" colorToken="textSecondary" style={styles.note}>
        {row.note}
      </Text>
    </View>
  );
}

/** What one document said about one field: the name, the figure, and the line it came off. */
function FieldCell({
  cell,
  document,
  tone,
}: {
  cell: ComparisonCell;
  document: ComparisonTable['documents'][number] | undefined;
  tone: Tone;
}) {
  const theme = useTheme();
  const name = document?.title || document?.fileName || 'This document';

  /*
    An empty cell says "not mentioned" in words. An em dash alone would be read as a zero or
    as a value the app failed to load, and on this screen the difference between "absent" and
    "disagrees" is the entire point.
  */
  if (cell.display === null) {
    return (
      <View style={styles.cell}>
        <Text variant="caption" colorToken="textTertiary" numberOfLines={1}>
          {name}
        </Text>
        <Text variant="bodySmall" colorToken="textTertiary">
          Not mentioned
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.cell}>
      <Text variant="caption" colorToken="textTertiary" numberOfLines={1}>
        {name}
      </Text>

      {/*
        `variant="heading"` with `mono`: monospace at 22pt, the size a figure is read at rather
        than checked at. The pairing in `TYPE` means this is the same rhythm as any other
        heading on the screen, so no new type token was needed to stop the two numbers a whole
        dispute turns on from being set smaller than the caption explaining them.
      */}
      <Text variant="heading" mono numberOfLines={2}>
        {cell.display}
      </Text>

      {cell.sourceQuote ? (
        /*
          `sourceValue` and not `display`: the document wrote `Rs. 1,80,000.00`, the app writes
          `₹1,80,000`, and searching the quote for the app's own wording would find nothing on
          exactly the two field types — amounts and dates — that disputes turn on.

          The highlighter takes the row's verdict tone, so the marked figures are amber on a row
          where the documents differ and green on one where they agree. That is the only place
          the verdict touches the evidence; the quoted characters themselves are never recoloured.
        */
        <Excerpt
          quote={clampQuote(cell.sourceQuote, cell.sourceValue)}
          value={cell.sourceValue}
          tone={tone}
          method={cell.method}
          numberOfLines={4}
        />
      ) : cell.method ? (
        /*
          No quote to show — a value someone typed in has no document line behind it, and
          saying so plainly is more honest than an empty sheet of paper. Provenance still
          travels with the value, because a figure a person confirmed and a figure a model
          guessed are not the same evidence and this is the screen where they sit next to
          each other.
        */
        <Row gap="xs" align="center">
          <Icon
            name={EXTRACTION_METHOD_ICON[cell.method]}
            size={12}
            color={theme.tone(EXTRACTION_METHOD_TONE[cell.method]).fg}
          />
          <Text variant="monoSmall" tone={EXTRACTION_METHOD_TONE[cell.method]}>
            {EXTRACTION_METHOD_LABELS[cell.method]}
          </Text>
        </Row>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  card: { padding: SPACING.lg, borderRadius: RADIUS.md },
  groundsRow: { marginBottom: SPACING.sm },
  // 44pt, not the 7pt of vertical padding that was here. These rows are the only way to
  // reach a document's own screen from a comparison, and at roughly 35pt they were the
  // smallest primary navigation in the app.
  documentRow: { minHeight: HIT_TARGET },
  cells: { marginTop: SPACING.md, gap: SPACING.xl },
  // `xxs` between the name, the figure and its sheet, `xl` between one document's block and
  // the next: the three parts of one document's answer belong together more tightly than two
  // documents' answers belong to each other, and that grouping is what lets a reader see the
  // comparison as two statements rather than six lines.
  cell: { gap: SPACING.xxs },
  note: { marginTop: SPACING.lg },
  incomplete: { marginTop: SPACING.lg },
  footnote: { marginTop: SPACING.xxxl },
});
