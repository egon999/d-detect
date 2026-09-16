/**
 * A voice-memo recorder: capture a statement in the app and hand it to the upload queue.
 *
 * ## Why the app records at all
 *
 * Most evidence arrives as a file — a screenshot, a PDF, a bank statement. A statement does
 * not. Asking someone to open a separate voice-recorder app, find the file it wrote and pick
 * it out of a share sheet loses the recording often enough that the statement simply never
 * gets made. Recording in place puts a spoken account beside the documents that support it,
 * and once it is in the queue it goes through the same transcription path as any other audio
 * file, which is what makes it citable rather than just stored.
 *
 * ## What this component does not do
 *
 * It does not upload, save or transcribe anything. It produces a `RecordedMemo` — a
 * `PickedFile` with a duration — and hands it to `onRecorded`. Everything after that is the
 * upload screen's, exactly as if the file had come out of the document picker. That boundary
 * is deliberate: the recorder should be droppable into any screen that already knows how to
 * accept a picked file, and it should not acquire an opinion about persistence.
 *
 * It also does not play the recording back. Reviewing a take before keeping it would need a
 * player, a scrub bar and a waveform, and none of that exists yet in this app; offering
 * "record again" is the honest version of a review step until it does.
 *
 * ## Permission
 *
 * No permission API is called on mount — not the request, and not the status read either. The
 * rationale sits on screen in the idle state, before anything can prompt, so the OS dialog is
 * never the first time the person hears why an evidence tool wants their microphone. The
 * request happens inside the start handler and nowhere else.
 *
 * ## File ownership
 *
 * Every recording writes a real file into the cache directory, and exactly one party is
 * responsible for deleting it at any moment. `ownedUri` holds it while this component is
 * responsible; the ref is cleared the instant `onRecorded` is called, because after that the
 * queue holds the file and deleting it on unmount would destroy an upload in progress. A take
 * that is discarded, re-recorded, abandoned or left behind by unmounting is deleted here.
 */

import {
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
  useAudioRecorderState,
  type RecordingOptions,
} from 'expo-audio';
import { File } from 'expo-file-system';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Linking, StyleSheet } from 'react-native';

import { fileSize } from '@services/ingestion/read-file';
import type { PickedFile } from '@services/ingestion/types';
import { Button, Icon, Notice, PulseDot, Row, Stack, Surface, Text, useTheme } from '@ui';

import {
  formatElapsedClock,
  memoExtension,
  memoFileName,
  memoMimeType,
} from './media-recorder-format';

/**
 * Recording settings.
 *
 * `HIGH_QUALITY` and not `LOW_QUALITY`, and the reason is not fidelity. On Android the low
 * preset writes `.3gp` with the AMR narrowband encoder, which is not one of the containers
 * Groq Whisper accepts — `whisperAcceptsExtension` in `@services/ingestion/transcribe` refuses
 * it outright — so a memo recorded that way could never be transcribed, and a statement that
 * cannot be transcribed cannot be cited. The high preset writes `.m4a`/AAC on both platforms.
 *
 * Mono at 64 kbps overrides the preset's stereo 128 kbps. This is one voice in a room: the
 * second channel records the same signal twice, and the extra bit rate is spent on fidelity a
 * speech model does not use. It halves the file: an hour of statement is about 29 MB rather
 * than 58 MB, which matters because both the transcription API and this app's own upload check
 * refuse anything over 100 MB, and a two-hour interview at the preset's settings would be
 * turned away after the person had already given it.
 */
const RECORDING_OPTIONS: RecordingOptions = {
  ...RecordingPresets.HIGH_QUALITY,
  numberOfChannels: 1,
  bitRate: 64_000,
};

/**
 * How often the elapsed time is re-read from the recorder.
 *
 * The clock displays whole seconds, so polling at one second would let the visible digit lag
 * the truth by up to a second and make the timer look stuck at the moment a person is watching
 * it hardest. A quarter of a second keeps the tick honest at a quarter of the cost of animating
 * it, and it is also the resolution at which the duration cap below is enforced.
 */
