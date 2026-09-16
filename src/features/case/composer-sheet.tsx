/**
 * The claim / event composer.
 *
 * ## Why this is a sheet and not an inline editor
 *
 * The case screen used to grow a form in the middle of itself when you tapped "Add claim":
 * the claims list shifted down, the thing you had been reading moved, and the form appeared
 * wherever the scroll position happened to leave it. That is the cheapest possible answer to
 * "where does the editor go", and it costs the reader their place.
 *
 * Composing a claim is a different activity from reading a case. It wants the full width, the
 * keyboard, and no competing content — so it gets its own surface, opened from the section
 * header, over the screen rather than inside it.
 *
 * ## Why an actual sheet, and not the full-screen modal this used to be
 *
 * The first version of this was a `<Modal transparent={false}>`: a whole screen, opaque,
 * covering the case. It was chosen over pushing a route for the right reason — the claim only
 * makes sense against the case behind it, and a route push replaces exactly that — but an
 * opaque modal replaces it just as completely. The case was gone either way, and what came
 * back when the user finished was a screen they had to re-find their place in.
 *
 * `BottomSheet` keeps the case on screen behind a scrim. The form is unmistakably *over* the
 * case rather than instead of it, which is the relationship the writing actually has: you are
 * writing about the thing you can still see.
 *
 * ## Why one component serves both claims and events
 *
 * A claim and an event are the same act of typing with different labels — a sentence, some
 * context, and for an event a date. Two components drifted apart in the previous version: the
 * timeline's event form offered a related claim and validated nothing, the case screen's
 * offered a date and validated the statement. Both entry points now share this one, so the
 * validation, the character limits and the keyboard handling cannot diverge again.
 *
 * ## What this does not do
 *
 * It does not write. `onSubmit` hands the draft back to the screen, which owns the repository
 * and the mutation. A sheet that committed would need its own copy of the session, the
 * mutation context and the error vocabulary, and would then be a second place where a claim
 * can be created.
 */

