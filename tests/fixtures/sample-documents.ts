/**
 * A corpus of source documents, for tests only.
 *
 * ## Why this is under `tests/`, not `src/`
 *
 * The product ships with no sample case, no seeded workspace and no pre-written findings:
 * a user's first launch shows an empty case list, because anything else would put invented
 * people and invented amounts in front of someone who opened the app to examine their own
 * documents. This file used to live in `src/data/seed/`, where nothing imported it at
 * runtime but one autocomplete would have been enough to change that. Under `tests/` the
 * guarantee is structural rather than a promise: Metro cannot reach it from the entry
 * point, so it cannot end up in an APK.
 *
 * ## What it is for
 *
 * A rule engine is only as trustworthy as the corpus it is tested against. These strings
 * are plain text of the kind the ingestion pass really produces from a PDF text layer or an
 * `.eml` export, and `build-sample-workspace.ts` runs them through the same
 * `extractFromText`, the same SHA-256 and the same engine as a live upload. Nothing here is
 * pre-computed — every conflict, duplicate and gap the assertions check is *derived*, so
 * changing a figure below changes what the engine finds, and a regression in normalisation
 * or in a rule shows up as a failing test rather than as a wrong answer on a real case.
 *
 * ## The document with `text: null`
 *
 * One item deliberately carries no readable text. Extraction can fail for real reasons —
 * an image too blurred to recognise, an encrypted PDF, a video with no speech — and the
 * pipeline has to produce an honest empty extraction and a `REVIEW_REQUIRED` state rather
 * than a plausible-looking guess. That path needs a test, so the corpus contains a case for
 * it. Never invent text for a `null`: doing so would test a record the app cannot produce.
 */

export interface SampleDocument {
  key: string;
  title: string;
  kind: 'PDF' | 'IMAGE' | 'TEXT' | 'EMAIL' | 'NOTE';
  fileName: string | null;
  mimeType: string | null;
  /**
   * The document's readable text, or `null` when the app genuinely cannot read this file
   * type. Never invent text for a `null` — see the note on OCR in the file header.
   */
  text: string | null;
  /** Bytes on disk, for a document with no readable text. Real files still have a size. */
  sizeBytes?: number;
}

const INVOICE_TEXT = `TAX INVOICE

Invoice Number: INV-2024-018
Invoice Date: 12/03/2024
Due Date: 26/03/2024

From: Pixelwave Studio
To: Harbour Retail Pvt Ltd

Description: Design and development of company website

Milestone 1 - Visual design                 INR 30,000.00
Milestone 2 - Development                   INR 45,000.00
Milestone 3 - Deployment and handover       INR 10,000.00

Total: INR 85,000.00

Payment terms: Net 14 days from final delivery.
Accounts contact: accounts@pixelwavestudio.in
Phone: +91 98204 41180
`;

