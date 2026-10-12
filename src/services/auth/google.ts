import {
  GoogleSignin,
  isErrorWithCode,
  isSuccessResponse,
  statusCodes,
} from '@react-native-google-signin/google-signin';

const WEB_CLIENT_ID = (process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID ?? '').trim();

export type GoogleSignInOutcome =
  | {
      ok: true;
      idToken: string;
      user?: { photo?: string | null; name?: string | null; email?: string | null };
    }

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

function ensureConfigured(): boolean {
  if (!isGoogleSignInConfigured()) return false;
  if (configured) return true;
  GoogleSignin.configure({ webClientId: WEB_CLIENT_ID });
  configured = true;
  return true;
}

export async function getGoogleIdToken(): Promise<GoogleSignInOutcome> {
  if (!ensureConfigured()) {
    return {
      ok: false,
      reason: 'NOT_CONFIGURED',
      message: 'Signing in with Google isn’t available here. Use your email and password instead.',
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

      return {
        ok: false,
        reason: 'NO_TOKEN',
        message: 'Google didn’t finish signing you in. Use your email and password instead.',
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
            message: 'A sign-in is already underway. Give it a moment.',
          };
        case statusCodes.PLAY_SERVICES_NOT_AVAILABLE:
          return {
            ok: false,
            reason: 'PLAY_SERVICES',
            message:
              'Google sign-in isn’t working on this device. Use your email and password instead.',
          };
        default:

          return {
            ok: false,
            reason: 'FAILED',
            message: 'Google sign-in couldn’t be completed. Use your email and password instead.',
          };
      }
    }

    return {
      ok: false,
      reason: 'FAILED',
      message: 'Google sign-in couldn’t be completed. Use your email and password instead.',
    };
  }
}

export async function signOutOfGoogle(): Promise<void> {
  if (!configured) return;
  try {
    await GoogleSignin.signOut();
  } catch {

  }
}
