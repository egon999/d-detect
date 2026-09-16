import { GoogleAuthProvider, signInWithPopup } from 'firebase/auth';
import { firebaseAuth } from '@data/firebase/auth';

export async function signInGoogleWeb() {
  const auth = await firebaseAuth();
  if (!auth) throw new Error('Sign-in is unavailable. Please try again when connected.');
  try {
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    const credential = await signInWithPopup(auth, provider);
    return credential.user;
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') return null;
    throw error;
  }
}

// Firebase owns the browser session; the native account chooser needs no cleanup here.
export async function signOutOfGoogle(): Promise<void> {}