export const SAMPLE_DOCUMENTS: readonly SampleDocument[] = [
  {
    key: 'invoice',
    title: 'Invoice INV-2024-018',
    kind: 'PDF',
    fileName: 'invoice-INV-2024-018.pdf',
    mimeType: 'application/pdf',
    text: INVOICE_TEXT,
  },
  {
    key: 'invoice-duplicate',
    title: 'Invoice (re-uploaded copy)',
    kind: 'PDF',
    fileName: 'invoice-final-copy.pdf',
    mimeType: 'application/pdf',
    // Byte-identical to the invoice above. This is what produces the duplicate finding —
    // the rule compares hashes, so an identical file under a different name is still caught.
    text: INVOICE_TEXT,
  },
  {
    key: 'agreement',
    title: 'Service agreement',
    kind: 'PDF',
    fileName: 'service-agreement-signed.pdf',
    mimeType: 'application/pdf',
    text: `SERVICE AGREEMENT

Client: Harbour Retail Pvt Ltd
Vendor: Pixelwave Studio
Date: 20/01/2024

Scope of work: Design and development of a company website delivered across three
milestones, including visual design, development and deployment.

Total contract value: INR 85,000.00
Payment terms: Net 14 days from final delivery.

Signed by both parties on 20 January 2024.
`,
  },
  {
    key: 'delivery-email',
    title: 'Delivery handover email (from Pixelwave)',
    kind: 'EMAIL',
    fileName: 'delivery-handover.eml',
    mimeType: 'message/rfc822',
    text: `From: Ravi Menon
To: accounts@harbourretail.in
Subject: Website delivery - final handover
Sent: 12 March 2024

Hi Neha,

The website is live and all three milestones are complete. The final handover package
with source files, deployment credentials and documentation has been uploaded to the
shared drive today.

Invoice No: INV-2024-018 for INR 85,000.00 was raised the same day. As agreed, payment
is due within 14 days of delivery.

Regards,
Ravi Menon
Pixelwave Studio
ravi@pixelwavestudio.in
`,
  },
  {
    key: 'client-reply',
    title: 'Client reply disputing handover date',
    kind: 'EMAIL',
    fileName: 'client-reply.eml',
    mimeType: 'message/rfc822',
    text: `From: Neha Kulkarni
To: ravi@pixelwavestudio.in
Subject: Re: Website delivery - final handover
Sent: 15 March 2024

Ravi,

Our team received the complete handover package on 15 March 2024. Two pages were still
returning server errors before that, so we cannot treat the earlier date as delivery.

We have released a part payment against Invoice No: INV-2024-018 and will review the
balance once the remaining fixes are confirmed.

Neha Kulkarni
Harbour Retail Pvt Ltd
neha@harbourretail.in
`,
  },
  {
    key: 'payment-receipt',
    title: 'NEFT payment confirmation',
    // A bank's downloaded confirmation is a PDF with a real text layer, which is what the
    // ingestion pass reads. It is deliberately not the screenshot below: this document has
    // to carry the INR 40,000 figure that produces the amount-mismatch finding, and a
    // figure the app cannot actually read would be a figure the app cannot actually use.
    kind: 'PDF',
    fileName: 'neft-confirmation-HDFC8841207733.pdf',
    mimeType: 'application/pdf',
    text: `PAYMENT CONFIRMATION

Transaction ID: HDFC8841207733
Payment Date: 28/03/2024
Status: Successful

Paid to: Pixelwave Studio
Paid by: Harbour Retail Pvt Ltd
Against Invoice No: INV-2024-018

Total amount paid: INR 40,000.00
Payment mode: NEFT
`,
  },
  {
    key: 'unreadable-screenshot',
    title: 'Screenshot of the payment app',
    /**
     * The unreadable case, and the reason the corpus contains one.
     *
     * Extraction genuinely fails on some files, and when it does the pipeline must yield an
     * empty extraction, no dates, no amounts, and a state that asks a person to look —
     * never a confident-looking reconstruction. That behaviour is load-bearing, so it is
     * asserted here rather than assumed.
     */
    kind: 'IMAGE',
    fileName: 'payment-app-screenshot.jpg',
    mimeType: 'image/jpeg',
    text: null,
    sizeBytes: 184_320,
  },
  {
    key: 'reminder-note',
    title: 'Note: follow-up call with client',
    kind: 'NOTE',
    fileName: null,
    mimeType: null,
    text: `Called Neha on 02/04/2024 about the outstanding balance. She said the remaining
amount would be released after an internal approval, but did not give a date. No written
confirmation of this call exists yet.
`,
  },
];

export function sampleDocument(key: string): SampleDocument {
  const found = SAMPLE_DOCUMENTS.find((document) => document.key === key);
  if (!found) throw new Error(`Unknown sample document: ${key}`);
  return found;
}

/**
 * The readable text of a sample document, for callers that require one.
 *
 * Throws rather than returning `''` for a document with no text. A caller asking for the
 * text of the unreadable item has made a mistake about what it represents, and an empty
 * string would let that mistake pass quietly into an assertion — which is the exact failure
 * this file is arranged to prevent.
 */
export function sampleText(key: string): string {
  const { text } = sampleDocument(key);
  if (text === null) {
    throw new Error(`Sample document "${key}" deliberately has no readable text.`);
  }
  return text;
}
