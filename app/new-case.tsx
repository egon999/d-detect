/**
 * New case.
 *
 * The first real thing a person does in the app, so it asks for one thing — a title — and
 * treats everything else as optional. Everything on this screen can be changed later from
 * inside the case; nothing here is a decision the person is stuck with.
 *
 * ## Why the category presets do not fill in the claim
 *
 * They used to. Choosing "Financial & Payment" wrote a template into the claim field —
 * `The payment of amount was completed on [date] via [UPI/Bank]` — and if the person did
 * not edit it, that string was saved as their claim. A claim is a factual assertion the
 * analysis then tries to check against evidence, so the app ended up assessing a sentence
 * with `[date]` in it that nobody had ever asserted.
 *
 * The presets now set the category only, and the example they carry is shown as a hint
 * under the field — visible while writing, never submitted.
 */

import { useRouter } from 'expo-router';
import React, { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, View } from 'react-native';
import type { CaseParticipant } from '@domain/models';
import { newId } from '@domain/ids';
import { useRepository, useSession } from '@services';
import { mutationContext, useWorkspace } from '@services/use-case-store';
import { createCase, createClaim } from '@data/mutations';
import { caseSchema, claimSchema } from '@domain/models';
import { Button, Chip, Notice, Pressable, Row, ScreenScroll, Stack, Surface, Text, TextField, readableError, useTheme } from '@ui';

/**
 * Dispute categories, with one worked example each.
 *
 * `example` is shown as a hint, never written into the field. It is phrased as a whole
 * sentence a person could have written themselves, because that is what the claim field
 * wants — not a form with blanks in it.
 */
const PRESET_CATEGORIES = [
  {
    id: 'financial',
    label: 'Payment',
    example: 'I paid the full amount on 14 March and it was never credited.',
  },
  {
    id: 'harassment',
    label: 'Harassment',
    example: 'They kept messaging me after I asked them to stop.',
  },
  {
    id: 'contract',
    label: 'Broken agreement',
    example: 'The work we agreed on in the contract was never delivered.',
  },
  {
    id: 'fraud',
    label: 'Misrepresentation',
    example: 'They described the item as new, and it arrived used.',
  },
  {
    id: 'commerce',
    label: 'Delivery',
    example: 'The order was marked delivered but nothing arrived.',
  },
  {
    id: 'workplace',
    label: 'Unpaid work',
    example: 'My salary for October and November has not been paid.',
  },
  {
    id: 'property',
    label: 'Rent and deposit',
    example: 'My deposit was not returned after I moved out.',
  },
] as const;

