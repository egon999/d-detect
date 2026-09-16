"use strict";
// Untrusted PDF parsing/rasterization runs outside the API process, without its secrets.
const {PDFParse} = require("pdf-parse");
const {createCanvas} = require("@napi-rs/canvas");
const MAX_PIXELS = 8 * 1024 * 1024;
class BoundedCanvasFactory {
  create(width, height) {
    this.check(width, height);
    const canvas = createCanvas(Math.ceil(width), Math.ceil(height));
    return {canvas, context: canvas.getContext("2d")};
  }
  check(width, height) {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0 || width > 8192 || height > 8192 || Math.ceil(width) * Math.ceil(height) > MAX_PIXELS) throw new Error("canvas-limit");
  }
  reset(target, width, height) { this.check(width, height); target.canvas.width = Math.ceil(width); target.canvas.height = Math.ceil(height); }
  destroy(target) { target.canvas.width = 0; target.canvas.height = 0; target.canvas = null; target.context = null; }
}
let omittedContent = false;
// PDF.js can skip oversized/unsupported images rather than reject the file. Surface that
// as incomplete coverage; never publish the raw warning (it can contain source content).
const recordWarning = (...values) => {
  const message = values.map(String).join(" ");
  if (/maxImageSize|unable to decode image|image.*removed|unsupported image|invalid image/i.test(message)) omittedContent = true;
};
console.log = recordWarning;
console.warn = recordWarning;
const chunks = [];
let inputSize = 0;
process.stdin.on("data", (chunk) => {
  inputSize += chunk.length;
  if (inputSize > 100 * 1024 * 1024) process.exit(1);
  chunks.push(chunk);
});
process.stdin.on("end", async () => {
  let parser;
  try {
    parser = new PDFParse({data: new Uint8Array(Buffer.concat(chunks)), isEvalSupported: false, verbosity: 1, CanvasFactory: BoundedCanvasFactory, maxImageSize: MAX_PIXELS, canvasMaxAreaInBytes: MAX_PIXELS * 4});
    const info = await parser.getInfo({first: 80, parsePageInfo: true});
    const result = await parser.getText({first: 80});
    const pages = [];
    const scans = [];
    const excludedOcrPages = [];
    let remaining = 40001;
    let truncated = info.total > 80;
    let imageBytes = 0;
    for (const part of result.pages) {
      const text = part.text.slice(0, Math.max(0, remaining));
      remaining -= text.length;
      if (text.length !== part.text.length) truncated = true;
      pages.push({page: part.num, text, method: "DETERMINISTIC"});
      // Page-number/header text does not mean a scanned page has a readable text layer.
      if (part.text.replace(/\s/g, "").length > 80) continue;
      if (scans.length >= 10) { excludedOcrPages.push(part.num); continue; }
      const dimensions = info.pages.find((item) => item.pageNumber === part.num);
      if (!dimensions || !(dimensions.width > 0) || !(dimensions.height > 0)) throw new Error("invalid-dimensions");
      const scale = Math.min(2, 1800 / dimensions.width, 2400 / dimensions.height, Math.sqrt(4 * 1024 * 1024 / (dimensions.width * dimensions.height)));
      const rendered = await parser.getScreenshot({partial: [part.num], scale, imageBuffer: true, imageDataUrl: false});
      const screenshot = rendered.pages[0];
      if (!screenshot || !screenshot.data.length) throw new Error("empty-render");
      imageBytes += screenshot.data.length;
      if (screenshot.data.length > 14 * 1024 * 1024 || imageBytes > 24 * 1024 * 1024) throw new Error("image-output-limit");
      scans.push({page: part.num, png: Buffer.from(screenshot.data).toString("base64"), width: screenshot.width, height: screenshot.height});
    }
    await parser.destroy(); parser = null;
    process.stdout.write(JSON.stringify({pages, scans, excludedOcrPages, totalPages: info.total, truncated: truncated || omittedContent, omittedContent}));
  } catch {
    process.exitCode = 1;
    try { if (parser) await parser.destroy(); } catch { /* Subprocess exits without source data in logs. */ }
  }
});
