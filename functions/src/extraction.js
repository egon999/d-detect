"use strict";
const {createHash} = require("node:crypto");
const {problem} = require("./contracts");
const {transcribe} = require("./provider");
const {parseDocument} = require("./parse-document");
const {extractImageText} = require("./image-ocr");
const {extractPdfWithOcr} = require("./pdf-ocr");
const {extractFromText} = require("../lib/domain/extraction/deterministic");
const MAX_TEXT = 40000;
const MAX_FILE = 100 * 1024 * 1024;

function segmentText(parts, method = "DETERMINISTIC") {
  let sourceText = "";
  const segments = [];
  let truncated = false;
  for (const part of parts) {
    const text = String(part.text || "");
    if (text && sourceText && !sourceText.endsWith("\n") && !text.startsWith("\n")) {
      if (sourceText.length >= MAX_TEXT) { truncated = true; break; }
      sourceText += "\n";
    }
    for (let offset = 0; offset < text.length; offset += 1600) {
      if (sourceText.length >= MAX_TEXT) { truncated = true; break; }
      const value = text.slice(offset, offset + Math.min(1600, MAX_TEXT - sourceText.length));
      const startOffset = sourceText.length;
      sourceText += value;
      segments.push({id: `seg_${segments.length + 1}`, text: value, startOffset, endOffset: sourceText.length, method: part.method || method,
        ...(part.page ? {page: part.page} : {}), ...(Number.isFinite(part.startMs) ? {startMs: part.startMs, endMs: part.endMs} : {})});
    }
  }
  return {sourceText, segments, sourceTextTruncated: truncated};
}

function zipSizeGuard(bytes) {
  let expanded = 0;
  let entries = 0;
  for (let offset = 0; offset + 46 <= bytes.length; offset++) {
    if (bytes.readUInt32LE(offset) !== 0x02014b50) continue;
    expanded += bytes.readUInt32LE(offset + 24);
    entries++;
    if (expanded > 40 * 1024 * 1024 || entries > 3000) throw problem("document-limit", "This document expands beyond the safe processing limit.");
    offset += 45 + bytes.readUInt16LE(offset + 28) + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32);
  }
  if (!entries) throw problem("invalid-file", "The document container could not be read.");
}

async function extractEvidence(evidence, bytes, apiKey) {
  let parts;
  let method = "DETERMINISTIC";
  let parserTruncated = false;
  const limitations = [];
  const extension = (evidence.fileName || "").toLowerCase().split(".").pop();
  const declaredMime = (evidence.mimeType || "").toLowerCase();
  // Android providers frequently omit MIME types. The parser still validates file bytes;
  // this routing fallback must not turn a correctly named screenshot into "unsupported".
  const fallbackMime = {png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4", ogg: "audio/ogg", flac: "audio/flac", mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", mkv: "video/x-matroska", eml: "message/rfc822"}[extension];
  const mime = (!declaredMime || declaredMime === "application/octet-stream") ? (fallbackMime || declaredMime) : declaredMime;
  if (evidence.kind === "NOTE") {
    parts = [{text: evidence.note || ""}];
    limitations.push("This source is a user statement, not independent corroboration.");
  } else {
    if (!bytes || !bytes.length || bytes.length > MAX_FILE) throw problem("file-limit", "This file is empty or exceeds the 100 MB storage limit.");
    if (mime === "application/pdf" || extension === "pdf") {
      if (bytes.subarray(0, 1024).indexOf(Buffer.from("%PDF-")) < 0) throw problem("invalid-file", "The file is not a valid PDF.");
      const result = await extractPdfWithOcr(bytes);
      parts = result.parts; parserTruncated = result.truncated;
      limitations.push(...result.limitations);
      if (parts.some((part) => part.method === "OCR")) method = "OCR";
      if (!parts.some((part) => part.text.trim())) throw problem("needs-ocr", "This PDF did not produce readable text. Upload clearer scans or the relevant pages as images.");
    } else if (extension === "docx") {
      zipSizeGuard(bytes);
      const result = await parseDocument(bytes, "docx");
      parts = result.parts; parserTruncated = result.truncated;
      limitations.push("Document text extracted; visual layout and embedded images were not analyzed.");
    } else if (mime.startsWith("image/")) {
      if (!["image/png", "image/jpeg", "image/webp"].includes(mime)) throw problem("unsupported-format", "Convert this image to PNG, JPEG or WebP for visual extraction.");
      const validMagic = (mime === "image/png" && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) ||
        (mime === "image/jpeg" && bytes[0] === 255 && bytes[1] === 216) ||
        (mime === "image/webp" && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP");
      if (!validMagic) throw problem("invalid-file", "The image contents do not match the declared file type.");
      const result = await extractImageText(bytes);
      parts = [{text: result.text}]; method = "OCR";
      limitations.push(...result.limitations);
    } else if (mime.startsWith("audio/") || mime.startsWith("video/")) {
      if (!["mp3", "mp4", "mpeg", "mpga", "m4a", "ogg", "wav", "webm", "flac"].includes(extension)) throw problem("unsupported-format", "Convert this recording to MP3, MP4, M4A, WAV, OGG, WebM or FLAC for transcription.");
      const transcript = await transcribe(apiKey, bytes, evidence.fileName, mime);
      if (typeof transcript.text !== "string") throw problem("invalid-response", "Transcription returned invalid text.");
      parts = Array.isArray(transcript.segments) && transcript.segments.length ? transcript.segments.map((item) => ({text: String(item.text || ""), startMs: Math.round(Number(item.start) * 1000), endMs: Math.round(Number(item.end) * 1000)})) : [{text: transcript.text}];
      method = "AI";
      limitations.push("Automatic transcription may mishear speech; speaker identity has not been verified.");
      if (mime.startsWith("video/")) limitations.push("Only the first audio track was transcribed. Video frames and visual events were not analyzed.");
    } else if (mime.startsWith("text/") || ["txt", "csv", "tsv", "md", "json", "eml", "log", "xml"].includes(extension)) {
      const sample = bytes.subarray(0, 4096);
      if (sample.includes(0)) throw problem("invalid-file", "This file contains binary data rather than supported UTF-8 text.");
      parts = [{text: bytes.toString("utf8")}];
    } else {
      throw problem("unsupported-format", "The original file is stored safely, but its format cannot yet be extracted. Export it as PDF, DOCX, text, an image, or a supported recording.");
    }
  }
  const text = segmentText(parts, method);
  text.sourceTextTruncated ||= parserTruncated;
  if (!text.sourceText.trim()) throw problem("empty-extraction", "No readable content was found. Review the original or upload another source.");
  if (text.sourceTextTruncated) limitations.push("Processing excluded some source content. See the source-specific limitations; add excluded pages or passages as new evidence.");
  const fields = extractFromText({evidenceId: evidence.id, title: evidence.title, text: text.sourceText, method});
  return {
    extraction: {...fields, ...text, extractorVersion: "server-v1", limitations: [...fields.limitations, ...limitations]},
    sha256: bytes ? createHash("sha256").update(bytes).digest("hex") : null,
  };
}
module.exports = {MAX_FILE, segmentText, zipSizeGuard, extractEvidence};