import React, { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import {
  BORDER_WIDTH,
  BottomSheet,
  Button,
  IconButton,
  LAYOUT,
  Notice,
  Row,
  SelectField,
  Text,
  TextField,
  useTheme,
} from '@ui';

export type ComposerKind = 'claim' | 'event';

export interface ComposerDraft {
  /** The claim statement, or the event title. Required; trimmed before it reaches here. */
  statement: string;
  detail: string;
  /** Free text as the user wrote it. Never parsed here — see the field's own hint. */
  date: string;
  /** Empty string means "not attached to a claim", which is a legitimate answer. */
  claimId: string;
}

const EMPTY_DRAFT: ComposerDraft = { statement: '', detail: '', date: '', claimId: '' };

/**
 * Field limits, matching `claimSchema` and `caseEventSchema` in `@domain/models`.
 *
 * Duplicated here on purpose rather than derived from the Zod schemas: `maxLength` on a
 * `TextInput` stops the user typing a 2001st character, which is a better experience than
 * letting them write a paragraph and rejecting it on save. If the schema changes, the save
 * still fails loudly — this is a courtesy, not the validation.
 */
const LIMITS = {
  claimStatement: 2000,
  eventTitle: 160,
  detail: 4000,
  date: 60,
} as const;

export interface CaseComposerSheetProps {
  visible: boolean;
  kind: ComposerKind;
  /** Claims an event can be attached to. Ignored when `kind` is `'claim'`. */
  claims: ReadonlyArray<{ id: string; statement: string }>;
  busy: boolean;
  /**
   * A save failure: the sentence to show, plus the original string behind it.
   *
   * Two fields rather than one because `readableError` does its job by throwing something away.
   * It replaces a provider's own words with a sentence the calling screen wrote, which is right
   * for the person reading it and useless to whoever they ask for help. `message` is what the
   * sheet shows; `detail` goes to the disclosure `Notice` renders, one tap down.
   */
  error: { message: string; detail?: string | null } | null;
  onDismiss: () => void;
  onSubmit: (draft: ComposerDraft) => void;
}

export function CaseComposerSheet({
  visible,
  kind,
  claims,
  busy,
  error,
  onDismiss,
  onSubmit,
}: CaseComposerSheetProps) {
  const theme = useTheme();
  const [draft, setDraft] = useState<ComposerDraft>(EMPTY_DRAFT);

  /**
   * Cleared on open, not on close.
   *
   * Resetting when `visible` goes false would blank the fields while the dismiss animation is
   * still running, so the user watches their own text disappear on the way out.
   */
  useEffect(() => {
    if (visible) setDraft(EMPTY_DRAFT);
  }, [visible, kind]);

  const isClaim = kind === 'claim';
  const ready = draft.statement.trim().length > 0;

  const claimOptions = [
    { value: '', label: 'Not attached to a claim', description: 'You can attach it later.' },
    ...claims.map((claim) => ({ value: claim.id, label: claim.statement })),
  ];

  return (
    <BottomSheet
      visible={visible}
      onDismiss={onDismiss}
      header={
        <View
          style={{
            paddingHorizontal: theme.layout.screenPadding,
            paddingBottom: theme.spacing.lg,
          }}
        >
          <Row gap="lg" align="center" justify="space-between">
            <Text variant="heading" accessibilityRole="header" style={styles.flex}>
              {isClaim ? 'What do you want checked?' : 'Record something that happened'}
            </Text>
            <IconButton
              icon="close"
              accessibilityLabel={isClaim ? 'Close the claim composer' : 'Close the event composer'}
              onPress={onDismiss}
              disabled={busy}
            />
          </Row>
        </View>
      }
    >
      <ScrollView
        // `flexShrink`, not `flex: 1`. The sheet is a content-height column with a ceiling
        // rather than a full-screen one, so there is no free space for `flexGrow` to claim —
        // a `flex: 1` child in a column sized by its content collapses to nothing. Shrink
        // lets the form size itself and gives way when it would exceed the sheet's maximum.
        style={styles.scroll}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={[
          styles.content,
          {
            paddingHorizontal: theme.layout.screenPadding,
            paddingBottom: theme.spacing.giant,
            gap: theme.spacing.xxl,
          },
        ]}
      >
        <Text variant="bodySmall" colorToken="textSecondary">
          {isClaim
            ? 'Write it as a single sentence a document could confirm or contradict. "I paid the vendor ₹100 on 4 March" can be checked; "the vendor was unfair" cannot.'
            : 'An event is something you know happened. It is kept separate from what the sources say, so the two can be compared rather than merged.'}
        </Text>

        <TextField
          label={isClaim ? 'Claim' : 'What happened'}
          value={draft.statement}
          onChangeText={(statement) => setDraft((current) => ({ ...current, statement }))}
          multiline={isClaim}
          maxLength={isClaim ? LIMITS.claimStatement : LIMITS.eventTitle}
          autoFocus
          {...(isClaim
            ? {}
            : { placeholder: 'Paid the balance at the counter' })}
        />

        <TextField
          label="Context"
          labelHint="optional"
          hint={
            isClaim
              ? 'Anything that helps you recognise this claim later. Not used as evidence.'
              : 'Where it happened, who was there, what was said.'
          }
          value={draft.detail}
          onChangeText={(detail) => setDraft((current) => ({ ...current, detail }))}
          multiline
          maxLength={LIMITS.detail}
        />

        {!isClaim ? (
          <>
            <TextField
              label="When"
              labelHint="optional"
              hint="Write what you know — a full date, a month, or nothing. An uncertain date is kept uncertain rather than guessed at."
              value={draft.date}
              onChangeText={(date) => setDraft((current) => ({ ...current, date }))}
              maxLength={LIMITS.date}
              placeholder="2024-03-04, or March 2024"
            />

            {claims.length > 0 ? (
              <SelectField
                label="Part of the story for"
                value={draft.claimId}
                options={claimOptions}
                onChange={(claimId) => setDraft((current) => ({ ...current, claimId }))}
                hint="Attaching an event tells the analysis which claim it is meant to bear on."
              />
            ) : null}
          </>
        ) : null}

        {error ? (
          <Notice tone="danger" title="Not saved" message={error.message} detail={error.detail ?? null} />
        ) : null}
      </ScrollView>

      {/*
        The save bar sits in the sheet's flex column rather than using `ScreenFooter`. That
        primitive is `position: absolute` because it is built for `ScreenScroll`, which
        reserves room for it by adding a literal 72 points to its content padding — a number
        I would have to copy here, and one that is wrong the moment the label wraps at 200%
        font scale. In a sheet the layout is a three-part column, so the footer can simply be
        the third part and take exactly the height its content needs.

        It paints no background of its own any more: the sheet supplies one, and a second
        opaque fill inside it would show as a seam along the divider wherever the two
        surfaces differ. The bottom safe-area inset moved to the sheet for the same reason —
        the sheet's own background has to reach the bottom of the screen, not stop above the
        home indicator.
      */}
      <View
        style={[
          styles.footer,
          {
            borderTopColor: theme.colors.border,
            paddingHorizontal: theme.layout.screenPadding,
            paddingTop: theme.spacing.lg,
            paddingBottom: theme.spacing.lg,
          },
        ]}
      >
        <Button
          label={isClaim ? 'Add claim' : 'Record event'}
          icon="check"
          loading={busy}
          disabled={!ready || busy}
          fullWidth
          onPress={() => onSubmit(draft)}
          // Spread rather than `accessibilityHint={ready ? undefined : …}`:
          // `exactOptionalPropertyTypes` treats an explicit `undefined` as a type error on an
          // optional prop, and a hint on an enabled button would be read out for no reason.
          {...(ready
            ? {}
            : {
                accessibilityHint: isClaim
                  ? 'Write the claim first.'
                  : 'Describe what happened first.',
              })}
        />
      </View>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  // Sizes to the form, shrinks when the form would overflow the sheet. See the call site.
  scroll: { flexShrink: 1, flexGrow: 0 },
  // The sheet is a reading-width form on a tablet, not a 1000pt-wide input.
  content: { maxWidth: LAYOUT.maxContentWidth, width: '100%', alignSelf: 'center' },
  footer: { borderTopWidth: BORDER_WIDTH.hairline },
});
