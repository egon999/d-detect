import {
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
  useAudioRecorderState,
} from 'expo-audio';
import * as DocumentPicker from 'expo-document-picker';
import * as Haptics from 'expo-haptics';
import * as ImagePicker from 'expo-image-picker';
import { LinearGradient } from 'expo-linear-gradient';
import { useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, AppState, Linking, Platform, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ApiError, createRecord, isCancelled, readableError, type DaybookRecord } from '@api';
import {
  AUDIO_SIZE_LIMIT_BYTES,
  NOTE_LIMIT,
  RECORDING_HARD_LIMIT_MS,
  RECORD_TITLE_LIMIT,
  createUploadQueue,
  decideAccess,
  formatRecordingLength,
  recordingAdvice,
  runTracked,
  spokenRecordingLength,
  titleFromNote,
  tooLargeToSend,
  trackedCapture,
  trackedMeetingUpload,
  uploadBytes,
  type AccessNeed,
  type AccessStatus,
  type QueueItem,
  type QueueSnapshot,
  type UploadFile,
  type UploadProgress,
  type UploadQueue,
} from '@api/files';
import {
  AmbientBackdrop,
  AudioWaveformVisualizer,
  BORDER_WIDTH,
  BottomSheet,
  Button,
  Chip,
  GlassSurface,
  HIT_TARGET,
  Icon,
  IconButton,
  IconTile,
  IndeterminateBar,
  Notice,
  Pressable,
  ProgressBar,
  PulseDot,
  RADIUS,
  Row,
  SPACING,
  Stack,
  Text,
  TextField,
  useTheme,
  useToast,
  type IconName,
} from '@ui';

type Stage = 'choose' | 'note' | 'adding' | 'meeting';

type MeetingPhase = 'live' | 'paused' | 'review' | 'sending';

type Picked = { label: string; file: UploadFile };

type PendingAudio = { file: UploadFile; durationMs: number | null; fromRecorder: boolean };

type AccessPrompt = { icon: IconName; message: string; action: string; onAction: () => void };

const MEETING_RECORDING = { ...RecordingPresets.HIGH_QUALITY, isMeteringEnabled: true };

const RECORDER_POLL_MS = 60;

const MIN_RECORDING_MS = 1_000;

const TITLE_LIMIT = RECORD_TITLE_LIMIT;

const PHOTO_SELECTION_LIMIT = 20;

function audioExtensionFor(type: string): string {
  if (type.includes('mp4') || type.includes('m4a') || type.includes('aac')) return 'm4a';
  if (type.includes('ogg')) return 'ogg';
  return 'webm';
}

async function buildAudioUpload(uri: string): Promise<UploadFile> {
  if (Platform.OS === 'web') {
    const response = await fetch(uri);
    const blob = await response.blob();
    const type = blob.type || 'audio/webm';
    return new File([blob], `meeting.${audioExtensionFor(type)}`, { type });
  }
  return { uri, name: 'meeting.m4a', type: 'audio/m4a' };
}

function imageToPicked(asset: ImagePicker.ImagePickerAsset, index: number, fallbackLabel: string): Picked {
  const type = asset.mimeType ?? 'image/jpeg';
  const name = asset.fileName ?? `photo-${index + 1}.${type.includes('png') ? 'png' : 'jpg'}`;
  if (Platform.OS === 'web' && asset.file) {
    return { label: asset.file.name || fallbackLabel, file: asset.file };
  }

  return {
    label: asset.fileName ?? fallbackLabel,
    file: { uri: asset.uri, name, type, ...(asset.fileSize ? { size: asset.fileSize } : {}) },
  };
}

function documentToPicked(asset: DocumentPicker.DocumentPickerAsset): Picked {
  if (Platform.OS === 'web' && asset.file) return { label: asset.file.name || asset.name, file: asset.file };
  return {
    label: asset.name,
    file: {
      uri: asset.uri,
      name: asset.name,
      type: asset.mimeType ?? 'application/octet-stream',
      ...(asset.size ? { size: asset.size } : {}),
    },
  };
}

function meterLevel(metering: number | undefined): number | null {
  if (typeof metering !== 'number' || !Number.isFinite(metering)) return null;
  return Math.min(1, Math.max(0, (metering + 60) / 60));
}

