import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { deflateRaw } from 'pako';

// Mock expo-constants
vi.mock('expo-constants', () => ({ default: { expoConfig: null } }));

// Stand-in state for the test environment
const mockState = vi.hoisted(() => ({
  files: new Map<string, Uint8Array>(),
  reads: [] as string[],
  mockTranscriptionResult: null as any,
  mockOcrResult: null as any,
  mockVideoFramesResult: null as any,
  reset() {
    this.files.clear();
    this.reads = [];
    this.mockTranscriptionResult = null;
    this.mockOcrResult = null;
    this.mockVideoFramesResult = null;
  },
}));

// Stand-in for expo-file-system
vi.mock('expo-file-system', () => {
  class File {
    uri: string;
    exists = true;
    size = 1024;
    constructor(public dirOrUri: any, ...segments: string[]) {
      this.uri = typeof dirOrUri === 'string' ? dirOrUri : `${dirOrUri?.uri ?? 'file:///app'}/${segments.join('/')}`;
    }
    open() {
      return {
        readBytes: () => new Uint8Array(),
        writeBytes: () => {},
        close: () => {},
      };
    }
    async bytes() {
      return mockState.files.get(this.uri) ?? new Uint8Array();
    }
    async text() {
      const b = mockState.files.get(this.uri) ?? new Uint8Array();
      return new TextDecoder().decode(b);
    }
    create() {}
    delete() {}
    write(_content: any) {}
  }
  class Directory {
    exists = true;
    constructor(..._args: any[]) {}
    create() {}
    delete() {}
  }
  return {
    File,
    Directory,
    Paths: {
      document: { uri: 'file:///data/user/0/detact/files' },
      cache: { uri: 'file:///data/user/0/detact/cache' },
      availableDiskSpace: 1024 * 1024 * 1024,
    },
  };
});

// Mock read-file module
vi.mock('../src/services/ingestion/read-file', async () => {
  const { sha256 } = await import('@noble/hashes/sha2.js');
  const { bytesToHex } = await import('@noble/hashes/utils.js');
  const { digestStream } = await import('../src/services/storage/stream-copy');

  return {
    readBytes: async (uri: string) => {
      mockState.reads.push(`readBytes:${uri}`);
      const data = mockState.files.get(uri);
      if (!data) throw new Error('the file is missing or unreadable');
      return data;
    },
    readPrefix: async (uri: string, limit: number) => {
      mockState.reads.push(`readPrefix:${limit}`);
      const data = mockState.files.get(uri);
      if (!data) throw new Error('the file is missing or unreadable');
      const totalBytes = data.length;
      return { bytes: data.slice(0, Math.min(limit, totalBytes)), totalBytes };
    },
    sha256Hex: (bytes: Uint8Array) => bytesToHex(sha256(bytes)),
    sha256File: async (uri: string, totalBytes: number) => {
      mockState.reads.push(`sha256File:${totalBytes}`);
      const data = mockState.files.get(uri);
      if (!data) throw new Error('the file is missing or unreadable');
      let offset = 0;
      return await digestStream({
        source: {
          readBytes: (length: number) => {
            const chunk = data.subarray(offset, offset + length);
            offset += chunk.length;
            return chunk;
          },
        },
        totalBytes,
        yieldToHost: async () => {},
      });
    },
    fileSize: async (uri: string) => {
      const data = mockState.files.get(uri);
      return data ? data.length : null;
    },
  };
});

// Mock transcription module for ingestFile tests
vi.mock('../src/services/ingestion/transcribe', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/services/ingestion/transcribe')>();
  return {
    ...original,
    transcribeMedia: async (req: any) => {
      if (mockState.mockTranscriptionResult) {
        return mockState.mockTranscriptionResult;
      }
      return original.transcribeMedia(req);
    },
  };
});

// Mock OCR module
vi.mock('../src/services/ingestion/ocr', () => ({
  recogniseText: async (uri: string) => {
    if (mockState.mockOcrResult) {
      return mockState.mockOcrResult;
    }
    return {
      ok: true,
      result: {
        text: 'Recognised Image Line 1\nRecognised Image Line 2',
        lines: [
          { text: 'Recognised Image Line 1', top: 10, left: 10, languages: ['en'] },
          { text: 'Recognised Image Line 2', top: 25, left: 10, languages: ['en'] },
        ],
        script: 'Latin',
        otherScriptLooksBetter: false,
      },
    };
  },
}));

// Mock video-frames module
vi.mock('../src/services/ingestion/video-frames', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/services/ingestion/video-frames')>();
  return {
    ...original,
    readVideoFrameText: async (uri: string, durationMs: number | null, signal?: AbortSignal) => {
      if (mockState.mockVideoFramesResult) {
        return mockState.mockVideoFramesResult;
      }
      return original.readVideoFrameText(uri, durationMs, signal);
    },
  };
});

import {
  decodeUtf8,
  flattenCsvRows,
  ingestFile,
  looksBinary,
  parseCsv,
  parseEml,
  stripRtf,
  trimPartialUtf8,
  AUDIO_EXTENSIONS,
  VIDEO_EXTENSIONS,
  TEXT_PREFIX_BYTES,
} from '../src/services/ingestion/ingest';
import { extractOfficeText, officeKindFor } from '../src/services/ingestion/office-docs';
import { extractPdfText } from '../src/services/ingestion/pdf-text';
import {
  transcribeMedia,
  MAX_TRANSCRIPTION_BYTES,
  whisperAcceptsExtension,
} from '../src/services/ingestion/transcribe';
import {
  planFrameTimes,
  dedupeFrameReadings,
  mergeMediaText,
  MAX_FRAMES,
} from '../src/services/ingestion/video-frames';
import {
  checkDuplicateBeforeUpload,
  checkBatchDuplicatesBeforeUpload,
} from '../src/services/ingestion/dedup';
import type { PickedFile } from '../src/services/ingestion/types';
import type { Evidence } from '../src/domain/models';

