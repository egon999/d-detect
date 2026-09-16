import { beforeEach, describe, expect, it } from 'vitest';

import {
  complaintDocuments,
  complaintSignal,
  detectForum,
  forumProfile,
  latestDatedDay,
  longestSilence,
  nowAsDate,
  type RedressalForum,
} from '@domain/analysis/escalation';
import type { Evidence } from '@domain/models';

import { evidence, resetIds } from './helpers';

/**
 * The redressal ladder: which one a complaint sits on, and when its silence is worth
 * mentioning.
 *
 * Every test here builds its evidence by running real text through the real extractor (the
 * shared `evidence()` helper), so the dates this module reasons from are the ones the
 * extractor actually produces. A test that hand-wrote an `Extraction` would keep passing
 * after the date parser stopped finding the date.
 *
 * The bar for this module is not "does it fire" — it is "does it stay quiet". A finding that
 * names the wrong regulator, or that says nobody replied when somebody did, is worse than no
 * finding at all, so most of what follows is about silence.
 */

const extractionOf = (items: readonly Evidence[]) => (id: string) =>
  items.find((item) => item.id === id)?.extraction ?? null;

/** 2024-06-01, as epoch ms. Every elapsed count below is measured against this. */
const JUNE_1 = Date.UTC(2024, 5, 1);

const BANK_COMPLAINT = [
  'To: Grievance Officer, State Bank',
  'Date: 01/03/2024',
  'Complaint reference: SBI/GRV/88421',
  'I am writing to complain about a failed UPI transfer from my savings account.',
  'Account Number: 3081 4429 0071, IFSC: SBIN0001234',
  'The amount was debited but never credited. Kindly resolve and refund.',
].join('\n');

beforeEach(resetIds);

describe('detectForum', () => {
  it('routes a bank complaint to banking on its own vocabulary', () => {
    expect(detectForum(BANK_COMPLAINT)).toBe('BANKING');
  });

  it('routes an insurance rejection to insurance', () => {
    const text = [
      'Policy Number: HLT/2023/99120',
      'Your claim has been repudiated under clause 4(b).',
      'The premium for the sum insured was received on 12/01/2024.',
    ].join('\n');
    expect(detectForum(text)).toBe('INSURANCE');
  });

  it('routes a broadband complaint to telecom', () => {
    const text = [
      'Broadband connection down since 04/02/2024.',
      'Landline number 080-4455-2211, postpaid account.',
      'No network coverage at the registered address.',
    ].join('\n');
    expect(detectForum(text)).toBe('TELECOM');
  });

  it('says nothing when one stray word is the only signal', () => {
    // The failure this guards: a builder's invoice mentioning a UPI payment is not a
    // banking dispute, and pointing its owner at the RBI Ombudsman would waste their time
    // on the strength of a single word.
    expect(detectForum('Payment for tiling work, paid by UPI on 03/03/2024.')).toBeNull();
  });

  it('says nothing when two sectors are equally indicated', () => {
    // A premium paid by NEFT is an entirely ordinary document and genuinely ambiguous: the
    // insurer's ombudsman and the banking ombudsman are different forums, and guessing
    // between them is worse than falling back to the consumer route.
    const text = [
      'Policy Number: LIF/2022/4410. Premium and sum assured as per schedule.',
      'Paid by NEFT from savings account 4400221199, IFSC HDFC0000123.',
    ].join('\n');
    expect(detectForum(text)).toBeNull();
  });

  it('says nothing about empty or unremarkable text', () => {
    expect(detectForum('')).toBeNull();
    expect(detectForum('   ')).toBeNull();
    expect(detectForum('Thanks for your email. Attached is the file you asked for.')).toBeNull();
  });
});

describe('forumProfile', () => {
  const forums: RedressalForum[] = ['BANKING', 'INSURANCE', 'TELECOM', 'CONSUMER'];

  it.each(forums)('gives %s a named scheme, a named next step and a route', (forum) => {
    const profile = forumProfile(forum);
    // The product rule this encodes: a quoted window is only usable if the reader can go
    // and check it, so a profile without its citation is not shippable.
    expect(profile.scheme.length).toBeGreaterThan(0);
    expect(profile.nextStep.length).toBeGreaterThan(0);
    expect(profile.where.length).toBeGreaterThan(0);
    expect(profile.replyWindowDays).toBeGreaterThan(0);
  });

  it.each(forums)('never states %s guidance in language of proof', (forum) => {
    const profile = forumProfile(forum);
    const copy = `${profile.sector} ${profile.nextStep} ${profile.scheme} ${profile.where}`;
    expect(copy).not.toMatch(/\b(proves|proven|verified|confirmed|authentic|guaranteed)\b/i);
  });
});