export default function AddSomethingModal() {
  const theme = useTheme();
  const toast = useToast();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ mode?: string }>();
  const navigation = useNavigation<{ setOptions: (options: { gestureEnabled: boolean }) => void }>();

  const recorder = useAudioRecorder(MEETING_RECORDING);
  const recorderState = useAudioRecorderState(recorder, RECORDER_POLL_MS);

  const [stage, setStage] = useState<Stage>('choose');
  const [access, setAccess] = useState<AccessPrompt | null>(null);
  const [opening, setOpening] = useState<'camera' | 'photos' | 'files' | 'audio' | null>(null);
  const [documentSheetVisible, setDocumentSheetVisible] = useState(false);

  const [noteText, setNoteText] = useState('');
  const [savingNote, setSavingNote] = useState(false);
  const [noteError, setNoteError] = useState<string | null>(null);
  const [isDictating, setIsDictating] = useState(false);
  const dictationRef = useRef<any>(null);

  const [queue, setQueue] = useState<QueueSnapshot | null>(null);
  const queueRef = useRef<UploadQueue<Picked> | null>(null);
  const savedRef = useRef<DaybookRecord[]>([]);

  const [phase, setPhase] = useState<MeetingPhase>('live');
  const [pending, setPending] = useState<PendingAudio | null>(null);
  const [meetingTitle, setMeetingTitle] = useState('');
  const [sendProgress, setSendProgress] = useState<UploadProgress | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [interrupted, setInterrupted] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<'discard' | 'stopAdding' | null>(null);

  const cancelSend = useRef<(() => void) | null>(null);
  const finishing = useRef(false);
  const seenLive = useRef(false);
  const autoStarted = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const recordingAvailable = useMemo(() => {
    if (Platform.OS !== 'web') return true;
    const nav = (globalThis as { navigator?: { mediaDevices?: { getUserMedia?: unknown } } }).navigator;
    return typeof nav?.mediaDevices?.getUserMedia === 'function';
  }, []);

  const elapsedMs = recorderState.durationMillis;
  const level = meterLevel(recorderState.metering);
  const advice = phase === 'live' || phase === 'paused' ? recordingAdvice(elapsedMs) : null;

  const holdingSomething =
    (stage === 'meeting' && (phase !== 'review' || pending !== null)) ||
    (stage === 'adding' && queue !== null && !queue.finished);

  useEffect(() => {
    navigation.setOptions({ gestureEnabled: !holdingSomething });
  }, [navigation, holdingSomething]);

  useEffect(
    () => () => {
      queueRef.current?.stopAll();
      cancelSend.current?.();
      if (dictationRef.current) {
        try {
          dictationRef.current.stop();
        } catch {}
        dictationRef.current = null;
      }
      try {
        if (recorder.isRecording) void recorder.stop();
      } catch {

      }
      void setAudioModeAsync({ allowsRecording: false }).catch(() => {});
    },
    [recorder],
  );

  const askFor = useCallback(
    async (need: AccessNeed, ask: () => Promise<AccessStatus>, again: () => void): Promise<boolean> => {
      const decision = decideAccess(need, await ask());
      if (decision.kind === 'allowed') {
        setAccess(null);
        return true;
      }
      const icon: IconName =
        need === 'microphone' ? 'microphone-off' : need === 'camera' ? 'camera-off-outline' : 'image-off-outline';
      if (decision.kind === 'settings' && Platform.OS !== 'web') {
        setAccess({
          icon,
          message: decision.message,
          action: decision.action,
          onAction: () => void Linking.openSettings(),
        });
      } else if (decision.kind === 'settings') {

        setAccess({ icon, message: decision.message, action: '', onAction: () => {} });
      } else {
        setAccess({ icon, message: decision.message, action: decision.action, onAction: again });
      }
      return false;
    },
    [],
  );

  const landAfterQueue = useCallback(
    (final: QueueSnapshot) => {
      const saved = savedRef.current;
      const first = saved[0];
      if (saved.length === 1 && final.failed === 0 && final.stopped === 0 && first) {

        router.replace({ pathname: '/record/[id]', params: { id: first.id } });
        return;
      }
      if (saved.length > 0 && final.failed === 0) {
        toast.show({
          message: `${saved.length} saved. D-Detect is reading them now.`,
          tone: 'ok',
          icon: 'check-circle-outline',
        });
        router.replace('/(tabs)');
        return;
      }
      if (saved.length === 0 && final.failed === 0) {

        setQueue(null);
        setStage('choose');
      }

    },
    [router, toast],
  );

  const startQueue = useCallback(
    async (picked: Picked[]) => {
      if (picked.length === 0) return;
      savedRef.current = [];
      const instance = createUploadQueue<Picked, { record: DaybookRecord }>(
        picked.map((item, index) => ({
          id: `picked-${index}`,
          label: item.label,
          bytes: uploadBytes(item.file),
          payload: item,
        })),
        {
          send: async (payload, handle) => {
            const oversize = tooLargeToSend(uploadBytes(payload.file), 'save');
            if (oversize) throw new ApiError(413, oversize, null, null);
            return runTracked(trackedCapture(payload.file, handle.onProgress), handle.signal);
          },
          onChange: (snapshot) => {
            if (mounted.current) setQueue(snapshot);
          },
          onSaved: (result) => savedRef.current.push(result.record),

          describeError: (error) => readableError(error, 'That could not be saved. Please try again.'),
        },
      );
      queueRef.current = instance;
      setQueue(instance.snapshot());
      setStage('adding');

      const final = await instance.start();
      if (mounted.current) landAfterQueue(final);
    },
    [landAfterQueue],
  );

  const retryQueue = useCallback(async () => {
    const instance = queueRef.current;
    if (!instance) return;
    instance.retryFailed();
    const final = await instance.start();
    if (mounted.current) landAfterQueue(final);
  }, [landAfterQueue]);

  const takePhoto = useCallback(async () => {
    if (opening) return;
    setOpening('camera');
    try {
      const allowed = await askFor(
        'camera',
        () => ImagePicker.requestCameraPermissionsAsync(),
        () => void takePhoto(),
      );
      if (!allowed) return;
      const result = await ImagePicker.launchCameraAsync({ quality: 0.8 });
      if (result.canceled) return;
      const asset = result.assets[0];
      if (!asset) return;
      await startQueue([imageToPicked(asset, 0, 'Photo')]);
    } catch (error) {
      toast.show({ message: readableError(error, 'The camera could not be opened.'), tone: 'danger' });
    } finally {
      if (mounted.current) setOpening(null);
    }

  }, [askFor, opening, startQueue, toast]);

  const choosePhotos = useCallback(async () => {
    if (opening) return;
    setOpening('photos');
    try {
      const current = await ImagePicker.getMediaLibraryPermissionsAsync();
      if (!current.granted) {
        const allowed = await askFor(
          'photos',
          () => ImagePicker.requestMediaLibraryPermissionsAsync(),
          () => void choosePhotos(),
        );
        if (!allowed) return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: 'images',
        allowsMultipleSelection: true,
        selectionLimit: PHOTO_SELECTION_LIMIT,
        quality: 0.8,
      });
      if (result.canceled) return;
      await startQueue(result.assets.map((asset, index) => imageToPicked(asset, index, `Photo ${index + 1}`)));
    } catch (error) {
      toast.show({ message: readableError(error, 'Your photos could not be opened.'), tone: 'danger' });
    } finally {
      if (mounted.current) setOpening(null);
    }

  }, [askFor, opening, startQueue, toast]);

  const pickFiles = useCallback(async () => {
    if (opening) return;
    setOpening('files');
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: ['image/*', 'application/pdf'],
        multiple: true,
        base64: false,
        copyToCacheDirectory: true,
      });
      if (result.canceled) return;
      await startQueue(result.assets.map(documentToPicked));
    } catch (error) {
      toast.show({ message: readableError(error, 'That file could not be opened.'), tone: 'danger' });
    } finally {
      if (mounted.current) setOpening(null);
    }
  }, [opening, startQueue, toast]);

  const pickAudio = useCallback(async () => {
    if (opening) return;
    setOpening('audio');
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: ['audio/*'],
        multiple: false,
        copyToCacheDirectory: true,
      });
      if (result.canceled) return;
      const asset = result.assets[0];
      if (!asset) return;
      if (asset.size && asset.size > AUDIO_SIZE_LIMIT_BYTES) {
        toast.show({
          message: 'That audio recording is over 96 MB. Please choose an audio file under 96 MB.',
          tone: 'danger',
        });
        return;
      }
      const picked = documentToPicked(asset);
      setMeetingTitle('');
      setSendError(null);
      setInterrupted(null);
      setPending({ file: picked.file, durationMs: null, fromRecorder: false });
      setPhase('review');
      setStage('meeting');
    } catch (error) {
      toast.show({ message: readableError(error, 'That recording could not be opened.'), tone: 'danger' });
    } finally {
      if (mounted.current) setOpening(null);
    }
  }, [opening, toast]);

  const insertTimestamp = useCallback(() => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    const now = new Date();
    const stamp = `[${now.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })} ${now.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}] `;
    setNoteText((prev) => (prev ? `${prev.trim()}\n${stamp}` : stamp));
    toast.show({ message: 'Timestamp added.', tone: 'info' });
  }, [toast]);

  const enhanceNoteText = useCallback(() => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    setNoteText((prev) => {
      if (!prev.trim()) return prev;
      let cleaned = prev
        .replace(/[ \t]+/g, ' ')
        .replace(/\s*([,.:;?!])\s*/g, '$1 ')
        .replace(/\s*\n\s*/g, '\n')
        .trim();
      cleaned = cleaned.replace(/(^\s*|[.!?]\s+)([a-z])/g, (_, p1, p2) => p1 + p2.toUpperCase());
      if (cleaned.length > 0 && !/[.!?]$/.test(cleaned)) {
        cleaned += '.';
      }
      return cleaned;
    });
    toast.show({ message: 'Text enhanced and formatted cleanly.', tone: 'ok' });
  }, [toast]);

  const toggleNoteDictation = useCallback(async () => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    if (isDictating) {
      setIsDictating(false);
      if (dictationRef.current) {
        try {
          dictationRef.current.stop();
        } catch {}
        dictationRef.current = null;
      }
      return;
    }

    const nav = typeof window !== typeof undefined ? (window as any) : null;
    const SpeechClass = nav?.SpeechRecognition || nav?.webkitSpeechRecognition;
    if (SpeechClass) {
      const rec = new SpeechClass();
      rec.continuous = false;
      rec.interimResults = false;
      rec.lang = 'en-US';
      rec.onresult = (event: any) => {
        const spoken = event.results?.[0]?.[0]?.transcript;
        if (spoken) {
          setNoteText((prev) => (prev ? `${prev.trim()} ${spoken.trim()}` : spoken.trim()));
          void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
        }
        setIsDictating(false);
      };
      rec.onerror = () => setIsDictating(false);
      rec.onend = () => setIsDictating(false);
      dictationRef.current = rec;
      rec.start();
      setIsDictating(true);
      return;
    }

    toast.show({
      message: 'Dictate using the microphone on your keyboard.',
      tone: 'info',
    });
  }, [isDictating, toast]);

  const saveNote = useCallback(async () => {
    const text = noteText.trim();
    if (!text || savingNote) return;
    setSavingNote(true);
    setNoteError(null);
    try {
      const { record } = await createRecord({ title: titleFromNote(text), kind: 'note', note: text });
      router.replace({ pathname: '/record/[id]', params: { id: record.id } });
    } catch (error) {
      if (!mounted.current) return;
      setSavingNote(false);
      setNoteError(readableError(error, 'That could not be saved. Please try again.'));
    }
  }, [noteText, router, savingNote]);

  const startRecording = useCallback(async () => {
    if (stage === 'meeting') return;
    if (!recordingAvailable) {
      toast.show({
        message: 'This browser will not let D-Detect listen. Record on your phone instead.',
        tone: 'warn',
      });
      return;
    }
    const allowed = await askFor('microphone', requestRecordingPermissionsAsync, () => void startRecording());
    if (!allowed) return;
    try {
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true }).catch(() => {});
      await recorder.prepareToRecordAsync();
      recorder.record();
      finishing.current = false;
      seenLive.current = false;
      setPending(null);
      setMeetingTitle('');
      setSendError(null);
      setInterrupted(null);
      setPhase('live');
      setStage('meeting');
    } catch (error) {
      toast.show({
        message: readableError(error, 'The recording would not start. Please try again.'),
        tone: 'danger',
      });
    }
  }, [askFor, recorder, recordingAvailable, stage, toast]);

  const finishRecording = useCallback(
    async (reason: 'person' | 'limit' | 'interrupted') => {
      if (finishing.current) return;
      finishing.current = true;
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
      const durationMs = Math.max(recorderState.durationMillis, Math.round(recorder.currentTime * 1000));
      try {
        await recorder.stop();
      } catch {

      }
      void setAudioModeAsync({ allowsRecording: false }).catch(() => {});
      const uri = recorder.uri;
      if (!mounted.current) return;

      if (!uri || durationMs < MIN_RECORDING_MS) {
        setPhase('review');
        setPending(null);
        setStage('choose');
        toast.show({ message: 'That was too short to save anything.', tone: 'warn' });
        return;
      }
      try {
        const file = await buildAudioUpload(uri);
        if (!mounted.current) return;
        setPending({ file, durationMs, fromRecorder: true });
        setPhase('review');
        if (reason === 'limit') {
          setInterrupted('That is as long as one recording can be. D-Detect kept every minute of it.');
        }
      } catch (error) {
        if (!mounted.current) return;
        setPhase('review');
        setPending(null);
        setSendError(readableError(error, 'The recording could not be read back off this phone.'));
      }
    },
    [meetingTitle, recorder, recorderState.durationMillis, toast],
  );

  const pauseRecording = useCallback(() => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    try {
      recorder.pause();
      setPhase('paused');
    } catch {
      toast.show({ message: 'This recording cannot be paused. Stop it to keep what you have.', tone: 'warn' });
    }
  }, [recorder, toast]);

  const resumeRecording = useCallback(() => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    try {
      recorder.record();

      seenLive.current = false;
      setInterrupted(null);
      setPhase('live');
    } catch (error) {
      toast.show({
        message: readableError(error, 'The recording would not start again. Stop it to keep what you have.'),
        tone: 'warn',
      });
    }
  }, [recorder, toast]);

  const discardRecording = useCallback(async () => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    setConfirm(null);
    finishing.current = true;

    cancelSend.current?.();
    cancelSend.current = null;
    try {
      if (recorder.isRecording) await recorder.stop();
    } catch {

    }
    void setAudioModeAsync({ allowsRecording: false }).catch(() => {});
    if (!mounted.current) return;
    setPending(null);
    setMeetingTitle('');
    setSendError(null);
    setInterrupted(null);
    setPhase('review');
    setStage('choose');
  }, [recorder]);

  const sendMeeting = useCallback(async () => {
    const item = pending;
    if (!item) return;
    const oversize = tooLargeToSend(uploadBytes(item.file), 'audio');
    if (oversize) {
      setSendError(oversize);
      return;
    }
    const userTitle = meetingTitle.trim();
    setSendError(null);
    setSendProgress(null);
    setPhase('sending');
    const upload = trackedMeetingUpload(
      item.file,
      {
        ...(userTitle ? { title: userTitle.slice(0, TITLE_LIMIT) } : {}),
        ...(item.durationMs ? { durationMs: item.durationMs } : {}),
      },
      (progress) => {
        if (mounted.current) setSendProgress(progress);
      },
    );
    cancelSend.current = upload.cancel;
    try {
      const { meeting } = await upload.result;
      cancelSend.current = null;
      router.replace({ pathname: '/meeting/[id]', params: { id: meeting.id } });
    } catch (error) {
      cancelSend.current = null;
      if (!mounted.current) return;
      setSendProgress(null);
      setPhase('review');

      if (isCancelled(error)) return;
      setSendError(
        readableError(error, 'That could not be sent. Your recording is still here — try again.'),
      );
    }
  }, [meetingTitle, pending, router]);

  useEffect(() => {
    if (autoStarted.current) return;
    if (params.mode === 'meeting') {
      autoStarted.current = true;
      void startRecording();
    } else if (params.mode === 'audio') {
      autoStarted.current = true;
      void pickAudio();
    }

  }, [params.mode]);

  useEffect(() => {
    if (stage !== 'meeting') return;
    if (recorderState.isRecording) {
      seenLive.current = true;
      return;
    }
    if (phase !== 'live' || !seenLive.current || finishing.current) return;
    setInterrupted('Something else took over the microphone. D-Detect kept everything up to that point.');
    void finishRecording('interrupted');
  }, [finishRecording, phase, recorderState.isRecording, stage]);

  useEffect(() => {
    if (stage !== 'meeting' || phase !== 'live') return;
    if (elapsedMs < RECORDING_HARD_LIMIT_MS) return;
    void finishRecording('limit');
  }, [elapsedMs, finishRecording, phase, stage]);

  useEffect(() => {
    if (stage !== 'meeting' || phase !== 'live') return;
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active') return;
      try {
        recorder.pause();
      } catch {
        return;
      }
      setPhase('paused');
      setInterrupted('Your recording paused when you left D-Detect. Nothing was lost.');
    });
    return () => subscription.remove();
  }, [phase, recorder, stage]);

  const stopAdding = useCallback(() => {
    setConfirm(null);

    queueRef.current?.stopAll();
    if (savedRef.current.length > 0) {
      router.replace('/(tabs)');
      return;
    }
    setQueue(null);
    setStage('choose');
  }, [router]);

  const close = useCallback(() => {
    if (dictationRef.current) {
      try {
        dictationRef.current.stop();
      } catch {}
      dictationRef.current = null;
      setIsDictating(false);
    }
    if (stage === 'meeting' && (phase === 'live' || phase === 'paused' || pending !== null)) {
      setConfirm('discard');
      return;
    }
    if (stage === 'adding') {
      if (queue && !queue.finished) {
        setConfirm('stopAdding');
        return;
      }
      stopAdding();
      return;
    }
    if (stage !== 'choose') {
      setStage('choose');
      return;
    }
    router.back();
  }, [pending, phase, queue, router, stage, stopAdding]);

  const heading =
    stage === 'meeting'
      ? phase === 'review'
        ? 'Name this meeting'
        : phase === 'sending'
          ? 'Saving your meeting'
          : 'Recording'
      : stage === 'note'
        ? 'Write it down'
        : stage === 'adding'
          ? 'Saving'
          : 'What do you want to save?';

  const ownRecording = phase === 'live' || phase === 'paused' || pending?.fromRecorder === true;

  return (
    <View
      style={[
        styles.fill,
        { backgroundColor: theme.colors.canvas, paddingTop: insets.top + theme.spacing.sm },
      ]}
    >
      <AmbientBackdrop />
      <View style={[styles.grabber, { backgroundColor: theme.colors.borderStrong }]} />

      <Row between align="center" style={[styles.header, { paddingHorizontal: theme.layout.screenPadding }]}>
        <Text variant="heading" style={styles.flex}>
          {heading}
        </Text>
        <IconButton
          icon="close"
          accessibilityLabel={stage === 'note' ? 'Go back' : 'Close'}
          onPress={close}
          filled
        />
      </Row>

      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: theme.layout.screenPadding,
          paddingBottom: insets.bottom + theme.spacing.giant,
          gap: theme.spacing.lg,
        }}
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
        showsVerticalScrollIndicator={false}
      >
        {access ? (
          <Stack gap="sm">
            <Notice tone="warn" icon={access.icon} message={access.message} onDismiss={() => setAccess(null)} />
            {access.action ? (
              <Button
                label={access.action}
                variant="secondary"
                size="sm"
                icon={access.action === 'Open settings' ? 'cog-outline' : 'refresh'}
                onPress={access.onAction}
                fullWidth
              />
            ) : null}
          </Stack>
        ) : null}

        {stage === 'choose' ? (
          <ChoosePaths
            onNote={() => {
              setNoteError(null);
              setStage('note');
            }}
            onRecord={() => void startRecording()}
            onAudioFile={() => void pickAudio()}
            onOpenDocuments={() => setDocumentSheetVisible(true)}
            opening={opening}
            recordingAvailable={recordingAvailable}
          />
        ) : null}

        {stage === 'note' ? (
          <Stack gap="lg">
            <GlassSurface padding="xl">
              <Stack gap="md">
                <TextField
                  label="What happened?"
                  value={noteText}
                  onChangeText={(next) => {
                    setNoteText(next);
                    if (noteError) setNoteError(null);
                  }}
                  placeholder="Paid the plumber in cash. He said he would come back on Friday."
                  multiline
                  minHeight={NOTE_FIELD_HEIGHT}
                  maxLength={NOTE_LIMIT}
                  autoFocus
                  editable={!savingNote}
                  hint="Your first line becomes its name, so you can find it later."
                  accessibilityLabel="What happened"
                  {...(noteError ? { error: noteError } : {})}
                />
                <Row gap="xs" style={{ flexWrap: 'wrap' }}>
                  <Button
                    label={isDictating ? 'Listening...' : 'Voice typing'}
                    icon={isDictating ? 'microphone' : 'microphone-outline'}
                    variant={isDictating ? 'danger' : 'secondary'}
                    size="sm"
                    onPress={() => void toggleNoteDictation()}
                    accessibilityHint={isDictating ? 'Stop listening' : 'Start voice typing'}
                  />
                  <Button
                    label="Timestamp"
                    icon="clock-outline"
                    variant="secondary"
                    size="sm"
                    onPress={insertTimestamp}
                    accessibilityHint="Insert current date and time"
                  />
                  <Button
                    label="Enhance text"
                    icon="format-text"
                    variant="secondary"
                    size="sm"
                    disabled={!noteText.trim()}
                    onPress={enhanceNoteText}
                    accessibilityHint="Clean up casing and punctuation"
                  />
                </Row>
                <Button
                  label="Save this"
                  variant="primary"
                  icon="check"
                  loading={savingNote}
                  disabled={noteText.trim().length === 0 || savingNote}
                  onPress={() => void saveNote()}
                  fullWidth
                />
              </Stack>
            </GlassSurface>
            <Text variant="caption" colorToken="textTertiary" center>
              Saved with today’s date, in your own words.
            </Text>
          </Stack>
        ) : null}

        {stage === 'adding' && queue ? (
          <AddingList
            snapshot={queue}
            onStop={(id) => queueRef.current?.stop(id)}
            onRetry={() => void retryQueue()}
            onDone={() => {
              if (savedRef.current.length > 0) router.replace('/(tabs)');
              else {
                setQueue(null);
                setStage('choose');
              }
            }}
          />
        ) : null}

        {stage === 'meeting' ? (
          <Stack gap="lg">
            {interrupted ? (
              <Notice
                tone="info"
                icon="information-outline"
                message={interrupted}
                onDismiss={() => setInterrupted(null)}
              />
            ) : null}

            {phase === 'live' || phase === 'paused' ? (
              <RecordingPanel
                elapsedMs={elapsedMs}
                level={level}
                paused={phase === 'paused'}
                canPause={Platform.OS !== 'web'}
                advice={advice}
                onPause={pauseRecording}
                onResume={resumeRecording}
                onStop={() => void finishRecording('person')}
                onDiscard={() => setConfirm('discard')}
                title={meetingTitle}
                onTitleChange={setMeetingTitle}
              />
            ) : null}

            {phase === 'review' && pending ? (
              <ReviewPanel
                durationMs={pending.durationMs}
                fromRecorder={pending.fromRecorder}
                title={meetingTitle}
                onTitleChange={setMeetingTitle}
                error={sendError}
                onSend={() => void sendMeeting()}
                onDiscard={() => setConfirm('discard')}
              />
            ) : null}

            {phase === 'sending' ? (
              <SendingPanel
                progress={sendProgress}
                onCancel={() => {
                  cancelSend.current?.();
                  cancelSend.current = null;
                }}
              />
            ) : null}
          </Stack>
        ) : null}
      </ScrollView>

      <BottomSheet
        visible={confirm !== null}
        onDismiss={() => setConfirm(null)}
        header={
          <View style={{ paddingHorizontal: theme.layout.screenPadding, paddingBottom: theme.spacing.md }}>
            <Text variant="subheading">
              {confirm !== 'discard'
                ? 'Stop saving?'
                : ownRecording
                  ? 'Throw this recording away?'
                  : 'Leave this recording out?'}
            </Text>
          </View>
        }
      >
        <Stack
          gap="md"
          style={{
            paddingHorizontal: theme.layout.screenPadding,
            paddingBottom: theme.spacing.md,
          }}
        >
          <Text variant="bodySmall" colorToken="textSecondary">
            {confirm !== 'discard'
              ? 'Anything already saved stays. Whatever has not gone up yet will be left out.'
              : ownRecording
                ? 'This recording only exists here. There is no way to get it back afterwards.'
                : 'The file stays where it is on your phone. It just will not be saved to D-Detect.'}
          </Text>
          <Button
            label={confirm !== 'discard' ? 'Stop' : ownRecording ? 'Throw it away' : 'Leave it out'}
            variant="danger"
            icon={confirm === 'discard' ? 'trash-can-outline' : 'stop'}
            onPress={() => {
              if (confirm === 'discard') void discardRecording();
              else stopAdding();
            }}
            fullWidth
          />
          <Button
            label={confirm === 'discard' ? 'Keep it' : 'Keep going'}
            variant="ghost"
            onPress={() => setConfirm(null)}
            fullWidth
          />
        </Stack>
      </BottomSheet>

      <BottomSheet
        visible={documentSheetVisible}
        onDismiss={() => setDocumentSheetVisible(false)}
        header={
          <View style={{ paddingHorizontal: theme.layout.screenPadding, paddingBottom: theme.spacing.md }}>
            <Text variant="subheading">Scan or upload documents</Text>
          </View>
        }
      >
        <Stack
          gap="sm"
          style={{
            paddingHorizontal: theme.layout.screenPadding,
            paddingBottom: theme.spacing.lg,
          }}
        >
          {Platform.OS !== 'web' ? (
            <PathRow
              icon="camera-outline"
              title="Take a photo"
              hint="A bill, a receipt, a letter, or a parcel label."
              onPress={() => {
                setDocumentSheetVisible(false);
                void takePhoto();
              }}
              busy={opening === 'camera'}
              disabled={opening !== null}
            />
          ) : null}
          <PathRow
            icon="image-multiple-outline"
            title="Choose from your photos"
            hint="Pick several images from your gallery at once."
            onPress={() => {
              setDocumentSheetVisible(false);
              void choosePhotos();
            }}
            busy={opening === 'photos'}
            disabled={opening !== null}
          />
          <PathRow
            icon="file-document-outline"
            title="Pick a document or PDF"
            hint="A PDF or file saved on this phone."
            onPress={() => {
              setDocumentSheetVisible(false);
              void pickFiles();
            }}
            busy={opening === 'files'}
            disabled={opening !== null}
          />
          <Button
            label="Cancel"
            variant="ghost"
            onPress={() => setDocumentSheetVisible(false)}
            fullWidth
          />
        </Stack>
      </BottomSheet>
    </View>
  );
}

