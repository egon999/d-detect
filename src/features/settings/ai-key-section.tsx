/**
 * The AI suggestions setting.
 *
 * One panel, two credentials: the user's own Groq key or xAI key, each held in the device
 * keystore by `@services/ai/credentials` and managed separately. Everything difficult
 * about this screen is a privacy or an honesty problem rather than a layout one, so those
 * are what the comments are about.
 *
 * ## The key is never shown back, in full or in part
 *
 * Not masked, not last-four, not on a long press. `loadKey` is called once per provider, on
 * mount, and its result is turned into a boolean on the same line — the string is never
 * assigned to state, to a ref, or to anything that outlives that expression. So there is no
 * render path, no devtools snapshot and no error-boundary dump that can put it on screen.
 * The panel knows *whether* a key exists and nothing else about it, which is all a person
 * needs to be told: they have the key already, in the console they created it in.
 *
 * Masking with the last four characters was the obvious alternative and was rejected. It
 * reads as reassurance while giving an onlooker a way to confirm which key is installed, and
 * it commits the app to holding the plaintext in component state to produce the mask.
 *
 * ## Nothing here is logged
 *
 * There is no `console` call in this file, and every message shown to the user goes through
 * `scrubKey` before it is rendered. The failure sentences from `groq-client` are already a
 * fixed vocabulary that cannot contain a key, but the keystore write can throw a native
 * error whose text this file does not control, and `scrubKey` is what makes that safe rather
 * than probably-safe.
 *
 * ## Why a shape check *and* a live call
 *
 * They catch different mistakes and neither is redundant. `looksLikeKey` catches the paste
 * errors — an `Authorization: Bearer …` header, a truncated copy, the console URL, a whole
 * curl command — at the moment the user still has the real key on their clipboard and can
 * fix it. It cannot tell a valid key from a revoked one. Only the provider can, so the
 * panel asks the provider before it stores anything, and a key the provider refuses is
 * never written to the device at all. The ask is `GET {base}/models` — the cheapest
 * authenticated call each provider offers, spending no tokens and carrying none of the
 * user's evidence.
 *
 * ## Gemini
 *
 * There is no Gemini field, and this is not an omission. Gemini belongs in a server
 * environment with its key in a secret manager; `credentials.ts` refuses to store one on the
 * device, so offering the field would render a control whose only outcome is an error.
 *
 * ## Transcription is Groq's alone
 *
 * xAI has no transcription endpoint, so an xAI key turns on suggestions but not the
 * transcription of recordings. The panel says so when xAI is the provider selected, rather
 * than letting a user discover it from a recording that stays untranscribed.
 */

import * as Haptics from 'expo-haptics';
import * as Linking from 'expo-linking';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View } from 'react-native';

// Imported from the two modules directly rather than from the `@services/ai` barrel: the
// barrel also re-exports the assistant and extractor layers, and this panel has no business
// pulling the whole AI stack into the profile screen's bundle to read one boolean.
import {
  AI_PROVIDER_CONSOLE_URLS,
  clearKey,
  loadKey,
  looksLikeKey,
  saveKey,
  secureStorageAvailable,
} from '@services/ai/credentials';
import {
  CHAT_PROVIDER_BASE_URLS,
  CHAT_PROVIDER_NAMES,
  scrubKey,
  type ChatProvider,
} from '@services/ai/groq-client';
import {
  Button,
  Chip,
  Divider,
  IconButton,
  Notice,
  Row,
  SegmentedControl,
  Shimmer,
  Surface,
  Text,
  TextField,
  useTheme,
} from '@ui';

import { confirmDestructive } from './confirm';

/**
 * Longest paste the field will take.
 *
 * Mirrors the limit `credentials.ts` enforces, which is not exported. The authority stays
 * with `looksLikeKey`; this only stops a stray multi-megabyte paste from reaching a
 * `TextInput` at all.
 */
const KEY_INPUT_LIMIT = 400;

/** Matches the single-line field height in `Field.tsx`, so the placeholder is the real shape. */
const FIELD_HEIGHT = 46;

/**
 * Ten seconds for the key check.
 *
 * A `GET /models` is a lookup, not an inference: anything that takes longer than this is a
 * connection problem, and a user pasting a key should not wait on one. The chat requests
 * themselves keep the transport's own, longer timeout.
 */
