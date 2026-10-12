import assert from 'node:assert/strict';
import { test } from 'node:test';

import { asSentence, looksTechnical, withoutIds, withoutIdsOrNull, withoutPlaceholders } from './prose.ts';

const ID = 'rec_2b368ec92e484a048f6e';

test('the answer that exposed this reads as a person would expect', () => {
  assert.equal(
    withoutIds(`You spent ₹2,450.00 on weekly groceries at Sharma Kirana Store (entry ${ID}).`),
    'You spent ₹2,450.00 on weekly groceries at Sharma Kirana Store.',
  );
});

test('an id is removed however the model chose to introduce it', () => {
  const cases: Array<[string, string]> = [
    [`Rent went out on the 5th (${ID})`, 'Rent went out on the 5th'],
    [`Rent went out on the 5th [${ID}]`, 'Rent went out on the 5th'],
    [`Rent went out on the 5th (see ${ID})`, 'Rent went out on the 5th'],
    [`Rent went out on the 5th (source: ${ID})`, 'Rent went out on the 5th'],
    [`Rent went out on the 5th — ${ID}`, 'Rent went out on the 5th'],
    [`Rent went out on the 5th: ${ID}`, 'Rent went out on the 5th'],
    [`Rent went out on the 5th, ${ID}.`, 'Rent went out on the 5th,.'],
    [`Entry ${ID} shows the rent.`, 'Entry shows the rent.'],
  ];
  for (const [input, expected] of cases) {
    assert.equal(withoutIds(input), expected, input);
  }
});

test('several ids in one parenthetical go together, brackets and all', () => {
  assert.equal(
    withoutIds(`Two payments that month (${ID}, mtg_9f1c4a7b22e04d1188aa and task_77b0e5c3419f4a6d90ff).`),
    'Two payments that month.',
  );
});

test('a parenthetical with real words in it keeps its brackets and loses only the id', () => {

  assert.equal(
    withoutIds(`Rent went out on the 5th (paid late, ${ID}).`),
    'Rent went out on the 5th (paid late,).',
  );
});

test('text with no id is returned byte for byte', () => {

  const clean = 'You spent ₹2,450.00  —  at  Sharma Kirana Store (weekly groceries).\n\nTwo entries. ';
  assert.equal(withoutIds(clean), clean);
});

test('things that look like ids but are the person\'s own data are untouched', () => {

  const keep = [
    'Paid to sharmakirana@ybl on the 28th.',
    'Transaction ID: T2609281142556677.',
    'The invoice number was INV_2026_0914.',
    'Their reference is order_id 44219.',
    'The file was named bank_statement_september.pdf.',
    'A snake_case note they wrote: paid_in_full.',
    'HDFC Bank ****4417 was debited.',
    'Reference abc_123def.',
  ];
  for (const text of keep) {
    assert.equal(withoutIds(text), text, text);
  }
});

test('an id must be a long run of hex, not merely long', () => {

  assert.equal(withoutIds('See rec_2b368ec92e484a048f6z for details.'), 'See rec_2b368ec92e484a048f6z for details.');
  assert.equal(withoutIds('See rec_2b368ec9 for details.'), 'See rec_2b368ec9 for details.');
  assert.equal(withoutIds(`See ${ID} for details.`), 'See for details.');
});

test('a field that was nothing but an id becomes empty rather than a stray fragment', () => {
  assert.equal(withoutIds(ID), '');
  assert.equal(withoutIds(`(${ID})`), '');
});

test('the nullable form keeps absence absent and never returns an empty string', () => {
  assert.equal(withoutIdsOrNull(null), null);
  assert.equal(withoutIdsOrNull(undefined), null);
  assert.equal(withoutIdsOrNull(''), null);
  assert.equal(withoutIdsOrNull('   '), null);
  assert.equal(withoutIdsOrNull(ID), null);
  assert.equal(withoutIdsOrNull(`Shall I break ${ID} down by category?`), 'Shall I break down by category?');
});

test('the pattern is stateless across calls', () => {

  const text = `Two entries (${ID}).`;
  assert.equal(withoutIds(text), withoutIds(text));
  assert.equal(withoutIds('No ids here.'), 'No ids here.');
  assert.equal(withoutIds('No ids here.'), 'No ids here.');
});

