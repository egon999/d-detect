"use strict";
const {spawn} = require("node:child_process");
const path = require("node:path");
const {problem} = require("./contracts");

function renderPdfPages(bytes) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 100 * 1024 * 1024) return Promise.reject(problem("file-limit", "This PDF is empty or exceeds the 100 MB storage limit."));
  return new Promise((resolve, reject) => {
    const environment = Object.fromEntries(["PATH", "SystemRoot", "TEMP", "TMP", "WINDIR"].filter((name) => process.env[name]).map((name) => [name, process.env[name]]));
    const child = spawn(process.execPath, ["--max-old-space-size=256", path.join(__dirname, "pdf-render-worker.js")], {stdio: ["pipe", "pipe", "ignore"], windowsHide: true, env: environment});
    let settled = false;
    let size = 0;
    const output = [];
    const finish = (error, result) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (error) { child.kill(); reject(error); } else resolve(result);
    };
    const timer = setTimeout(() => finish(problem("document-timeout", "PDF rendering exceeded 45 seconds. Split this document into smaller files.")), 45000);
    child.stdout.on("data", (chunk) => {
      size += chunk.length;
      if (size > 34 * 1024 * 1024) finish(problem("document-limit", "Rendered PDF pages exceeded the safe output limit. Split this document into smaller files."));
      else output.push(chunk);
    });
    child.on("error", () => finish(problem("document-unavailable", "The PDF renderer could not start.")));
    child.stdin.on("error", () => {});
    child.on("close", (code) => {
      if (code !== 0) return finish(problem("invalid-file", "This PDF could not be rendered safely. It may be damaged, encrypted, or exceed the image complexity limit."));
      try {
        const result = JSON.parse(Buffer.concat(output).toString("utf8"));
        if (!Array.isArray(result.pages) || !Array.isArray(result.scans) || result.scans.length > 10 || !Number.isInteger(result.totalPages)) throw new Error();
        finish(null, result);
      } catch { finish(problem("invalid-file", "The PDF renderer returned unreadable content.")); }
    });
    child.stdin.end(bytes);
  });
}

/** Native text and OCR remain distinguishable and retain their physical PDF page. */
async function extractPdfWithOcr(bytes, {render = renderPdfPages, ocr} = {}) {
  const rendered = await render(bytes);
  const readImage = ocr || (rendered.scans.length ? require("./image-ocr").extractImageText : null);
  const byPage = new Map(rendered.pages.map((part) => [part.page, [{...part, method: "DETERMINISTIC"}]]));
  const limitations = [];
  const processedPages = [];
  const failedPages = [];
  let ocrTruncated = false;
  let failure;
  for (const scan of rendered.scans) {
    try {
      const result = await readImage(Buffer.from(scan.png, "base64"));
      if (typeof result.text !== "string" || result.text.length > 100000) throw problem("invalid-response", "PDF OCR returned invalid text.");
      ocrTruncated ||= result.truncated === true;
      const native = byPage.get(scan.page) || [];
      const normalized = (value) => value.replace(/\s+/g, " ").trim();
      if (result.text.trim() && !native.some((part) => normalized(part.text) === normalized(result.text))) native.push({text: result.text, page: scan.page, method: "OCR"});
      byPage.set(scan.page, native);
      processedPages.push(scan.page);
      for (const item of result.limitations || []) if (typeof item === "string") limitations.push(`Page ${scan.page}: ${item.slice(0, 800)}`);
    } catch (error) {
      failedPages.push(scan.page); failure = error;
      limitations.push(`Page ${scan.page}: OCR failed; visual content from this page is excluded. Upload a clearer copy of this page as a new evidence item.`);
    }
  }
  const parts = [...byPage.entries()].sort(([a], [b]) => a - b).flatMap(([, pageParts]) => pageParts.filter((part) => part.text.trim()));
  if (!parts.length && failure) throw failure;
  if (rendered.scans.length) limitations.unshift("OCR is a machine transcription, not a verified fact. Check dates, amounts and names against the original page. Native text and OCR from the same page are one source, not independent corroboration.");
  const textPages = rendered.pages.filter((part) => part.text.replace(/\s/g, "").length > 80).map((part) => part.page);
  if (textPages.length) limitations.push("Text-rich PDF pages use their embedded text layer. Images embedded in those pages and a potentially inaccurate hidden text layer have not been visually verified.");
  if (rendered.excludedOcrPages.length) limitations.push(`OCR is limited to 10 pages per processing job. Pages ${rendered.excludedOcrPages.join(", ")} were not visually extracted. Split this PDF or upload those pages separately.`);
  if (rendered.totalPages > 80) limitations.push(`Only the first 80 of ${rendered.totalPages} PDF pages were inspected. Later pages are excluded.`);
  if (rendered.omittedContent) limitations.push("The PDF renderer omitted an oversized or unsupported image. Some visual content is missing from this extraction; review the original and upload the affected pages as smaller images.");
  return {
    parts,
    truncated: rendered.truncated || ocrTruncated || rendered.excludedOcrPages.length > 0 || failedPages.length > 0,
    limitations: [...new Set(limitations)].slice(0, 40),
    coverage: {totalPages: rendered.totalPages, textPages, ocrPages: processedPages, excludedOcrPages: [...rendered.excludedOcrPages, ...failedPages].sort((a, b) => a - b)},
  };
}
module.exports = {renderPdfPages, extractPdfWithOcr};