const PROBE_TIMEOUT_MS = 10_000;

type Provider = ChatProvider;

/** The two providers a key can be saved for, in the order the control shows them. */
const PROVIDER_OPTIONS: ReadonlyArray<{ value: Provider; label: string }> = [
  { value: 'groq', label: 'Groq' },
  { value: 'grok', label: 'xAI (Grok)' },
];

type StoreState =
  /** Reading the keystore. Rendered as shimmer in the shape of the text that is coming. */
  | 'reading'
  /** No keystore on this device, so there is nowhere for a key to live. */
  | 'no-storage'
  | 'configured'
  | 'absent';

/** What the panel is doing. Only one of these can be true at a time, hence one value. */
type Phase = 'idle' | 'checking' | 'saving' | 'removing';

interface ShapeProblem {
  message: string;
  /**
   * Whether to show it while the user is still typing.
   *
   * A key that starts with the wrong thing is wrong no matter how much more is typed, so
   * saying so immediately is help. A key that is merely *short* is what every key looks like
   * halfway through being typed, so that one waits for the field to lose focus.
   */
  immediate: boolean;
}

/**
 * Says which paste mistake was made, rather than that one was made.
 *
 * `looksLikeKey` returns a boolean, which is the right shape for a gate and the wrong shape
 * for a person: "that does not look like a key" leaves them re-reading the same string. Each
 * branch here names the thing that is actually in the field, in the vocabulary of the
 * provider they selected.
 */
function describeShapeProblem(draft: string, provider: Provider): ShapeProblem | null {
  const trimmed = draft.trim();
  if (trimmed.length === 0 || looksLikeKey(provider, trimmed)) return null;

  if (/\s/.test(trimmed)) {
    return {
      message:
        'This has spaces in it, which usually means a header or a whole command was copied along with the key. Paste only the key.',
      immediate: true,
    };
  }
  if (trimmed.length > KEY_INPUT_LIMIT) {
    return { message: 'This is far longer than a key. Paste only the key itself.', immediate: true };
  }
  if (provider === 'grok' && !trimmed.startsWith('xai-')) {
    return {
      message: 'An xAI key starts with "xai-". This looks like something else — an ID or the key\u2019s name.',
      immediate: true,
    };
  }
  if (provider === 'groq' && !trimmed.startsWith('gsk_')) {
    return {
      message: 'A Groq key starts with "gsk_". This looks like something else — an ID or the key\u2019s name.',
      immediate: true,
    };
  }
  const name = CHAT_PROVIDER_NAMES[provider];
  return { message: `This looks like only part of a key. Copy the whole value from the ${name} console.`, immediate: false };
}

type Verdict =
  /** The provider authenticated the key. Safe to store. */
  | 'accepted'
  /** The provider refused it. Never store this. */
  | 'rejected'
  /** The request never got an answer, so the key is neither confirmed nor disproved. */
  | 'unconfirmed';

interface KeyCheck {
  verdict: Verdict;
  message: string;
}

/**
 * Asks the provider whether it will accept this key.
 *
 * `GET {base}/models` with the key as a bearer token: the cheapest authenticated call the
 * provider offers, no tokens spent, no prompt, and none of the user's evidence leaves the
 * device to validate a credential. The reply body is not even read — any 2xx means the key
 * authenticated.
 *
 * Reading the outcome takes some care, because "the request failed" and "the key is bad" are
 * different answers and only one of them should stop a save:
 *
 * - 401/403 is the provider refusing the key. The one verdict that refuses to store.
 * - 429 proves the key authenticated: a provider answers an unauthenticated request with
 *   401 before it ever consults quota. A rate limit therefore means the key works.
 * - any other status, or a request that never completed, is a network condition, and
 *   refusing to save a well-formed key because the user is on a train would be the app
 *   being pedantic at their expense.
 */