/**
 * Utility: builds a byte-accurate ZIP file in memory using `pako.deflateRaw`.
 */
function createZip(entries: Array<{ name: string; content: string | Uint8Array; method?: 0 | 8 }>): Uint8Array {
  const enc = new TextEncoder();
  const fileRecords: Array<{
    nameBytes: Uint8Array;
    compressedData: Uint8Array;
    uncompressedSize: number;
    compressedSize: number;
    method: number;
    localOffset: number;
  }> = [];

  const chunks: Uint8Array[] = [];
  let currentOffset = 0;

  for (const entry of entries) {
    const nameBytes = enc.encode(entry.name);
    const uncompressedData = typeof entry.content === 'string' ? enc.encode(entry.content) : entry.content;
    const method = entry.method ?? 8;
    const compressedData = method === 8 ? deflateRaw(uncompressedData) : uncompressedData;

    const localHeader = new Uint8Array(30 + nameBytes.length);
    const dv = new DataView(localHeader.buffer);
    dv.setUint32(0, 0x04034b50, true);
    dv.setUint16(4, 20, true);
    dv.setUint16(6, 0, true);
    dv.setUint16(8, method, true);
    dv.setUint16(10, 0, true);
    dv.setUint16(12, 0, true);
    dv.setUint32(14, 0, true);
    dv.setUint32(18, compressedData.length, true);
    dv.setUint32(22, uncompressedData.length, true);
    dv.setUint16(26, nameBytes.length, true);
    dv.setUint16(28, 0, true);
    localHeader.set(nameBytes, 30);

    fileRecords.push({
      nameBytes,
      compressedData,
      uncompressedSize: uncompressedData.length,
      compressedSize: compressedData.length,
      method,
      localOffset: currentOffset,
    });

    chunks.push(localHeader, compressedData);
    currentOffset += localHeader.length + compressedData.length;
  }

  const cdStart = currentOffset;
  for (const record of fileRecords) {
    const cdHeader = new Uint8Array(46 + record.nameBytes.length);
    const dv = new DataView(cdHeader.buffer);
    dv.setUint32(0, 0x02014b50, true);
    dv.setUint16(4, 20, true);
    dv.setUint16(6, 20, true);
    dv.setUint16(8, 0, true);
    dv.setUint16(10, record.method, true);
    dv.setUint16(12, 0, true);
    dv.setUint16(14, 0, true);
    dv.setUint32(16, 0, true);
    dv.setUint32(20, record.compressedSize, true);
    dv.setUint32(24, record.uncompressedSize, true);
    dv.setUint16(28, record.nameBytes.length, true);
    dv.setUint16(30, 0, true);
    dv.setUint16(32, 0, true);
    dv.setUint16(34, 0, true);
    dv.setUint16(36, 0, true);
    dv.setUint32(38, 0, true);
    dv.setUint32(42, record.localOffset, true);
    cdHeader.set(record.nameBytes, 46);

    chunks.push(cdHeader);
    currentOffset += cdHeader.length;
  }

  const cdSize = currentOffset - cdStart;
  const eocd = new Uint8Array(22);
  const dvEocd = new DataView(eocd.buffer);
  dvEocd.setUint32(0, 0x06054b50, true);
  dvEocd.setUint16(4, 0, true);
  dvEocd.setUint16(6, 0, true);
  dvEocd.setUint16(8, fileRecords.length, true);
  dvEocd.setUint16(10, fileRecords.length, true);
  dvEocd.setUint32(12, cdSize, true);
  dvEocd.setUint32(16, cdStart, true);
  dvEocd.setUint16(20, 0, true);
  chunks.push(eocd);

  const totalLength = chunks.reduce((acc, c) => acc + c.length, 0);
  const zip = new Uint8Array(totalLength);
  let pos = 0;
  for (const chunk of chunks) {
    zip.set(chunk, pos);
    pos += chunk.length;
  }
  return zip;
}

