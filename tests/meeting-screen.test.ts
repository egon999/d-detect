/**
 * The decisions behind the meeting screen and the attention list.
 *
 * These are the functions that turn what the server sent into what a person sees, and each
 * has a wrong answer that would reach somebody's eyes: a language nobody could place rendering
 * as `UND`, a blank page for a meeting that came back empty, a stack trace under a recording
 * that failed, a timer asking the server four hundred times about a three-hour meeting.
 *
 * They are tested here rather than through the screen because detact has no component-render
 * harness, and because logic reachable only by rendering is logic that drifts.
 */

import { describe, expect, it } from 'vitest';

import {
  ATTENTION_LOOK_CEILING_MS,
  attentionIsCitable,
  attentionPollDelayMs,
} from '../src/api/attention';
import {
  MEETING_POLL_MIN_MS,
  canRetryMeeting,
  formatRecordingClock,
  formatSpokenLength,
  languageDisplayName,
  meetingHasNothingToShow,
  meetingInProgress,
  meetingParagraphs,
  meetingPassages,
  meetingPlainText,
  meetingPollDelayMs,
  meetingStartInputs,
  meetingStoppedPartway,
  meetingTroubleMessage,
  parseMeetingStart,
  type MeetingDetail,
  type MeetingStatus,
} from '../src/api/meetings';

function meetingFixture(over: Partial<MeetingDetail> = {}): MeetingDetail {
  return {
    id: 'm1',
    title: 'Meeting with the landlord',
    status: 'complete',
    language: 'hi',
    durationMs: 1_500_000,
    startedAt: 1_767_000_000_000,
    startedAtEstimated: false,
    note: '',
    endedAt: null,
    createdAt: 1_767_000_000_000,
    updatedAt: 1_767_000_000_000,
    error: null,
    fileId: 'f1',
    summary: null,
    intelligence: {},
    tasks: [],
    transcript: null,
    ...over,
  };
}

describe('Where a recording has got to', () => {
  it('keeps watching only while something is still moving', () => {
    expect(meetingInProgress({ status: 'transcribing', error: null })).toBe(true);
    expect(meetingInProgress({ status: 'transcribed', error: null })).toBe(true);
    expect(meetingInProgress({ status: 'complete', error: null })).toBe(false);
    expect(meetingInProgress({ status: 'failed', error: 'Nothing could be heard.' })).toBe(false);
  });

  it('stops watching a half-finished meeting that has stopped', () => {
    // The spinner that outlives its request: words saved, reading given up, status never
    // reaching an end state. Polling this forever is what the old fixed timer did.
    const stuck = { status: 'transcribed' as MeetingStatus, error: 'Reading this did not finish.' };
    expect(meetingInProgress(stuck)).toBe(false);
    expect(meetingStoppedPartway(stuck)).toBe(true);
  });

  it('does not call a finished or still-running meeting half-finished', () => {
    expect(meetingStoppedPartway({ status: 'complete', error: null })).toBe(false);
    expect(meetingStoppedPartway({ status: 'failed', error: 'It could not be read.' })).toBe(false);
    expect(meetingStoppedPartway({ status: 'transcribing', error: null })).toBe(false);
  });

  it('offers another attempt exactly where the server would accept one', () => {
    expect(canRetryMeeting({ status: 'failed' })).toBe(true);
    expect(canRetryMeeting({ status: 'transcribed' })).toBe(true);
    expect(canRetryMeeting({ status: 'complete' })).toBe(false);
    expect(canRetryMeeting({ status: 'transcribing' })).toBe(false);
  });
});

describe('How often to ask', () => {
  it('starts tight, because that is when short meetings finish', () => {
    expect(meetingPollDelayMs(0)).toBe(MEETING_POLL_MIN_MS);
    expect(meetingPollDelayMs(29_999)).toBe(MEETING_POLL_MIN_MS);
  });

  it('opens the gap as the wait drags on', () => {
    expect(meetingPollDelayMs(30_000)).toBe(6_000);
    expect(meetingPollDelayMs(120_000)).toBe(15_000);
    expect(meetingPollDelayMs(6 * 60_000)).toBe(30_000);
    expect(meetingPollDelayMs(3 * 60 * 60_000)).toBe(30_000);
  });

  it('never returns zero, however strange the clock', () => {
    for (const odd of [-1, Number.NaN, Number.POSITIVE_INFINITY, -50_000]) {
      expect(meetingPollDelayMs(odd)).toBeGreaterThanOrEqual(MEETING_POLL_MIN_MS);
    }
  });

  it('asks far fewer times across an hour than a fixed timer would', () => {
    // A fixed 2.5s timer is 1,440 requests an hour on somebody's radio and battery.
    let asks = 0;
    for (let waited = 0; waited < 60 * 60_000; waited += meetingPollDelayMs(waited)) asks += 1;
    expect(asks).toBeLessThan(200);
  });
});

