import { useLocalSearchParams, useRouter } from 'expo-router';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import React, { useCallback, useMemo, useState } from 'react';
import { Platform, Share, StyleSheet, View } from 'react-native';

import {
  draftQuestions,
  draftReadiness,
  fillLine,
  filingDraftForCase,
  renderDraftText,
  type DraftLine,
  type DraftQuestion,
  type FilingDraft,
} from '@domain/analysis/filing-draft';
import { describeLimitation, type LimitationWindow } from '@domain/analysis/limitation';
import { useSession } from '@services';
import { useDraftAnswers } from '@services/draft-answers';
import { useCaseRecord, useWorkspace } from '@services/use-case-store';
import {
  Button,
  Chip,
  Divider,
  EmptyState,
  errorDetail,
  ErrorState,
  HIT_TARGET,
  Icon,
  LAYOUT,
  Notice,
  Pressable,
  readableError,
  routeParam,
  Row,
  ScreenScroll,
  Section,
  SkeletonCard,
  SPACING,
  Stack,
  Surface,
  Text,
  TextField,
  useTheme,
  useToast,
} from '@ui';

/**
 * The letter.
 *
 * ## What this screen is for
 *
 * Everywhere else the app reads documents and tells the user what it found. This is the one
 * screen where the app hands them something to *send*. A complaint has gone unanswered past
 * the window its redressal scheme allows, and the next step is a grievance form that asks for
 * a page of facts — every one of which is already sitting in this case, spread across
 * documents uploaded weeks ago and no longer remembered in detail.
 *
 * So the letter is assembled here and the user fills in the handful of things no document
 * contains. The alternative is what happens today: they look at the form, decide they will do
 * it at the weekend, and never file.
 *
 * ## Why the letter is shown whole, not as a form
 *
 * The obvious design is a wizard — one question per screen, letter generated at the end. It
 * is rejected deliberately. This document goes to a regulator over the user's signature, and
 * a person is entitled to read every word before they sign it. A wizard hides the text until
 * the user has already committed, which is exactly backwards for a document whose whole claim
 * to trust is that every sentence in it can be checked against a page they uploaded.
 *
 * So the letter is rendered in full, in order, with the gaps in it. Answering a question
 * rewrites the line in place, and the user watches the letter fill in.
 *
 * ## Three kinds of line, shown as three different things
 *
 * - **FACT** — assembled from a document. Carries the source's name, tappable through to the
 *   evidence it came from. This is the property the whole feature rests on: a sentence about
 *   the user's money that no document supports is one they can neither check nor defend.
 * - **TEMPLATE** — fixed wording that says nothing about this case. Shown plainly.
 * - **BLANK** — the app does not know this. Rendered with its brackets intact until answered,
 *   which is deliberately uncomfortable to look at: an unfilled `[your full name]` cannot be
 *   missed, whereas a blank line is something a person sends by accident.
 *
 * ## What this screen will not do
 *
 * It does not submit anything. There is no API here, no upload, no "file this for me" — the
 * user copies or shares the letter and sends it themselves, through their own email or the
 * scheme's own portal. Filing on someone's behalf would mean acting in their name before a
 * forum, which is not a thing this app is entitled to do.
 */
