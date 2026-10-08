import { createHmac, timingSafeEqual } from 'node:crypto';

export interface SessionClaims {
  userId: string;
  issuedAt: number;
  expiresAt: number;
}

const SESSION_SECRET = process.env.SESSION_SIGNING_SECRET ?? '';

function sign(payload: string): string {
  return createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
}

/**
 * Accepts a session cookie only when its signature matches and it has not expired.
 * Returns the claims, or null when the cookie must be rejected.
 */
export function readSession(cookie: string | undefined, now = Date.now()): SessionClaims | null {
  if (!cookie) return null;
  const [payload, signature] = cookie.split('.');
  if (!payload || !signature) return null;

  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;

  let claims: SessionClaims;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as SessionClaims;
  } catch {
    return null;
  }
  if (typeof claims.userId !== 'string' || claims.userId === '') return null;
  if (claims.expiresAt <= now) return null;
  if (claims.issuedAt > now) return null;
  return claims;
}

export function issueSession(userId: string, ttlMs: number, now = Date.now()): string {
  const claims: SessionClaims = { userId, issuedAt: now, expiresAt: now + ttlMs };
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${payload}.${sign(payload)}`;
}
