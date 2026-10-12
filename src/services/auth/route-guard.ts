export function isAccountFreeRoute(pathname: string): boolean {
  return (
    pathname === '/' ||
    pathname === '/sign-in' ||
    pathname === '/onboarding' ||
    pathname === '/legal'
  );
}

export function shouldLeaveForSignIn(input: {
  status: 'restoring' | 'signedOut' | 'signedIn';

  heldSession: boolean;
  pathname: string;
}): boolean {
  if (input.status !== 'signedOut') return false;
  if (!input.heldSession) return false;
  return !isAccountFreeRoute(input.pathname);
}