export default function FilingLetterScreen() {
  const theme = useTheme();
  const router = useRouter();
  const toast = useToast();
  const caseId = routeParam(useLocalSearchParams<{ caseId?: string | string[] }>().caseId);
  const { user } = useSession();
  const { workspace, loading, refreshing, error: loadError, reload } = useWorkspace(user?.id ?? null, caseId);

  const record = useCaseRecord(workspace, caseId);
  const { answers, setAnswer, clearCaseAnswers, loaded } = useDraftAnswers(user?.id ?? null, caseId ?? null);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /*
    The clock is read once per mount rather than on every render.

    `buildFilingDraft` counts whole days from the complaint to `now`, so a `Date.now()` in the
    render body would recompute the letter on every keystroke — and, at midnight, would change
    the number of days in a sentence the user is halfway through reading. Once per visit is
    the honest granularity for a document about how long something has been waiting.
  */
  const [now] = useState(() => Date.now());

  const draft = useMemo(
    () => (caseId ? filingDraftForCase(workspace, caseId, now) : null),
    [workspace, caseId, now],
  );

  const questions = useMemo(() => (draft ? draftQuestions(draft) : []), [draft]);
  const readiness = useMemo(
    () => (draft ? draftReadiness(draft, answers) : { blanks: 0, toCheck: 0 }),
    [draft, answers],
  );

  /** Document ids to titles, for the byline under each sourced line. */
  const evidenceTitles = useMemo(() => {
    const map = new Map<string, string>();
    for (const item of workspace.evidence) {
      if (!item.deletedAt) map.set(item.id, item.title);
    }
    return map;
  }, [workspace.evidence]);

  const letterText = useMemo(
    () => (draft ? renderDraftText(draft, answers) : ''),
    [draft, answers],
  );

  const shareText = useCallback(async () => {
    if (!draft) return;
    setError(null);
    try {
      /*
        Web first, because the native path does not exist there.

        `Share` on web is a thin wrapper over `navigator.share`, which several desktop
        browsers do not implement and which some others refuse outside a secure context —
        so a user on a laptop can press this and get nothing but a rejection. Falling back
        to the clipboard means the letter always ends up somewhere they can paste it from.
        The clipboard is a browser API here, not a new dependency.
      */
      if (Platform.OS === 'web') {
        const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
        if (clipboard?.writeText) {
          await clipboard.writeText(letterText);
          toast.show({ message: 'The letter is on your clipboard.' });
          return;
        }
        if (typeof navigator !== 'undefined' && navigator.share) {
          await navigator.share({ text: letterText, title: draft.subject });
          return;
        }
        setError('This browser will not let the app copy or share the letter. Use Print instead.');
        return;
      }

      // The system share sheet on device, which is how the user reaches their own mail
      // client and the messaging app they would actually send this through.
      await Share.share({ message: letterText, title: draft.subject });
    } catch (caught) {
      setError(readableError(caught, 'The letter could not be shared.'));
    }
  }, [draft, letterText, toast]);

  const sharePdf = useCallback(async () => {
    if (!draft) return;
    setBusy(true);
    setError(null);
    try {
      const html = letterHtml(draft, letterText);

      if (Platform.OS === 'web') {
        await Print.printAsync({ html });
        return;
      }

      const file = await Print.printToFileAsync({ html });
      // Sharing is unavailable on some devices and in some managed configurations. Printing
      // is the fallback rather than an error: the user still ends up with the document.
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(file.uri, {
          mimeType: 'application/pdf',
          dialogTitle: 'Save the letter',
          UTI: 'com.adobe.pdf',
        });
      } else {
        await Print.printAsync({ uri: file.uri });
      }
    } catch (caught) {
      setError(readableError(caught, 'The letter could not be created.'));
    } finally {
      setBusy(false);
    }
  }, [draft, answers, letterText]);

  const discard = useCallback(() => {
    clearCaseAnswers();
    toast.show({ message: 'Your answers for this letter were cleared. The letter itself is unchanged.' });
  }, [clearCaseAnswers, toast]);

  /*
    First paint, before the case has been read.

    This screen used to go straight to the masthead over an empty canvas: the `!loading &&
    !draft` guard below fell through while loading, and the body's own `draft ?` guard
    rendered nothing, so a user opening the letter saw a title, a `Share as PDF` footer and a
    blank page. Held here instead, shaped like the letter that is coming — a notice, a short
    block of questions, then the document — and saying nothing at all about the case, because
    which of the four "no letter yet" reasons applies is not knowable until the workspace has
    loaded.
  */
  if (loading && !draft) {
    return (
      <ScreenScroll title="Escalation letter" back contentStyle={styles.content}>
        <Stack
          gap="lg"
          accessibilityRole="progressbar"
          accessibilityLabel="Reading this case to assemble the letter"
        >
          <SkeletonCard lines={3} />
          <SkeletonCard lines={4} />
          <SkeletonCard lines={8} />
        </Stack>
      </ScreenScroll>
    );
  }

  /*
    No draft is the ordinary case, not an error, and the screen says which of the four
    reasons applies rather than showing an empty page. `longestSilence` returns null when
    there is no complaint, nothing day-dated, the complaint is still inside its reply window,
    or something in the case is dated after it — and the last of those is the one a user would
    otherwise find baffling, because it means the app thinks they already got an answer.

    A failed load is the one situation where none of that is true: nothing was read, so the
    app does not know whether there is a letter to draft and must not imply that there is not.
  */
  if (!draft) {
    return (
      <ScreenScroll
        title="Escalation letter"
        back
        {...(record?.title ? { subtitle: record.title } : {})}
        contentStyle={styles.content}
        refreshing={refreshing}
        onRefresh={reload}
      >
        {loadError ? (
          <ErrorState
            title="This case could not be read"
            message="The connection to your stored cases failed, so nothing could be assembled. Nothing has been changed, and this is not a sign that there is no letter to draft."
            detail={errorDetail(loadError)}
            onRetry={reload}
          />
        ) : (
          <EmptyState
            icon="email-off-outline"
            title="No letter to draft yet"
            message={
              'A letter is drafted when this case holds a complaint with a date on it, the reply ' +
              'window in its scheme has passed, and nothing else in the case is dated after it. ' +
              'If something here is dated later than the complaint, the app treats that as an ' +
              'answer and stays quiet.'
            }
            {...(caseId
              ? {
                  action: {
                    label: 'Add evidence',
                    icon: 'file-plus-outline' as const,
                    onPress: () => router.push({ pathname: '/case/[caseId]/upload', params: { caseId } }),
                  },
                }
              : {})}
          />
        )}
      </ScreenScroll>
    );
  }

  return (
    <ScreenScroll
      title="Escalation letter"
      back
      {...(record?.title ? { subtitle: record.title } : {})}
      contentStyle={styles.content}
      refreshing={refreshing}
      onRefresh={reload}
      meta={
        draft ? (
          <Row gap="sm" wrap>
            <Chip label={`${draft.daysElapsed} days unanswered`} tone="warn" icon="clock-alert-outline" />
            <LimitationChip window={draft.limitation} />
            <Chip
              label={readiness.blanks === 0 ? 'Nothing left to write' : `${readiness.blanks} to write`}
              tone={readiness.blanks === 0 ? 'ok' : 'info'}
              icon="pencil-outline"
            />
            {readiness.toCheck > 0 ? (
              <Chip label={`${readiness.toCheck} to check`} tone="warn" icon="image-search-outline" />
            ) : null}
          </Row>
        ) : null
      }
      footer={
        draft ? (
          <Row gap="sm">
            <Button label="Share as text" onPress={() => void shareText()} variant="secondary" style={styles.flex} />
            <Button
              label={Platform.OS === 'web' ? 'Print' : 'Share as PDF'}
              onPress={() => void sharePdf()}
              loading={busy}
              disabled={busy}
              style={styles.flex}
            />
          </Row>
        ) : null
      }
    >
      {/* Two different failures, said as two different things. A stale read leaves a letter
          on screen that is still perfectly usable; a failed share leaves the letter exactly
          where it was. Neither is "something went wrong". */}
      {loadError ? (
        <Notice
          tone="warn"
          title="This letter may not include your latest documents"
          message="The last attempt to re-read your stored cases did not succeed, so the letter below was assembled from what had already loaded. Pull down to try again."
        />
      ) : null}
      {error ? <Notice title="The letter could not be sent" message={error} tone="danger" /> : null}

      {draft ? (
        <View style={{ gap: theme.spacing.lg }}>
          <LimitationNotice window={draft.limitation} />

          <Notice
            tone="info"
            icon="information-outline"
            message={
              `This letter was assembled from the documents in this case. It is a draft for you to ` +
              `read, change and send yourself — the app does not file anything on your behalf. ` +
              `Check it against your own records before you send it.`
            }
          />

          {readiness.toCheck > 0 ? (
            <Notice
              tone="warn"
              icon="image-search-outline"
              title="Check these against the original documents"
              message={
                `${readiness.toCheck === 1 ? 'One value' : `${readiness.toCheck} values`} in this letter ` +
                `${readiness.toCheck === 1 ? 'was' : 'were'} read from an image rather than from text in ` +
                `the file, so ${readiness.toCheck === 1 ? 'it' : 'they'} may have been misread: ` +
                `${draft.checkBeforeFiling.map((read) => `${read.label.toLowerCase()} "${read.reading}"`).join(', ')}.`
              }
            />
          ) : null}

          {questions.length > 0 ? (
            <Section
              first
              title="What only you can answer"
              count={readiness.blanks}
              hint="These are not in any of your documents. What you write here appears in the letter below as you type."
            >
              <Surface padding="lg" radius="lg" style={{ gap: theme.spacing.md }}>
                {questions.map((question) => (
                  <QuestionField
                    key={question.slot}
                    question={question}
                    value={answers[question.slot] ?? ''}
                    editable={loaded}
                    onChange={(value) => setAnswer(question.slot, value)}
                  />
                ))}
              </Surface>
            </Section>
          ) : null}

          <Section
            title="The letter"
            hint="Every line marked with a source was taken from a document in this case. Tap one to see where it came from."
          >
            <Surface padding="lg" radius="lg" style={{ gap: theme.spacing.lg }}>
              {draft.sections.map((section, index) => (
                <View key={section.heading} style={{ gap: theme.spacing.sm }}>
                  {index > 0 ? <Divider spacing="sm" /> : null}
                  {/* The letter's own headings — "What I am asking for", "Declaration" —
                      which are authored sentences, not extracted values. They were set in
                      the monospace face and uppercased, which in this product is the mark
                      reserved for a figure lifted off a document: it told a reader that the
                      heading of their own letter came out of a machine. Sans, sentence
                      case, exactly as the draft writes them. */}
                  <Text variant="label" colorToken="textSecondary">
                    {section.heading}
                  </Text>
                  {section.lines.map((item, lineIndex) => {
                    // Bound to a local before the closure: `item.evidenceId` is a mutable
                    // property, so the narrowing from the guard below does not survive into
                    // the arrow function that uses it.
                    const { evidenceId } = item;
                    return (
                      <LetterLine
                        key={`${section.heading}:${lineIndex}`}
                        item={item}
                        text={fillLine(item, answers)}
                        sourceTitle={sourceTitleFor(item, evidenceTitles)}
                        {...(evidenceId && caseId
                          ? {
                              onPressSource: () =>
                                router.push({
                                  pathname: '/case/[caseId]/evidence/[evidenceId]',
                                  params: { caseId, evidenceId },
                                }),
                            }
                          : {})}
                      />
                    );
                  })}
                </View>
              ))}
            </Surface>
          </Section>

          <Section
            title="Documents to attach"
            count={draft.annexures.length}
            hint="Send copies of these with the letter. The app refers to them; it does not attach them for you."
          >
            <Surface padding="lg" radius="lg" style={{ gap: theme.spacing.md }}>
              {draft.annexures.map((annexure) => (
                <View key={annexure.serial} style={{ gap: theme.spacing.xxs }}>
                  <Text variant="bodyMedium">
                    {annexure.serial}. {annexure.title}
                  </Text>
                  {annexure.date ? (
                    <Text variant="caption" colorToken="textTertiary">
                      Dated {annexure.date}
                    </Text>
                  ) : null}
                </View>
              ))}
              <Text variant="caption" colorToken="textTertiary">
                The letter prints a fingerprint for each file. That identifies the bytes held in the
                app; it does not establish that a document is genuine.
              </Text>
            </Surface>
          </Section>

          {draft.gaps.length > 0 ? (
            <Section
              title="What would make this stronger"
              count={draft.gaps.length}
              hint="Read from what this case does and does not contain. None of it is a statement about what any forum requires."
            >
              <Surface padding="lg" radius="lg" style={{ gap: theme.spacing.md }}>
                {draft.gaps.map((gap, index) => (
                  <View key={gap.what} style={{ gap: theme.spacing.xxs }}>
                    {index > 0 ? <Divider spacing="sm" /> : null}
                    <Row gap="sm" align="flex-start">
                      <Icon name="alert-circle-outline" size={15} color={theme.colors.textTertiary} />
                      <Text variant="bodyMedium" style={styles.flex}>
                        {gap.what}
                      </Text>
                    </Row>
                    <Text variant="caption" colorToken="textTertiary">
                      {gap.why}
                    </Text>
                  </View>
                ))}
              </Surface>
            </Section>
          ) : null}

          <Section
            title="Before you send it"
            hint="The app quotes this window from a named scheme rather than stating it on its own authority."
          >
            <Surface padding="lg" radius="lg" style={{ gap: theme.spacing.sm }}>
              <Text variant="bodySmall" colorToken="textSecondary">
                Under {draft.forum.scheme}, a {draft.forum.sector} provider is generally expected to
                respond within {draft.forum.replyWindowDays} days, after which {draft.forum.nextStep} is
                usually the next step. You can reach it at {draft.forum.where}.
              </Text>
              <Text variant="bodySmall" colorToken="textSecondary">
                Check the current rules of that scheme before acting. They are amended from time to
                time, and what applies to your case depends on facts this app cannot see.
              </Text>
              <Button
                label="Clear what I wrote"
                onPress={discard}
                variant="ghost"
                icon="eraser"
                disabled={readiness.blanks === questions.length}
              />
            </Surface>
          </Section>
        </View>
      ) : null}
    </ScreenScroll>
  );
}