async function probeProvider(provider: Provider, key: string, signal: AbortSignal): Promise<KeyCheck> {
  const name = CHAT_PROVIDER_NAMES[provider];
  // The caller's signal and the timeout are merged the way the chat transport merges them:
  // one abort, but the caller can tell afterwards which reason fired.
  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(), PROBE_TIMEOUT_MS);
  const onCallerAbort = () => timeoutController.abort();
  signal.addEventListener('abort', onCallerAbort);

  try {
    const response = await fetch(`${CHAT_PROVIDER_BASE_URLS[provider]}/models`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: timeoutController.signal,
    });

    if (response.status === 401 || response.status === 403) {
      return { verdict: 'rejected', message: `${name} did not accept this key.` };
    }
    if (response.status === 429) {
      return {
        verdict: 'accepted',
        message: `${name} accepted this key, but it is being rate limited right now. Suggestions are on; an analysis may need a second attempt.`,
      };
    }
    if (!response.ok) {
      return {
        verdict: 'unconfirmed',
        message: `${name} answered, but not with a yes or a no. Try again in a moment.`,
      };
    }
    return { verdict: 'accepted', message: `${name} accepted this key.` };
  } catch {
    return { verdict: 'unconfirmed', message: `Could not reach ${name} to check this key.` };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onCallerAbort);
  }
}

interface Feedback {
  tone: 'ok' | 'warn' | 'danger' | 'info';
  title: string;
  message: string;
}

/** The one-line state of the panel, for the provider currently selected. */
function statusLine(state: Exclude<StoreState, 'reading'>, provider: Provider): string {
  switch (state) {
    case 'configured':
      return 'On. A key is set up on this device, so AI can offer suggestions alongside what Ddetect reads for itself.';
    // Reads as a state, not a fault. A missing key is what a fresh install looks like, and the
    // app is fully usable in it — so this sentence leads with what does work.
    case 'absent':
      return `Off. Ddetect is reading your documents and comparing your claims without AI. Add a ${CHAT_PROVIDER_NAMES[provider]} key to get AI suggestions as well.`;
    case 'no-storage':
      return 'Off. This device has no secure storage, so a key cannot be kept here safely.';
  }
}

/** Whether a key is stored, per provider. `null` until the keystore has been read. */
type ConfiguredMap = { groq: boolean; grok: boolean } | null;