describe('Naming the language a meeting was held in', () => {
  it('says the name, not the code', () => {
    expect(languageDisplayName('hi', 'en')).toBe('Hindi');
    expect(languageDisplayName(' ta ', 'en')).toBe('Tamil');
    // A regional tag is named too, however the platform's data words it ("English (India)"
    // on one build, "Indian English" on another). What matters is that it is words.
    expect(languageDisplayName('en-IN', 'en')).toMatch(/English/);
  });

  it('says nothing at all when the language could not be placed', () => {
    // `und` reached the old header as `UND`. Nothing is the honest rendering of "unknown".
    for (const code of ['und', 'UND', 'unknown', 'zxx', 'mul', 'mis', 'n/a', '', '   ']) {
      expect(languageDisplayName(code, 'en')).toBeNull();
    }
    expect(languageDisplayName(null)).toBeNull();
    expect(languageDisplayName(undefined)).toBeNull();
  });

  it('never hands back a raw token for a tag nobody can name', () => {
    const named = languageDisplayName('qqz', 'en');
    expect(named === null || named.toLowerCase() !== 'qqz').toBe(true);
  });

  it('passes through a value that is already a name', () => {
    expect(languageDisplayName('Hindi', 'en')).toBe('Hindi');
    expect(languageDisplayName('Punjabi (Gurmukhi)', 'en')).toBe('Punjabi (Gurmukhi)');
  });
});

describe('Saying how long it ran', () => {
  it('reads as a clock while the recording plays', () => {
    expect(formatRecordingClock(0)).toBe('0:00');
    expect(formatRecordingClock(7_400)).toBe('0:07');
    expect(formatRecordingClock(65_000)).toBe('1:05');
    expect(formatRecordingClock(3_600_000)).toBe('1:00:00');
    expect(formatRecordingClock(3_725_000)).toBe('1:02:05');
  });

  it('never shows a negative or missing position as anything but zero', () => {
    expect(formatRecordingClock(null)).toBe('0:00');
    expect(formatRecordingClock(undefined)).toBe('0:00');
    expect(formatRecordingClock(-5_000)).toBe('0:00');
    expect(formatRecordingClock(Number.NaN)).toBe('0:00');
  });

  it('reads as words in the header', () => {
    expect(formatSpokenLength(20_000)).toBe('Under a minute');
    expect(formatSpokenLength(1_500_000)).toBe('25 min');
    expect(formatSpokenLength(3_600_000)).toBe('1 hr');
    expect(formatSpokenLength(6_000_000)).toBe('1 hr 40 min');
  });

  it('says nothing rather than claim a meeting lasted no time', () => {
    expect(formatSpokenLength(null)).toBeNull();
    expect(formatSpokenLength(0)).toBeNull();
    expect(formatSpokenLength(-1)).toBeNull();
    expect(formatSpokenLength(Number.NaN)).toBeNull();
  });
});

describe('A meeting that came back with nothing in it', () => {
  it('is the state that used to render a blank page', () => {
    expect(meetingHasNothingToShow(meetingFixture())).toBe(true);
  });

  it('is not claimed when there is anything to show', () => {
    expect(meetingHasNothingToShow(meetingFixture({ summary: 'They agreed to repair the roof.' }))).toBe(false);
    expect(meetingHasNothingToShow(meetingFixture({ transcript: 'कुछ कहा गया था' }))).toBe(false);
    expect(meetingHasNothingToShow(meetingFixture({ intelligence: { topics: ['Rent'] } }))).toBe(false);
    expect(meetingHasNothingToShow(meetingFixture({ intelligence: { decisions: ['Pay by Friday'] } }))).toBe(false);
    expect(meetingHasNothingToShow(meetingFixture({ intelligence: { keyPoints: ['The lease ends in May'] } }))).toBe(false);
    expect(meetingHasNothingToShow(meetingFixture({ intelligence: { attention: ['No receipt yet'] } }))).toBe(false);
    expect(
      meetingHasNothingToShow(
        meetingFixture({
          tasks: [{ id: 't1', text: 'Send the photos', owner: null, priority: null, dueAt: null, doneAt: null }],
        }),
      ),
    ).toBe(false);
  });

  it('treats whitespace as nothing', () => {
    expect(meetingHasNothingToShow(meetingFixture({ summary: '   ', transcript: '\n\n' }))).toBe(true);
  });
});