/**
 * One question, as the field that answers it.
 *
 * `multiline` is driven off the slot rather than passed in, because which answers need room
 * is a property of the question: an address is three lines on an envelope, and the relief is
 * where someone writes what they actually want done. A single-line box for either produces a
 * one-line answer, which is the whole failure mode — a letter that ends "please resolve".
 */
function QuestionField({
  question,
  value,
  editable,
  onChange,
}: {
  question: DraftQuestion;
  value: string;
  editable: boolean;
  onChange: (value: string) => void;
}) {
  const theme = useTheme();
  const roomy = question.slot === 'relief' || question.slot === 'address';

  return (
    <TextField
      label={question.placeholder}
      value={value}
      onChangeText={onChange}
      editable={editable}
      placeholder={editable ? 'Not yet written' : 'Loading…'}
      {...(roomy
        ? {
            multiline: true,
            // Stated as the number of lines the answer needs, derived from the body line
            // height, rather than as the 110 and 80 that used to be here. A box sized in
            // raw points stops matching the text in it the moment the type scale moves.
            minHeight: theme.type.body.lineHeight * (question.slot === 'relief' ? 4 : 3),
          }
        : {})}
      {...(question.personal
        ? { labelHint: 'saved for next time' }
        : question.lines > 1
          ? { hint: `Fills ${question.lines} lines of the letter` }
          : {})}
    />
  );
}

