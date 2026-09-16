import React, { useCallback, useState } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { buildCaseReportHtml } from '@domain/analysis/export-report';
import { latestCaseAnalysis } from '@domain/analysis/case-report';
import { useSession } from '@services';
import { useCaseRecord, useWorkspace } from '@services/use-case-store';
import {
  Button,
  EmptyState,
  ErrorState,
  LAYOUT,
  Notice,
  RADIUS,
  routeParam,
  Row,
  ScreenScroll,
  SkeletonCard,
  SPACING,
  Stack,
  Stagger,
  Surface,
  Text,
  errorDetail,
  readableError,
  useTheme,
  useToast,
} from '@ui';

/**
 * Export the case as a readable document.
 *
 * ## Why a PDF and not a data export
 *
 * The recipient of this file is a person — a manager, a lawyer, a bank's grievance desk —
 * reading it away from the app. What they need is the reasoning laid out in order, with the
 * quoted source text beside each conclusion, so they can check it without being asked to
 * trust a tool they have never seen. A JSON dump of the workspace serves a different reader
 * and is not what this screen is for.
 *
 * ## What leaves the device
 *
 * The rendering is local: `buildCaseReportHtml` composes the document and `expo-print`
 * rasterises it on device. Nothing is uploaded to produce the file. Where it goes next is
 * the user's choice through the system share sheet, which is why the warning below names
 * the sensitivity of the contents rather than reassuring them about it.
 *
 * ## Web behaves differently on purpose
 *
 * `Sharing` has no meaning in a browser tab, and `printToFileAsync` produces a file the
 * page cannot hand anywhere useful. On web the print dialog *is* the save mechanism, so it
 * is opened directly and the button says so.
 *
 * ## Why the screen says nothing about the case until the case has loaded
 *
 * The contents list used to be rendered on first paint, and its middle line reads either
 * "the most recent assessment" or "no assessment has been saved yet" — a statement about
 * *this* case, decided by a `report` that is always null while the workspace is still being
 * read. Every user therefore saw the app assert that their case had never been assessed,
 * and for anyone who had just run an assessment that assertion was false. The whole column
 * is now held behind the load, because a placeholder that admits it knows nothing is the
 * only honest thing to show in that moment.
 */