const TIMER_INTERVAL_MS = 250;

/**
 * Default ceiling on one recording: one hour.
 *
 * At these settings an hour is roughly 29 MB, comfortably inside the 100 MB limit that both the
 * transcription API and the upload screen impose — so a recording that runs to the cap is still
 * a recording that can be used, which is the property the number was chosen for. The real risk
 * is a recording nobody stopped: without a ceiling a phone left face-down grows a file past the
 * point where any of this pipeline will accept it, and the person finds out afterwards.
 */
export const DEFAULT_MAX_DURATION_MS = 60 * 60 * 1000;

/**
 * Where the recorder is. Not derived from the native recorder's own `isRecording`, because the
 * states that need distinguishing are mostly ones the native recorder cannot see: waiting on a
 * permission dialog, holding a finished take for review, blocked by a denial.
 */
type RecorderPhase =
  | 'idle'
  /** The OS permission dialog is up. */
  | 'requesting'
  /** Permission is in hand; the audio session and encoder are being set up. */
  | 'preparing'
  | 'recording'
  /** `stop()` has been called and the file is being measured. */
  | 'stopping'
  /** A take is finished and waiting to be kept or dropped. */
  | 'recorded'
  /** Microphone access was refused. */
  | 'blocked'
  | 'failed';

/**
 * Fixed sentences. Written out here rather than assembled at the call site so that every
 * failure states what happened, whether anything was saved, and what to do next — and so that
 * no platform error string can reach the screen. Those read like
 * `AVAudioSessionErrorCodeCannotStartRecording`: precise for a developer, useless to the person
 * holding the phone, and a poor thing to meet after speaking for ten minutes.
 */
const MESSAGES = {
  rationale:
    'Recording a statement needs access to the microphone. The audio stays on this device unless you choose to transcribe it, and nothing is recorded until you tap Start.',
  blockedRetry:
    'Microphone access was declined, so nothing was recorded. Tap Start recording to be asked again.',
  blockedPermanent:
    'Microphone access is turned off for this app, so nothing was recorded. You can turn it on in Settings and come back.',
  startFailed:
    'The recording could not be started. Check that no other app is holding the microphone, then try again.',
  stopFailed:
    'The recording could not be closed properly and has not been kept. Nothing was saved. Please record it again.',
  interrupted:
    'The system took the microphone — usually an incoming call or another app starting to record. Nothing was saved.',
  empty:
    'The recording finished but the file is empty, so there is nothing to keep. This usually means the microphone was never actually opened. Please try again.',
} as const;

/** A finished recording, in the shape the upload flow already accepts. */
export interface RecordedMemo extends PickedFile {
  /**
   * Length of the recording in milliseconds, as the recorder reported it while running.
   *
   * Carried alongside the file because nothing downstream can cheaply find it out: the
   * ingestion layer only learns a duration once Whisper has transcribed the audio and returned
   * one, which is a network round trip away.
   */
  durationMs: number;
}

export interface MediaRecorderProps {
  /**
   * Called once with a finished recording the person chose to keep.
   *
   * Takes ownership of the file at `memo.uri`: this component stops tracking it and will not
   * delete it, so the receiver is responsible for it from that moment on.
   */
  onRecorded: (memo: RecordedMemo) => void;
  /**
   * Called when the person backs out without keeping anything. Any recording in progress is
   * stopped and its file deleted before this fires. Omit it to render no way out — appropriate
   * when the recorder is a section of a screen rather than a sheet of its own.
   */
  onCancel?: () => void;
  /** True while the surrounding screen is writing. Every control locks; a recording is not interrupted. */
  busy?: boolean;
  /** Hard ceiling on one take. Defaults to `DEFAULT_MAX_DURATION_MS`. */
  maxDurationMs?: number;
}