/**
 * The limitation window as a header chip.
 *
 * Tone is the whole design here. A closed window is `warn`, not `danger`: the forum retains the
 * power to hear a late complaint, and a red chip would tell someone their case is over at a
 * glance, which is both untrue and the most discouraging possible reading. An open window is
 * deliberately `neutral` rather than `ok` — having time left is the ordinary state of affairs,
 * not an achievement, and a green tick beside a deadline invites someone to stop reading.
 */
function LimitationChip({ window }: { window: LimitationWindow }) {
  if (window.state === 'UNKNOWN') {
    return <Chip label="Time limit unclear" tone="neutral" icon="help-circle-outline" />;
  }

  if (window.state === 'CLOSED') {
    return <Chip label="Past the usual window" tone="warn" icon="calendar-alert" />;
  }

  const days = window.daysRemaining ?? 0;
  if (window.state === 'CLOSING') {
    return (
      <Chip
        label={`${days} ${days === 1 ? 'day' : 'days'} left to file`}
        tone="warn"
        icon="calendar-clock"
      />
    );
  }

  return <Chip label={`Window open to ${window.closesOn}`} tone="neutral" icon="calendar-check" />;
}

/**
 * The limitation window, stated in full, above the letter.
 *
 * Placed first — before the "this is a draft" note and before the questions — because it is the
 * only thing on the screen that can change whether writing the letter is worth the afternoon.
 * Burying it under the draft would mean someone fills in six answers, prints a PDF and then
 * reads that the window closed eighteen months ago.
 *
 * An open window renders nothing at all. A banner that fires on every visit to say "everything
 * is fine" is how people learn to scroll past banners, and the header chip already carries the
 * date for anyone who wants it.
 */
