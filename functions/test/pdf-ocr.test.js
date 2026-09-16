"use strict";
const {test} = require("node:test");
const assert = require("node:assert/strict");
const {renderPdfPages, extractPdfWithOcr} = require("../src/pdf-ocr");
const {makePdf} = require("./helpers/pdf-fixtures");

test("mixed PDF preserves native page and rasterizes the scanned page with real canvas", async () => {
  const result = await renderPdfPages(makePdf());
  assert.equal(result.totalPages, 2);
  assert.match(result.pages[0].text, /customer claims a transfer succeeded/);
  assert.equal(result.scans.length, 1);
  assert.equal(result.scans[0].page, 2);
  assert.deepEqual(Buffer.from(result.scans[0].png, "base64").subarray(0, 8), Buffer.from([137,80,78,71,13,10,26,10]));
  assert.ok(result.scans[0].width * result.scans[0].height <= 4 * 1024 * 1024);
});
test("selectable header on a scanned page does not suppress OCR", async () => {
  const result = await renderPdfPages(makePdf(["sparse"]));
  assert.match(result.pages[0].text, /Receipt attachment/);
  assert.deepEqual(result.scans.map((page) => page.page), [1]);
});
test("rendering stops at ten OCR pages and names omitted pages", async () => {
  const result = await renderPdfPages(makePdf(Array(12).fill("scan")));
  assert.equal(result.totalPages, 12);
  assert.equal(result.scans.length, 10);
  assert.deepEqual(result.excludedOcrPages, [11, 12]);
});
test("malformed and empty PDFs fail with a safe diagnostic", async () => {
  await assert.rejects(renderPdfPages(Buffer.from("%PDF-1.4 broken")), /could not be rendered safely/);
  await assert.rejects(renderPdfPages(Buffer.alloc(0)), /empty/);
});
test("a skipped oversized embedded image marks the rendered PDF incomplete", async () => {
  const result = await renderPdfPages(makePdf(["sparse"], {declaredImageWidth: 9000, declaredImageHeight: 9000}));
  assert.equal(result.omittedContent, true);
  assert.equal(result.truncated, true);
});
const rendered = () => ({pages: [{page: 1, text: "Native cover", method: "DETERMINISTIC"}, {page: 2, text: "", method: "DETERMINISTIC"}], scans: [{page: 2, png: Buffer.from("synthetic").toString("base64")}], excludedOcrPages: [], totalPages: 2, truncated: false});
test("OCR passages preserve page provenance and method without inventing facts", async () => {
  const result = await extractPdfWithOcr(Buffer.from("test"), {render: async () => rendered(), ocr: async () => ({text: "Status: FAILED\nAmount: INR 2500.00", limitations: ["Review original."]})});
  assert.deepEqual(result.parts.map((part) => [part.page, part.method]), [[1, "DETERMINISTIC"], [2, "OCR"]]);
  assert.equal(result.parts[1].text, "Status: FAILED\nAmount: INR 2500.00");
  assert.match(result.limitations.join(" "), /not a verified fact/);
  assert.deepEqual(result.coverage.ocrPages, [2]);
});
test("failed OCR retains native text and marks source coverage partial", async () => {
  const result = await extractPdfWithOcr(Buffer.from("test"), {render: async () => rendered(), ocr: async () => { throw new Error("private parser detail"); }});
  assert.equal(result.parts.length, 1);
  assert.equal(result.truncated, true);
  assert.deepEqual(result.coverage.excludedOcrPages, [2]);
  assert.ok(!JSON.stringify(result).includes("private parser detail"));
});
test("scanned-only OCR failure cannot become successful empty evidence", async () => {
  await assert.rejects(extractPdfWithOcr(Buffer.from("test"), {render: async () => ({...rendered(), pages: []}), ocr: async () => { throw new Error("OCR unavailable"); }}), /OCR unavailable/);
});
test("partial OCR budget remains explicit even when some pages were extracted", async () => {
  const result = await extractPdfWithOcr(Buffer.from("test"), {render: async () => ({...rendered(), totalPages: 90, excludedOcrPages: [11,12], truncated: true}), ocr: async () => ({text: "Receipt", limitations: []})});
  assert.equal(result.truncated, true);
  assert.match(result.limitations.join(" "), /Pages 11, 12 were not visually extracted/);
  assert.match(result.limitations.join(" "), /first 80 of 90/);
});
test("OCR truncation and renderer omissions remain visible to case analysis", async () => {
  const result = await extractPdfWithOcr(Buffer.from("test"), {render: async () => ({...rendered(), omittedContent: true, truncated: true}), ocr: async () => ({text: "Partial receipt", truncated: true, limitations: ["OCR output truncated."]})});
  assert.equal(result.truncated, true);
  assert.match(result.limitations.join(" "), /renderer omitted/);
  assert.match(result.limitations.join(" "), /OCR output truncated/);
});
