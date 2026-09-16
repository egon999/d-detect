# Synthetic processing fixtures

These files contain generated test data only. They are not evidence of an actual payment.

`synthetic-pdf-receipt.png` is a generated receipt showing **FAILED**, INR 2500.00, reference TEST-TX-2048, and 14 September 2026. `synthetic-scanned-payment.pdf` embeds that image without a text layer. `synthetic-mixed-payment.pdf` has a native-text cover followed by the scanned receipt, so extraction must preserve physical page numbers and distinguish native text from OCR.

Regenerate these three files with `node functions/test/helpers/pdf-fixtures.js` from the repository root. The generator uses the canvas package already installed by pdf-parse. Other fixtures in this directory belong to their existing test flows.

Run the bounded PDF renderer and orchestration tests with `node --test functions/test/pdf-ocr.test.js`. They use real PDF rasterization and injected OCR responses for deterministic error-path tests. Actual local OCR was separately checked against the generated receipt; the full source extraction returned native text on page 1 and OCR with the expected status, amount and reference on page 2. OCR language files are cached by the backend image OCR service and may require an internet connection the first time they are downloaded.
