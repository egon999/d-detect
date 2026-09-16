"use strict";
const {spawn} = require("node:child_process");
const path = require("node:path");
const {problem} = require("./contracts");

// Only the three accepted image formats are decoded; every loop has byte and step bounds.
function imageDimensions(bytes) {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return {width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20)};
  if (bytes.length >= 30 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") {
    const format = bytes.toString("ascii", 12, 16);
    if (format === "VP8X") return {width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3)};
    if (format === "VP8L" && bytes[20] === 47) { const bits = bytes.readUInt32LE(21); return {width: 1 + (bits & 16383), height: 1 + ((bits >>> 14) & 16383)}; }
    if (format === "VP8 " && bytes.readUIntBE(23, 3) === 0x9d012a) return {width: bytes.readUInt16LE(26) & 16383, height: bytes.readUInt16LE(28) & 16383};
  }
  if (bytes[0] === 255 && bytes[1] === 216) {
    let offset = 2;
    for (let step = 0; step < 10000 && offset + 4 < bytes.length; step++) {
      if (bytes[offset] !== 255) break;
      while (bytes[offset] === 255 && offset < bytes.length) offset++;
      const marker = bytes[offset++];
      if (marker === 217 || marker === 218 || offset + 2 > bytes.length) break;
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if ([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker) && length >= 7) return {width: bytes.readUInt16BE(offset + 5), height: bytes.readUInt16BE(offset + 3)};
      offset += length;
    }
  }
  throw problem("invalid-file", "This image could not be decoded safely.");
}

function extractImageText(bytes) {
  let dimensions;
  try { dimensions = imageDimensions(bytes); } catch { throw problem("invalid-file", "This image could not be decoded safely."); }
  if (!dimensions.width || !dimensions.height) throw problem("invalid-file", "This image has invalid dimensions.");
  if (bytes.length > 30 * 1024 * 1024 || dimensions.width * dimensions.height > 24000000) throw problem("image-limit", "Use an image no larger than 24 megapixels and 30 MB for text extraction.");
  return new Promise((resolve, reject) => {
    const environment = Object.fromEntries(["PATH", "SystemRoot", "TEMP", "TMP", "WINDIR"].filter((name) => process.env[name]).map((name) => [name, process.env[name]]));
    environment.OCR_CACHE = path.join(__dirname, "../.cache/ocr");
    const child = spawn(process.execPath, ["--max-old-space-size=256", path.join(__dirname, "image-ocr-worker.js")], {stdio: ["pipe", "pipe", "ignore"], windowsHide: true, env: environment});
    let settled = false;
    let outputSize = 0;
    const chunks = [];
    const finish = (error, result) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (error) { child.kill(); reject(error); } else resolve(result);
    };
    const timer = setTimeout(() => finish(problem("ocr-timeout", "Image text extraction exceeded 30 seconds. Try a smaller, clearer image.")), 30000);
    child.stdout.on("data", (chunk) => {
      outputSize += chunk.length;
      if (outputSize > 1024 * 1024) finish(problem("image-limit", "The image produced too much text to process safely."));
      else chunks.push(chunk);
    });
    child.on("error", () => finish(problem("ocr-unavailable", "Image text extraction could not start.")));
    child.stdin.on("error", () => {});
    child.on("close", (code) => {
      if (code !== 0) return finish(problem("ocr-unavailable", "Image text extraction could not finish. The OCR language files may need an internet connection on first use."));
      try {
        const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (typeof result.text !== "string" || !Number.isFinite(result.confidence)) throw new Error();
        const limitations = ["OCR is a machine reading. Verify names, amounts, timestamps and speaker placement against the original image."];
        if (result.confidence < 65) limitations.push("The OCR engine reported poor recognition quality; this reading needs human verification.");
        if (result.truncated) limitations.push("OCR output was truncated at the processing limit.");
        finish(null, {...result, limitations});
      } catch { finish(problem("ocr-unavailable", "Image text extraction returned unreadable content.")); }
    });
    child.stdin.end(bytes);
  });
}
module.exports = {extractImageText, imageDimensions};
