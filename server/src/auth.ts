import { createMiddleware } from 'hono/factory';
import { HTTPException } from 'hono/http-exception';

import { ensureUser } from './db.ts';
import { config } from './env.ts';

export type Account = { id: string; email: string | null; name: string | null };

type Variables = { account: Account };

const TOKEN_CACHE_MAX = 500;
const tokenCache = new Map<string, { account: Account; expiresAt: number }>();

const REJECTED_TTL_MS = 60_000;
const rejectedTokens = new Map<string, number>();

function rememberRejection(idToken: string): void {
  const now = Date.now();
  for (const [key, until] of rejectedTokens) {
    if (until <= now) rejectedTokens.delete(key);
  }

  while (rejectedTokens.size >= TOKEN_CACHE_MAX) {
    const oldest = rejectedTokens.keys().next();
    if (oldest.done) break;
    rejectedTokens.delete(oldest.value);
  }
  rejectedTokens.set(idToken, now + REJECTED_TTL_MS);
}

function rememberToken(idToken: string, account: Account, expiresAt: number): void {
  if (tokenCache.size >= TOKEN_CACHE_MAX) {
    const now = Date.now();
    for (const [key, entry] of tokenCache) {
      if (entry.expiresAt <= now) tokenCache.delete(key);
    }

    while (tokenCache.size >= TOKEN_CACHE_MAX) {
      const oldest = tokenCache.keys().next();
      if (oldest.done) break;
      tokenCache.delete(oldest.value);
    }
  }
  tokenCache.set(idToken, { account, expiresAt });
}

const JWT_SEGMENTS = 3;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

function looksLikeIdToken(idToken: string): boolean {
  const segments = idToken.split('.');
  if (segments.length !== JWT_SEGMENTS) return false;
  if (!segments.every((segment) => segment.length > 0 && BASE64URL.test(segment))) return false;

  if (idToken.length > 16_384) return false;
  try {
    const claims = JSON.parse(Buffer.from(segments[1]!, 'base64url').toString('utf8')) as {
      exp?: unknown;
    };
    return typeof claims.exp === 'number' && Number.isFinite(claims.exp);
  } catch {
    return false;
  }
}

async function accountFromIdToken(idToken: string): Promise<Account | null> {
  const cached = tokenCache.get(idToken);
  if (cached && cached.expiresAt > Date.now()) return cached.account;

  const rejectedAt = rejectedTokens.get(idToken);
  if (rejectedAt !== undefined && rejectedAt > Date.now()) return null;

  if (!config.auth.firebaseWebApiKey) return null;
  if (!looksLikeIdToken(idToken)) {
    rememberRejection(idToken);
    return null;
  }

  const response = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(config.auth.firebaseWebApiKey)}`,
    {
      method: 'POST',
      signal: AbortSignal.timeout(10_000),
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ idToken }),
    },
  ).catch(() => null);

  if (!response?.ok) {
    rememberRejection(idToken);
    return null;
  }

  const payload = (await response.json().catch(() => null)) as {
    users?: Array<{ localId?: string; email?: string; displayName?: string }>;
  } | null;

  const user = payload?.users?.[0];
  if (!user?.localId) {
    rememberRejection(idToken);
    return null;
  }

  const account: Account = {
    id: user.localId,
    email: user.email ?? null,
    name: user.displayName ?? null,
  };

  rememberToken(idToken, account, Date.now() + 5 * 60_000);
  return account;
}

const DEVICE_ID = /^[A-Za-z0-9_-]{8,64}$/;

function deviceIdentityAllowed(): boolean {
  if (process.env.NODE_ENV === 'production') return false;
  return config.auth.allowDeviceIdentity;
}

export const requireAccount = createMiddleware<{ Variables: Variables }>(async (context, next) => {
  const header = context.req.header('authorization') ?? '';
  const bearer = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';

  let account: Account | null = null;

  if (bearer) {

    account = await accountFromIdToken(bearer);
    if (!account) {

      throw new HTTPException(401, {
        message: config.auth.firebaseWebApiKey
          ? 'That sign-in has expired. Sign in again.'
          : 'Sign-in is not set up on this server yet.',
      });
    }
  } else if (deviceIdentityAllowed()) {
    const deviceId = (context.req.header('x-device-id') ?? '').trim();

    if (!DEVICE_ID.test(deviceId)) {
      throw new HTTPException(401, { message: 'Sign in to continue.' });
    }
    account = { id: `device:${deviceId}`, email: null, name: null };
  }

  if (!account) throw new HTTPException(401, { message: 'Sign in to continue.' });

  ensureUser(account.id, account.email, account.name);
  context.set('account', account);
  await next();
});

export function accountOf(context: { get: (key: 'account') => Account }): Account {
  const account = context.get('account');
  if (!account) throw new HTTPException(401, { message: 'Sign in to continue.' });
  return account;
}
