import { router } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { View } from 'react-native';

import {
  createCase,
  createCaseFromRecord,
  isCancelled,
  listRecords,
  readableError,
  type DaybookRecord,
  type NewCaseInput,
} from '@api';
import {
  Button,
  Chip,
  formatMoneyCompact,
  formatRelativeTime,
  GlassSurface,
  Icon,
  IconTile,
  Notice,
  Pressable,
  Row,
  ScreenScroll,
  Skeleton,
  Stack,
  Text,
  TextField,
  useTheme,
  useToast,
} from '@ui';

const LIMIT = { title: 160, question: 400, claim: 4_000 };

type Step = 'happened' | 'sides' | 'want';

const ORDER: Step[] = ['happened', 'sides', 'want'];

const STEP_COPY: Record<Step, { title: string; hint: string }> = {
  happened: {
    title: 'What happened?',
    hint: 'One line is enough. You can change it later, and nothing is shown to anyone else.',
  },
  sides: {
    title: 'What is each side saying?',
    hint: 'Write it the way you would say it out loud. Leave either one blank if there is nothing to put there yet.',
  },
  want: {
    title: 'What do you want to happen?',
    hint: 'This is what the comparison will be aimed at. It can wait if you are not sure yet.',
  },
};

function SavedEntry({
  record,
  onPress,
  disabled,
}: {
  record: DaybookRecord;
  onPress: () => void;
  disabled: boolean;
}) {
  const theme = useTheme();
  const amount =
    record.amountMinor !== null && record.currency
      ? formatMoneyCompact(record.amountMinor, record.currency)
      : null;
  const when = record.occurredAt ?? record.createdAt;

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      dimOnPress
      pressScale={0.99}
      accessibilityRole="button"
      accessibilityLabel={`Start a case from ${record.title}`}
      style={{
        borderRadius: theme.radius.md,
        backgroundColor: theme.colors.surface,
        padding: theme.spacing.md,
      }}
    >
      <Row gap="md" align="flex-start">
        <IconTile icon={record.fileId ? 'file-document-outline' : 'note-text-outline'} size="sm" />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text variant="body" numberOfLines={2}>
            {record.title}
          </Text>
          <Row gap="sm" align="center" wrap style={{ marginTop: 2 }}>
            <Text variant="caption" colorToken="textTertiary">
              {formatRelativeTime(when, Date.now())}
            </Text>
            {amount ? (
              <Text variant="caption" colorToken="textTertiary" mono>
                {amount}
              </Text>
            ) : null}
            {record.counterparty ? (
              <Text variant="caption" colorToken="textTertiary" numberOfLines={1}>
                {record.counterparty}
              </Text>
            ) : null}
          </Row>
        </View>
        <Icon name="chevron-right" size={18} color={theme.colors.textTertiary} />
      </Row>
    </Pressable>
  );
}