interface ChoosePathsProps {
  onNote: () => void;
  onRecord: () => void;
  onAudioFile: () => void;
  onOpenDocuments: () => void;
  opening: 'camera' | 'photos' | 'files' | 'audio' | null;
  recordingAvailable: boolean;
}

function ChoosePaths({
  onNote,
  onRecord,
  onAudioFile,
  onOpenDocuments,
  opening,
  recordingAvailable,
}: ChoosePathsProps) {
  const busy = opening !== null;
  return (
    <Stack gap="lg">
      <Stack gap="sm">
        <Text variant="overline" colorToken="textTertiary" uppercase>
          Meeting intelligence
        </Text>
        <PathTile
          icon="microphone"
          title="Record a meeting"
          hint={
            recordingAvailable
              ? 'Capture high-fidelity audio with automated transcripts, executive summaries, key decisions, and action items.'
              : 'Microphone access is unavailable in this environment. Record directly on mobile or import an existing audio file.'
          }
          tone="accent"
          glow
          onPress={onRecord}
          busy={false}
          disabled={busy || !recordingAvailable}
        />
        <PathRow
          icon="file-music-outline"
          title="Import an existing recording (Max 96 MB)"
          hint="Select an audio recording saved on this device."
          onPress={onAudioFile}
          busy={opening === 'audio'}
          disabled={busy}
        />
      </Stack>

      <Stack gap="sm">
        <Text variant="overline" colorToken="textTertiary" uppercase>
          Evidence & documentation
        </Text>
        <PathTile
          icon="file-document-outline"
          title="Scan or upload documents"
          hint="Capture physical documents with your camera, pick gallery images, or upload verified PDF files."
          tone="accent"
          onPress={onOpenDocuments}
          busy={opening === 'camera' || opening === 'photos' || opening === 'files'}
          disabled={busy}
        />

        <PathTile
          icon="note-text-outline"
          title="Create written record"
          hint="Record structured timestamped notes with voice typing and text formatting tools."
          tone="info"
          onPress={onNote}
          busy={false}
          disabled={busy}
        />
      </Stack>
    </Stack>
  );
}