/** The platform's own words, for the log only. Never rendered. */
function describeError(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}

/**
 * Deletes a cache file, or does nothing if it cannot.
 *
 * Module-level so the unmount effect below closes over nothing but refs and can therefore
 * declare an honestly empty dependency list. A failed delete is swallowed: the cache directory
 * is the OS's to reclaim, and there is nothing the person could do with the information.
 */
function deleteQuietly(uri: string | null): void {
  if (uri === null) return;
  try {
    new File(uri).delete();
  } catch {
    // Already gone, or never written. Either way the goal is met.
  }
}

export function MediaRecorder({
  onRecorded,
  onCancel,
  busy = false,
  maxDurationMs = DEFAULT_MAX_DURATION_MS,
}: MediaRecorderProps) {
  const theme = useTheme();
  const recorder = useAudioRecorder(RECORDING_OPTIONS);
  const state = useAudioRecorderState(recorder, TIMER_INTERVAL_MS);

  const [phase, setPhase] = useState<RecorderPhase>('idle');
  const [memo, setMemo] = useState<RecordedMemo | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [granted, setGranted] = useState(false);
  const [canAskAgain, setCanAskAgain] = useState(true);

  /** The file this component is still responsible for deleting. See the docblock. */
  const ownedUri = useRef<string | null>(null);
  /**
   * Last elapsed time seen while the recorder was actually running.
   *
   * Kept because the duration has to be read *before* `stop()`, and the polled state is a
   * quarter-second behind. `recorder.currentTime` is the live figure and is preferred; this is
   * the floor under it for the case where the native read comes back as zero.
   */
  const observedMs = useRef(0);
  const recorderRef = useRef(recorder);

  useEffect(() => {
    recorderRef.current = recorder;
  }, [recorder]);

  useEffect(() => {
    if (state.isRecording) observedMs.current = state.durationMillis;
  }, [state.isRecording, state.durationMillis]);

  // Leaving the screen mid-recording must not leave the encoder running or the file behind.
  // Deps are empty and that is correct rather than convenient: the body reads only refs and
  // module-level functions, so there is nothing here that could go stale.
  useEffect(() => {
    return () => {
      const sweep = async () => {
        try {
          if (recorderRef.current.isRecording) await recorderRef.current.stop();
        } catch {
          // `useAudioRecorder` releases the native object on unmount too, and the order of the
          // two cleanups is not specified. A throw here means it got there first, which is the
          // outcome this was trying to produce.
        }
        deleteQuietly(ownedUri.current);
        ownedUri.current = null;
        try {
          await setAudioModeAsync({ allowsRecording: false });
        } catch {
          // Restoring the session is a courtesy to whatever plays audio next. Not worth
          // reporting from a component that no longer exists.
        }
      };
      void sweep();
    };
  }, []);

  /** Stops anything running, deletes the file, and shows `message` if there is one to show. */
  const abandon = useCallback(
    async (message: string | null) => {
      try {
        if (recorder.isRecording) await recorder.stop();
      } catch {
        // Nothing is being kept, so a failed stop changes nothing about the outcome.
      }
      deleteQuietly(ownedUri.current);
      ownedUri.current = null;
      observedMs.current = 0;
      setMemo(null);
      setProblem(message);
      setPhase(message === null ? 'idle' : 'failed');
      try {
        await setAudioModeAsync({ allowsRecording: false });
      } catch {
        // As above.
      }
    },
    [recorder],
  );

  const start = useCallback(async () => {
    setProblem(null);
    setMemo(null);
    observedMs.current = 0;

    if (!granted) {
      setPhase('requesting');
      try {
        const response = await requestRecordingPermissionsAsync();
        if (!response.granted) {
          setCanAskAgain(response.canAskAgain);
          setPhase('blocked');
          return;
        }
        setGranted(true);
      } catch (caught) {
        console.warn('[recorder] permission request failed:', describeError(caught));
        setProblem(MESSAGES.startFailed);
        setPhase('failed');
        return;
      }
    }

    setPhase('preparing');
    try {
      // iOS will not open the microphone until its audio session is put into a category that
      // allows recording, and it fails by producing a silent zero-length file rather than by
      // throwing — which is exactly the failure that is impossible to diagnose from a bug
      // report. `playsInSilentMode` covers the same session for the playback this screen may
      // grow later. Android ignores both flags.
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await recorder.prepareToRecordAsync();
      recorder.record();
      // Claimed as soon as the encoder has a path, not after `stop()`. A recording interrupted
      // by the person leaving the screen has still written a file, and this ref is the only
      // record of where it is.
      ownedUri.current = recorder.uri;
      setPhase('recording');
    } catch (caught) {
      console.warn('[recorder] could not start recording:', describeError(caught));
      deleteQuietly(ownedUri.current);
      ownedUri.current = null;
      setProblem(MESSAGES.startFailed);
      setPhase('failed');
    }
  }, [granted, recorder]);

  const finish = useCallback(async () => {
    setPhase('stopping');

    // Read before `stop()`. `currentTime` documents itself as the current length of the
    // recording, which says nothing about what it holds once the recorder has been stopped.
    const live = recorder.currentTime * 1000;
    const durationMs =
      Number.isFinite(live) && live > 0 ? Math.round(live) : observedMs.current;

    let uri: string | null;
    try {
      await recorder.stop();
      uri = recorder.uri ?? ownedUri.current;
    } catch (caught) {
      console.warn('[recorder] stop failed:', describeError(caught));
      deleteQuietly(ownedUri.current);
      ownedUri.current = null;
      setProblem(MESSAGES.stopFailed);
      setPhase('failed');
      return;
    }

    if (uri === null) {
      setProblem(MESSAGES.empty);
      setPhase('failed');
      return;
    }
    ownedUri.current = uri;

    const size = await fileSize(uri);
    if (size === null || size === 0) {
      // A zero-byte file is the signature of a session that never really opened the
      // microphone — permission revoked mid-recording, or another app holding it. Passing it
      // on would put a row in the queue that can never be read and would fail again later,
      // further from the cause.
      deleteQuietly(uri);
      ownedUri.current = null;
      setProblem(MESSAGES.empty);
      setPhase('failed');
      return;
    }

    const extension = memoExtension(uri);
    setMemo({
      uri,
      name: memoFileName(new Date(), extension),
      mimeType: memoMimeType(extension),
      size,
      durationMs,
    });
    setPhase('recorded');

    try {
      await setAudioModeAsync({ allowsRecording: false });
    } catch {
      // The take is already safe on disk; the session category is cosmetic from here.
    }
  }, [recorder]);

  // The ceiling is enforced from here rather than with `record({ forDuration })`. The native
  // option is the more reliable of the two if the JS thread is ever starved, but it stops the
  // recorder outside `finish` — the one function that measures the file and produces the memo —
  // so the component would have to notice after the fact and both paths could fire on the same
  // take. One finish path, at the cost of overrunning the cap by up to a poll interval.
  useEffect(() => {
    if (phase !== 'recording') return;
    if (state.mediaServicesDidReset) {
      void abandon(MESSAGES.interrupted);
      return;
    }
    if (state.durationMillis >= maxDurationMs) void finish();
  }, [
    phase,
    state.mediaServicesDidReset,
    state.durationMillis,
    maxDurationMs,
    abandon,
    finish,
  ]);

  const keep = useCallback(() => {
    if (memo === null) return;
    // Ownership transfers here. Clearing the ref before the callback is what stops the unmount
    // sweep from deleting a file the queue has already accepted — if the caller unmounts this
    // component in response to `onRecorded`, that cleanup runs immediately.
    ownedUri.current = null;
    observedMs.current = 0;
    setMemo(null);
    setPhase('idle');
    onRecorded(memo);
  }, [memo, onRecorded]);

  const cancel = useCallback(async () => {
    await abandon(null);
    onCancel?.();
  }, [abandon, onCancel]);

  const openSettings = useCallback(() => {
    // Best effort. `openSettings` rejects on a platform that has no per-app settings page, and
    // there is nothing useful to say about that beyond what the notice already says.
    void Linking.openSettings().catch(() => undefined);
  }, []);

  const recording = phase === 'recording';
  const working = phase === 'requesting' || phase === 'preparing' || phase === 'stopping';
  const locked = busy || working;
  const elapsedMs = recording ? state.durationMillis : (memo?.durationMs ?? 0);
  const clock = formatElapsedClock(elapsedMs);

  return (
    <Surface elevation="low" style={styles.card}>
      <Stack gap="lg">
        <Row between>
          <Row gap="sm">
            {recording ? (
              <PulseDot color={theme.colors.tones.danger.solid} size={9} />
            ) : (
              <Icon name="microphone-outline" size={16} color={theme.colors.textSecondary} />
            )}
            <Text variant="subheading">{recording ? 'Recording' : 'Voice statement'}</Text>
          </Row>
          {/* One label rather than a live region: a polite region on a clock makes a screen
              reader read every tick and drown out everything else on the screen. The label is
              read when focus lands on it, which is when it is wanted. */}
          <Text
            variant="monoValue"
            tone={recording ? 'danger' : 'neutral'}
            accessibilityLabel={`${clock} elapsed`}
          >
            {clock}
          </Text>
        </Row>

        {phase === 'idle' && !granted ? (
          <Notice tone="info" icon="microphone-outline" message={MESSAGES.rationale} />
        ) : null}

        {phase === 'blocked' ? (
          <Notice
            tone="warn"
            icon="microphone-off"
            message={canAskAgain ? MESSAGES.blockedRetry : MESSAGES.blockedPermanent}
          />
        ) : null}

        {problem !== null ? <Notice tone="danger" message={problem} /> : null}

        {phase === 'recorded' && memo !== null ? (
          <Notice
            tone="ok"
            icon="check"
            message={`Recorded ${clock}. Keep it to add it to this case, or record it again — a discarded take is deleted from the device.`}
          />
        ) : null}

        <Row gap="md" wrap>
          {recording ? (
            <>
              <Button
                label="Stop"
                icon="stop"
                variant="primary"
                onPress={() => void finish()}
                disabled={busy}
              />
              <Button
                label="Discard"
                variant="ghost"
                onPress={() => void abandon(null)}
                disabled={busy}
                accessibilityHint="Stops recording and deletes this take"
              />
            </>
          ) : phase === 'recorded' ? (
            <>
              <Button label="Keep recording" icon="check" onPress={keep} disabled={locked} />
              <Button
                label="Record again"
                icon="refresh"
                variant="secondary"
                onPress={() => void abandon(null)}
                disabled={locked}
                accessibilityHint="Deletes this take and starts over"
              />
            </>
          ) : phase === 'blocked' && !canAskAgain ? (
            <Button
              label="Open Settings"
              icon="cog-outline"
              variant="secondary"
              onPress={openSettings}
              disabled={locked}
            />
          ) : (
            <Button
              label={phase === 'failed' || phase === 'blocked' ? 'Try again' : 'Start recording'}
              icon="record"
              onPress={() => void start()}
              loading={working}
              disabled={locked}
            />
          )}

          {onCancel !== undefined && !recording ? (
            <Button label="Cancel" variant="ghost" onPress={() => void cancel()} disabled={locked} />
          ) : null}
        </Row>
      </Stack>
    </Surface>
  );
}

const styles = StyleSheet.create({
  card: { padding: 14, borderRadius: 14 },
});