export function AIKeySection() {
  const theme = useTheme();
  const [provider, setProvider] = useState<Provider>('groq');
  const [storage, setStorage] = useState<'reading' | 'ok' | 'none'>('reading');
  const [configured, setConfigured] = useState<ConfiguredMap>(null);
  const [draft, setDraft] = useState('');
  const [revealed, setRevealed] = useState(false);
  /** True when the input is on screen. Always so with no key; opt-in when replacing one. */
  const [entering, setEntering] = useState(false);
  /** Set on blur, so "this looks short" waits until the user has finished typing. */
  const [visited, setVisited] = useState(false);
  const [phase, setPhase] = useState<Phase>('idle');
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  /**
   * The exact draft that the provider could not be reached about.
   *
   * Held so the "save without checking" button can only ever save the string that was
   * actually checked. It is cleared on every keystroke, so an edited draft cannot be saved
   * on the strength of a verdict about a different one.
   */
  const [unconfirmed, setUnconfirmed] = useState<string | null>(null);

  const checkRef = useRef<AbortController | null>(null);
  // The provider the panel is on *right now*. The keystore read below is async, so the
  // `provider` state it captured at mount is stale if the user has already switched
  // segments by the time it resolves; the ref is not.
  const providerRef = useRef<Provider>('groq');

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const available = await secureStorageAvailable();
      if (cancelled) return;
      if (!available) {
        setStorage('none');
        return;
      }
      // Each key becomes a boolean here and the string is dropped. See the file docblock:
      // nothing in this component ever holds it. This runs once, on mount; `providerRef`
      // holds the live selection, which the async read may be finishing behind.
      const present = {
        groq: (await loadKey('groq')) !== null,
        grok: (await loadKey('grok')) !== null,
      };
      if (cancelled) return;
      setConfigured(present);
      setStorage('ok');
      // A user whose only key is xAI should land on that key's panel, not on an open Groq
      // entry field, so the panel opens on the stored key's provider when the default has
      // none — unless the user has already picked a segment themselves, which the ref
      // knows and the `provider` captured here does not.
      const initial: Provider =
        providerRef.current === 'groq' && !present.groq && present.grok
          ? 'grok'
          : providerRef.current;
      providerRef.current = initial;
      if (initial !== 'groq') setProvider(initial);
      setEntering(!present[initial]);
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // A check in flight when the screen goes away is a request nobody is waiting for. Aborting
  // it also stops the resolved handler from touching state after unmount.
  useEffect(() => () => checkRef.current?.abort(), []);

  const store: StoreState =
    storage === 'reading'
      ? 'reading'
      : storage === 'none'
        ? 'no-storage'
        : configured === null
          ? 'reading'
          : configured[provider]
            ? 'configured'
            : 'absent';

  const problem = describeShapeProblem(draft, provider);
  const shapeOk = draft.trim().length > 0 && problem === null;
  const shapeError = problem && (problem.immediate || visited) ? problem.message : null;
  const providerName = CHAT_PROVIDER_NAMES[provider];

  const setConfiguredFor = useCallback((next: Provider, value: boolean) => {
    setConfigured((current) => {
      if (current === null) return current;
      return next === 'groq' ? { ...current, groq: value } : { ...current, grok: value };
    });
  }, []);

  const persist = useCallback(
    async (key: string, note: Feedback) => {
      setPhase('saving');
      try {
        await saveKey(provider, key);
        setConfiguredFor(provider, true);
        setDraft('');
        setRevealed(false);
        setEntering(false);
        setVisited(false);
        setUnconfirmed(null);
        setFeedback(note);
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      } catch (caught) {
        setFeedback({
          tone: 'danger',
          title: 'The key was not saved',
          // `saveKey` throws sentences of its own, but a keystore write can also surface a
          // native message this file does not control. Scrubbed either way.
          message: scrubKey(
            caught instanceof Error ? caught.message : 'This device would not accept the key into its keystore.',
            key,
          ),
        });
      } finally {
        setPhase('idle');
      }
    },
    [provider, setConfiguredFor],
  );

  const check = useCallback(async () => {
    const key = draft.trim();
    // The button is disabled without this, so reaching it means something changed underneath
    // the render. Refusing here is what makes the shape gate a gate rather than a hint.
    if (!looksLikeKey(provider, key)) return;

    checkRef.current?.abort();
    const controller = new AbortController();
    checkRef.current = controller;
    setPhase('checking');
    setFeedback(null);
    setUnconfirmed(null);

    const outcome = await probeProvider(provider, key, controller.signal).catch<KeyCheck>(() => ({
      verdict: 'unconfirmed',
      message: `Could not reach ${providerName} to check this key.`,
    }));

    // Cancelled, or the screen is gone. Either way the user is no longer looking at an answer
    // to this question, so leave the panel exactly as they left it.
    if (controller.signal.aborted) return;
    setPhase('idle');

    if (outcome.verdict === 'rejected') {
      setFeedback({ tone: 'danger', title: `${providerName} did not accept this key`, message: scrubKey(outcome.message, key) });
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
      return;
    }

    if (outcome.verdict === 'unconfirmed') {
      setUnconfirmed(key);
      setFeedback({
        tone: 'warn',
        title: `Could not check this key with ${providerName}`,
        message: `${scrubKey(outcome.message, key)} The key has the right shape, so you can save it now and it will be checked the first time an analysis runs.`,
      });
      return;
    }

    await persist(key, { tone: 'ok', title: 'AI suggestions are on', message: outcome.message });
  }, [draft, persist, provider, providerName]);

  const cancelCheck = useCallback(() => {
    checkRef.current?.abort();
    checkRef.current = null;
    setPhase('idle');
  }, []);

  /** Switching provider is switching subject: every pending answer belongs to the old one. */
  const switchProvider = useCallback(
    (next: Provider) => {
      if (next === provider) return;
      checkRef.current?.abort();
      checkRef.current = null;
      providerRef.current = next;
      setProvider(next);
      setDraft('');
      setRevealed(false);
      setVisited(false);
      setUnconfirmed(null);
      setFeedback(null);
      setPhase('idle');
      setEntering(configured === null || !configured[next]);
    },
    [configured, provider],
  );

  const remove = useCallback(() => {
    confirmDestructive({
      title: `Remove the ${providerName} key?`,
      message:
        'AI suggestions from this provider turn off. Reading your documents, comparing your claims and every finding already saved stay exactly as they are.',
      confirmLabel: 'Remove key',
      onConfirm: () => {
        void (async () => {
          setPhase('removing');
          setFeedback(null);
          // `clearKey` swallows a keystore failure on purpose: once it returns there is no
          // readable key either way, which is precisely what was asked for. So there is
          // nothing here to catch.
          await clearKey(provider);
          setConfiguredFor(provider, false);
          setDraft('');
          setEntering(true);
          setVisited(false);
          setUnconfirmed(null);
          setPhase('idle');
          setFeedback({
            tone: 'ok',
            title: 'The key has been removed',
            message: 'Nothing else changed. Ddetect keeps reading your documents and comparing your claims on this device.',
          });
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
        })();
      },
    });
  }, [provider, providerName, setConfiguredFor]);

  const openConsole = useCallback(() => {
    // `openURL` genuinely rejects — when nothing is registered for the scheme, and when the
    // user dismisses the system prompt — so a bare `void` here would be an unhandled
    // rejection. The fallback names the address so the trip is not wasted.
    const url = AI_PROVIDER_CONSOLE_URLS[provider];
    void Linking.openURL(url).catch(() => {
      setFeedback({
        tone: 'info',
        title: 'No browser opened',
        message: `Create a key at ${url.replace(/^https?:\/\//, '')}, then come back and paste it here.`,
      });
    });
  }, [provider]);

  const busy = phase !== 'idle';

  return (
    <Surface padding="lg" radius="lg" style={{ gap: theme.spacing.md }}>
      <Row between align="center" gap="md">
        <Text variant="title" style={{ flexShrink: 1 }}>
          AI suggestions
        </Text>
        {store === 'reading' ? (
          <Shimmer width={54} height={24} radius="pill" />
        ) : (
          <Chip
            label={store === 'configured' ? 'On' : 'Off'}
            tone={store === 'configured' ? 'ok' : 'neutral'}
            dot
          />
        )}
      </Row>

      {store === 'reading' ? (
        // Shaped like what is arriving — two lines of secondary text and a field — rather
        // than a spinner in the middle of a box, so the panel does not resize under the eye.
        <>
          <Shimmer height={theme.type.bodySmall.lineHeight} width="88%" />
          <Shimmer height={theme.type.bodySmall.lineHeight} width="62%" />
          <Shimmer height={FIELD_HEIGHT} radius="sm" />
        </>
      ) : (
        <>
          <Text variant="bodySmall" colorToken="textSecondary">
            {statusLine(store, provider)}
          </Text>

          <Divider />

          {/*
            The two sentences the client asked for, and the only place in the app that has to
            carry them: where the key lives, that it is not uploaded, and that the product
            works without it. Deliberately not phrased as a disclaimer — it is the reason the
            missing-key state is not a problem.

            Violet — `tone: 'ai'` — is not used anywhere in this panel, even though the panel
            is about AI. That colour means "this value came from a model", and spending it on
            a settings heading is how it stops meaning anything where it matters.
          */}
          <Text variant="bodySmall" colorToken="textSecondary">
            The key stays in this device&apos;s keystore and is never uploaded to us or copied anywhere
            else. Everything else works without it: reading your documents and comparing them happens
            on this device, and AI only ever adds suggestions you accept or reject.
          </Text>

          {feedback ? (
            <Notice
              tone={feedback.tone}
              title={feedback.title}
              message={feedback.message}
              onDismiss={() => setFeedback(null)}
            />
          ) : null}

          {unconfirmed ? (
            <Button
              label="Save without checking"
              variant="secondary"
              icon="content-save-outline"
              loading={phase === 'saving'}
              disabled={busy}
              accessibilityHint={`Stores the key on this device now. ${providerName} will check it the first time an analysis runs.`}
              onPress={() =>
                void persist(unconfirmed, {
                  tone: 'ok',
                  title: 'The key has been saved',
                  message: `It has not been checked with ${providerName} yet. The first analysis you run will tell you if it works.`,
                })
              }
            />
          ) : null}

          {store === 'no-storage' ? (
            <Notice
              tone="info"
              title="A key cannot be kept on this device"
              message="Secure storage is unavailable here, so there is nowhere safe to put one. Everything else in Ddetect works as normal."
            />
          ) : null}

          {store !== 'no-storage' ? (
            <View style={{ gap: theme.spacing.md }}>
              {/*
                Which provider the panel is managing. The chip and every sentence above track
                the selection, so "Off" under xAI with a Groq key installed is a true
                statement about suggestions, not a bug.
              */}
              <SegmentedControl value={provider} onChange={switchProvider} options={PROVIDER_OPTIONS} />
              {provider === 'grok' ? (
                <Text variant="caption" colorToken="textTertiary">
                  Recordings are transcribed with Groq, so an xAI key does not turn that on.
                </Text>
              ) : null}
            </View>
          ) : null}

          {store === 'configured' && !entering ? (
            <>
              <Text variant="caption" colorToken="textTertiary">
                The key is not shown here, in full or in part. To change it, paste a new one.
              </Text>
              <Row gap="sm" wrap>
                <Button
                  label="Replace key"
                  variant="secondary"
                  icon="key-variant"
                  disabled={busy}
                  onPress={() => {
                    setEntering(true);
                    setFeedback(null);
                    setVisited(false);
                  }}
                />
                <Button
                  label="Remove key"
                  variant="danger"
                  icon="trash-can-outline"
                  loading={phase === 'removing'}
                  disabled={busy}
                  onPress={remove}
                />
              </Row>
            </>
          ) : null}

          {entering && store !== 'no-storage' ? (
            <View style={{ gap: theme.spacing.md }}>
              <TextField
                label={`${providerName} API key`}
                value={draft}
                onChangeText={(text) => {
                  setDraft(text);
                  setUnconfirmed(null);
                  if (feedback) setFeedback(null);
                }}
                onBlur={() => setVisited(true)}
                // Hidden by default. A key is readable off a shoulder in a way a password is
                // not — it is long, it is unique, and it is worth memorising a fragment of.
                secureTextEntry={!revealed}
                // A key is an identifier, so it is set in mono: character shapes that cannot
                // be confused are the difference between finding a bad paste and not.
                mono
                autoCapitalize="none"
                autoCorrect={false}
                spellCheck={false}
                autoComplete="off"
                textContentType="password"
                maxLength={KEY_INPUT_LIMIT}
                editable={!busy}
                placeholder={provider === 'groq' ? 'gsk_\u2026' : 'xai-\u2026'}
                hint={`Paste the whole key. It is checked with ${providerName} before anything is stored, and stored only in this device's secure keychain — not in your account and not in the cloud.`}
                {...(shapeError ? { error: shapeError } : {})}
                trailing={
                  <IconButton
                    icon={revealed ? 'eye-off-outline' : 'eye-outline'}
                    accessibilityLabel={revealed ? 'Hide the key' : 'Show the key'}
                    onPress={() => setRevealed((current) => !current)}
                  />
                }
              />

              <Row gap="sm" wrap>
                <Button
                  label={phase === 'checking' ? `Checking with ${providerName}` : 'Check and turn on'}
                  icon="shield-check-outline"
                  loading={phase === 'checking' || phase === 'saving'}
                  disabled={!shapeOk || busy}
                  accessibilityHint={`Sends one small request to ${providerName} with this key, and saves it only if ${providerName} accepts it`}
                  onPress={() => void check()}
                />
                {phase === 'checking' ? (
                  <Button label="Stop" variant="ghost" onPress={cancelCheck} />
                ) : null}
                {store === 'configured' && phase === 'idle' ? (
                  <Button
                    label="Keep the current key"
                    variant="ghost"
                    onPress={() => {
                      setEntering(false);
                      setDraft('');
                      setRevealed(false);
                      setVisited(false);
                      setFeedback(null);
                    }}
                  />
                ) : null}
                <Button
                  label={`Get a key from ${providerName}`}
                  variant="ghost"
                  icon="open-in-new"
                  disabled={busy}
                  onPress={openConsole}
                />
              </Row>
            </View>
          ) : null}
        </>
      )}
    </Surface>
  );
}