interface PathProps {
  icon: IconName;
  title: string;
  hint: string;
  tone?: 'accent' | 'info' | 'danger';
  glow?: boolean;
  onPress: () => void;
  busy: boolean;
  disabled: boolean;
}

function PathTile({ icon, title, hint, tone = 'accent', glow = false, onPress, busy, disabled }: PathProps) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      haptic
      style={{ borderRadius: theme.radius.xl }}
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityHint={hint}
      accessibilityState={{ disabled, busy }}
    >
      <View
        style={[
          styles.pathTileCard,
          {
            borderRadius: theme.radius.xl,
            backgroundColor: theme.colors.surface,
            borderColor: glow ? theme.colors.accent : theme.colors.border,
            borderWidth: glow ? 1.5 : 1,
            shadowColor: glow ? theme.colors.accent : 'transparent',
            shadowOffset: { width: 0, height: 2 },
            shadowOpacity: glow ? 0.3 : 0,
            shadowRadius: 10,
            elevation: glow ? 4 : 0,
            padding: theme.spacing.xl,
          },
        ]}
      >
        <LinearGradient
          colors={
            glow
              ? ['rgba(37, 99, 235, 0.14)', 'rgba(30, 58, 138, 0.04)', 'transparent']
              : ['rgba(255, 255, 255, 0.03)', 'transparent']
          }
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={[StyleSheet.absoluteFillObject, { borderRadius: theme.radius.xl }]}
          pointerEvents="none"
        />
        <Row gap="lg" align="center" style={styles.pathRow}>
          <IconTile icon={icon} tone={tone} size="lg" />
          <Stack gap="xxs" style={styles.flex}>
            <Text variant="subheading">{title}</Text>
            <Text variant="bodySmall" colorToken="textSecondary">
              {hint}
            </Text>
          </Stack>
          <Icon
            name={busy ? 'dots-horizontal' : 'chevron-right'}
            size={22}
            color={theme.colors.textTertiary}
            disabled={disabled}
          />
        </Row>
      </View>
    </Pressable>
  );
}

