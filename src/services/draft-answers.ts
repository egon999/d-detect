/**
 * What the user has written into a filing draft, kept between sessions.
 *
 * ## Why this is persisted at all
 *
 * The letter is assembled from the case's own documents, but a handful of things are not in
 * any document and never will be: the person's name, their address, a phone number, what
 * outcome they want. Those are typed by hand.
 *
 * A grievance letter is not written in one sitting. Someone starts it on the bus, looks up
 * their account number at home, and comes back to it days later when they have decided what
 * to ask for. If the screen forgets what they wrote the moment it unmounts, the second visit
 * starts from an empty form — and the letter never gets sent, which is the exact failure the
 * whole feature exists to prevent.
 *
 * ## The split, and why it is not one bucket
 *
 * Two storage scopes, drawn along `PERSONAL_SLOTS`:
 *
 * - **Personal** — name, address, contact. Facts about the person, identical on every letter
 *   they will ever send. Stored per owner, so a second complaint arrives with these already
 *   filled and the user writes them once in their life rather than once per dispute.
 * - **Case-bound** — the account number, the organisation, the sum, the relief sought, the
 *   place. Stored per case and deliberately *not* shared. Carrying a previous dispute's
 *   account number into a new letter is not a convenience; it is a way to file a complaint
 *   about the wrong account, and the user would have no reason to look twice at a field that
 *   was already filled in.
 *
 * ## Why AsyncStorage and not the workspace
 *
 * This is a half-written note to oneself, not case evidence. Putting it in the workspace
 * would mean a schema migration, a sync to the repository, and an audit entry for every
 * keystroke — and it would put a draft of the user's own words into the same record the app
 * treats as evidence. It belongs on the device, beside the theme preference, which is what
 * `@services/preferences` already does for settings of this weight.
 *
 * Nothing here is a secret in the credentials sense, but it is personal data: a name, a
 * postal address, a phone number. It stays on the device and is never uploaded.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { DraftAnswers, DraftSlot } from '@domain/analysis/filing-draft';
import { PERSONAL_SLOTS } from '@domain/analysis/filing-draft';

/** Personal details, scoped to the account rather than to any one dispute. */
const personalKey = (ownerId: string) => `detact:v1:draft-personal:${ownerId}`;

/** This letter's own answers. Scoped to the case, and never shared with another. */
const caseKey = (ownerId: string, caseId: string) => `detact:v1:draft-answers:${ownerId}:${caseId}`;

const isPersonal = (slot: string): slot is DraftSlot =>
  (PERSONAL_SLOTS as readonly string[]).includes(slot);

/**
 * Reads a stored blob back into answers, discarding anything that is not a string.
 *
 * Storage is not a trusted input: it survives app upgrades, and a slot that was removed from
 * the union in a later version will still be sitting in a user's device from an older one.
 * Unknown keys are kept rather than dropped — they cost nothing, and a slot renamed back
 * would otherwise lose an answer the user had already written.
 */
function parseAnswers(raw: string | null): DraftAnswers {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};

    const answers: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string' && value.trim()) answers[key] = value;
    }
    return answers as DraftAnswers;
  } catch {
    // A corrupt blob is not worth failing the screen over. An empty form is recoverable;
    // a screen that will not open is not.
    return {};
  }
}

function splitAnswers(answers: DraftAnswers): { personal: DraftAnswers; caseBound: DraftAnswers } {
  const personal: Record<string, string> = {};
  const caseBound: Record<string, string> = {};

  for (const [slot, value] of Object.entries(answers)) {
    if (typeof value !== 'string' || !value.trim()) continue;
    if (isPersonal(slot)) personal[slot] = value;
    else caseBound[slot] = value;
  }

  return { personal: personal as DraftAnswers, caseBound: caseBound as DraftAnswers };
}

