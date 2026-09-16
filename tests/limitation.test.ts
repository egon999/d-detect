import { describe, expect, it } from 'vitest';

import { forumProfile, type RedressalForum } from '@domain/analysis/escalation';
import { describeLimitation, limitationWindow } from '@domain/analysis/limitation';
import { normalizeDate } from '@domain/normalize/dates';

/**
 * The limitation window is arithmetic the user is expected to check, so these tests assert the
 * exact figures rather than ranges. A test that accepted "roughly a year" would not have caught
 * the off-by-thirty-days error that the RBI scheme's "one year and 30 days" invites.
 */

/** Epoch ms for a UTC day, so tests read as dates rather than as numbers. */
const at = (iso: string): number => Date.parse(`${iso}T00:00:00Z`);

const on = (iso: string) => normalizeDate(iso);

const windowFor = (forum: RedressalForum, complaint: string, today: string) =>
  limitationWindow(forumProfile(forum), on(complaint), at(today));

describe('limitation windows', () => {
  describe('the banking ladder', () => {
    it('runs 395 days from the complaint, being one year and 30 days', () => {
      // Complaint on 1 March 2024; the scheme's outer limit falls on 31 March 2025.
      const result = windowFor('BANKING', '2024-03-01', '2024-03-01');
      expect(result.daysRemaining).toBe(395);
      expect(result.closesOn).toBe('31 March 2025');
    });

    it('is open with a year to go', () => {
      const result = windowFor('BANKING', '2024-03-01', '2024-06-01');
      expect(result.state).toBe('OPEN');
      expect(result.daysRemaining).toBe(303);
    });

    it('cites the clause rather than stating the period on its own authority', () => {
      const result = windowFor('BANKING', '2024-03-01', '2024-06-01');
      expect(result.provision).toContain('Clause 10(2)(a)(ii)');
      expect(result.provision).toContain('Integrated Ombudsman Scheme, 2021');
    });

    it('does not offer a condonation route the scheme does not provide', () => {
      // The RBI scheme attaches no power to overlook this bar. Claiming otherwise would send
      // someone to ask for an indulgence the Ombudsman cannot grant.
      const result = windowFor('BANKING', '2024-03-01', '2024-06-01');
      expect(result.condonation).toBeNull();
    });

    it('points a late banking complainant at the route that is still open', () => {
      const result = windowFor('BANKING', '2024-03-01', '2026-09-15');
      expect(result.whenClosed).toContain('Consumer Protection Act, 2019');
    });
  });

  describe('the boundary', () => {
    it('is still open on the last day of the window', () => {
      const result = windowFor('BANKING', '2024-03-01', '2025-03-31');
      expect(result.daysRemaining).toBe(0);
      expect(result.state).not.toBe('CLOSED');
    });

    it('closes the day after', () => {
      const result = windowFor('BANKING', '2024-03-01', '2025-04-01');
      expect(result.state).toBe('CLOSED');
      expect(result.daysRemaining).toBe(-1);
    });

    it('reports how long ago it closed rather than clamping at zero', () => {
      // The difference between "closed yesterday" and "closed two years ago" is the
      // difference between acting today and not bothering.
      const result = windowFor('BANKING', '2024-03-01', '2026-09-15');
      expect(result.daysRemaining).toBe(-533);
      expect(describeLimitation(result)).toContain('533 days ago');
    });
  });

  describe('closing soon', () => {
    it('grades the last 60 days as closing rather than open', () => {
      const result = windowFor('BANKING', '2024-03-01', '2025-02-15');
      expect(result.state).toBe('CLOSING');
      expect(result.daysRemaining).toBe(44);
    });

    it('is still open at 61 days out', () => {
      const result = windowFor('BANKING', '2024-03-01', '2025-01-29');
      expect(result.daysRemaining).toBe(61);
      expect(result.state).toBe('OPEN');
    });
  });

  describe('the consumer ladder', () => {
    it('runs two years', () => {
      const result = windowFor('CONSUMER', '2024-03-01', '2024-03-01');
      expect(result.daysRemaining).toBe(730);
    });

    it('discloses that the complaint date stands in for the cause of action', () => {
      // The Act measures from the cause of action, which this app cannot determine. Measuring
      // from the complaint understates the time remaining, which is the safe direction, but
      // the reader is told rather than left to assume the date was the statutory one.
      const result = windowFor('CONSUMER', '2024-03-01', '2024-03-01');
      expect(result.anchorIsAssumed).toBe(true);
    });

    it('cites section 69 and the sufficient-cause provision', () => {
      const result = windowFor('CONSUMER', '2024-03-01', '2024-03-01');
      expect(result.provision).toContain('Section 69(1)');
      expect(result.condonation).toContain('69(2)');
    });
  });

  describe('the insurance ladder', () => {
    it('runs a year from a month after the representation', () => {
      const result = windowFor('INSURANCE', '2024-03-01', '2024-03-01');
      expect(result.daysRemaining).toBe(395);
    });

    it('cites rule 14(4) for condonation, which is a sub-rule and not a proviso', () => {
      const result = windowFor('INSURANCE', '2024-03-01', '2024-03-01');
      expect(result.condonation).toContain('Rule 14(4)');
    });

    it('measures from the date the representation was sent', () => {
      // The insurance rules run from sending; the RBI scheme runs from receipt. The wording
      // shown to the reader has to match the rule it cites.
      const result = windowFor('INSURANCE', '2024-03-01', '2024-03-01');
      expect(result.runsFrom).toContain('sent');
    });

    it('does not claim an assumed anchor, the rule naming its own trigger', () => {
      const result = windowFor('INSURANCE', '2024-03-01', '2024-03-01');
      expect(result.anchorIsAssumed).toBe(false);
    });
  });

  describe('when the app cannot know', () => {
    it('declines to compute a telecom window and says what to check instead', () => {
      // Regulation 9(3) gives thirty days, but from the expiry of the Regulation 8 period,
      // which defers to per-service Quality of Service rules. The trigger is not in any
      // document the app holds, so a number here would be arithmetic from the wrong day.
      const result = windowFor('TELECOM', '2024-03-01', '2024-06-01');
      expect(result.state).toBe('UNKNOWN');
      expect(result.daysRemaining).toBeNull();
      expect(result.unknownBecause).toContain('thirty days');
    });

    it('never quotes the telecom condonation ceiling as if it were the deadline', () => {
      // Three months is the outer limit for a late appeal allowed on sufficient cause, not
      // the window as of right. Quoting it as the deadline would overstate the time available
      // threefold.
      const result = windowFor('TELECOM', '2024-03-01', '2024-06-01');
      expect(result.unknownBecause).not.toContain('three months');
      expect(result.whenClosed).toContain('thirty days');
    });

    it('declines when the complaint is dated only to a month', () => {
      const result = limitationWindow(forumProfile('BANKING'), on('March 2024'), at('2024-06-01'));
      expect(result.state).toBe('UNKNOWN');
      expect(result.closesOn).toBeNull();
    });

    it('still cites the provision when the date is too coarse to count from', () => {
      // The window is unknown; the rule is not. A reader who fixes the date wants to know
      // which clause they are up against.
      const result = limitationWindow(forumProfile('BANKING'), on('March 2024'), at('2024-06-01'));
      expect(result.provision).toContain('Clause 10(2)(a)(ii)');
    });

    it('declines when the complaint is dated in the future', () => {
      const result = windowFor('BANKING', '2027-01-01', '2026-09-15');
      expect(result.state).toBe('UNKNOWN');
      expect(result.unknownBecause).toContain('future');
    });
  });

  describe('the sentence shown to the reader', () => {
    it('never tells someone their claim is dead', () => {
      const result = windowFor('BANKING', '2024-03-01', '2026-09-15');
      const text = describeLimitation(result);
      expect(text).not.toMatch(/too late|expired|barred|cannot file|no longer possible/i);
    });

    it('offers the consumer route rather than a condonation the RBI scheme lacks', () => {
      // The sentence must not imply the Ombudsman can be talked round. It points instead at
      // the forum whose own two-year clock may still be running.
      const text = describeLimitation(windowFor('BANKING', '2024-03-01', '2026-09-15'));
      expect(text).toContain('Consumer Protection Act, 2019');
      expect(text).not.toMatch(/condone/i);
    });

    it('does name condonation where the scheme actually provides it', () => {
      const text = describeLimitation(windowFor('INSURANCE', '2024-03-01', '2026-09-15'));
      expect(text).toContain('Rule 14(4)');
      expect(text).toMatch(/condone/i);
    });

    it('avoids the app-wide forbidden certainty words', () => {
      // The same product rule the rest of the app follows: nothing here proves or verifies.
      for (const iso of ['2024-06-01', '2025-02-15', '2026-09-15']) {
        const text = describeLimitation(windowFor('BANKING', '2024-03-01', iso));
        expect(text).not.toMatch(/\b(proves?|verified|confirmed|authentic)\b/i);
      }
    });

    it('states the closing date when the window is open', () => {
      expect(describeLimitation(windowFor('BANKING', '2024-03-01', '2024-06-01'))).toContain(
        '31 March 2025',
      );
    });

    it('singularises a one-day remainder', () => {
      const result = windowFor('BANKING', '2024-03-01', '2025-03-30');
      expect(describeLimitation(result)).toContain('1 day left');
    });
  });

  it('carries the forum so a window cannot be shown beside the wrong letter', () => {
    expect(windowFor('CONSUMER', '2024-03-01', '2024-06-01').forum).toBe('CONSUMER');
  });

  it('marks every computed window as approximate', () => {
    // A year is taken as 365 days. Someone within a day of the edge must check the scheme.
    expect(windowFor('BANKING', '2024-03-01', '2024-06-01').approximate).toBe(true);
  });
});