function PathRow({ icon, title, hint, onPress, busy, disabled }: PathProps) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      dimOnPress
      pressScale={1}
      style={{ borderRadius: theme.radius.md }}
      contentStyle={[
        styles.pathRow,
        {
          flexDirection: 'row',
          alignItems: 'center',
          gap: theme.spacing.lg,
          paddingVertical: theme.spacing.md,
        },
      ]}
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityHint={hint}
      accessibilityState={{ disabled, busy }}
    >
      <IconTile icon={icon} tone="neutral" size="md" />
      <Stack gap="xxs" style={styles.flex}>
        <Text variant="bodyMedium">{title}</Text>
        <Text variant="caption" colorToken="textTertiary">
          {hint}
        </Text>
      </Stack>
      <Icon
        name={busy ? 'dots-horizontal' : 'chevron-right'}
        size={20}
        color={theme.colors.textTertiary}
        disabled={disabled}
      />
    </Pressable>
  );
}

interface AddingListProps {
  snapshot: QueueSnapshot;
  onStop: (id: string) => void;
  onRetry: () => void;
  onDone: () => void;
}

function AddingList({ snapshot, onStop, onRetry, onDone }: AddingListProps) {
  const visible = snapshot.items.filter((item) => item.state !== 'stopped');
  const total = visible.length;
  const failed = snapshot.failed;
  return (
    <Stack gap="lg">
      <GlassSurface padding="lg">
        <Stack gap="md">
          {visible.map((item) => (
            <AddingRow key={item.id} item={item} onStop={() => onStop(item.id)} />
          ))}
        </Stack>
      </GlassSurface>

      <Row between align="center">
        <Text variant="caption" colorToken="textSecondary">
          {snapshot.finished
            ? failed > 0
              ? `${snapshot.saved} of ${total} saved.`
              : 'All saved. D-Detect is reading them now.'
            : `${snapshot.saved} of ${total} saved so far.`}
        </Text>
      </Row>

      {snapshot.finished ? (
        <Stack gap="md">
          {failed > 0 ? (
            <Button label="Try those again" variant="primary" icon="refresh" onPress={onRetry} fullWidth />
          ) : null}
          <Button
            label={failed > 0 ? 'Leave them out' : 'Done'}
            variant={failed > 0 ? 'ghost' : 'primary'}
            onPress={onDone}
            fullWidth
          />
        </Stack>
      ) : null}
    </Stack>
  );
}

