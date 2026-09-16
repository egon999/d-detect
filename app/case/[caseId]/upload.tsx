import React, { useEffect, useRef, useState } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { createNote, failEvidenceUpload, queueEvidence, recordEvidenceFile } from '@data/mutations';
import { newId } from '@domain/ids';
import type { EvidenceKind } from '@domain/enums';
import { MediaRecorder, type RecordedMemo } from '@features/evidence/media-recorder';
import { findDuplicate, type DuplicateMatch } from '@features/evidence/upload-queue';
import { uploadEvidenceFile, requestCaseAnalysis, requestEvidenceProcessing, useRepository, useSession } from '@services';
import { MAX_EVIDENCE_UPLOAD_BYTES } from '@services/storage/evidence-storage';
import { useWorkspace, useCaseRecord, mutationContext } from '@services/use-case-store';
import {
  Button,
  ErrorState,
  IndeterminateBar,
  LAYOUT,
  Notice,
  ProgressBar,
  Row,
  ScreenScroll,
  SPACING,
  Surface,
  Text,
  TextField,
  TYPE,
  errorDetail,
  formatBytes,
  readableError,
} from '@ui';

/**
 * Where a picked file is in its life on this screen.
 *
 * `extracted` and `review` are the two finished outcomes of on-device processing: the
 * contents were read, or they genuinely could not be and the reason is shown. `failed`
 * means the file never made it to the stored state — nothing was saved for it unless the
 * entry itself already existed (see `saved`), which the error line says plainly.
 */
type Item = {
  id: string; uri: string; name: string; mimeType: string; size: number | null; title: string;
  saved: boolean; uploaded: boolean; progress: number | null; sha256: string | null; duplicate: DuplicateMatch | null;
  status: 'waiting' | 'uploading' | 'processing' | 'extracted' | 'review' | 'failed'; error?: string;
};
function kindFor(file: Item): EvidenceKind {
  const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
  if (file.mimeType.startsWith('image/') || /^(png|jpe?g|webp|heic|gif)$/.test(extension)) return 'IMAGE';
  if (extension === 'pdf') return 'PDF';
  if (file.mimeType.startsWith('audio/')) return 'AUDIO';
  if (file.mimeType.startsWith('video/')) return 'VIDEO';
  if (/^(mp3|wav|m4a|ogg|flac)$/.test(extension)) return 'AUDIO';
  if (/^(mp4|mov|webm|mkv)$/.test(extension)) return 'VIDEO';
  if (/^(docx|doc|odt|rtf)$/.test(extension)) return 'DOCUMENT';
  if (/^(csv|tsv|xlsx|xls)$/.test(extension)) return 'SPREADSHEET';
  if (extension === 'eml') return 'EMAIL';
  if (file.mimeType.startsWith('text/') || /^(txt|md|json|log)$/.test(extension)) return 'TEXT';
  return 'OTHER';
}

const nativeDevice = Platform.OS !== 'web';

function itemFrom(source: { uri: string; name: string; mimeType?: string | null; size: number | null }): Item {
  const oversize = source.size !== null && source.size > MAX_EVIDENCE_UPLOAD_BYTES;
  return {
    id: newId('evd'), uri: source.uri, name: source.name, mimeType: source.mimeType || 'application/octet-stream', size: source.size,
    title: source.name.replace(/\.[^.]+$/, '').slice(0, 200), saved: false, uploaded: false, progress: null,
    sha256: null, duplicate: null,
    status: oversize ? 'failed' : 'waiting',
    ...(oversize ? { error: 'This file is larger than 100 MB. Split it into smaller files and add those.' } : {}),
  };
}