export default function NewCaseScreen() {
  const theme = useTheme();
  const toast = useToast();

  const [step, setStep] = useState<Step>('happened');
  const [title, setTitle] = useState('');
  const [titleError, setTitleError] = useState<string | undefined>(undefined);
  const [myClaim, setMyClaim] = useState('');
  const [theirClaim, setTheirClaim] = useState('');
  const [question, setQuestion] = useState('');

  const [saved, setSaved] = useState<DaybookRecord[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const lock = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    void listRecords(12)
      .then((records) => {
        if (mounted.current) setSaved(records.filter((record) => record.status !== 'processing').slice(0, 6));
      })
      .catch(() => {
        if (mounted.current) setSaved([]);
      });
  }, []);

  const run = useCallback(async (action: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setFailure(null);
    try {
      await action();
    } catch (cause) {

      if (mounted.current && !isCancelled(cause)) {
        setFailure(readableError(cause, 'The case could not be started just now.'));
      }
    } finally {
      lock.current = false;
      if (mounted.current) setBusy(false);
    }
  }, []);

  const fromRecord = (record: DaybookRecord) =>
    void run(async () => {
      const result = await createCaseFromRecord(record.id);

      if (result.existing) {
        toast.show({ message: 'You already started a case from this. Here it is.', tone: 'info' });
      }
      router.replace(`/case/${result.case.id}`);
    });

  const create = () =>
    void run(async () => {
      const input: NewCaseInput = { title: title.trim() };
      if (question.trim()) input.question = question.trim();
      if (myClaim.trim()) input.myClaim = myClaim.trim();
      if (theirClaim.trim()) input.theirClaim = theirClaim.trim();
      const created = await createCase(input);
      router.replace(`/case/${created.id}`);
    });

  const advance = () => {
    if (step === 'happened') {
      if (!title.trim()) {
        setTitleError('Say what happened, in a few words, so you can find this again.');
        return;
      }
      setStep('sides');
      return;
    }
    if (step === 'sides') {
      setStep('want');
      return;
    }
    create();
  };

  const back = () => {
    const at = ORDER.indexOf(step);
    if (at > 0) {
      setFailure(null);
      setStep(ORDER[at - 1] ?? 'happened');
      return;
    }
    if (router.canGoBack()) router.back();
    else router.replace('/(tabs)/cases');
  };

  const copy = STEP_COPY[step];
  const position = ORDER.indexOf(step) + 1;

  return (
    <ScreenScroll
      title={copy.title}
      overline={`Step ${position} of ${ORDER.length}`}
      subtitle={copy.hint}
      back
      onBack={back}
      footer={
        <Button
          label={step === 'want' ? 'Start the case' : 'Next'}
          icon={step === 'want' ? 'check' : 'arrow-right'}
          iconTrailing
          onPress={advance}
          loading={busy}
          fullWidth
        />
      }
    >
      <Stack gap="lg">
        {failure ? <Notice tone="danger" message={failure} onDismiss={() => setFailure(null)} /> : null}

        {step === 'happened' ? (
          <>
            <TextField
              label="What happened?"
              value={title}
              onChangeText={(next) => {
                setTitle(next);
                if (titleError) setTitleError(undefined);
              }}
              placeholder="The landlord is keeping my deposit"
              maxLength={LIMIT.title}
              editable={!busy}
              autoFocus
              returnKeyType="next"
              onSubmitEditing={advance}
              {...(titleError ? { error: titleError } : {})}
            />

            {saved === null ? (
              <Stack gap="sm">
                <Skeleton height={18} width="60%" />
                <Skeleton height={56} />
                <Skeleton height={56} />
              </Stack>
            ) : saved.length > 0 ? (
              <GlassSurface padding="lg">
                <Stack gap="md">
                  <Stack gap="xs">
                    <Text variant="subheading">Or start from something you saved</Text>
                    <Text variant="bodySmall" colorToken="textSecondary">
                      The file comes with it, on your side, and is read straight away.
                    </Text>
                  </Stack>
                  <Stack gap="sm">
                    {saved.map((record) => (
                      <SavedEntry
                        key={record.id}
                        record={record}
                        disabled={busy}
                        onPress={() => fromRecord(record)}
                      />
                    ))}
                  </Stack>
                </Stack>
              </GlassSurface>
            ) : null}
          </>
        ) : null}

        {step === 'sides' ? (
          <>
            <GlassSurface padding="lg" tone="accent">
              <Stack gap="md">
                <Row gap="sm" align="center">
                  <IconTile icon="account-outline" size="sm" tone="accent" />
                  <Text variant="subheading">What you say happened</Text>
                </Row>
                <TextField
                  value={myClaim}
                  onChangeText={setMyClaim}
                  placeholder="I paid ₹30,000 in cash on 3 May and have the receipt."
                  labelHint="optional"
                  maxLength={LIMIT.claim}
                  editable={!busy}
                  multiline
                  minHeight={120}
                />
              </Stack>
            </GlassSurface>

            <GlassSurface padding="lg">
              <Stack gap="md">
                <Row gap="sm" align="center">
                  <IconTile icon="account-multiple-outline" size="sm" />
                  <Text variant="subheading">What they are saying</Text>
                </Row>
                <TextField
                  value={theirClaim}
                  onChangeText={setTheirClaim}
                  placeholder="He says the money went on repairs, but has not said what for."
                  labelHint="optional"
                  maxLength={LIMIT.claim}
                  editable={!busy}
                  multiline
                  minHeight={120}
                />
                <Text variant="caption" colorToken="textTertiary">
                  If they have not said anything yet, leave this. You can add it the moment they do.
                </Text>
              </Stack>
            </GlassSurface>
          </>
        ) : null}

        {step === 'want' ? (
          <>
            <TextField
              label="What do you want to happen?"
              value={question}
              onChangeText={setQuestion}
              placeholder="Get the ₹30,000 deposit back"
              labelHint="optional"
              maxLength={LIMIT.question}
              editable={!busy}
              multiline
              minHeight={100}
              autoFocus
            />

            <GlassSurface padding="lg">
              <Stack gap="md">
                <Text variant="subheading">What happens next</Text>
                <Stack gap="sm">
                  {[
                    'You add what you have — photos, screenshots, documents, or just what you remember.',
                    'Anything from their side goes in its own column, kept separate from yours.',
                    'When both are in, the two are set against each other: what they agree on, where they contradict, and what is missing.',
                  ].map((line) => (
                    <Row key={line} gap="sm" align="flex-start">
                      <View style={{ paddingTop: 3 }}>
                        <Icon name="check" size={15} color={theme.tone('ok').fg} />
                      </View>
                      <Text variant="bodySmall" colorToken="textSecondary" style={{ flex: 1 }}>
                        {line}
                      </Text>
                    </Row>
                  ))}
                </Stack>
                <Row gap="sm" wrap>
                  <Chip label="Only you can see this" tone="neutral" icon="lock-outline" />
                  <Chip label="Nothing is sent to anyone" tone="neutral" icon="shield-check-outline" />
                </Row>
              </Stack>
            </GlassSurface>
          </>
        ) : null}
      </Stack>
    </ScreenScroll>
  );
}