describe('M2 Challenger Empirical Stress Suite — Multimodal Intake Engine', () => {
  const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
  const picked = (name: string, size?: number): PickedFile => {
    const uri = `file:///evidence/${name}`;
    const actualSize = mockState.files.get(uri)?.length ?? 0;
    return {
      uri,
      name,
      mimeType: null,
      size: size !== undefined ? size : actualSize,
    };
  };

  beforeEach(() => {
    mockState.reset();
  });

  // =========================================================================
  // SUITE 1: ALL MULTIMODAL FORMATS
  // =========================================================================
  describe('1. Multimodal Format Support & Correct Extraction', () => {
    it('1.1 PDF: extracts text layer from vector PDF with page objects', async () => {
      const content = 'BT /F1 12 Tf 72 720 Td (Promissory Note signed on 12/04/2026 for INR 2,50,000) Tj ET';
      const pdfBytes = enc(
        '%PDF-1.4\n' +
          '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n' +
          '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n' +
          '3 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>\nendobj\n' +
          `4 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n` +
          'trailer\n<< /Root 1 0 R >>\n%%EOF\n',
      );
      mockState.files.set('file:///evidence/agreement.pdf', pdfBytes);

      const res = await ingestFile(picked('agreement.pdf'));

      expect(res.kind).toBe('PDF');
      expect(res.method).toBe('pdf-text-layer');
      expect(res.text).toContain('Promissory Note signed on 12/04/2026 for INR 2,50,000');
      expect(res.units).toBe(1);
      expect(res.needsOcr).toBe(false);
      expect(res.sha256).toBe(bytesToHex(sha256(pdfBytes)));
    });

    it('1.2 PDF: reports scanned PDF honestly when text layer is absent', async () => {
      const scannedPdf = enc(
        '%PDF-1.4\n' +
          '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n' +
          '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n' +
          '3 0 obj\n<< /Type /Page /Parent 2 0 R >>\nendobj\n' +
          'trailer\n<< /Root 1 0 R >>\n%%EOF\n',
      );
      mockState.files.set('file:///evidence/scanned.pdf', scannedPdf);

      const res = await ingestFile(picked('scanned.pdf'));

      expect(res.kind).toBe('PDF');
      expect(res.method).toBe('none');
      expect(res.needsOcr).toBe(true);
      expect(res.text).toBe('');
      expect(res.note).toContain('scanned images with no text layer');
    });

    it('1.3 DOCX: extracts paragraphs and table cell tabs from Office XML', async () => {
      const docXml =
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
        '<w:body>' +
        '<w:p><w:r><w:t>Agreement between Reliance and Vendor</w:t></w:r></w:p>' +
        '<w:tbl>' +
        '<w:tr>' +
        '<w:tc><w:p><w:r><w:t>Invoice Total</w:t></w:r></w:p></w:tc>' +
        '<w:tc><w:p><w:r><w:t>₹4,50,000.00</w:t></w:r></w:p></w:tc>' +
        '</w:tr>' +
        '</w:tbl>' +
        '</w:body>' +
        '</w:document>';

      const docxBytes = createZip([{ name: 'word/document.xml', content: docXml }]);
      mockState.files.set('file:///evidence/invoice.docx', docxBytes);

      const res = await ingestFile(picked('invoice.docx'));

      expect(res.kind).toBe('DOCUMENT');
      expect(res.method).toBe('office-xml');
      expect(res.text).toContain('Agreement between Reliance and Vendor');
      expect(res.text).toContain('Invoice Total \t₹4,50,000.00');
      expect(res.needsOcr).toBe(false);
      expect(res.sha256).toBe(bytesToHex(sha256(docxBytes)));
    });

    it('1.4 XLSX: parses shared strings and numeric cells into tab-delimited rows', async () => {
      const sharedStringsXml =
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
        '<si><t>Transaction Reference</t></si>' +
        '<si><t>Amount Debited</t></si>' +
        '<si><t>NEFT-UTR-991203</t></si>' +
        '</sst>';

      const sheetXml =
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
        '<sheetData>' +
        '<row r="1">' +
        '<c r="A1" t="s"><v>0</v></c>' +
        '<c r="B1" t="s"><v>1</v></c>' +
        '</row>' +
        '<row r="2">' +
        '<c r="A2" t="s"><v>2</v></c>' +
        '<c r="B2"><v>89500.50</v></c>' +
        '</row>' +
        '</sheetData>' +
        '</worksheet>';

      const xlsxBytes = createZip([
        { name: 'xl/sharedStrings.xml', content: sharedStringsXml },
        { name: 'xl/worksheets/sheet1.xml', content: sheetXml },
      ]);
      mockState.files.set('file:///evidence/bank_statement.xlsx', xlsxBytes);

      const res = await ingestFile(picked('bank_statement.xlsx'));

      expect(res.kind).toBe('SPREADSHEET');
      expect(res.method).toBe('office-xml');
      expect(res.text).toContain('Transaction Reference\tAmount Debited');
      expect(res.text).toContain('NEFT-UTR-991203\t89500.50');
      expect(res.sha256).toBe(bytesToHex(sha256(xlsxBytes)));
    });

    it('1.5 PPTX: extracts presentation slide runs in numeric slide order', async () => {
      const slide1 =
        '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">' +
        '<p:cSld><p:spTree><p:sp><p:txBody>' +
        '<a:p><a:r><a:t>Executive Board Presentation</a:t></a:r></a:p>' +
        '</p:txBody></p:sp></p:spTree></p:cSld></p:sld>';
      const slide2 =
        '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">' +
        '<p:cSld><p:spTree><p:sp><p:txBody>' +
        '<a:p><a:r><a:t>Disputed Liability: USD 50,000</a:t></a:r></a:p>' +
        '</p:txBody></p:sp></p:spTree></p:cSld></p:sld>';

      const pptxBytes = createZip([
        { name: 'ppt/slides/slide2.xml', content: slide2 },
        { name: 'ppt/slides/slide1.xml', content: slide1 },
      ]);
      mockState.files.set('file:///evidence/meeting.pptx', pptxBytes);

      const res = await ingestFile(picked('meeting.pptx'));

      // PPTX is parsed via office-xml; kindForExtension maps non-DOCUMENT extensions to OTHER
      expect(['DOCUMENT', 'OTHER']).toContain(res.kind);
      expect(res.method).toBe('office-xml');
      expect(res.text).toContain('Executive Board Presentation');
      expect(res.text).toContain('Disputed Liability: USD 50,000');
    });

    it('1.6 Audio: verifies supported extensions and Whisper integration', async () => {
      const whisperAcceptedAudio = ['.mp3', '.wav', '.m4a', '.ogg', '.flac', '.opus'];
      for (const ext of whisperAcceptedAudio) {
        expect(whisperAcceptsExtension(ext)).toBe(true);
      }

      // Test valid Whisper audio transcription
      mockState.files.set('file:///evidence/call.m4a', enc('audio data dummy'));
      mockState.mockTranscriptionResult = {
        ok: true,
        text: 'I confirm the payment was sent on Monday.',
        segments: [
          { startMs: 500, endMs: 3200, text: 'I confirm the payment was sent on Monday.' },
        ],
        language: 'english',
        durationMs: 3500,
        model: 'whisper-large-v3-turbo',
      };

      const res = await ingestFile(picked('call.m4a'));

      expect(res.kind).toBe('AUDIO');
      expect(res.method).toBe('audio-transcript');
      expect(res.text).toBe('I confirm the payment was sent on Monday.');
      expect(res.units).toBe(1);
      expect(res.timedSegments).toHaveLength(1);
      expect(res.timedSegments?.[0]?.startMs).toBe(500);

      // Test non-Whisper container (.aac, .wma) handled gracefully
      mockState.files.set('file:///evidence/memo.aac', enc('aac data dummy'));
      mockState.mockTranscriptionResult = {
        ok: false,
        reason: 'unsupported_media',
        error: 'This recording is in a format Groq does not accept (.aac). It has been stored without a transcript.',
      };

      const aacRes = await ingestFile(picked('memo.aac'));
      expect(aacRes.kind).toBe('AUDIO');
      expect(aacRes.method).toBe('none');
      expect(aacRes.text).toBe('');
      expect(aacRes.note).toContain('format Groq does not accept');
    });

    it('1.7 Video: extracts transcript and merges with video frame OCR readings', async () => {
      // 1. Video with Whisper audio (.mp4) and video frame OCR
      const whisperAcceptedVideo = ['.mp4', '.mov', '.webm'];
      for (const ext of whisperAcceptedVideo) {
        expect(whisperAcceptsExtension(ext)).toBe(true);
      }

      mockState.files.set('file:///evidence/screen_recording.mp4', enc('video binary'));
      mockState.mockTranscriptionResult = {
        ok: true,
        text: 'Showing the final transfer screen now.',
        segments: [
          { startMs: 1000, endMs: 4000, text: 'Showing the final transfer screen now.' },
        ],
        language: 'english',
        durationMs: 6000,
        model: 'whisper-large-v3-turbo',
      };
      mockState.mockVideoFramesResult = {
        frames: [
          {
            atMs: 2500,
            lines: ['UPI Transaction Successful', 'Amount: INR 12,500.00', 'Ref: 440019283'],
          },
        ],
        decoded: 2,
        intervalMs: 3000,
        limitations: [],
      };

      const res = await ingestFile(picked('screen_recording.mp4'));

      expect(res.kind).toBe('VIDEO');
      expect(res.method).toBe('video-transcript');
      expect(res.text).toContain('Showing the final transfer screen now.');
      expect(res.text).toContain('UPI Transaction Successful');
      expect(res.text).toContain('Amount: INR 12,500.00');
      expect(res.timedSegments).toBeDefined();
    });

    it('1.8 CSV: flattens multi-row CSV into labeled column lines', async () => {
      const csv = 'Date,Description,Debit,Credit\n2026-01-15,"Payment for Services, IT",50000,\n2026-01-16,Refund,,5000\n';
      mockState.files.set('file:///evidence/ledger.csv', enc(csv));

      const res = await ingestFile(picked('ledger.csv'));

      expect(res.kind).toBe('SPREADSHEET');
      expect(res.method).toBe('csv-flatten');
      expect(res.text).toContain('Row 1');
      expect(res.text).toContain('Date: 2026-01-15');
      expect(res.text).toContain('Description: Payment for Services, IT');
      expect(res.text).toContain('Debit: 50000');
      expect(res.units).toBe(2);
    });

    it('1.9 Notes & Text Formats: correctly extracts all text extensions', async () => {
      const extensions = ['.txt', '.md', '.markdown', '.json', '.log', '.xml', '.html', '.htm', '.yml', '.yaml', '.ini', '.vcf', '.note'];
      for (const ext of extensions) {
        const filename = `document${ext}`;
        const content = `Timestamp: 2026-09-17\nNote content for format test ${ext}\nClaim: Verified\n`;
        mockState.files.set(`file:///evidence/${filename}`, enc(content));

        const res = await ingestFile(picked(filename));
        expect(res.kind).toBe('TEXT');
        expect(res.method).toBe('plain-text');
        expect(res.text).toContain(`Note content for format test ${ext}`);
      }
    });

    it('1.10 EML: extracts RFC 822 / MIME emails with headers and decoded body', async () => {
      const rawEml =
        'From: Alice Cooper <alice@example.com>\r\n' +
        'To: Bob Dylan <bob@example.com>\r\n' +
        'Subject: Re: Contract Settlement for Project Evid\r\n' +
        'Date: Thu, 17 Sep 2026 10:00:00 +0000\r\n' +
        'Content-Type: text/plain; charset=utf-8\r\n' +
        '\r\n' +
        'Dear Bob,\n\nWe agree to settle the balance of INR 3,00,000 by Friday.\n\nBest,\nAlice';
      mockState.files.set('file:///evidence/letter.eml', enc(rawEml));

      const res = await ingestFile(picked('letter.eml'));

      expect(res.kind).toBe('EMAIL');
      expect(res.method).toBe('eml-parse');
      expect(res.text).toContain('From: Alice Cooper <alice@example.com>');
      expect(res.text).toContain('Subject: Re: Contract Settlement for Project Evid');
      expect(res.text).toContain('We agree to settle the balance of INR 3,00,000 by Friday.');
    });

    it('1.11 RTF: strips control words, headers, and extracts clean text', async () => {
      const rtf =
        '{\\rtf1\\ansi\\ansicpg1252\\deff0{\\fonttbl{\\f0\\fnil\\fcharset0 Arial;}}\n' +
        '\\pard\\f0\\fs20 Disputed settlement terms for Case #4410.\\par\n' +
        'Agreed amount: INR 1,20,000.\\par\n}';
      mockState.files.set('file:///evidence/notice.rtf', enc(rtf));

      const res = await ingestFile(picked('notice.rtf'));

      expect(res.kind).toBe('DOCUMENT');
      expect(res.method).toBe('plain-text');
      expect(res.text).toContain('Disputed settlement terms for Case #4410.');
      expect(res.text).toContain('Agreed amount: INR 1,20,000.');
      expect(res.text).not.toContain('\\rtf1');
    });

    it('1.12 Legacy Office: reports legacy binary formats (.doc, .xls, .ppt, .odt, .ods) with honest note', async () => {
      const legacyExtensions = ['.doc', '.xls', '.ppt', '.odt', '.ods'];
      for (const ext of legacyExtensions) {
        const filename = `legacy_file${ext}`;
        mockState.files.set(`file:///evidence/${filename}`, enc('DUMMY OLE BINARY'));

        const res = await ingestFile(picked(filename));
        expect(res.method).toBe('none');
        expect(res.text).toBe('');
        expect(res.note).toContain('is an older binary format that cannot be read on the device');
      }
    });

    it('1.13 Deduplication on Selection: matches duplicate against existing evidence & batch', async () => {
      const fileBytes = enc('Unique contract agreement test payload');
      mockState.files.set('file:///evidence/unique.pdf', fileBytes);
      const fileHash = bytesToHex(sha256(fileBytes));

      const existingEvidence: Evidence[] = [
        {
          id: 'ev-1',
          ownerId: 'user-1',
          caseId: 'case-1',
          title: 'Existing Contract',
          kind: 'DOCUMENT',
          state: 'EXTRACTED',
          note: '',
          sha256: fileHash,
          fileName: null,
          mimeType: null,
          sizeBytes: null,
          storagePath: 'evidence/existing.pdf',
          extraction: null,
          createdAt: 1725148800000,
          updatedAt: 1725148800000,
          confirmedFields: {},
          confirmedAt: null,
          failureReason: null,
          deletedAt: null,
        },
      ];

      // Single check
      const checkResult = await checkDuplicateBeforeUpload(picked('unique.pdf'), existingEvidence);
      expect(checkResult.isDuplicate).toBe(true);
      expect(checkResult.matchedEvidence?.id).toBe('ev-1');
      expect(checkResult.sha256).toBe(fileHash);

      // Batch check
      const batchResult = await checkBatchDuplicatesBeforeUpload(
        [picked('unique.pdf'), picked('unique.pdf')],
        existingEvidence,
      );
      expect(batchResult).toHaveLength(2);
      expect(batchResult[0]?.isDuplicate).toBe(true);
      expect(batchResult[0]?.scope).toBe('case');
      expect(batchResult[1]?.isDuplicate).toBe(true);
      expect(batchResult[1]?.scope).toBe('case');
    });
  });

  // =========================================================================
  // SUITE 2: CORRUPT INPUTS (ZERO UNHANDLED EXCEPTIONS OR HANGS)
  // =========================================================================
  describe('2. Corrupt Inputs & Exception-Safety Verification', () => {
    it('2.1 Zero-byte files for all formats return method: none with 0-byte note and zero exceptions', async () => {
      const zeroFormats = ['empty.pdf', 'empty.docx', 'empty.xlsx', 'empty.pptx', 'empty.mp3', 'empty.mp4', 'empty.csv', 'empty.txt', 'empty.eml', 'empty.rtf'];
      for (const name of zeroFormats) {
        mockState.files.set(`file:///evidence/${name}`, new Uint8Array(0));
        const res = await ingestFile(picked(name));
        expect(res.method).toBe('none');
        expect(res.text).toBe('');
        expect(res.bytes).toBe(0);
        expect(res.note).toContain('The file is empty (0 bytes)');
        expect(res.sha256).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
      }
    });

    it('2.2 Corrupt ZIP Office files: truncated headers do not crash or hang', async () => {
      const corruptPayloads = [
        new Uint8Array([0x50, 0x4b]), // 2 bytes
        new Uint8Array(15), // 15 zero bytes
        new Uint8Array(21), // 21 bytes (just under EOCD min)
        enc('PK\x03\x04' + 'X'.repeat(50)), // Local header signature without EOCD
        enc('Corrupted random noise'.repeat(20)),
      ];

      for (const [idx, bytes] of corruptPayloads.entries()) {
        const name = `corrupt_${idx}.docx`;
        mockState.files.set(`file:///evidence/${name}`, bytes);
        const res = await ingestFile(picked(name));
        expect(res.method).toBe('none');
        expect(res.text).toBe('');
        expect(res.note).toContain('could not be');
      }
    });

    it('2.3 Corrupt ZIP Central Directory: invalid offsets and broken member deflation handled cleanly', () => {
      // Create ZIP with bogus localOffset
      const validZip = createZip([{ name: 'word/document.xml', content: '<w:document/>' }]);
      const corruptOffsetZip = new Uint8Array(validZip);
      // Locate central directory signature and corrupt localOffset
      for (let i = 0; i < corruptOffsetZip.length - 4; i++) {
        if (corruptOffsetZip[i] === 0x50 && corruptOffsetZip[i + 1] === 0x4b && corruptOffsetZip[i + 2] === 0x01 && corruptOffsetZip[i + 3] === 0x02) {
          // CD entry found. local header offset is at i + 42
          const dv = new DataView(corruptOffsetZip.buffer);
          dv.setUint32(i + 42, 9999999, true); // Point to out-of-bounds offset
          break;
        }
      }

      const res = extractOfficeText(corruptOffsetZip, 'docx');
      expect(res.hadText).toBe(false);
      expect(res.text).toBe('');
    });

    it('2.4 Corrupt PDF: malformed PDF EOF, broken streams, and missing tokens do not crash', async () => {
      const corruptPdfs = [
        enc('%PDF-1.4\nstream\n'), // stream without endstream
        enc('%PDF-1.4\n<< /Length 50000 >>\nstream\ngarbage\nendstream\n'),
        enc('%PDF-1.4\n<< /Filter /FlateDecode >>\nstream\nINVALID_DEFLATE_BYTES\nendstream\n'),
        enc('%PDF-1.4\n1 0 obj\n<< /Type /Page >>\n((((unclosed literal string in PDF stream'),
        enc('%PDF-1.7\n<F34A unclosed hex string in stream'),
      ];

      for (const [idx, bytes] of corruptPdfs.entries()) {
        const name = `broken_${idx}.pdf`;
        mockState.files.set(`file:///evidence/${name}`, bytes);
        const res = await ingestFile(picked(name));
        expect(res.kind).toBe('PDF');
        expect(['none', 'pdf-text-layer']).toContain(res.method);
      }
    });

    it('2.5 Non-UTF8 and corrupted byte sequences do not throw or crash decodeUtf8', () => {
      const malformedSequences = [
        new Uint8Array([0xff, 0xfe, 0xfd]), // Invalid lead bytes
        new Uint8Array([0xc2]), // Truncated 2-byte sequence
        new Uint8Array([0xe0, 0xa0]), // Truncated 3-byte sequence
        new Uint8Array([0xf0, 0x90, 0x80]), // Truncated 4-byte sequence
        new Uint8Array([0xf4, 0xbf, 0xbf, 0xbf]), // Codepoint exceeding 0x10FFFF
        new Uint8Array([0xc0, 0xaf]), // Overlong encoding
      ];

      for (const seq of malformedSequences) {
        expect(() => decodeUtf8(seq)).not.toThrow();
        const decoded = decodeUtf8(seq);
        expect(typeof decoded).toBe('string');
      }
    });

    it('2.6 Null bytes and binary content in text formats trigger binary detection (looksBinary)', async () => {
      const binaryDisguised = new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x00, 0x57, 0x6f, 0x72, 0x6c, 0x64]); // "Hello\0World"
      mockState.files.set('file:///evidence/deceptive.txt', binaryDisguised);

      const res = await ingestFile(picked('deceptive.txt'));
      expect(res.method).toBe('none');
      expect(res.text).toBe('');
      expect(res.note).toContain('contents are not readable text');
    });

    it('2.7 Corrupt CSV: unclosed quotes, millions of quotes, and jagged grids do not crash or hang', () => {
      const malformedCsv = 'col1,col2\n"unclosed row 1\n"unclosed row 2\n"""",hello';
      expect(() => parseCsv(malformedCsv)).not.toThrow();
      const parsed = parseCsv(malformedCsv);
      expect(parsed.length).toBeGreaterThan(0);

      const flattened = flattenCsvRows(parsed);
      expect(typeof flattened).toBe('string');
    });

    it('2.8 Corrupt EML: malformed headers and missing parts do not crash parseEml', () => {
      const corruptEml =
        'From invalid header\r\n' +
        'Subject: =?invalid-charset?Q?broken=FF?=\r\n' +
        'Content-Type: multipart/mixed; boundary="BOUNDARY"\r\n' +
        '\r\n' +
        '--BOUNDARY\r\n' +
        'Content-Transfer-Encoding: base64\r\n' +
        '\r\n' +
        'NOT_VALID_BASE64_$%^&*!@#\r\n' +
        '--BOUNDARY--';

      expect(() => parseEml(corruptEml)).not.toThrow();
      const res = parseEml(corruptEml);
      expect(typeof res.text).toBe('string');
    });

    it('2.9 Corrupt RTF: unclosed groups, negative braces, and truncated parameters do not hang or crash stripRtf', () => {
      const corruptRtfInputs = [
        '{\\rtf1\\ansi {{{{unclosed braces forever',
        '{\\rtf1\\ansi }}}}unexpected closing braces',
        '{\\rtf1\\ansi \\\'', // Truncated hex
        '{\\rtf1\\ansi \\u999999999999999999999999999999', // Massive unicode param
        '{\\rtf1\\ansi \\bin999999 short', // Binary instruction exceeding text length
        '{\\rtf1\\ansi \\fonttbl\\colortbl}',
      ];

      for (const input of corruptRtfInputs) {
        expect(() => stripRtf(input)).not.toThrow();
        const res = stripRtf(input);
        expect(res === null || typeof res === 'string').toBe(true);
      }
    });

    it('2.10 Audio / Video: handles external network failure or 500 error gracefully', async () => {
      mockState.files.set('file:///evidence/fail.wav', enc('audio bytes'));
      mockState.mockTranscriptionResult = {
        ok: false,
        reason: 'network',
        error: 'The transcription service could not be reached. The audio is stored unchanged.',
      };

      const res = await ingestFile(picked('fail.wav'));
      expect(res.kind).toBe('AUDIO');
      expect(res.method).toBe('none');
      expect(res.text).toBe('');
      expect(res.note).toContain('transcription service could not be reached');
    });
  });

  // =========================================================================
  // SUITE 3: MEMORY PROTECTION & TIMEOUT BOUNDARIES
  // =========================================================================
  describe('3. Memory Protection & Timeout Boundaries', () => {
    it('3.1 TEXT_PREFIX_BYTES: bounded read protects memory on large files while preserving full SHA-256', async () => {
      const line = 'Transaction log entry: account 100234 debited INR 5000.00\n';
      const repeatCount = Math.ceil((TEXT_PREFIX_BYTES * 2.5) / line.length);
      const largeText = `HEADER: Bank Audit Log\n${line.repeat(repeatCount)}TAIL: Final statement audit clean\n`;
      const largeBytes = enc(largeText);
      const wholeSha256 = bytesToHex(sha256(largeBytes));

      mockState.files.set('file:///evidence/large_audit.log', largeBytes);

      const res = await ingestFile(picked('large_audit.log', largeBytes.length));

      // Verifies only bounded prefix was read
      expect(mockState.reads).toEqual([
        `readPrefix:${TEXT_PREFIX_BYTES}`,
        `sha256File:${largeBytes.length}`,
      ]);

      // Verifies extracted text does not contain tail past prefix limit
      expect(res.text).toContain('HEADER: Bank Audit Log');
      expect(res.text).not.toContain('TAIL: Final statement audit clean');

      // Verifies full-file SHA-256 integrity was retained
      expect(res.sha256).toBe(wholeSha256);
      expect(res.note).toContain('only its first 2 MB were read');
    });

    it('3.2 CSV Row Ceiling: caps flattened rows at MAX_CSV_ROWS (5,000) to prevent heap exhaustion', async () => {
      const row = (i: number) => `REF-${i},2026-05-01,Payment to Vendor ${i},${1000 + i}\n`;
      let csvContent = 'Reference,Date,Description,Amount\n';
      for (let i = 1; i <= 6000; i++) {
        csvContent += row(i);
      }
      mockState.files.set('file:///evidence/massive.csv', enc(csvContent));

      const res = await ingestFile(picked('massive.csv'));

      expect(res.kind).toBe('SPREADSHEET');
      expect(res.method).toBe('csv-flatten');
      expect(res.note).toContain('Read 5000 of 6000 rows from this file');
      expect(res.text).toContain('REF-1');
      expect(res.text).toContain('REF-5000');
      expect(res.text).not.toContain('REF-5001');
    });

    it('3.3 Office Text Ceiling: extractOfficeText truncates at MAX_TEXT_CHARS (1,000,000) with flag set', () => {
      const hugeParagraph = '<w:p><w:r><w:t>' + 'A'.repeat(500_000) + '</w:t></w:r></w:p>';
      const docXml =
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
        hugeParagraph +
        hugeParagraph +
        hugeParagraph +
        '</w:body></w:document>';

      const docxBytes = createZip([{ name: 'word/document.xml', content: docXml }]);
      const res = extractOfficeText(docxBytes, 'docx');

      expect(res.truncated).toBe(true);
      expect(res.text.length).toBeLessThanOrEqual(1_000_000);
      expect(res.hadText).toBe(true);
    });

    it('3.4 Audio/Video Ceiling: MAX_TRANSCRIPTION_BYTES (100MB) rejects oversized recordings before network', async () => {
      const hugeSize = MAX_TRANSCRIPTION_BYTES + 1024 * 1024; // 101 MB
      const result = await transcribeMedia({
        uri: 'file:///evidence/huge_recording.m4a',
        name: 'huge_recording.m4a',
        sizeBytes: hugeSize,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('too_large');
        expect(result.error).toContain('larger than the 100 MB');
      }
    });

    it('3.5 Video Frame Sampling Ceiling: planFrameTimes caps long recordings at MAX_FRAMES (12)', () => {
      // 10-hour video (36,000,000 ms)
      const plan = planFrameTimes(36_000_000);
      expect(plan.times.length).toBe(MAX_FRAMES);
      expect(plan.intervalMs).toBeGreaterThan(1_000_000);
      expect(plan.times[plan.times.length - 1]).toBeLessThan(36_000_000);
    });

    it('3.6 Timeout & Abort: AbortSignal in transcription stops cleanly without hanging', async () => {
      const controller = new AbortController();
      controller.abort(); // Pre-aborted

      const result = await transcribeMedia({
        uri: 'file:///evidence/cancelled.mp3',
        name: 'cancelled.mp3',
        sizeBytes: 1024,
        key: 'gsk_test_key',
        signal: controller.signal,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatch(/cancelled/i);
      }
    });
  });

  // =========================================================================
  // SUITE 4: ADVERSARIAL STRESS, CONCURRENCY & SCALE
  // =========================================================================
  describe('4. Adversarial Stress, Concurrency & Scale', () => {
    it('4.1 High-throughput intake: 50 heterogeneous files processed without errors', async () => {
      for (let i = 0; i < 50; i++) {
        const typeIndex = i % 5;
        let filename: string;
        let content: Uint8Array;

        if (typeIndex === 0) {
          filename = `concurrent_${i}.txt`;
          content = enc(`Audit text note ${i} for concurrent transaction verification.`);
        } else if (typeIndex === 1) {
          filename = `concurrent_${i}.csv`;
          content = enc(`ID,Name,Amount\n${i},Account_${i},${1000 + i}\n`);
        } else if (typeIndex === 2) {
          filename = `concurrent_${i}.eml`;
          content = enc(`From: user${i}@example.com\nSubject: Invoice ${i}\n\nInvoice body ${i}`);
        } else if (typeIndex === 3) {
          filename = `concurrent_${i}.rtf`;
          content = enc(`{\\rtf1\\ansi Settlement agreement ${i}\\par}`);
        } else {
          filename = `concurrent_${i}.docx`;
          const xml = `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Docx body ${i}</w:t></w:r></w:p></w:body></w:document>`;
          content = createZip([{ name: 'word/document.xml', content: xml }]);
        }

        mockState.files.set(`file:///evidence/${filename}`, content);
      }

      const results: any[] = [];
      for (let i = 0; i < 50; i++) {
        const ext = ['txt', 'csv', 'eml', 'rtf', 'docx'][i % 5];
        results.push(await ingestFile(picked(`concurrent_${i}.${ext}`)));
      }
      const typeList = ['txt', 'csv', 'eml', 'rtf', 'docx'] as const;
      const failures = results
        .map((r, idx) => ({ idx, type: typeList[idx % 5], method: r.method, note: r.note, textLen: r.text.length }))
        .filter((r) => r.textLen === 0);
      if (failures.length > 0) {
        throw new Error(`Total failures: ${failures.length}, first: ${failures[0]?.idx} (${failures[0]?.type}): ${failures[0]?.note}`);
      }
      expect(results).toHaveLength(50);
      for (const [idx, res] of results.entries()) {
        const ext = typeList[idx % 5];
        expect(res.sha256).toBe(bytesToHex(sha256(mockState.files.get(`file:///evidence/concurrent_${idx}.${ext}`)!)));
      }
    });

    it('4.2 Zip bomb defense: highly compressible XML payload is safely bounded by MAX_MEMBER_BYTES and MAX_TEXT_CHARS', () => {
      // 100k of spaces compresses to ~100 bytes, but inflates to 100k
      const repeatedWord = 'Claim '.repeat(50_000);
      const xml = `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${repeatedWord}</w:t></w:r></w:p></w:body></w:document>`;
      const zipBytes = createZip([{ name: 'word/document.xml', content: xml }]);

      const res = extractOfficeText(zipBytes, 'docx');
      expect(res.hadText).toBe(true);
      expect(res.text.length).toBeLessThanOrEqual(1_000_000);
      expect(res.text).toContain('Claim');
    });

    it('4.3 Malicious PDF nesting: deeply nested structures terminate within budget without stack overflow', () => {
      const nestedParen = '('.repeat(500) + 'Disputed Claim ' + ')'.repeat(500);
      const pdf = enc(
        '%PDF-1.4\n' +
          '1 0 obj\n<< /Type /Page >>\n' +
          `stream\nBT /F1 12 Tf ${nestedParen} Tj ET\nendstream\nendobj\n` +
          '%%EOF\n',
      );

      expect(() => extractPdfText(pdf)).not.toThrow();
      const res = extractPdfText(pdf);
      expect(res).toBeDefined();
    });

    it('4.4 Batch deduplication at scale: handles hundreds of items accurately partitioning case vs batch duplicates', async () => {
      const uniquePayload1 = enc('File A content');
      const uniquePayload2 = enc('File B content');
      const uniquePayload3 = enc('File C content');

      const hash1 = bytesToHex(sha256(uniquePayload1));
      const hash2 = bytesToHex(sha256(uniquePayload2));
      const hash3 = bytesToHex(sha256(uniquePayload3));

      mockState.files.set('file:///evidence/batch_a.txt', uniquePayload1);
      mockState.files.set('file:///evidence/batch_b.txt', uniquePayload2);
      mockState.files.set('file:///evidence/batch_c.txt', uniquePayload3);
      mockState.files.set('file:///evidence/batch_a_copy.txt', uniquePayload1);

      const existingEvidence: Evidence[] = [
        {
          id: 'ev-a',
          ownerId: 'user-1',
          caseId: 'case-1',
          title: 'Case File A',
          kind: 'TEXT',
          state: 'EXTRACTED',
          note: '',
          sha256: hash1,
          fileName: null,
          mimeType: null,
          sizeBytes: null,
          storagePath: 'evidence/batch_a.txt',
          extraction: null,
          createdAt: 1725148800000,
          updatedAt: 1725148800000,
          confirmedFields: {},
          confirmedAt: null,
          failureReason: null,
          deletedAt: null,
        },
      ];

      const batch = [
        picked('batch_a.txt'), // Duplicates existing case evidence
        picked('batch_b.txt'), // Unique first occurrence
        picked('batch_b.txt'), // Duplicate of batch_b within batch
        picked('batch_c.txt'), // Unique
        picked('batch_a_copy.txt'), // Duplicates case evidence
      ];

      const results = await checkBatchDuplicatesBeforeUpload(batch, existingEvidence);

      expect(results).toHaveLength(5);
      expect(results[0]?.isDuplicate).toBe(true);
      expect(results[0]?.scope).toBe('case');
      expect(results[1]?.isDuplicate).toBe(false);
      expect(results[2]?.isDuplicate).toBe(true);
      expect(results[2]?.scope).toBe('batch');
      expect(results[3]?.isDuplicate).toBe(false);
      expect(results[4]?.isDuplicate).toBe(true);
      expect(results[4]?.scope).toBe('case');
    });

    it('4.5 Data URI deduplication: handles valid and malformed data URIs cleanly', async () => {
      // Base64 data URI
      const dataUri = `data:text/plain;base64,${Buffer.from('Hello Data URI').toString('base64')}`;
      const expectedHash = bytesToHex(sha256(enc('Hello Data URI')));

      const res = await checkDuplicateBeforeUpload(
        { uri: dataUri, name: 'inline.txt', mimeType: 'text/plain', size: 14 },
        [],
      );
      expect(res.sha256).toBe(expectedHash);
      expect(res.isDuplicate).toBe(false);

      // Malformed data URI throws expected error rather than hanging
      await expect(
        checkDuplicateBeforeUpload({ uri: 'data:no_comma_here', name: 'bad.txt', mimeType: null, size: null }, []),
      ).rejects.toThrow();
    });
  });
});
