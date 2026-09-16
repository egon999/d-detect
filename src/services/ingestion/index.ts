/**
 * Public surface of the ingestion layer.
 *
 * Note for tests: this barrel re-exports `read-file` and `ocr`, which import
 * `expo-file-system` and the ML Kit binding respectively and therefore cannot be
 * loaded in a plain Node process. Unit tests should import the specific module they
 * need (`./ingest`, `./pdf-text`, `./transcribe`, `./video-frames`) rather than this
 * file — those four are importable in Node, and between them they hold all the logic
 * that can be wrong.
 */

export type { IngestResult, IngestSourceKind, PickedFile, TimedSegment } from './types';

export { extractPdfText, type PdfTextResult } from './pdf-text';

export {
  extractPdfImages,
  MAX_PAGE_IMAGES,
  type PdfImage,
  type PdfImageResult,
} from './pdf-images';

export {
  ingestFile,
  parseCsv,
  parseEml,
  flattenCsvRows,
  looksBinary,
  decodeUtf8,
  decodeQuotedPrintable,
  fileExtension,
  formatMediaDuration,
  type ParsedEmail,
} from './ingest';

export { readBytes, readText, fileSize, sha256Hex } from './read-file';

export {
  recogniseText,
  type RecognisedLine,
  type RecognisedText,
  type RecognitionOutcome,
} from './ocr';

export {
  transcribeMedia,
  transcriptionAvailable,
  whisperAcceptsExtension,
  MAX_TRANSCRIPTION_BYTES,
  TRANSCRIPTION_MODEL,
  TRANSCRIPTION_MODEL_CHAIN,
  type TranscriptionFailure,
  type TranscriptionFailureReason,
  type TranscriptionRequest,
  type TranscriptionResult,
  type TranscriptionSuccess,
} from './transcribe';

export {
  readVideoFrameText,
  mergeMediaText,
  planFrameTimes,
  MAX_FRAMES,
  type FrameLimitation,
  type FrameReading,
  type FrameTextOutcome,
} from './video-frames';