describe('What to say when a recording did not get through', () => {
  const fallback = 'This recording could not be read.';

  it('shows the server sentence, which is the only thing that knows what happened', () => {
    const said = 'This recording was too quiet to make out any words. Record again from closer.';
    expect(meetingTroubleMessage(said, fallback)).toBe(said);
  });

  it('refuses anything shaped like a cause rather than copy', () => {
    for (const cause of [
      'TypeError: Cannot read properties of undefined',
      'fetch failed',
      'ECONNRESET',
      '{"error":"bad_request"}',
      'Request to https://api.example.com/v1/audio failed',
      'ZodError: invalid_type at intelligence.topics[0]',
      'Unexpected token < in JSON at position 0',
      'null',
      'at readMeeting (server/src/jobs.ts:120:9)',
    ]) {
      expect(meetingTroubleMessage(cause, fallback)).toBe(fallback);
    }
  });

  it('falls back when there is nothing, or far too much', () => {
    expect(meetingTroubleMessage(null, fallback)).toBe(fallback);
    expect(meetingTroubleMessage('', fallback)).toBe(fallback);
    expect(meetingTroubleMessage('   ', fallback)).toBe(fallback);
    expect(meetingTroubleMessage(`${'A long wall of text. '.repeat(40)}`, fallback)).toBe(fallback);
  });
});

describe('Looking through what was said', () => {
  const transcript = 'The rent was raised to 30,000.\n\nI asked for a receipt.\nHe said he would send one by Friday.';

  it('splits the words where the recording divided them', () => {
    expect(meetingParagraphs(transcript)).toEqual([
      'The rent was raised to 30,000.',
      'I asked for a receipt.',
      'He said he would send one by Friday.',
    ]);
  });

  it('has nothing to split when there are no words', () => {
    expect(meetingParagraphs(null)).toEqual([]);
    expect(meetingParagraphs('')).toEqual([]);
    expect(meetingParagraphs('\n  \n')).toEqual([]);
  });

  it('returns only the passages containing what was typed', () => {
    const paragraphs = meetingParagraphs(transcript);
    expect(meetingPassages(paragraphs, 'receipt')).toEqual(['I asked for a receipt.']);
    expect(meetingPassages(paragraphs, 'RECEIPT')).toEqual(['I asked for a receipt.']);
    expect(meetingPassages(paragraphs, 'said')).toHaveLength(1);
    expect(meetingPassages(paragraphs, 'nobody said this')).toEqual([]);
  });

  it('shows everything when nothing was typed', () => {
    const paragraphs = meetingParagraphs(transcript);
    expect(meetingPassages(paragraphs, '')).toEqual(paragraphs);
    expect(meetingPassages(paragraphs, '   ')).toEqual(paragraphs);
  });

  it('searches the language the meeting was held in', () => {
    const hindi = meetingParagraphs('किराया तीस हज़ार हो गया।\nरसीद मांगी थी।');
    expect(meetingPassages(hindi, 'रसीद')).toEqual(['रसीद मांगी थी।']);
  });
});