test('a model saying it has nothing becomes nothing, not a value on a card', () => {

  for (const nothing of [
    'unknown', 'Unknown', 'UNKNOWN', 'unspecified', 'not specified', 'Not Available',
    'not applicable', 'N/A', 'n/a', 'NA', 'none', 'None', 'nil', 'null', 'undefined',
    'missing', 'blank', 'Untitled', 'No text', 'no title', 'TBD', '?', '--', '—', '...', '_',
    '"unknown"', '(none)', '   ', '',
  ]) {
    assert.equal(withoutPlaceholders(nothing), null, JSON.stringify(nothing));
  }
  assert.equal(withoutPlaceholders(null), null);
  assert.equal(withoutPlaceholders(undefined), null);
  assert.equal(withoutPlaceholders(ID), null);
});

test('a real value that merely contains one of those words is kept whole', () => {

  for (const real of [
    'Nil Kamal Furniture', 'Unknown Traders Pvt Ltd', 'None of the items were delivered',
    'Naan and curry', 'No. 14 Market Road', 'Sharma Electronics', '₹4,500.00 paid',
    'The amount is not specified on the slip',
  ]) {
    assert.equal(withoutPlaceholders(real), real, real);
  }
});

test('a sentence about the machine is recognised so plain words can replace it', () => {
  for (const inside of [
    'Could not parse the JSON response.',
    'OCR returned null for this image.',
    'The amount field value was undefined.',
    'See the extraction payload for details.',
    'Request failed with status code 429.',
    'The schema validation threw an exception.',
    'base64 decode error',
  ]) {
    assert.equal(looksTechnical(inside), true, inside);
  }
  for (const fine of [
    'I could not read this clearly. Check the amount against the picture.',
    'Paid ₹4,500.00 to Sharma Electronics by UPI.',
    'This page was too dark to read.',
    'यह बिल अन्ना पूर्णा मेस का है।',
    'The last three pages were not read.',
  ]) {
    assert.equal(looksTechnical(fine), false, fine);
  }
  assert.equal(looksTechnical(null), false);
  assert.equal(looksTechnical(undefined), false);
});

test('the machine\'s own proper nouns never reach a sentence a person reads', () => {

  for (const inside of [
    'The vision model could not read the amount.',
    'Groq returned nothing for this page.',
    'Read with tesseract at low confidence.',
    'Confidence in this reading is low.',
    'gemini-2.0-flash declined the image.',
    'Transcribed with whisper-large-v3-turbo.',
    'The gpt-oss reply was empty.',
    'The AI provider is unavailable.',
    'The system prompt was rejected.',
    'ENOENT while opening the file.',
    'Failed with errno -4058.',
    'Could not open C:\\Users\\ayush\\.data\\detact.db.',
    'Saved to /var/data/uploads/receipt.png.',
    'Served from localhost on port 8787.',
    'File digest 9f1c4a7b22e04d118812e484a048f6ec3a9b7d41 did not match.',
    'The upload was 0 bytes.',
    'Could not decode the image.',
  ]) {
    assert.equal(looksTechnical(inside), true, inside);
  }
});

test('a document that merely uses one of those words is still readable', () => {

  for (const real of [

    'Vision Eye Care Centre, Koramangala',
    'Bill from Gemini Edibles Pvt Ltd',
    'Model Public School — term fees',

    'Model: WM-6102, Serial 4417829',
    'Washing machine, model number WM-6102',

    'Hash browns and filter coffee',
    'Prompt payment discount of 2% applied',
    'Dispute resolution under clause 14',
    'Your service provider is Airtel',
    'EMAIL: accounts@sharmaelectronics.in',
    'Confidentiality agreement, two pages',
    'No. 14/2, MG Road, Bengaluru',

    'UPI transaction ID 462839175503',
    'Meter number 100020003000400050006000700080009000',

    'Only the first 12 pages of this file were read.',
    'That file is empty. Try uploading it again.',
    'Nothing could be read in this picture. Try taking a fresh photo in good light.',
    'This file is password protected. Remove the password and upload it again.',
  ]) {
    assert.equal(looksTechnical(real), false, real);
  }
});

test('a sentence this server writes itself is tidied, and other scripts are left alone', () => {  assert.equal(asSentence('  paid   to Sharma   Electronics  '), 'Paid to Sharma Electronics.');
  assert.equal(asSentence('Already a sentence.'), 'Already a sentence.');
  assert.equal(asSentence('Is this right?'), 'Is this right?');
  assert.equal(asSentence('₹4,500.00 paid'), '₹4,500.00 paid.');

  assert.equal(asSentence('यह बिल पढ़ा नहीं जा सका।'), 'यह बिल पढ़ा नहीं जा सका।');
  assert.equal(asSentence('   '), '');
});
