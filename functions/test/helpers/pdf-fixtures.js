"use strict";
// Public, synthetic fixtures only. No user documents, names or account data.
const {createCanvas} = require("@napi-rs/canvas");
const {deflateSync} = require("node:zlib");
function receiptImage() {
  const canvas = createCanvas(900, 650);
  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff"; context.fillRect(0, 0, 900, 650);
  context.fillStyle = "#111111";
  context.font = "bold 36px Arial"; context.fillText("SYNTHETIC PAYMENT RECEIPT", 45, 80);
  context.font = "30px Arial";
  ["Status: FAILED", "Amount: INR 2500.00", "Reference: TEST-TX-2048", "Date: 14 September 2026", "This fixture is not a real payment."].forEach((line, index) => context.fillText(line, 45, 155 + index * 78));
  const pixels = context.getImageData(0, 0, 900, 650).data;
  const rgb = Buffer.alloc(900 * 650 * 3);
  for (let input = 0, output = 0; input < pixels.length; input += 4) { rgb[output++] = pixels[input]; rgb[output++] = pixels[input + 1]; rgb[output++] = pixels[input + 2]; }
  return {png: canvas.toBuffer("image/png"), rgb, width: 900, height: 650};
}
function makePdf(pageKinds = ["native", "scan"], {declaredImageWidth, declaredImageHeight} = {}) {
  const image = receiptImage();
  const compressed = deflateSync(image.rgb);
  const objects = [null, null, Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"), Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${declaredImageWidth || image.width} /Height ${declaredImageHeight || image.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${compressed.length} >>\nstream\n`), compressed, Buffer.from("\nendstream")])];
  const kids = [];
  for (const kind of pageKinds) {
    const pageNumber = objects.length + 1;
    kids.push(`${pageNumber} 0 R`);
    const stream = kind === "native" ? "BT /F1 16 Tf 45 650 Td (Synthetic dispute cover: a customer claims a transfer succeeded.) Tj 0 -30 Td (The attached receipt must be checked before accepting that claim.) Tj ET" : "q 540 0 0 390 30 200 cm /Im1 Do Q" + (kind === "sparse" ? " BT /F1 12 Tf 30 700 Td (Receipt attachment) Tj ET" : "");
    objects.push(Buffer.from(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 780] /Resources << /Font << /F1 3 0 R >> /XObject << /Im1 4 0 R >> >> /Contents ${pageNumber + 1} 0 R >>`));
    objects.push(Buffer.from(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`));
  }
  objects[0] = Buffer.from("<< /Type /Catalog /Pages 2 0 R >>");
  objects[1] = Buffer.from(`<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${kids.length} >>`);
  const chunks = [Buffer.from("%PDF-1.4\n")];
  const offsets = [0];
  let position = chunks[0].length;
  objects.forEach((object, index) => {
    offsets.push(position);
    const chunk = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), object, Buffer.from("\nendobj\n")]);
    chunks.push(chunk); position += chunk.length;
  });
  chunks.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${position}\n%%EOF`));
  return Buffer.concat(chunks);
}
if (require.main === module) {
  const fs = require("node:fs");
  const path = require("node:path");
  const directory = path.join(__dirname, "..", "fixtures");
  fs.writeFileSync(path.join(directory, "synthetic-pdf-receipt.png"), receiptImage().png);
  fs.writeFileSync(path.join(directory, "synthetic-mixed-payment.pdf"), makePdf());
  fs.writeFileSync(path.join(directory, "synthetic-scanned-payment.pdf"), makePdf(["scan"]));
}
module.exports = {receiptImage, makePdf};
