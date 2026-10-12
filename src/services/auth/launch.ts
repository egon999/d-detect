export const BOOT_DEADLINE_MS = 1500;

export const SPLASH_OVERLAY_CEILING_MS = 2800;

export const SPLASH_OVERLAY_EXIT_MS = 380;

export const SPLASH_OVERLAY_SETTLE_MS = 2200;

export const SPLASH_FAILSAFE_MS = 3400;

export const SPLASH_OVERLAY_BACKSTOP_MS =
  SPLASH_OVERLAY_CEILING_MS + SPLASH_OVERLAY_EXIT_MS + 300;

export const SESSION_RESTORE_DEADLINE_MS = 4500;

export const STORAGE_DEADLINE_MS = 2000;

export const STUCK_MS = 6500;

export function deadlineOrderingProblems(): string[] {
  const problems: string[] = [];

  if (BOOT_DEADLINE_MS >= SPLASH_FAILSAFE_MS) {
    problems.push('The fonts outlast the splash, so the first frame reflows in front of the user.');
  }
  if (SPLASH_OVERLAY_CEILING_MS >= SPLASH_FAILSAFE_MS) {
    problems.push('The native splash lifts before the overlay starts leaving, revealing a seam.');
  }
  if (SPLASH_OVERLAY_BACKSTOP_MS <= SPLASH_OVERLAY_CEILING_MS + SPLASH_OVERLAY_EXIT_MS) {
    problems.push('The overlay is cut away before its fade finishes.');
  }
  if (SESSION_RESTORE_DEADLINE_MS <= SPLASH_OVERLAY_BACKSTOP_MS) {
    problems.push('The session gives up while the splash is still covering the screen.');
  }
  if (STORAGE_DEADLINE_MS >= SESSION_RESTORE_DEADLINE_MS) {
    problems.push('The introduction flag outlasts the session, so it decides nothing.');
  }
  if (STUCK_MS <= SESSION_RESTORE_DEADLINE_MS) {
    problems.push('The way out appears while the app is still starting normally.');
  }

  return problems;
}

export type LaunchDestination =

  | 'wait'

  | 'app'

  | 'introduction'

  | 'signIn';

export interface LaunchInputs {
  status: 'restoring' | 'signedOut' | 'signedIn';

  hasUser: boolean;

  seenIntroduction: boolean | null;

  storageDeadlinePassed: boolean;
}

export function launchDestination({
  status,
  hasUser,
  seenIntroduction,
  storageDeadlinePassed,
}: LaunchInputs): LaunchDestination {

  if (status === 'signedIn' && hasUser) return 'app';

  if (status === 'restoring') return 'wait';

  if (seenIntroduction === null && !storageDeadlinePassed) return 'wait';

  return seenIntroduction === false ? 'introduction' : 'signIn';
}
