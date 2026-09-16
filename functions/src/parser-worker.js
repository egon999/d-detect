"use strict";
// Isolated process: parser bugs or oversized objects cannot exhaust the API server heap.
const chunks = [];
let size = 0;
console.log = () => {};
console.warn = () => {};
process.stdin.on("data", (chunk) => { size += chunk.length; if (size > 100 * 1024 * 1024) process.exit(1); chunks.push(chunk); });
process.stdin.on("end", async () => {
  try {
    const bytes = Buffer.concat(chunks);
    let parts;
    let truncated = false;
    if (process.argv[2] === "pdf") {
      const {PDFParse} = require("pdf-parse");
      const parser = new PDFParse({data: new Uint8Array(bytes), isEvalSupported: false});
      try {
        const info = await parser.getInfo();
        const result = await parser.getText({first: 80});
        parts = result.pages.map((page) => ({text: page.text, page: page.num}));
        truncated = info.total > 80;
      } finally { await parser.destroy(); }
    } else {
      const {extractRawText} = require("mammoth");
      const result = await extractRawText({buffer: bytes});
      parts = [{text: result.value}];
    }
    let remaining = 40001;
    const bounded = [];
    for (const part of parts) {
      const text = part.text.slice(0, remaining);
      if (part.text.length > remaining) truncated = true;
      if (text) bounded.push({...part, text});
      remaining -= text.length;
    }
    process.stdout.write(JSON.stringify({parts: bounded, truncated}));
  } catch { process.exitCode = 1; }
});