export default function ExportReportScreen() {
  const theme = useTheme();
  const router = useRouter();
  const toast = useToast();
  const caseId = routeParam(useLocalSearchParams<{ caseId?: string | string[] }>().caseId);
  const { user } = useSession();
  const { workspace, loading, refreshing, error: loadError, reload } = useWorkspace(user?.id ?? null, caseId);

  const record = useCaseRecord(workspace, caseId);
  const report = caseId ? latestCaseAnalysis(workspace, caseId) : null;

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * The last file this screen produced, kept so it can be handed out again.
   *
   * `Sharing.shareAsync` resolves the same way whether the user sent the report or backed
   * out of the share sheet, so the screen cannot report which happened and does not try.
   * What it can say is that the file exists — and then leave it reachable, so a user who
   * dismissed the sheet by accident is not made to regenerate the document to find out.
   */
  const [lastFile, setLastFile] = useState<string | null>(null);

  const handOff = useCallback(async (uri: string) => {
    // Sharing is unavailable on some devices and in some managed configurations.
    // Printing is the fallback rather than an error: the user still ends up with the
    // document, which is what they asked for.
    if (await Sharing.isAvailableAsync()) {
      await Sharing.shareAsync(uri, {
        mimeType: 'application/pdf',
        dialogTitle: 'Save case report',
        UTI: 'com.adobe.pdf',
      });
    } else {
      await Print.printAsync({ uri });
    }
  }, []);

  const exportReport = useCallback(async () => {
    // Without an id there is no case to report on, and building one anyway would produce a
    // document about nothing. The screen already shows "Back to cases" in that state.
    if (!caseId) return;
    setBusy(true);
    setError(null);
    try {
      const html = buildCaseReportHtml(workspace, caseId, Date.now());

      if (Platform.OS === 'web') {
        await Print.printAsync({ html });
        toast.show({
          message: 'The print dialog was opened. Choose "Save as PDF" there to keep a copy.',
        });
        return;
      }

      const file = await Print.printToFileAsync({ html });
      setLastFile(file.uri);
      await handOff(file.uri);
      toast.show({
        tone: 'ok',
        message: 'The report was created. You can send it again from this screen.',
      });
    } catch (caught) {
      setError(readableError(caught, 'The report could not be created. Nothing was sent.'));
    } finally {
      setBusy(false);
    }
  }, [workspace, caseId, handOff, toast]);

  const shareAgain = useCallback(async () => {
    if (!lastFile) return;
    setBusy(true);
    setError(null);
    try {
      await handOff(lastFile);
    } catch (caught) {
      setError(readableError(caught, 'The report could not be sent. It is still saved here.'));
    } finally {
      setBusy(false);
    }
  }, [lastFile, handOff]);

  return (
    <ScreenScroll
      title="Export case report"
      back
      {...(record?.title ? { subtitle: record.title } : {})}
      refreshing={refreshing}
      onRefresh={reload}
    >
      {loadError ? (
        <ErrorState
          title="This case could not be loaded"
          message="The stored copy of this case could not be read, so there is nothing to export yet."
          detail={errorDetail(loadError)}
          onRetry={reload}
        />
      ) : loading && !record ? (
        <Stack
          gap="lg"
          style={styles.column}
          accessibilityRole="progressbar"
          accessibilityLabel="Loading this case"
        >
          <SkeletonCard lines={3} />
          <SkeletonCard lines={5} />
        </Stack>
      ) : !record ? (
        <EmptyState
          icon="folder-remove-outline"
          title="Case unavailable"
          message="This case has been deleted, or it belongs to another account. Nothing was loaded, so nothing can be exported."
          action={{ label: 'Back to cases', onPress: () => router.replace('/cases'), icon: 'arrow-left' }}
        />
      ) : (
        <>
          {/*
        The blocks arrive in the order they are read: what the report is, what is in it, then
        the button that makes it.

        Keys are explicit rather than left to `Stagger`'s positional fallback. Both the notice
        and the closing hint appear in response to something the user did, and an unkeyed
        sibling list would re-key on the first failure — remounting the wrappers and replaying
        every entrance on the screen at the moment the user is being told something went wrong.
      */}
          <Stagger gap="lg" style={styles.column}>
            {error ? (
              <Notice key="failure" title="The report could not be created" message={error} tone="danger" />
            ) : null}

            <Text key="intro" colorToken="textSecondary">
              A readable copy of the case: every claim and what was concluded about it, the exact
              lines quoted from each document, the contradictions found, the timeline, and the
              fingerprint of each original file.
            </Text>

            <Surface key="contents" padding="lg" radius="lg" style={{ gap: theme.spacing.md }}>
              <Text variant="heading">What the report contains</Text>

              <View style={{ gap: theme.spacing.sm }}>
                <Line theme={theme}>The case details and every claim recorded in it</Line>
                <Line theme={theme}>
                  {report
                    ? 'The most recent assessment, with its quoted passages and stated limitations'
                    : 'No assessment has been saved yet, so every claim will be marked as not assessed'}
                </Line>
                <Line theme={theme}>An index of the evidence, with a fingerprint for each file that has one</Line>
              </View>

              <Text variant="bodySmall" colorToken="textSecondary" style={{ marginTop: theme.spacing.xs }}>
                The original files are not embedded — the report refers to them. It does contain the
                case's contents, so choose where you save or send it.
              </Text>
            </Surface>

            <Button
              key="action"
              label={Platform.OS === 'web' ? 'Print or save as PDF' : 'Create PDF report'}
              onPress={() => void exportReport()}
              loading={busy}
              disabled={busy}
            />

            {lastFile ? (
              <Button
                key="again"
                label="Send the report again"
                variant="secondary"
                onPress={() => void shareAgain()}
                disabled={busy}
              />
            ) : null}
          </Stagger>
        </>
      )}
    </ScreenScroll>
  );
}

/** One item in the contents list. A bullet the theme owns, rather than a literal "•". */
function Line({ children, theme }: { children: React.ReactNode; theme: ReturnType<typeof useTheme> }) {
  return (
    <Row gap="sm" align="flex-start">
      <View
        style={[
          styles.bullet,
          { backgroundColor: theme.colors.textTertiary, marginTop: theme.spacing.sm },
        ]}
      />
      <Text variant="bodySmall" style={styles.flex}>
        {children}
      </Text>
    </Row>
  );
}

const styles = StyleSheet.create({
  column: { maxWidth: LAYOUT.maxContentWidth, width: '100%', alignSelf: 'center' },
  bullet: { width: SPACING.xs, height: SPACING.xs, borderRadius: RADIUS.pill },
  flex: { flex: 1 },
});
