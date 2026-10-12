export {
  SessionProvider,
  useSession,
  useOwnerId,
  runSignOutTeardown,
  KEEP_SIGNED_IN_STORAGE_KEY,
  type SessionStatus,
  type SessionUser,
  type SessionValue,
} from './session-provider';

export {
  sessionAccount,
  accountInitials,
  accountLabel,
  greetingName,
  hasPersonalName,
  personalEmail,
  personalName,
  providerLabel,
  deviceSessionUser,
  UNNAMED_LABEL,
  type AccountSource,
  type StoredDeviceIdentity,
} from './auth/account';

export {
  launchDestination,
  deadlineOrderingProblems,
  BOOT_DEADLINE_MS,
  SESSION_RESTORE_DEADLINE_MS,
  SPLASH_FAILSAFE_MS,
  SPLASH_OVERLAY_BACKSTOP_MS,
  SPLASH_OVERLAY_CEILING_MS,
  SPLASH_OVERLAY_EXIT_MS,
  SPLASH_OVERLAY_SETTLE_MS,
  STORAGE_DEADLINE_MS,
  STUCK_MS,
  type LaunchDestination,
  type LaunchInputs,
} from './auth/launch';

export { isAccountFreeRoute, shouldLeaveForSignIn } from './auth/route-guard';

export { readableAuthError, asAuthError, KNOWN_AUTH_ERROR_CODES } from './auth/errors';
export { sendDiagnosticReport, SUPPORT_EMAIL, CLIENT_NAME } from './reporting';