export default function EvidenceUploadScreen() {
  const { caseId } = useLocalSearchParams<{ caseId: string }>();
  const router = useRouter();
  const { user } = useSession();
  const { repository } = useRepository();
  const { workspace, loading, refreshing, error: loadError, reload } = useWorkspace(user?.id ?? null, caseId);
  const record = useCaseRecord(workspace, caseId);
  const [items, setItems] = useState<Item[]>([]);
  const [sourceLabel, setSourceLabel] = useState('');
  const [capturedAt, setCapturedAt] = useState('');
  const [noteTitle, setNoteTitle] = useState('');
  const [noteText, setNoteText] = useState('');
  const [busy, setBusy] = useState(false);
  const [analysing, setAnalysing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The raw text behind `error`, kept for the disclosure rather than put in the sentence. */
  const [errorDetailText, setErrorDetailText] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [recorderOpen, setRecorderOpen] = useState(false);
  const active = useRef<AbortController | null>(null);
  const lock = useRef(false);
  useEffect(() => () => active.current?.abort(), []);
  const patch = (id: string, value: Partial<Item>) => setItems((all) => all.map((item) => item.id === id ? { ...item, ...value } : item));

  /**
   * Records — or clears — the one thing that just went wrong.
   *
   * Every failure on this screen used to be shown as `caught.message`: a picker throwing
   * `E_DOCUMENT_PICKER_CANCELED`, a storage layer throwing a quota code, a commit throwing
   * a rule path. Those are strings written for a log. `readableError` keeps the sentence a
   * person can act on and passes the raw text to the disclosure instead, where it is
   * reachable for a support message and out of the way otherwise.
   *
   * Called with `null` to clear, with a string for a failure this screen worded itself
   * (a declined camera permission is not an exception), or with the caught value and the
   * sentence to fall back on.
   */
  function fail(caught: unknown, fallback?: string) {
    if (caught === null) {
      setError(null);
      setErrorDetailText(null);
      return;
    }
    if (typeof caught === 'string' && fallback === undefined) {
      setError(caught);
      setErrorDetailText(null);
      return;
    }
    setError(readableError(caught, fallback ?? 'That could not be completed.'));
    setErrorDetailText(errorDetail(caught) ?? null);
  }

  async function pick(photos = false) {
    fail(null);
    try {
      const result = photos
        ? await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images', 'videos'], allowsMultipleSelection: true, quality: 1 })
        : await DocumentPicker.getDocumentAsync({ type: '*/*', multiple: true, copyToCacheDirectory: true });
      if (result.canceled) return;
      const added: Item[] = result.assets.map((asset) => {
        const document = asset as DocumentPicker.DocumentPickerAsset;
        const photo = asset as ImagePicker.ImagePickerAsset;
        return itemFrom({ uri: asset.uri, name: document.name || photo.fileName || `evidence-${Date.now()}`,
          mimeType: asset.mimeType, size: document.size ?? photo.fileSize ?? null });
      });
      setItems((all) => [...all, ...added]);
    } catch (caught) { fail(caught, 'The file picker could not be opened. Nothing was added.'); }
  }

  async function takePhoto() {
    fail(null);
    try {
      const permission = await ImagePicker.requestCameraPermissionsAsync();
      if (!permission.granted) {
        fail(permission.canAskAgain
          ? 'Camera access was declined, so no photo was taken. Tap Take photo to be asked again.'
          : 'Camera access is turned off for this app, so no photo was taken. You can turn it on in device settings and try again.');
        return;
      }
      const result = await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 1 });
      if (result.canceled) return;
      const added = result.assets.map((asset) => itemFrom({ uri: asset.uri,
        name: asset.fileName || `photo-${Date.now()}.${asset.mimeType?.split('/')[1] ?? 'jpg'}`,
        mimeType: asset.mimeType, size: asset.fileSize ?? null }));
      setItems((all) => [...all, ...added]);
    } catch (caught) { fail(caught, 'The camera could not be opened. No photo was taken.'); }
  }

  function keepMemo(memo: RecordedMemo) {
    setItems((all) => [...all, itemFrom(memo)]);
  }

  /**
   * Saves selected files: record → store (hash) → record the stored file → read it.
   *
   * One file at a time, awaited, on purpose. Recognition is the expensive step and ten
   * of them started at once would contend for memory and finish later than ten run in
   * sequence (see `upload-queue.ts` for the argument); the per-file status line below
   * names the step that is running, so waiting looks like progress rather than a hang.
   * The whole flow works identically signed in or not — the store is on this device
   * either way, which is the only place an original needs to be for it to be read here.
   *
   * `only` runs a single item, which is what the per-file Retry button passes. Retrying one
   * failed file used to mean pressing "Save selected sources", which re-ran *every* waiting
   * and failed item in the queue — so a user whose ninth file failed had to sit through the
   * other eight being reprocessed to get at it.
   */
  async function upload(only?: string) {
    if (lock.current || !user || !record) return;
    lock.current = true; setBusy(true); fail(null); setNotice(null);
    let processed = 0;
    let unreadable = 0;
    let incomplete = 0;
    // Whether the user pressed Stop. Read after the loop, where `active.current` has
    // already been cleared and the controller is out of scope.
    let stopped = false;
    try {
      let current = workspace;
      const storedInBatch: Array<{ sha256: string; title: string }> = [];
      const queue = items.filter((entry) =>
        only === undefined
          ? entry.status === 'waiting' || entry.status === 'failed'
          : entry.id === only);
      for (const item of queue) {
        if (item.size !== null && item.size > MAX_EVIDENCE_UPLOAD_BYTES) continue;
        const controller = new AbortController(); active.current = controller;
        const context = mutationContext(user.id);
        patch(item.id, { status: 'uploading', error: undefined });
        // Tracked locally rather than read back off `item`, which is a snapshot from the
        // render that started this run and is never updated by `patch`. The previous
        // revision assigned `item.saved = true` directly to keep these two readable, which
        // mutated a state object in place — it happened to work only because `patch`
        // replaced the object a moment later, and it would have silently stopped working
        // the first time React reused the array.
        let saved = item.saved;
        let uploaded = item.uploaded;
        try {
          if (!saved) {
            const mutation = queueEvidence(current, context, caseId, {
              id: item.id, title: item.title.trim() || item.name, kind: kindFor(item),
              fileName: item.name, mimeType: item.mimeType, sizeBytes: item.size,
              sourceLabel, capturedAt,
            });
            await repository.commit(user.id, mutation.changes);
            current = mutation.workspace;
            saved = true; patch(item.id, { saved: true });
          }
          if (!uploaded) {
            const storedFile = await uploadEvidenceFile({ ownerId: user.id, caseId, evidenceId: item.id, uri: item.uri, name: item.name,
              mimeType: item.mimeType, sizeBytes: item.size, onProgress: (progress) => patch(item.id, { progress }), signal: controller.signal });
            // The digest exists only now, so this is the first moment a duplicate can be
            // known. Flagged, not blocked: an identical file is legitimately worth having
            // twice (the analysis reports it as one source, by hash), and the warning lets
            // the user decide before they leave this screen. The item's own record is
            // excluded — a retry must not warn about itself.
            const duplicate = findDuplicate(storedFile.sha256,
              current.evidence.filter((evidence) => evidence.caseId === caseId && !evidence.deletedAt && evidence.id !== item.id),
              storedInBatch);
            const mutation = recordEvidenceFile(current, context, item.id,
              { storagePath: storedFile.storagePath, sizeBytes: storedFile.sizeBytes, sha256: storedFile.sha256 });
            await repository.commit(user.id, mutation.changes);
            current = mutation.workspace;
            uploaded = true;
            storedInBatch.push({ sha256: storedFile.sha256, title: item.title.trim() || item.name });
            patch(item.id, { uploaded: true, sha256: storedFile.sha256, duplicate });
          }
          // Checked before starting the read rather than only after it. Reading is the long
          // step — a transcription is an upload plus inference — and a user who pressed Stop
          // during the write should not then wait out a full extraction they have already
          // abandoned.
          if (controller.signal.aborted) throw new Error('Upload cancelled.');
          patch(item.id, { status: 'processing' });
          const receipt = await requestEvidenceProcessing(caseId, item.id, { repository, ownerId: user.id });
          // `requestEvidenceProcessing` takes no signal (its `ProcessingContext` has no
          // field for one), so a Stop pressed while it runs cannot interrupt it. What this
          // screen can guarantee is that it writes nothing for a job the user abandoned:
          // the receipt of an aborted run is dropped here rather than being painted over
          // the "Stopped" line the catch below is about to write.
          if (controller.signal.aborted) throw new Error('Upload cancelled.');
          patch(item.id, {
            status: receipt.state === 'EXTRACTED' || receipt.state === 'CONFIRMED' ? 'extracted' : receipt.state === 'REVIEW_REQUIRED' ? 'review' : 'failed',
            progress: 1,
            ...(receipt.state !== 'EXTRACTED' && receipt.state !== 'CONFIRMED' ? { error: receipt.failureReason ?? undefined } : {}),
          });
          if (receipt.state === 'FAILED') unreadable += 1; else processed += 1;
        } catch (caught) {
          const cancelled = controller.signal.aborted;
          if (!cancelled && saved && !uploaded) incomplete += 1;
          // A user-stopped upload is not a failure and must not be labelled "needs
          // retry"; what actually exists — an entry without its original, or nothing
          // at all — is the honest thing to say.
          const message = cancelled
            ? saved
              ? uploaded
                ? 'Stopped before its contents were read. The file is saved; save again to read it.'
                : 'Stopped before the original was stored. Its entry exists; save again to store the file.'
              : 'Stopped. This file was not added to the case.'
            : readableError(caught, 'This file did not finish. Try it again.');
          patch(item.id, { status: cancelled ? 'waiting' : 'failed', error: message });
          // The row exists and its bytes do not, and nothing outside this screen will ever
          // supply them: processing runs inline here, so once this screen is gone the record
          // is describing work that is running nowhere. Committing the failure is what stops
          // it being a permanent spinner in the case — `patch` above writes only React state,
          // which is discarded the moment the user navigates away.
          //
          // Swallowed on purpose. This is the error path; a case that cannot even record the
          // failure must still show the sentence above rather than replacing it with a second,
          // more confusing one.
          if (saved && !uploaded) {
            try {
              const closed = failEvidenceUpload(current, context, item.id, message);
              await repository.commit(user.id, closed.changes);
              current = closed.workspace;
            } catch { /* keep the message the user can act on */ }
          }
        }
        if (controller.signal.aborted) { stopped = true; break; }
      }
      // Every item is accounted for in the sentence, by its real outcome: the failure
      // this flow cannot afford is a file that disappears from both the case and the
      // summary, leaving the user believing more was read than was.
      const summary: string[] = [];
      if (processed) {
        summary.push(`${processed} ${processed === 1 ? 'document is' : 'documents are'} saved and processed on this device.`);
      }
      if (unreadable) {
        summary.push(`${unreadable} ${unreadable === 1 ? 'document was' : 'documents were'} saved but could not be read — open ${unreadable === 1 ? 'it' : 'each one'} to see why.`);
      }
      if (incomplete) {
        summary.push(`${incomplete} ${incomplete === 1 ? 'entry was' : 'entries were'} saved without ${incomplete === 1 ? 'its original file' : 'their original files'} — save again from this screen to store ${incomplete === 1 ? 'it' : 'them'}.`);
      }
      if (summary.length) setNotice(summary.join(' '));

      /*
        Adding a document now analyses the case.

        This is the fix for the app appearing to do nothing. The deterministic engine —
        which compares the sources against each other and against the claims, and is the
        thing this product is — ran only when somebody found one of three buttons buried
        inside the case. So the ordinary path (make a case, add documents, look at it)
        read every file, extracted every value, and then sat on them. Reading a document
        and never comparing it is the one outcome that is indistinguishable from broken.

        It runs once for the batch rather than per file, because the rules are
        cross-document: what matters is the case as a whole after everything landed.

        Not run when the user pressed Stop — they asked for the work to end — and not run
        when nothing was successfully read, which would re-analyse an unchanged case.
      */
      if (processed > 0 && !stopped) {
        setAnalysing(true);
        try {
          await requestCaseAnalysis(caseId, { repository, ownerId: user.id });
          setNotice([...summary, 'The case was analysed again with these included. Open the case to see what changed.'].join(' '));
        } catch {
          // Deliberately silent. The upload is what this screen promised and the upload
          // succeeded; the evidence is saved either way. Reporting an analysis failure as
          // an upload error would tell the user their files did not save, which is false.
          // The case screen offers the run again, and reports its own failure there.
        } finally {
          setAnalysing(false);
        }
      }
    } finally { active.current = null; lock.current = false; setBusy(false); }
  }

  async function saveNote() {
    if (!user || !record || lock.current || !noteTitle.trim() || !noteText.trim()) return;
    lock.current = true; setBusy(true); fail(null); setNotice(null);
    try {
      // A statement is complete in one commit: its text is its content, so it is born
      // extracted — the same path for signed-in and local workspaces.
      const mutation = createNote(workspace, mutationContext(user.id), caseId, { title: noteTitle.trim(), text: noteText.trim() });
      await repository.commit(user.id, mutation.changes);
      setNoteTitle(''); setNoteText('');
      const saved = 'Your statement is saved and read on this device.';
      setNotice(saved);
      // A statement is a document like any other, so adding one re-runs the comparison for
      // the same reason a file does. Silent on failure: the statement is already saved.
      setAnalysing(true);
      try {
        await requestCaseAnalysis(caseId, { repository, ownerId: user.id });
        setNotice(`${saved} The case was analysed again with it included.`);
      } catch {
        // Left as saved. The case screen offers the run again and reports its own failure.
      } finally {
        setAnalysing(false);
      }
    } catch (caught) { fail(caught, 'The statement could not be saved. Nothing was written to the case.'); }
    finally { lock.current = false; setBusy(false); }
  }

  const statusLine = (item: Item) => item.status === 'extracted' ? 'Saved · Contents read and extracted'
    : item.status === 'review' ? 'Saved · Needs review'
    : item.status === 'processing' ? 'Reading contents on this device…'
    : item.status === 'uploading' ? (item.progress === null ? 'Reading the file…' : `Storing original ${Math.round(item.progress * 100)}%`)
    // A stored file whose reading failed is still saved evidence — the label must not
    // read as if nothing was kept.
    : item.status === 'failed' ? (item.uploaded ? 'Saved · Could not be read' : 'Failed')
    : 'Ready to save';

  return <ScreenScroll title="Add evidence" back subtitle={record?.title} onRefresh={reload} refreshing={refreshing}>
    <View style={styles.column}>
      {/*
        A failed *load* and a failed *action* are two different sentences, and they were
        being rendered as one: `(loadError?.message ?? error)!` put a raw repository string
        under the content-free title "Action needs attention", with no way to retry the
        load it was actually reporting. The load failure now gets the retry it needs; the
        action failure keeps the raw text behind a disclosure.
      */}
      {loadError ? (
        <ErrorState
          compact
          title="This case could not be opened"
          message="The stored copy of this case could not be read, so nothing can be added to it yet. Nothing you have picked has been lost."
          detail={errorDetail(loadError)}
          onRetry={reload}
        />
      ) : null}
      {error ? (
        <Notice
          title="That did not happen"
          message={error}
          detail={errorDetailText}
          tone="danger"
          onDismiss={() => fail(null)}
        />
      ) : null}
      {notice ? <Notice title="Evidence saved" message={notice} tone="ok" /> : null}
      {/*
        The analysis runs after the files are saved, and it is the slowest step on this
        screen. Without a line saying so, the screen sits on "saved" with the buttons
        still disabled and looks hung at exactly the moment it is doing the work the user
        came for.
      */}
      {analysing ? <View style={styles.stack}>
        <Notice title="Analysing the case" message="Comparing the new documents against everything already in this case." tone="info" />
        <IndeterminateBar accessibilityLabel="Analysing the case" />
      </View> : null}
      <Text colorToken="textSecondary">Add original records from each perspective. Their content stays separate from what someone claims happened.</Text>
      <TextField label="Who provided these" labelHint="optional" value={sourceLabel} onChangeText={setSourceLabel} maxLength={240} placeholder="Where did these records come from?" />
      <TextField label="When was it captured?" labelHint="optional" value={capturedAt} onChangeText={setCapturedAt} maxLength={120} placeholder="Use the date on the record if you know it" />
      <Row gap="md" style={styles.wrap}>
        <Button label="Choose files" icon="file-upload-outline" disabled={busy || loading || !record} onPress={() => void pick()} />
        {nativeDevice ? <Button label="Take photo" icon="camera-outline" variant="secondary" disabled={busy || loading || !record} onPress={() => void takePhoto()} /> : null}
        <Button label="Photos or videos" variant="secondary" disabled={busy || loading || !record} onPress={() => void pick(true)} />
        {nativeDevice && !recorderOpen ? <Button label="Record audio" icon="microphone-outline" variant="secondary" disabled={busy || loading || !record} onPress={() => setRecorderOpen(true)} /> : null}
      </Row>
      {/*
        This paragraph named a model vendor and a Settings key, and described a limit as
        something "this build" could not do. Neither is the reader's vocabulary: they are
        being told what kinds of file work and what happens to one that does not, and the
        answer to "why can't it read my voice note" is that transcription has to be
        connected, not which company supplies it.
      */}
      <Text variant="caption" colorToken="textSecondary">
        Images, PDFs, text, spreadsheets, email, audio and video can be added, up to 100 MB each.
        Files are stored and read on this device: images by reading the text in the picture, PDFs
        through their own text layer — or, when a PDF is a scan with no text, by reading its pages
        as pictures — and audio or video by transcription, which has to be connected in Settings
        first. A file whose contents cannot be read is kept exactly as it is and flagged for you to
        look at — nothing is guessed.
      </Text>
      {recorderOpen ? <MediaRecorder busy={busy || loading || !record} onRecorded={keepMemo} onCancel={() => setRecorderOpen(false)} /> : null}
      {items.map((item) => {
        // The tone of the whole card follows the file's outcome, because a list of ten
        // documents where one failed has to make that one findable without reading every
        // line. `ok` is only claimed once the contents were actually read.
        const done = item.status === 'extracted';
        const broken = item.status === 'failed';
        const running = item.status === 'uploading' || item.status === 'processing';
        return <Surface key={item.id} glass glassVariant="panel" elevation={running ? 'medium' : 'low'} padding="lg" style={styles.stack}>
        {/*
          The file name is what the device called the file, so it is set in mono like every
          other machine-supplied value in this app — and below the rank of the title field,
          not above it. At `subheading` in the human typeface it read as the heading of the
          card, which told the user their document was already named "IMG_4821.HEIC" and
          made the field where they could actually name it look like a footnote.
        */}
        <Row gap="sm" align="center" style={styles.wrap}>
          <Text variant="monoSmall" colorToken="textSecondary" numberOfLines={1} style={styles.flex}>{item.name}</Text>
          <Text variant="caption" colorToken="textSecondary">{item.size === null ? 'Size checked while storing' : formatBytes(item.size)}</Text>
        </Row>
        {!item.saved ? <TextField label="Document title" value={item.title} onChangeText={(title) => patch(item.id, { title })} maxLength={200} /> : null}
        {broken ? <Text tone="danger">{statusLine(item)}</Text>
          : done ? <Text tone="ok">{statusLine(item)}</Text>
          : <Text>{statusLine(item)}</Text>}
        {/*
          Measured progress is drawn, not spelled out. The byte callback gives a real 0→1
          during the store, and the read that follows it has no measurable duration — so
          the store gets a fill and the read gets a sweep. Both say "still moving", which
          a percentage that updates every few seconds does not.
        */}
        {item.status === 'uploading' && item.progress !== null
          ? <ProgressBar value={item.progress} accessibilityLabel={`Storing ${item.name}`} />
          : running
            ? <IndeterminateBar accessibilityLabel={item.status === 'processing' ? `Reading ${item.name}` : `Storing ${item.name}`} />
            : null}
        {item.duplicate ? <Text colorToken="textSecondary">{item.duplicate.scope === 'case'
          ? `Same file as "${item.duplicate.title}", already saved in this case. Both are kept; the analysis treats identical files as one document.`
          : `Same file as "${item.duplicate.title}", picked earlier in this batch.`}</Text> : null}
        {/*
          An error was rendered in the same muted grey as the file size, which read as a
          footnote. It is the one line on the card that requires the user to do something,
          so it carries the danger tone — except where the file *was* stored and only the
          reading failed, which is a caution, not a loss.
        */}
        {item.error ? <Text tone={item.uploaded ? 'warn' : 'danger'}>{item.error}</Text> : null}
        <Row gap="sm" style={styles.wrap}>
          {/*
            Retry is offered per file, for the two states a single file can be stuck in: it
            failed, or the user stopped it and it went back to waiting. Without this the only
            way to retry one file was the batch button, which re-runs every waiting and failed
            item — so recovering the one file that failed meant reprocessing all the others,
            including re-transcribing recordings that had already succeeded.
          */}
          {!busy && (item.status === 'failed' || (item.status === 'waiting' && (item.saved || item.uploaded)))
            ? <Button label={item.uploaded ? 'Read this file again' : 'Retry this file'} variant="secondary" size="sm" onPress={() => void upload(item.id)} /> : null}
          {!busy && !item.saved ? <Button label="Remove from selection" variant="ghost" size="sm" onPress={() => setItems((all) => all.filter((entry) => entry.id !== item.id))} /> : null}
        </Row>
      </Surface>;
      })}
      {items.some((item) => item.status === 'waiting' || item.status === 'failed') ? <Row gap="md" style={styles.wrap}><Button label="Add evidence" loading={busy} disabled={busy} onPress={() => void upload()} />{/*
            Offered while files are being read, and withdrawn once the analysis starts.

            `busy` alone covers both phases, but `active.current` holds the *last file's*
            controller by then — already settled — and `ProcessingContext` takes no signal,
            so a press during the analysis aborted nothing and left the button sitting there
            inert. A control that does nothing is worse than an absent one: the user presses
            it, watches the work continue, and concludes the app ignores them.
          */}
          {busy && !analysing ? <Button label="Stop" variant="ghost" onPress={() => active.current?.abort()} /> : null}</Row> : null}
      <Surface padding="lg" style={styles.panel}>
        <Text variant="heading">Record a statement</Text><Text colorToken="textSecondary">A typed statement is your own account, attributed to you. It is not treated as an independent record the way a document from someone else is.</Text>
        <TextField label="Statement title" value={noteTitle} onChangeText={setNoteTitle} maxLength={200} />
        {/* Six lines of body text, derived from the type scale rather than the 140 that
            was here — so the box still holds six lines if the scale ever moves. */}
        <TextField label="Statement content" value={noteText} onChangeText={setNoteText} multiline minHeight={TYPE.body.lineHeight * 6} maxLength={4000} />
        <Button label="Save statement" onPress={() => void saveNote()} disabled={busy || !record || !noteTitle.trim() || !noteText.trim()} />
      </Surface>
      <Button label="Return to case" variant="secondary" disabled={busy} onPress={() => router.replace({ pathname: '/case/[caseId]', params: { caseId } })} />
    </View>
  </ScreenScroll>;
}

const styles = StyleSheet.create({
  // 720, the measure the rest of the app sets its reading column to. 800 was a number
  // this screen invented, and a form field 800 points wide is one the eye loses track of.
  column: { gap: SPACING.xxl, maxWidth: LAYOUT.maxContentWidth, width: '100%', alignSelf: 'center' },
  stack: { gap: SPACING.md },
  panel: { gap: SPACING.lg },
  wrap: { flexWrap: 'wrap' },
  flex: { flex: 1 },
});
