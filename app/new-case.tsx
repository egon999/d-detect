/**
 * New case.
 *
 * The first real thing a person does in the app, and it asks for two things: a name for the
 * case, and — optionally — the one statement they want the evidence to settle.
 *
 * ## Why it stops there
 *
 * It used to ask for eight fields across four headed sections — a category from seven preset
 * chips or a text box of your own, a background paragraph, a date, and a repeatable list of
 * people — under a subtitle reading "A title is all you need to begin. Everything else can be
 * added later." The second half of that sentence was false. `updateCase` had no caller
 * anywhere in the app, so everything collected here was collected once and then frozen for
 * the life of the case. The form was long *because* nothing downstream could change it.
 *
 * `app/case/[caseId]/details.tsx` is that caller now. Category, background, the date and the
 * people moved there, where they can be answered by someone who has read their documents
 * rather than guessed at by someone who has not yet uploaded one.
 *
 * ## Why the claim stayed
 *
 * It is the only field here that changes what the app does next. A claim is what findings are
 * assessed against, so a case created with one has something to check from the first upload
 * and a case created without one has nothing. It is still optional, and the composer on the
 * case screen adds more.
 *
 * ## Why nothing fills a field in for the reader
 *
 * The category presets used to. Choosing "Financial & Payment" wrote a template into the
 * claim field — `The payment of amount was completed on [date] via [UPI/Bank]` — and if the
 * person did not edit it, that string was saved as their claim. A claim is a factual
 * assertion the analysis then tries to check against evidence, so the app ended up assessing
 * a sentence with `[date]` in it that nobody had ever asserted. The presets are gone; the
 * rule they taught is not.
 */

import { useRouter } from 'expo-router';
import React, { useState } from 'react';
import { KeyboardAvoidingView, Platform, View } from 'react-native';
import { useRepository, useSession } from '@services';
import { mutationContext, useWorkspace } from '@services/use-case-store';
import { createCase, createClaim } from '@data/mutations';
import { caseSchema, claimSchema } from '@domain/models';
import { Button, Notice, ScreenScroll, Stack, Surface, Text, TextField, readableError, useTheme } from '@ui';