describe('complaintSignal', () => {
  it('reads the organisation’s own reference out of a complaint', () => {
    const signal = complaintSignal(BANK_COMPLAINT);
    expect(signal?.reference).toBe('SBI/GRV/88421');
  });

  it('treats a printed reference as worth more than complaining language', () => {
    // A reference number is the organisation's own record that a complaint entered its
    // system. Nothing a customer can write is equivalent to it.
    const withRef = complaintSignal('Docket No: TEL-99-2201 raised for the connection.');
    expect(withRef).not.toBeNull();
    expect(withRef?.reference).toBe('TEL-99-2201');
  });

  it('accepts a complaint with no reference when the language is unambiguous', () => {
    const signal = complaintSignal(
      'This is to complain about the delay. Kindly refund the amount. Nodal Officer copied.',
    );
    expect(signal).not.toBeNull();
    expect(signal?.reference).toBeNull();
  });

  it('stays null for an ordinary document that merely mentions a problem', () => {
    expect(complaintSignal('The delivery was late again this month.')).toBeNull();
    expect(complaintSignal('Invoice for March. Amount due: INR 4,000.')).toBeNull();
    expect(complaintSignal('')).toBeNull();
  });
});

describe('complaintDocuments', () => {
  it('finds the complaint and the ladder it sits on', () => {
    const items = [evidence(BANK_COMPLAINT, { id: 'evd_c', title: 'Complaint to bank' })];

    const found = complaintDocuments(items, extractionOf(items));
    expect(found).toHaveLength(1);
    expect(found[0]?.evidenceId).toBe('evd_c');
    expect(found[0]?.forum).toBe('BANKING');
    expect(found[0]?.date.iso).toBe('2024-03-01');
  });

  it('anchors the clock at the latest date the complaint carries, not the earliest', () => {
    // A complaint quotes the transaction it is about, and cannot mention a date that had
    // not happened when it was written — so its latest date is a lower bound on its own
    // age. Anchoring there understates the silence, which is the safe direction to be
    // wrong in: the rule speaks later rather than printing a number that is too big.
    const text = [
      'Complaint reference: ABC/1199 dated 05/01/2024.',
      'Regarding the transaction of 20/02/2024 which was never reversed.',
      'Kindly refund. Escalating to the Nodal Officer.',
    ].join('\n');
    const items = [evidence(text, { id: 'evd_c' })];

    expect(complaintDocuments(items, extractionOf(items))[0]?.date.iso).toBe('2024-02-20');
  });

  it('ignores a complaint whose date is only a month', () => {
    // "March 2024" could start the clock anywhere in a 31-day range. The entire value of
    // the elapsed count is that the reader can check it against their own document.
    const items = [
      evidence('Complaint reference: X/1 was registered in March 2024. Kindly resolve.', { id: 'evd_c' }),
    ];
    expect(complaintDocuments(items, extractionOf(items))).toEqual([]);
  });

  it('ignores evidence that was never extracted', () => {
    const items = [evidence(BANK_COMPLAINT, { id: 'evd_c', extraction: null })];
    expect(complaintDocuments(items, extractionOf(items))).toEqual([]);
  });

  it('falls back to the consumer route when the sector is unclear', () => {
    const text = [
      'Complaint reference: SHOP/4411 dated 01/03/2024.',
      'The furniture delivered was damaged. Kindly resolve or refund.',
    ].join('\n');
    const items = [evidence(text, { id: 'evd_c' })];

    // Consumer commissions hear every sector, so this is never the wrong forum — only a
    // less specific one than the document might have supported.
    expect(complaintDocuments(items, extractionOf(items))[0]?.forum).toBe('CONSUMER');
  });

  it('returns complaints in date order, with ties broken by id', () => {
    const later = evidence('Complaint reference: SBI/GRV/2200 dated 10/03/2024. Kindly resolve.', { id: 'evd_b' });
    const earlier = evidence('Complaint reference: SBI/GRV/1100 dated 01/03/2024. Kindly resolve.', { id: 'evd_a' });
    const items = [later, earlier];

    expect(complaintDocuments(items, extractionOf(items)).map((c) => c.evidenceId)).toEqual([
      'evd_a',
      'evd_b',
    ]);
  });
});

describe('latestDatedDay', () => {
  it('finds the most recent day across every evidence item', () => {
    const items = [
      evidence('Complaint reference: A/1 dated 01/03/2024. Kindly resolve.', { id: 'evd_a' }),
      evidence('Reply sent 18/03/2024 regarding your request.', { id: 'evd_b' }),
    ];

    const latest = latestDatedDay(items, extractionOf(items));
    expect(latest?.date.iso).toBe('2024-03-18');
    expect(latest?.evidenceId).toBe('evd_b');
  });

  it('is null when nothing carries a day-precision date', () => {
    const items = [evidence('No dates here at all.', { id: 'evd_a' })];
    expect(latestDatedDay(items, extractionOf(items))).toBeNull();
  });
});

