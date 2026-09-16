/**
 * Shapes for the ingestion layer: turning a picked file into plain text plus
 * metadata, so the deterministic extractor (`@domain/extraction/deterministic`)
 * has something to read.
 *
 * Nothing here touches the filesystem or React Native, so it is safe to import
 * from tests and from the domain layer.
 */

import type { TimedSegment } from '../../domain/models';

export type IngestSourceKind = 'PDF' | 'IMAGE' | 'TEXT' | 'EMAIL' | 'SPREADSHEET' | 'AUDIO' | 'VIDEO' | 'DOCUMENT' | 'OTHER';

export interface PickedFile {
  uri: string;
  name: string;
  mimeType: string | null;
  size: number | null;
}

export type { TimedSegment };


export interface IngestResult {
  kind: IngestSourceKind;
  /** Plain text pulled out of the file. Empty string when none could be. */
  text: string;
  /**
   * How the text was obtained, for the UI to show honestly.
   *
   * `ocr` means a local ML Kit pass over pixels — a *reading* of the document rather
   * than the document's own characters, and every value in it is provisional. It is a
   * separate member from `pdf-text-layer` precisely so the UI cannot accidentally
   * present one as the other.
   *
   * `pdf-page-ocr` is the same pixel reading applied to the page images lifted out of a
   * scanned PDF. It is deliberately **not** folded into `ocr`: the two differ in what the
   * user can do about a bad reading. A photograph can be retaken in better light; a
   * scanned PDF is a fixed artefact someone else produced, so the only remedies are a
   * re-scan by that someone or typing the values in. It is also not `pdf-text-layer`,
   * because nothing in it came from characters in the file — treating it as the text layer
   * would silently promote a guess to the highest-trust reading the product has.
   */
  method:
    | 'pdf-text-layer'
    | 'pdf-page-ocr'
    | 'plain-text'
    | 'csv-flatten'
    | 'eml-parse'
    | 'office-xml'
    | 'ocr'
    | 'audio-transcript'
    | 'video-transcript'
    | 'none';
  /** Page count for PDFs, row count for CSV, etc. Null when not meaningful. */
  units: number | null;
  /**
   * True when no text was extracted and a *further* reading of the pixels could still
   * produce some — a scanned PDF with no text layer, or an image on a build where the ML
   * Kit recogniser is not linked.
   *
   * False after a recognition pass that ran and found nothing, because nothing would be
   * gained by running it again. NOT an error in either case.
   */
  needsOcr: boolean;
  /** A human sentence explaining what happened. Always set. Shown in the UI. */
  note: string;
  bytes: number;
  /** Lowercase hex SHA-256 of the file bytes. */
  sha256: string;
  /**
   * Clock positions for a time-based source, in the same order as the lines of `text`.
   * Absent for every source that has no clock — a PDF, a spreadsheet, a photograph.
   *
   * **Nothing consumes this yet.** It exists so that
   * `src/domain/extraction/deterministic.ts` → `buildSegments()` can populate the
   * `startMs`/`endMs` that `extractionSchema.segments` already declares and that
   * `app/case/[caseId]/evidence/[evidenceId].tsx` already renders as a timestamp. The
   * intended handoff, spelled out because getting it subtly wrong would attach a real
   * timestamp to the wrong sentence:
   *
   * `buildSegments` walks the non-empty lines of `sourceText` in order. Walk this array
   * with a pointer alongside it; when a line's trimmed text equals the pointed-at
   * segment's `text`, copy its `startMs`/`endMs` onto the segment being built and advance
   * the pointer. Leave the pointer where it is otherwise. Matching on text rather than on
   * position is what keeps the two in step across the section headings and frame markers
   * this layer interleaves, and advancing only on a match is what keeps a recording that
   * says "Yes." twice from having its second "Yes." timed as its first.
   *
   * The list is empty rather than absent when a recording was reached but produced no
   * timings, so "no key, never transcribed" and "transcribed, no speech found" stay
   * distinguishable.
   */
  timedSegments?: TimedSegment[];
}