describe('Correcting when a meeting happened', () => {
  it('prefills the fields in the order they ask for', () => {
    const at = new Date(2026, 8, 26, 14, 5).getTime();
    expect(meetingStartInputs(at)).toEqual({ date: '26/09/2026', time: '14:05' });
  });

  it('round-trips what it prefilled', () => {
    const at = new Date(2026, 1, 3, 9, 30).getTime();
    const { date, time } = meetingStartInputs(at);
    expect(parseMeetingStart(date, time)).toBe(at);
  });

  it('reads a date the way the people it is for write one', () => {
    expect(parseMeetingStart('25/12/2026')).toBe(new Date(2026, 11, 25, 0, 0).getTime());
    expect(parseMeetingStart('25-12-26')).toBe(new Date(2026, 11, 25, 0, 0).getTime());
    expect(parseMeetingStart('2026-12-25')).toBe(new Date(2026, 11, 25, 0, 0).getTime());
  });

  it('reads a time either way round the clock', () => {
    expect(parseMeetingStart('25/12/2026', '21:30')).toBe(new Date(2026, 11, 25, 21, 30).getTime());
    expect(parseMeetingStart('25/12/2026', '9:30 pm')).toBe(new Date(2026, 11, 25, 21, 30).getTime());
    expect(parseMeetingStart('25/12/2026', '9 am')).toBe(new Date(2026, 11, 25, 9, 0).getTime());
  });

  it('refuses a day that does not exist rather than moving it', () => {
    // 31/02 round-trips through Date as 3 March. Silently relocating somebody's correction
    // is worse than telling them the date did not look right.
    expect(parseMeetingStart('31/02/2026')).toBeNull();
    expect(parseMeetingStart('32/01/2026')).toBeNull();
    expect(parseMeetingStart('25/13/2026')).toBeNull();
  });

  it('refuses what it cannot read', () => {
    expect(parseMeetingStart('')).toBeNull();
    expect(parseMeetingStart('last Tuesday')).toBeNull();
    expect(parseMeetingStart('25/12/2026', 'half past nine')).toBeNull();
    expect(parseMeetingStart('25/12/2026', '25:00')).toBeNull();
    expect(parseMeetingStart('25/12/2026', '13:30 pm')).toBeNull();
  });
});

describe('Taking a meeting with you', () => {
  it('writes the meeting as something that pastes into a message', () => {
    const text = meetingPlainText(
      meetingFixture({
        title: 'Rent renegotiation',
        note: 'At the shop, with his son there too',
        summary: 'He agreed to keep the rent as it is until May.',
        intelligence: { decisions: ['Rent stays at 30,000'], keyPoints: ['The lease ends in May'] },
        tasks: [
          { id: 't1', text: 'Get it in writing', owner: null, priority: null, dueAt: null, doneAt: null },
          { id: 't2', text: 'Send last month’s receipt', owner: null, priority: null, dueAt: null, doneAt: 1 },
        ],
      }),
      { when: '26 September 2026, 2:30 pm', length: '25 min', language: 'Hindi' },
    );

    expect(text.startsWith('Rent renegotiation\n26 September 2026, 2:30 pm · 25 min · Hindi')).toBe(true);
    expect(text).toContain('At the shop, with his son there too');
    expect(text).toContain('- Rent stays at 30,000');
    expect(text).toContain('- Get it in writing');
    expect(text).toContain('- Send last month’s receipt (done)');
    expect(text).toContain('The lease ends in May');
  });

  it('leaves out the headings it has nothing for, and never the title', () => {
    const text = meetingPlainText(meetingFixture({ title: '  ' }));
    expect(text).toBe('Meeting');
    expect(text).not.toContain('Summary');
    expect(text).not.toContain('To do');
  });

  it('carries no vocabulary from inside the machine', () => {
    const text = meetingPlainText(
      meetingFixture({ summary: 'Short version.', transcript: 'Words.' }),
      { when: '26 September 2026', length: '25 min', language: 'Hindi' },
    );
    for (const banned of ['transcript', 'transcription', 'confidence', 'provider', 'model', 'pipeline', 'job']) {
      expect(text.toLowerCase()).not.toContain(banned);
    }
  });
});

describe('The attention list', () => {
  it('will not cite something with nothing behind it', () => {
    expect(attentionIsCitable({ sources: [] })).toBe(false);
    expect(attentionIsCitable({ sources: [{ kind: 'record', id: 'r1', title: 'A receipt' }] })).toBe(true);
  });

  it('opens its gap as a pass drags on, and gives up long after the longest pass', () => {
    expect(attentionPollDelayMs(0)).toBe(3_000);
    expect(attentionPollDelayMs(30_000)).toBe(6_000);
    expect(attentionPollDelayMs(120_000)).toBe(15_000);
    expect(attentionPollDelayMs(10 * 60_000)).toBe(30_000);
    expect(attentionPollDelayMs(-1)).toBeGreaterThan(0);
    expect(ATTENTION_LOOK_CEILING_MS).toBeGreaterThan(6 * 60_000);
  });
});