export interface DraftAnswersState {
  answers: DraftAnswers;
  /** Records one answer. Writes are debounced; the value is available immediately. */
  setAnswer: (slot: DraftSlot, value: string) => void;
  /** Clears this case's answers. Personal details are kept — they are not this dispute's. */
  clearCaseAnswers: () => void;
  /** False until the stored values have been read, so the form is not painted empty first. */
  loaded: boolean;
}

/** How long to wait after the last keystroke before writing. */
const WRITE_DELAY_MS = 600;

/**
 * The answers for one case's letter, loaded on mount and saved as the user types.
 *
 * ## Why writes are debounced rather than immediate
 *
 * `setAnswer` fires on every keystroke. Writing to AsyncStorage on each one would mean a
 * hundred serialised writes to compose one address, on the same thread that is animating the
 * keyboard. The in-memory value updates synchronously — the field never lags — and the disk
 * catches up when typing pauses.
 *
 * A flush on unmount covers the case the delay opens up: a user who types their last
 * character and immediately taps back would otherwise lose it.
 */
export function useDraftAnswers(ownerId: string | null, caseId: string | null): DraftAnswersState {
  const [answers, setAnswers] = useState<DraftAnswers>({});
  const [loaded, setLoaded] = useState(false);

  // Mirrored in a ref so the debounced write and the unmount flush read the current value
  // without either becoming a dependency that resets the timer on every keystroke.
  const latest = useRef<DraftAnswers>({});
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const persist = useCallback(
    async (next: DraftAnswers) => {
      if (!ownerId || !caseId) return;
      const { personal, caseBound } = splitAnswers(next);
      try {
        await Promise.all([
          AsyncStorage.setItem(personalKey(ownerId), JSON.stringify(personal)),
          AsyncStorage.setItem(caseKey(ownerId, caseId), JSON.stringify(caseBound)),
        ]);
      } catch {
        // A failed write costs the user their draft on next launch. It must not cost them
        // the letter they are in the middle of writing.
      }
    },
    [ownerId, caseId],
  );

  useEffect(() => {
    let cancelled = false;
    if (!ownerId || !caseId) {
      setAnswers({});
      latest.current = {};
      setLoaded(true);
      return;
    }

    setLoaded(false);
    void Promise.all([
      AsyncStorage.getItem(personalKey(ownerId)),
      AsyncStorage.getItem(caseKey(ownerId, caseId)),
    ])
      .then(([personalRaw, caseRaw]) => {
        if (cancelled) return;
        // Case-bound answers last: if the same slot somehow exists in both, the one written
        // for *this* dispute is the one the user meant.
        const merged = { ...parseAnswers(personalRaw), ...parseAnswers(caseRaw) };
        latest.current = merged;
        setAnswers(merged);
      })
      .catch(() => {
        // Unreadable storage means an empty form, not a broken screen.
      })
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });

    return () => {
      cancelled = true;
    };
  }, [ownerId, caseId]);

  // Flush on unmount, so the last character typed before a back tap is not the one that is
  // lost. Depends on `persist` only, which is stable for a given owner and case.
  useEffect(() => {
    return () => {
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
        void persist(latest.current);
      }
    };
  }, [persist]);

  const setAnswer = useCallback(
    (slot: DraftSlot, value: string) => {
      const next = { ...latest.current, [slot]: value };
      latest.current = next;
      setAnswers(next);

      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        timer.current = null;
        void persist(next);
      }, WRITE_DELAY_MS);
    },
    [persist],
  );

  const clearCaseAnswers = useCallback(() => {
    // Personal details survive deliberately: someone clearing a draft is discarding this
    // letter, not asking the app to forget their own address.
    const { personal } = splitAnswers(latest.current);
    latest.current = personal;
    setAnswers(personal);

    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (ownerId && caseId) void AsyncStorage.removeItem(caseKey(ownerId, caseId)).catch(() => {});
  }, [ownerId, caseId]);

  return { answers, setAnswer, clearCaseAnswers, loaded };
}