export default function NewCaseScreen() {
  const router = useRouter();
  const theme = useTheme();
  const { user, isLocal } = useSession();
  const { repository, ready, fallbackReason } = useRepository();
  const { workspace } = useWorkspace(user?.id ?? null, null);

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [selectedPreset, setSelectedPreset] = useState<string | null>(null);
  const [customCategory, setCustomCategory] = useState('');
  const [incidentDate, setIncidentDate] = useState('');
  const [initialClaim, setInitialClaim] = useState('');
  const [participants, setParticipants] = useState<CaseParticipant[]>([]);
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

  const preset = selectedPreset ? PRESET_CATEGORIES.find((item) => item.id === selectedPreset) ?? null : null;
  const activeCategory = preset?.label ?? customCategory;

  const handleSelectPreset = (next: (typeof PRESET_CATEGORIES)[number]) => {
    // Selecting the chosen one again clears it, so a category can be unset without
    // reaching for the text field.
    if (selectedPreset === next.id) {
      setSelectedPreset(null);
      setCustomCategory('');
      return;
    }
    setSelectedPreset(next.id);
    setCustomCategory('');
  };

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
        description: description.trim() || undefined,
        category: activeCategory.trim() || undefined,
        incidentDate: incidentDate.trim() || null,
        participants: participants.filter((p) => p.name.trim().length > 0),
        priority: 'NORMAL',
      });

      const createdCase = caseMutation.workspace.cases[caseMutation.workspace.cases.length - 1];
      if (!createdCase) {
        throw new Error('The case could not be created. Try again.');
      }
      caseSchema.parse(createdCase);

      let allChanges = [...caseMutation.changes];

      if (initialClaim.trim()) {
        const claimMutation = createClaim(caseMutation.workspace, context, createdCase.id, {
          statement: initialClaim.trim(),
        });
        const createdClaim = claimMutation.workspace.claims[claimMutation.workspace.claims.length - 1];
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
              hint="A short name you will recognise later."
            />

            <View style={{ gap: theme.spacing.sm }}>
              <Text variant="label">Category</Text>
              <Text variant="caption" colorToken="textSecondary">
                Pick the closest one, or write your own below.
              </Text>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={{ gap: theme.spacing.sm, paddingVertical: theme.spacing.xs }}
              >
                {PRESET_CATEGORIES.map((item) => (
                  <Pressable
                    key={item.id}
                    onPress={() => handleSelectPreset(item)}
                    accessibilityRole="button"
                    accessibilityState={{ selected: selectedPreset === item.id }}
                    accessibilityLabel={`Category: ${item.label}`}
                  >
                    <Chip label={item.label} tone={selectedPreset === item.id ? 'accent' : 'neutral'} />
                  </Pressable>
                ))}
              </ScrollView>
              <TextField
                label="Your own category"
                value={customCategory}
                onChangeText={(value) => {
                  setCustomCategory(value);
                  setSelectedPreset(null);
                }}
                maxLength={80}
                placeholder="Freelance milestone dispute"
              />
            </View>
          </Surface>

          <Surface padding="lg" radius="lg" style={{ gap: theme.spacing.lg }}>
            {/*
              The heading, and nothing beside it. Each of these three sections used to carry
              a grey "Optional" chip, and two of the fields inside them repeated it as a
              label hint, and the category caption said it in words — six statements of one
              fact, on a screen whose subtitle already says a title is all you need. A badge
              that appears on every section is not telling the reader which ones are optional.
            */}
            <Text variant="heading">The first thing to check</Text>
            <Text variant="bodySmall" colorToken="textSecondary">
              Write one statement you want the evidence to settle. Keep it specific enough that a
              document could confirm or contradict it. You can add more later.
            </Text>
            <TextField
              label="Statement to check"
              value={initialClaim}
              onChangeText={setInitialClaim}
              multiline
              maxLength={2000}
              placeholder="I paid the full amount and it was never credited."
              {...(preset ? { hint: `For example: ${preset.example}` } : {})}
            />
          </Surface>

          <Surface padding="lg" radius="lg" style={{ gap: theme.spacing.lg }}>
            <Text variant="heading">Background</Text>
            <TextField
              label="What happened?"
              value={description}
              onChangeText={setDescription}
              multiline
              maxLength={4000}
              placeholder="Describe what happened and what you are trying to establish."
            />
            <TextField
              label="When did it happen?"
              value={incidentDate}
              onChangeText={setIncidentDate}
              maxLength={60}
              placeholder="14 March 2026, or October 2025 to January 2026"
            />
          </Surface>

          <Surface padding="lg" radius="lg" style={{ gap: theme.spacing.lg }}>
            <Text variant="heading">People involved</Text>
            <Text variant="bodySmall" colorToken="textSecondary">
              Adding a name lets the app show you where that person appears across your documents.
            </Text>
            {participants.map((person, index) => (
              /*
                No border on this one. It is a panel inside a card that already has an edge,
                and `variant="sunken"` gives it a fill a shade below its parent's — which is
                what separates it. A hairline as well would be the third statement of the
                same boundary.
              */
              <Surface
                key={person.id}
                variant="sunken"
                bordered={false}
                padding="md"
                radius="md"
                style={{ gap: theme.spacing.md }}
              >
                <Row between align="center">
                  <Text variant="label">Person {index + 1}</Text>
                  <Button
                    label="Remove"
                    variant="ghost"
                    size="sm"
                    onPress={() => setParticipants((prev) => prev.filter((p) => p.id !== person.id))}
                  />
                </Row>
                <TextField
                  label="Name"
                  value={person.name}
                  maxLength={120}
                  placeholder="Their name, or the company's"
                  onChangeText={(name) =>
                    setParticipants((values) =>
                      values.map((p) => (p.id === person.id ? { ...p, name } : p)),
                    )
                  }
                />
                <TextField
                  label="How are they involved?"
                  value={person.role}
                  maxLength={80}
                  placeholder="Landlord, witness, the bank"
                  onChangeText={(role) =>
                    setParticipants((values) =>
                      values.map((p) => (p.id === person.id ? { ...p, role } : p)),
                    )
                  }
                />
              </Surface>
            ))}
            <Button
              label="Add a person"
              variant="secondary"
              icon="account-plus-outline"
              onPress={() =>
                setParticipants((values) => [...values, { id: newId('person'), name: '', role: '' }])
              }
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