describe('longestSilence', () => {
  it('reports a complaint that has outlasted its scheme’s reply window', () => {
    const items = [evidence(BANK_COMPLAINT, { id: 'evd_c', title: 'Complaint to bank' })];

    const silence = longestSilence(items, extractionOf(items), JUNE_1);
    expect(silence).not.toBeNull();
    expect(silence?.complaint.evidenceId).toBe('evd_c');
    expect(silence?.profile.forum).toBe('BANKING');
    // 1 March to 1 June 2024, inclusive of the leap day.
    expect(silence?.daysElapsed).toBe(92);
  });

  it('stays quiet while the window is still open', () => {
    const items = [evidence(BANK_COMPLAINT, { id: 'evd_c' })];

    // 20 days after the complaint: the bank still has time, and saying anything here would
    // push someone to escalate before the organisation has had the period it is owed.
    const twentyDays = Date.UTC(2024, 2, 21);
    expect(longestSilence(items, extractionOf(items), twentyDays)).toBeNull();
  });

  it('stays quiet on the day the window closes, and speaks the day after', () => {
    const items = [evidence(BANK_COMPLAINT, { id: 'evd_c' })];
    const window = forumProfile('BANKING').replyWindowDays;

    const dayBefore = Date.UTC(2024, 2, 1 + window - 1);
    const onTheDay = Date.UTC(2024, 2, 1 + window);
    expect(longestSilence(items, extractionOf(items), dayBefore)).toBeNull();
    expect(longestSilence(items, extractionOf(items), onTheDay)?.daysElapsed).toBe(window);
  });

  it('stays quiet when anything in the case is dated after the complaint', () => {
    // The failure this prevents is the worst one this rule can produce: telling someone
    // nobody answered them when the answer is sitting in their own case.
    const items = [
      evidence(BANK_COMPLAINT, { id: 'evd_c' }),
      evidence('Dear Customer, further to your request dated 09/04/2024, we have credited the amount.', {
        id: 'evd_r',
      }),
    ];

    expect(longestSilence(items, extractionOf(items), JUNE_1)).toBeNull();
  });

  it('does not let a complaint’s own quoted dates silence it', () => {
    // The false negative this guards. One document, quoting a debit dated after its own
    // reference line, and nothing in the case from anyone else. An earlier version scanned
    // every item including the complaint, so the complaint's own quoted date counted as
    // "something happened after this" — and the most thoroughly written complaints, whose
    // owners most need the prompt, were exactly the ones that suppressed it.
    const text = [
      'Complaint reference: BNK/7781 dated 01/03/2024.',
      'The recurring debit on 15/03/2024 has still not been reversed.',
      'Savings account 4400221199, IFSC HDFC0000123, UPI reference 402288119900.',
      'Kindly resolve. Escalating to the Nodal Officer.',
    ].join('\n');
    const items = [evidence(text, { id: 'evd_c' })];

    const silence = longestSilence(items, extractionOf(items), JUNE_1);
    expect(silence).not.toBeNull();
    expect(silence?.complaint.evidenceId).toBe('evd_c');
    // Anchored at the latest date the complaint carries: 15 March, not 1 March.
    expect(silence?.daysElapsed).toBe(78);
  });

  it('stays quiet when there is no complaint at all', () => {
    const items = [evidence('Invoice for March. Amount due: INR 4,000 by 31/03/2024.', { id: 'evd_i' })];
    expect(longestSilence(items, extractionOf(items), JUNE_1)).toBeNull();
  });

  it('stays quiet when the complaint is dated in the future', () => {
    // A typo or a device clock that is wrong. Either way it is not a silence, and a
    // negative elapsed count must never reach a sentence shown to a person.
    const items = [evidence(BANK_COMPLAINT, { id: 'evd_c' })];
    const beforeTheComplaint = Date.UTC(2024, 0, 1);
    expect(longestSilence(items, extractionOf(items), beforeTheComplaint)).toBeNull();
  });

  it('reports the longest-running silence when a case holds more than one complaint', () => {
    const items = [
      evidence('Complaint reference: A/1 dated 01/02/2024. Kindly resolve. Nodal Officer copied.', {
        id: 'evd_a',
      }),
      evidence('Complaint reference: B/2 dated 01/03/2024. Kindly resolve. Nodal Officer copied.', {
        id: 'evd_b',
      }),
    ];

    // Both are past the window, but B is dated after A — so nothing is silent since A, and
    // only the later complaint is genuinely unanswered.
    const silence = longestSilence(items, extractionOf(items), JUNE_1);
    expect(silence?.complaint.evidenceId).toBe('evd_b');
  });

  it('is stable across the day: two runs on the same date agree', () => {
    const items = [evidence(BANK_COMPLAINT, { id: 'evd_c' })];
    const morning = Date.UTC(2024, 5, 1, 3, 15);
    const night = Date.UTC(2024, 5, 1, 23, 45);

    expect(longestSilence(items, extractionOf(items), morning)?.daysElapsed).toBe(
      longestSilence(items, extractionOf(items), night)?.daysElapsed,
    );
  });
});

describe('nowAsDate', () => {
  it('reads the clock in UTC, at day precision', () => {
    expect(nowAsDate(Date.UTC(2024, 5, 1, 12, 0))).toEqual({
      original: '2024-06-01',
      iso: '2024-06-01',
      precision: 'DAY',
      ambiguous: false,
    });
  });

  it('pads single-digit months and days', () => {
    expect(nowAsDate(Date.UTC(2024, 0, 5)).iso).toBe('2024-01-05');
  });
});