function AddingRow({ item, onStop }: { item: QueueItem; onStop: () => void }) {
  const theme = useTheme();
  const sending = item.state === 'sending';
  const saved = item.state === 'saved';
  const failed = item.state === 'failed';

  return (
    <Stack gap="sm">
      <Row gap="md" align="center">
        <Icon
          name={saved ? 'check-circle-outline' : failed ? 'alert-circle-outline' : 'file-document-outline'}
          size={18}
          color={saved ? theme.tone('ok').fg : failed ? theme.tone('danger').fg : theme.colors.textTertiary}
        />
        <Text variant="bodySmall" numberOfLines={1} style={styles.flex}>
          {item.label}
        </Text>
        {sending ? (
          <IconButton
            icon="close"
            accessibilityLabel={`Stop saving ${item.label}`}
            tone="neutral"
            onPress={onStop}
          />
        ) : saved ? (
          <Chip label="Saved" tone="ok" icon="check" />
        ) : failed ? null : (
          <Text variant="caption" colorToken="textTertiary">
            Waiting
          </Text>
        )}
      </Row>

      {}
      {sending && item.fraction !== null ? (
        <ProgressBar value={item.fraction} tone="accent" accessibilityLabel={`Saving ${item.label}`} />
      ) : sending ? (
        <IndeterminateBar tone="accent" accessibilityLabel={`Saving ${item.label}`} />
      ) : (
        <ProgressBar
          value={saved ? 1 : 0}
          tone={saved ? 'ok' : failed ? 'danger' : 'neutral'}
          accessibilityLabel={saved ? `${item.label} saved` : item.label}
        />
      )}

      {failed && item.error ? (
        <Text variant="caption" tone="danger">
          {item.error}
        </Text>
      ) : null}
    </Stack>
  );
}