function LimitationNotice({ window }: { window: LimitationWindow }) {
  if (window.state === 'OPEN') return null;

  const sentence = describeLimitation(window);

  if (window.state === 'UNKNOWN') {
    return (
      <Notice
        tone="neutral"
        icon="help-circle-outline"
        title="Check the time limit for this route yourself"
        message={[sentence, window.whenClosed, window.provision ? `The limit is set by ${window.provision}.` : null]
          .filter(Boolean)
          .join(' ')}
      />
    );
  }

  // Both remaining states say what to do next, not merely where the clock stands. The closed
  // case leans on `describeLimitation`, which already names the scheme's own answer — whether
  // that is condonation or a different forum — so nothing here asserts that a late complaint
  // will be heard. Under the RBI scheme it may not be, and a cheerful "send it anyway" would
  // spend someone's remaining months on the one door that is required to stay shut.
  const guidance =
    window.state === 'CLOSED'
      ? 'It is still worth writing: the delay itself is part of what happened, and the letter is the record of it.'
      : 'It is worth sending this sooner rather than later.';

  const anchorNote = window.anchorIsAssumed
    ? ' This is counted from the date of your complaint. The Act counts from when the problem itself arose, which may be earlier.'
    : '';

  return (
    <Notice
      tone="warn"
      icon={window.state === 'CLOSED' ? 'calendar-alert' : 'calendar-clock'}
      title={
        window.state === 'CLOSED' ? 'Past the usual window for this route' : 'The window is closing'
      }
      message={`${sentence} ${guidance}${anchorNote} The limit comes from ${window.provision}; these schemes are amended, so check the current rule before you rely on the date.`}
    />
  );
}

