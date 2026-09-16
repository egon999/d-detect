/**
 * Google Sign-In.
 *
 * ## Why this is not `signInWithPopup`
 *
 * Firebase ships a **separate React Native build** of `firebase/auth`, selected by the
 * `react-native` export condition. `signInWithPopup`, `signInWithRedirect` and
 * `getRedirectResult` are compiled out of it entirely — they need `window.open`, iframes and
 * browser redirect storage, none of which exist on a handset. Importing them does not fail
 * loudly; it yields `undefined`, and calling `undefined` throws a `TypeError` that surfaces to
 * the user as a generic "Sign-in failed". That is precisely how this app's Google button
 * behaved before this module existed.
 *
 * The supported path on React Native is: get an ID token from Google's own native SDK, then
 * hand it to Firebase through `signInWithCredential`. Two systems, one token between them.
 *
 * ## What has to be true on the Android side
 *
 * A misconfiguration here fails as `DEVELOPER_ERROR`, which says nothing useful, so the
 * requirements are written down rather than left to be rediscovered:
 *
 * 1. `google-services.json` must carry the app's real package name (`com.ddetect.casegraph`).
 *    The Google Services Gradle plugin **throws at build time** on a mismatch.
 * 2. An **Android OAuth client** (`client_type: 1`) must exist for that package name, bound to
 *    the SHA-1 of the certificate the APK is signed with. This authenticates *the app*.
 * 3. `webClientId` must be the **web** client (`client_type: 3`). This is what makes Google
 *    return an `idToken` at all, and it is the audience Firebase validates against. Passing the
 *    Android client ID here yields a null token with no error.
 *
 * The signing certificate is part of the contract: switching from the debug keystore to a
 * release keystore changes the SHA-1, and Google Sign-In then fails in release builds only —
 * the classic "worked on my machine" failure. Register the release SHA-1 before shipping.
 *
 * @see https://react-native-google-signin.github.io/docs/setting-up/expo
 */

import {
  GoogleSignin,
  isErrorWithCode,
  isSuccessResponse,
  statusCodes,
} from '@react-native-google-signin/google-signin';

/**
 * The web (type 3) OAuth client. Public by nature — an OAuth client ID identifies an app, it
 * does not authenticate one; the flow itself does that.
 */
const WEB_CLIENT_ID = (process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID ?? '').trim();

export type GoogleSignInOutcome =
  | {
      ok: true;
      idToken: string;
      user?: { photo?: string | null; name?: string | null; email?: string | null };
    }
  /** The user backed out. Not an error, and nothing should be shown for it. */
  | { ok: false; reason: 'CANCELLED' }
  | {
      ok: false;
      reason: 'NOT_CONFIGURED' | 'PLAY_SERVICES' | 'IN_PROGRESS' | 'NO_TOKEN' | 'FAILED';
      message: string;
    };

export function isGoogleSignInConfigured(): boolean {
  return WEB_CLIENT_ID.length > 0;
}

let configured = false;

/**
 * Applies the native configuration once.
 *
 * `configure` is synchronous and must run before `signIn`. Calling it repeatedly is harmless,
 * but the guard keeps the call site free of ordering concerns — any entry point can ask for a
 * sign-in without first knowing whether something else already set the module up.
 */
function ensureConfigured(): boolean {
  if (!isGoogleSignInConfigured()) return false;
  if (configured) return true;
  GoogleSignin.configure({ webClientId: WEB_CLIENT_ID });
  configured = true;
  return true;
}

/**
 * Runs the native Google flow and returns an ID token for Firebase.
 *
 * Never throws: every outcome is a value, because a sign-in screen with an unhandled rejection
 * leaves a spinner running forever.
 *
 * Cancellation is deliberately its own outcome rather than an error. In v16 the library returns
 * a discriminated union where backing out is `{ type: 'cancelled' }` — a response, not an
 * exception — and treating it as a failure would show an error message to someone who simply
 * changed their mind.
 */
export async function getGoogleIdToken(): Promise<GoogleSignInOutcome> {
  if (!ensureConfigured()) {
    return {
      ok: false,
      reason: 'NOT_CONFIGURED',
      message: 'Google sign-in is not set up for this build. Use email and password instead.',
    };
  }

  try {
    await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });

    const response = await GoogleSignin.signIn();

    if (!isSuccessResponse(response)) {
      return { ok: false, reason: 'CANCELLED' };
    }

    const idToken = response.data.idToken;
    if (!idToken) {
      // Google returned an account but no ID token. In practice this means `webClientId` is
      // not a type-3 web client — the one misconfiguration that produces a "successful"
      // sign-in Firebase cannot accept.
      return {
        ok: false,
        reason: 'NO_TOKEN',
        message: 'Google did not return a sign-in token. Please try email sign-in.',
      };
    }

    return {
      ok: true,
      idToken,
      user: response.data.user
        ? {
            photo: response.data.user.photo,
            name: response.data.user.name,
            email: response.data.user.email,
          }
        : undefined,
    };
  } catch (caught) {
    if (isErrorWithCode(caught)) {
      switch (caught.code) {
        case statusCodes.SIGN_IN_CANCELLED:
          return { ok: false, reason: 'CANCELLED' };
        case statusCodes.IN_PROGRESS:
          return {
            ok: false,
            reason: 'IN_PROGRESS',
            message: 'A sign-in is already in progress.',
          };
        case statusCodes.PLAY_SERVICES_NOT_AVAILABLE:
          return {
            ok: false,
            reason: 'PLAY_SERVICES',
            message:
              'Google Play Services is unavailable or out of date on this device. Use email sign-in instead.',
          };
        default:
          // DEVELOPER_ERROR lands here. The user cannot fix a signing-certificate mismatch, so
          // they are offered the path that does work rather than shown a diagnostic code.
          return {
            ok: false,
            reason: 'FAILED',
            message: 'Google sign-in could not be completed. Use email and password instead.',
          };
      }
    }

    return {
      ok: false,
      reason: 'FAILED',
      message: 'Google sign-in could not be completed. Use email and password instead.',
    };
  }
}

/**
 * Clears the native Google session.
 *
 * Signing out of Firebase alone leaves the Google account selected, so the next sign-in skips
 * the account chooser and silently returns the same person — which looks like the sign-out
 * silently failed. Errors are swallowed on purpose: never trap someone in a session because
 * the sign-out helper itself failed.
 */
export async function signOutOfGoogle(): Promise<void> {
  if (!configured) return;
  try {
    await GoogleSignin.signOut();
  } catch {
    // Non-fatal by design. See above.
  }
}