interface RecordingPanelProps {
  elapsedMs: number;
  level: number | null;
  paused: boolean;
  canPause: boolean;
  advice: { level: 'long' | 'limit'; message: string } | null;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
  onDiscard: () => void;
  title: string;
  onTitleChange: (next: string) => void;
}

const RecordingPanel = memo(function RecordingPanel({
  elapsedMs,
  level,
  paused,
  canPause,
  advice,
  onPause,
  onResume,
  onStop,
  onDiscard,
  title,
  onTitleChange,
}: RecordingPanelProps) {
  const theme = useTheme();
  const danger = theme.tone('danger');
  const warn = theme.tone('warn');

  return (
    <Stack gap="xl" align="center">
      {}
      <View
        style={[
          styles.recordingHeroCard,
          {
            borderColor: paused ? warn.border : danger.border,
            backgroundColor: theme.colors.surface,
          },
        ]}
      >
        <Stack gap="md" align="center" style={styles.full}>
          {}
          <Row gap="xs" align="center">
            {paused ? (
              <Chip label="PAUSED" tone="warn" icon="pause" />
            ) : (
              <View style={styles.recBadge}>
                <Row gap="xs" align="center">
                  <PulseDot color={danger.solid} size={9} active />
                  <Text variant="caption" tone="danger" style={{ fontWeight: '700', letterSpacing: 1.2 }}>
                    REC · LIVE
                  </Text>
                </Row>
              </View>
            )}
          </Row>

          {}
          <Text
            variant="display"
            mono
            accessibilityRole="timer"
            accessibilityLabel={`${paused ? 'Paused at' : 'Recording'} ${spokenRecordingLength(elapsedMs)}`}
            style={styles.recordingClock}
          >
            {formatRecordingLength(elapsedMs)}
          </Text>

          {}
          <View style={styles.visualizerCapsule}>
            <AudioWaveformVisualizer
              isActive={!paused}
              metering={level ?? undefined}
              barCount={22}
              maxHeight={52}
              tone={paused ? 'accent' : 'danger'}
            />
          </View>

          {}
          <Row gap="xs" align="center" justify="center">
            <Icon
              name={paused ? 'pause-circle-outline' : level !== null && level > 0.2 ? 'microphone' : 'microphone-outline'}
              size={14}
              color={theme.colors.textTertiary}
            />
            <Text variant="caption" colorToken="textTertiary">
              {paused
                ? 'Audio capture suspended'
                : level !== null && level > 0.2
                  ? 'Capturing clear audio'
                  : 'Microphone active · Ready for speech'}
            </Text>
          </Row>
        </Stack>
      </View>

      <Text
        variant="bodySmall"
        colorToken="textSecondary"
        center
        accessibilityLiveRegion="polite"
      >
        {paused
          ? 'Recording paused. Tap carry on when your conversation continues.'
          : 'Recording live conversation. D-Detect will automatically generate summary, decisions, and action items when you finish.'}
      </Text>

      {advice ? (
        <Notice
          tone={advice.level === 'limit' ? 'warn' : 'info'}
          icon="clock-outline"
          message={advice.message}
          style={styles.full}
        />
      ) : null}

      <Stack gap="md" style={styles.full}>
        <TextField
          label="Meeting subject (optional)"
          value={title}
          onChangeText={onTitleChange}
          placeholder="e.g. Project Alignment with Client"
          maxLength={TITLE_LIMIT}
          icon="pencil-outline"
          hint="You can also adjust the title and details after recording."
          accessibilityLabel="What this meeting is about"
        />
        <Button
          label="Stop and save recording"
          icon="stop"
          variant="primary"
          size="lg"
          onPress={onStop}
          fullWidth
          accessibilityHint="Ends the recording and generates executive summary, decisions, and tasks"
        />
        {canPause ? (
          <Button
            label={paused ? 'Carry on recording' : 'Pause'}
            icon={paused ? 'play' : 'pause'}
            variant="secondary"
            onPress={paused ? onResume : onPause}
            fullWidth
          />
        ) : null}
        <Button label="Discard recording" variant="ghost" onPress={onDiscard} fullWidth />
      </Stack>
    </Stack>
  );
});

