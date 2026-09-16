"use strict";
const fs = require("node:fs/promises");
const {createWorker} = require("tesseract.js");
const chunks = [];
let size = 0;
process.stdin.on("data", (chunk) => { size += chunk.length; if (size > 30 * 1024 * 1024) process.exit(1); chunks.push(chunk); });
process.stdin.on("end", async () => {
  let worker;
  try {
    await fs.mkdir(process.env.OCR_CACHE, {recursive: true, mode: 0o700});
    worker = await createWorker(["eng", "hin"], 1, {cachePath: process.env.OCR_CACHE, logger: () => {}, errorHandler: () => {}});
    const {data} = await worker.recognize(Buffer.concat(chunks));
    process.stdout.write(JSON.stringify({text: data.text.slice(0, 100000), confidence: data.confidence, truncated: data.text.length > 100000}));
  } catch { process.exitCode = 1; } finally { if (worker) await worker.terminate(); }
});