/**
 * One line of the letter, shown as what it is.
 *
 * A FACT line carries the name of the document it came from, and that byline is the point:
 * it is what lets a reader challenge any sentence by going to the page it was read from. A
 * needs-check line says so in the same place, because a value read off a scan is exactly the
 * one someone should look at twice before signing.
 *
 * The byline is a `Pressable` — the app's one tappable primitive — and not a ghost `Button`
 * like the one under a citation in the analysis panel. A citation there is a single card with
 * one action; here the byline repeats under every sourced line, and eight buttons down a page
 * turn a letter into a form. The `Pressable` keeps the document reading as a document while
 * still giving the press feedback and the hit area that an `onPress` on bare text does not.
 */
function LetterLine({
  item,
  text,
  sourceTitle,
  onPressSource,
}: {
  item: DraftLine;
  text: string;
  sourceTitle: string | null;
  onPressSource?: () => void;
}) {
  const theme = useTheme();
  const unanswered = item.kind === 'BLANK' && text === item.text;

  const byline =
    item.kind === 'FACT' && sourceTitle ? (
      <Row gap="xxs" align="center">
        <Icon
          name={item.needsCheck ? 'image-search-outline' : 'file-document-outline'}
          size={12}
          color={item.needsCheck ? theme.colors.tones.warn.fg : theme.colors.textTertiary}
        />
        <Text variant="caption" colorToken={item.needsCheck ? 'textSecondary' : 'textTertiary'}>
          {sourceTitle}
          {item.needsCheck ? ' · read from an image, check it' : ''}
        </Text>
      </Row>
    ) : null;

  return (
    <View style={{ gap: theme.spacing.xxs }}>
      {/*
        An unanswered blank is marked by highlighting it, not by slanting it.

        This was `fontStyle: 'italic'`, and `FONT_FAMILY` loads no italic face — so every
        blank in the letter was drawn with a synthetic oblique the renderer invented by
        shearing the upright, on the one screen whose output a user prints and signs. The
        highlight is a real mark: `warn` is the tone this product already uses for "look at
        this", the brackets stay intact, and the whole thing survives being screenshotted,
        printed or read at any type size.
      */}
      <Text
        variant="body"
        {...(unanswered ? { tone: 'warn' as const } : { colorToken: 'text' as const })}
        style={
          unanswered
            ? [
                styles.unanswered,
                {
                  backgroundColor: theme.colors.tones.warn.bg,
                  borderRadius: theme.radius.xs,
                  paddingHorizontal: theme.spacing.sm,
                  paddingVertical: theme.spacing.xxs,
                },
              ]
            : undefined
        }
      >
        {text}
      </Text>

      {byline && onPressSource ? (
        <Pressable
          onPress={onPressSource}
          dimOnPress
          pressScale={0}
          accessibilityRole="link"
          accessibilityLabel={`Open the source: ${sourceTitle}`}
          accessibilityHint="Opens the document this line was assembled from"
          style={styles.byline}
        >
          {byline}
        </Pressable>
      ) : (
        byline
      )}
    </View>
  );
}