interface ReviewPanelProps {
  durationMs: number | null;
  fromRecorder: boolean;
  title: string;
  onTitleChange: (next: string) => void;
  error: string | null;
  onSend: () => void;
  onDiscard: () => void;
}

function ReviewPanel({
  durationMs,
  fromRecorder,
  title,
  onTitleChange,
  error,
  onSend,
  onDiscard,
}: ReviewPanelProps) {
  const theme = useTheme();
  return (
    <Stack gap="lg">
      <GlassSurface variant="hero" padding="xl" radius="xl">
        <Stack gap="lg">
          <Row gap="lg" align="center">
            <IconTile icon="waveform" tone="ok" size="lg" />
            <Stack gap="xxs" style={styles.flex}>
              <Text variant="subheading">{fromRecorder ? 'Recording kept' : 'Recording ready'}</Text>
              {durationMs !== null ? (
                <Text variant="bodySmall" colorToken="textSecondary">
                  {formatRecordingLength(durationMs)} long, here on your phone.
                </Text>
              ) : (
                <Text variant="bodySmall" colorToken="textSecondary">
                  Ready to send whenever you are.
                </Text>
              )}
            </Stack>
          </Row>

          <TextField
            label="What was it about?"
            value={title}
            onChangeText={onTitleChange}
            placeholder="Leave blank to auto-generate title, or name it here"
            maxLength={TITLE_LIMIT}
            icon="pencil-outline"
            autoFocus={title.length === 0}
            hint="Optional. Leave blank to automatically generate a title from what was discussed."
            accessibilityLabel="What this meeting was about"
          />
        </Stack>
      </GlassSurface>

      {error ? <Notice tone="danger" icon="alert-circle-outline" message={error} /> : null}

      <Stack gap="md">
        <Button
          label="Save this meeting"
          icon="check"
          variant="primary"
          size="lg"
          onPress={onSend}
          fullWidth
          accessibilityHint="Sends the recording so D-Detect can write down what was said"
        />
        <Button
          label={fromRecorder ? 'Throw it away' : 'Leave it out'}
          variant="ghost"
          onPress={onDiscard}
          fullWidth
        />
      </Stack>

      <Text variant="caption" colorToken="textTertiary" center style={{ paddingTop: theme.spacing.xxs }}>
        D-Detect listens to it after it arrives, and writes back what was discussed, what was
        decided and what to do — in the language you spoke.
      </Text>
    </Stack>
  );
}

function SendingPanel({ progress, onCancel }: { progress: UploadProgress | null; onCancel: () => void }) {
  const fraction = progress?.fraction ?? null;
  return (
    <Stack gap="lg">
      <GlassSurface padding="xl" radius="xl">
        <Stack gap="lg">
          <Row gap="lg" align="center">
            <IconTile icon="waveform" tone="accent" size="lg" />
            <Stack gap="xxs" style={styles.flex}>
              <Text variant="subheading">Sending your recording</Text>
              <Text variant="bodySmall" colorToken="textSecondary">
                Keep D-Detect open until this finishes. A long meeting on a slow connection takes
                a few minutes.
              </Text>
            </Stack>
          </Row>

          {}
          {fraction !== null ? (
            <ProgressBar value={fraction} tone="accent" size="lg" accessibilityLabel="Sending your recording" />
          ) : (
            <IndeterminateBar tone="accent" size="md" accessibilityLabel="Sending your recording" />
          )}
        </Stack>
      </GlassSurface>

      <Button
        label="Stop sending"
        variant="ghost"
        onPress={onCancel}
        fullWidth
        accessibilityHint="Stops sending. The recording stays on your phone so you can try again."
      />
    </Stack>
  );
}

const MIC_CIRCLE = SPACING.colossal + SPACING.huge; 
const MIC_GLYPH = SPACING.huge;
const METER_MAX = SPACING.giant;
const NOTE_FIELD_HEIGHT = SPACING.colossal * 2;
const GRABBER_WIDTH = SPACING.huge;

const styles = StyleSheet.create({
  fill: { flex: 1 },
  flex: { flex: 1 },
  full: { width: '100%' },
  grabber: {
    alignSelf: 'center',
    width: GRABBER_WIDTH,
    height: SPACING.xs,
    borderRadius: RADIUS.pill,
    marginBottom: SPACING.sm,
  },
  header: { paddingBottom: SPACING.md, gap: SPACING.md },

  pathRow: { minHeight: HIT_TARGET },
  pathTileCard: {
    overflow: 'hidden',
    position: 'relative',
  },
  recordingHeroCard: {
    width: '100%',
    padding: SPACING.xl,
    borderRadius: RADIUS.xl,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  recBadge: {
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.xxs,
    borderRadius: RADIUS.pill,
    backgroundColor: 'rgba(239, 68, 68, 0.12)',
    borderWidth: 1,
    borderColor: 'rgba(239, 68, 68, 0.3)',
  },
  recordingClock: {
    fontSize: 40,
    fontWeight: '700',
    letterSpacing: 2,
    marginVertical: SPACING.xs,
  },
  visualizerCapsule: {
    width: '100%',
    paddingVertical: SPACING.md,
    paddingHorizontal: SPACING.lg,
    borderRadius: RADIUS.lg,
    backgroundColor: 'rgba(0, 0, 0, 0.25)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.06)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  micCircle: {
    width: MIC_CIRCLE,
    height: MIC_CIRCLE,
    borderRadius: MIC_CIRCLE / 2,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: BORDER_WIDTH.hairline,
    marginTop: SPACING.lg,
  },
  meter: { height: METER_MAX, alignItems: 'center' },
});