export default function NewCaseScreen() {
  const router = useRouter();
  const theme = useTheme();
  const { user, isLocal } = useSession();
  const { repository, ready, fallbackReason } = useRepository();
  const { workspace } = useWorkspace(user?.id ?? null, null);

  const [title, setTitle] = useState('');
  const [initialClaim, setInitialClaim] = useState('');
  const [busy, setBusy] = useState(false);
  /**
   * The two failures this form can have, kept apart.
   *
   * They were one `error` string shown in one banner titled "Check this first" — which is
   * the right sentence for a missing title and the wrong one for a network failure, where
   * there is nothing for the reader to check. A missing title now marks the field it is
   * about, which is where a form error belongs; the banner is left for the only thing it
   * can honestly be about, which is a save that did not complete.
   */
  const [titleError, setTitleError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  async function submit() {
    if (busy || !user || !ready) return;
    const cleanTitle = title.trim();
    if (!cleanTitle) {
      setTitleError('Give the case a title so you can find it later.');
      return;
    }

    setBusy(true);
    setTitleError(null);
    setSaveError(null);

    try {
      const context = mutationContext(user.id);
      const caseMutation = createCase(workspace, context, {
        title: cleanTitle,
        priority: 'NORMAL',
      });

      const caseChange = caseMutation.changes.find(
        (change) => change.collection === 'cases' && change.op === 'put',
      );
      const createdCaseId = caseChange && caseChange.op === 'put' ? caseChange.record.id : null;
      const createdCase = createdCaseId
        ? caseMutation.workspace.cases.find((item) => item.id === createdCaseId)
        : null;
      if (!createdCase) {
        throw new Error('The case could not be created. Try again.');
      }
      caseSchema.parse(createdCase);

      let allChanges = [...caseMutation.changes];

      if (initialClaim.trim()) {
        const claimMutation = createClaim(caseMutation.workspace, context, createdCase.id, {
          statement: initialClaim.trim(),
        });
        const claimChange = claimMutation.changes.find(
          (change) => change.collection === 'claims' && change.op === 'put',
        );
        const createdClaimId = claimChange && claimChange.op === 'put' ? claimChange.record.id : null;
        const createdClaim = createdClaimId
          ? claimMutation.workspace.claims.find((item) => item.id === createdClaimId)
          : null;
        if (createdClaim) {
          claimSchema.parse(createdClaim);
        }
        allChanges = [...allChanges, ...claimMutation.changes];
      }

      await repository.commit(user.id, allChanges);
      router.replace({ pathname: '/case/[caseId]', params: { caseId: createdCase.id } });
    } catch (caught) {
      /*
        `readableError`, not `caught.message`.

        Everything in the try block above throws its own vocabulary at this line: `caseSchema`
        and `claimSchema` throw a `ZodError`, whose `message` is a *JSON array of issue
        objects* — `[{"code":"too_small","path":["title"],...}]` — and `repository.commit`
        throws whatever the storage layer says, which is how "Missing or insufficient
        permissions." and "FirebaseError: [code=unavailable]" reached the banner on this
        screen. `readableError` shows a caught message only when it reads as a sentence
        written for a person, and otherwise shows the one written here.

        `permission-denied` keeps its own sentence because the code carries information the
        message does not: it is the one failure with a specific thing for the reader to do.
      */
      const code = (caught as { code?: string })?.code;
      setSaveError(
        code === 'permission-denied'
          ? 'This case could not be saved to your account. Check that you are still signed in, then try again.'
          : readableError(
              caught,
              'The case could not be saved. Nothing you typed has been lost — try again.',
            ),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScreenScroll
        title="Create a case"
        back
        subtitle="A title is all you need to begin. Everything else can be added later."
      >
        <View
          style={{
            gap: theme.spacing.xxl,
            maxWidth: theme.layout.maxContentWidth,
            width: '100%',
            alignSelf: 'center',
          }}
        >
          {saveError && <Notice title="The case was not saved" message={saveError} tone="danger" />}
          {fallbackReason && !isLocal && (
            <Notice
              title="Saving to this device"
              message="Your account could not be reached, so this case is being saved here. It will sync when the connection is back."
              tone="info"
            />
          )}

          <Surface padding="lg" radius="lg" style={{ gap: theme.spacing.xl }}>
            <TextField
              label="What is this case about?"
              value={title}
              onChangeText={(text) => {
                setTitle(text);
                if (titleError) setTitleError(null);
              }}
              error={titleError ?? undefined}
              maxLength={160}
              autoFocus
              placeholder="Deposit not returned by landlord"
            />

            {/*
              `labelHint`, not a caption under the field and not a grey chip beside the
              heading. Three of the four sections this screen used to have carried an
              "Optional" badge, two of the fields inside them repeated it as a hint, and the
              subtitle said it in words — the badge that appears on everything tells the
              reader nothing about which thing it is on. One word, on the one field that is.
            */}
            <TextField
              label="The first thing to check"
              labelHint="Optional"
              value={initialClaim}
              onChangeText={setInitialClaim}
              multiline
              maxLength={2000}
              placeholder="I paid the full amount and it was never credited."
            />
          </Surface>

          <Text variant="caption" colorToken="textSecondary">
            {isLocal
              ? 'Saved on this device. Sign in to keep your cases across devices.'
              : 'Saved privately to your account. Only you can read it.'}
          </Text>

          {/*
            One column, both full width, primary first.

            They were a wrapping `Row` of two auto-width buttons, which on a narrow device
            puts "Cancel" beside "Create a case" at roughly the same size — two equal-looking
            controls where one is the thing the screen is for — and at a narrower width drops
            it to a second line anyway. Stacked, the hierarchy is stated by order and by
            variant instead of by whatever the labels happen to measure.
          */}
          <Stack gap="md" style={{ marginTop: theme.spacing.sm }}>
            {/*
              The label does not change while saving. It used to read "Creating…" next to a
              spinner that already says so, and a button whose text is replaced mid-press is
              a button the reader has to re-read to check they pressed the right one.

              `disabled` no longer includes the empty title. A primary action that is inert on
              first paint, with the reason in a line below it, asks the reader to work out why
              the screen will not let them proceed; pressing it now marks the title field,
              which is where that fact belongs and where their next tap has to go anyway.
            */}
            <Button
              label="Create a case"
              variant="primary"
              size="lg"
              fullWidth
              onPress={() => void submit()}
              disabled={busy || !ready}
              loading={busy}
            />
            <Button
              label="Cancel"
              variant="ghost"
              size="lg"
              fullWidth
              disabled={busy}
              onPress={() => (router.canGoBack() ? router.back() : router.replace('/cases'))}
            />
          </Stack>

          {!busy && !ready ? (
            <Text variant="bodySmall" colorToken="textSecondary" style={{ textAlign: 'center' }}>
              Still getting set up. The case can be created in a moment.
            </Text>
          ) : null}
        </View>
      </ScreenScroll>
    </KeyboardAvoidingView>
  );
}