/**
 * The title of the document a line was assembled from.
 *
 * Looked up from the case's evidence rather than from `draft.annexures`, because an annexure
 * carries only its serial, title, date and fingerprint — not the id of the document it came
 * from. Matching on title would mislabel two documents that happen to share a name.
 */
function sourceTitleFor(item: DraftLine, titles: ReadonlyMap<string, string>): string | null {
  if (!item.evidenceId) return null;
  return titles.get(item.evidenceId) ?? null;
}

/**
 * The letter as a printable page.
 *
 * Built from `renderDraftText` rather than from the sections directly, so the PDF and the
 * shared text are the same document — a user who sends the text and then prints the PDF must
 * not end up with two letters that differ.
 */
function letterHtml(draft: FilingDraft, text: string): string {
  const escape = (value: string): string =>
    value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

  return (
    `<!doctype html><html><head><meta charset="utf-8"><title>${escape(draft.subject)}</title>` +
    '<style>' +
    '@page { margin: 22mm 18mm; }' +
    'body { font-family: Georgia, "Times New Roman", serif; font-size: 11.5pt; line-height: 1.65; color: #111; }' +
    'pre { font-family: inherit; font-size: inherit; line-height: inherit; white-space: pre-wrap; word-wrap: break-word; margin: 0; }' +
    '</style></head><body>' +
    `<pre>${escape(text)}</pre>` +
    '</body></html>'
  );
}

const styles = StyleSheet.create({
  content: { maxWidth: LAYOUT.maxContentWidth, width: '100%', alignSelf: 'center' },
  flex: { flex: 1 },
  // Shrink-wraps the highlight to the blank rather than washing the whole column.
  unanswered: { alignSelf: 'flex-start' },
  // The byline is the route from a sentence in the letter to the page it was read off, so
  // it is primary navigation and takes the full target. The caption's own line box is about
  // 15pt; `HIT_TARGET` is the floor, applied to the touch area and not to the text, so the
  // annotation still sits against the line it annotates.
  byline: {
    minHeight: HIT_TARGET,
    justifyContent: 'center',
    paddingRight: SPACING.sm,
    alignSelf: 'flex-start',
  },
});
