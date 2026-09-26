import { createHmac, timingSafeEqual } from 'node:crypto';
import type { AstroCookies } from 'astro';
import { env } from './env';

// Session cookie. Two signed formats are accepted:
//
//   person   p1.<personId>.<sessionVersion>.<expiresMs>.<hmac>   (email + password, setup link)
//   shared   <expiresMs>.<hmac>                                   (the old team password)
//
// Person cookies need SESSION_SECRET. Shared cookies fall back to
// SHARED_PASSWORD so sessions issued before SESSION_SECRET existed survive.
// This file only checks signatures and expiry; src/lib/people.ts
// (loadPrincipal) checks that the person is active and the session version
// matches, and the middleware is the real gate.

export const SESSION_COOKIE = 'flammard_session';
const SESSION_DAYS = 30;
const PERSON_PREFIX = 'p1';

function sharedSecret(): string {
  const s = env('SESSION_SECRET') || env('SHARED_PASSWORD');
  if (!s) throw new Error('SHARED_PASSWORD is not configured');
  return `flammard:${s}`;
}

function personSecret(): string {
  const s = env('SESSION_SECRET');
  if (!s) throw new Error('SESSION_SECRET is not configured (required for personal sign-in)');
  return `flammard:person:${s}`;
}

const hmac = (key: string, payload: string) => createHmac('sha256', key).update(payload).digest('base64url');

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/** True when the team password may be used (and shared cookies accepted). */
export function sharedLoginEnabled(): boolean {
  return !!env('SHARED_PASSWORD') && (env('SHARED_PASSWORD_LOGIN') ?? '').trim().toLowerCase() !== 'off';
}

/** Compares against the shared team password. */
export function passwordMatches(candidate: string): boolean {
  const expected = env('SHARED_PASSWORD');
  return !!expected && safeEqual(candidate, expected);
}

function setCookie(cookies: AstroCookies, value: string, expires: number): void {
  cookies.set(SESSION_COOKIE, value, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: import.meta.env.PROD,
    expires: new Date(expires),
  });
}

/** Signs a person in. Bumping people.session_version later invalidates the cookie. */
export function startPersonSession(cookies: AstroCookies, p: { id: string; session_version: number }): void {
  const expires = Date.now() + SESSION_DAYS * 86_400_000;
  const payload = `${PERSON_PREFIX}.${p.id}.${p.session_version}.${expires}`;
  setCookie(cookies, `${payload}.${hmac(personSecret(), payload)}`, expires);
}

/** Signs in with the shared team password (the pre-P0 cookie format). */
export function startSharedSession(cookies: AstroCookies): void {
  const expires = Date.now() + SESSION_DAYS * 86_400_000;
  const payload = String(expires);
  setCookie(cookies, `${payload}.${hmac(sharedSecret(), payload)}`, expires);
}

/** @deprecated use startSharedSession */
export const startSession = startSharedSession;

export function endSession(cookies: AstroCookies): void {
  cookies.delete(SESSION_COOKIE, { path: '/' });
}

export type SessionData = { kind: 'person'; personId: string; version: number } | { kind: 'shared' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Parses a raw cookie value, checking the signature and expiry only. */
export function parseSessionValue(raw: string | undefined): SessionData | null {
  if (!raw) return null;
  const dot = raw.lastIndexOf('.');
  if (dot < 1) return null;
  const payload = raw.slice(0, dot);
  const signature = raw.slice(dot + 1);
  try {
    if (payload.startsWith(`${PERSON_PREFIX}.`)) {
      const parts = payload.split('.');
      if (parts.length !== 4) return null;
      const [, personId, version, expires] = parts;
      if (!UUID.test(personId) || !/^\d+$/.test(version) || !/^\d+$/.test(expires)) return null;
      if (!env('SESSION_SECRET') || !safeEqual(signature, hmac(personSecret(), payload))) return null;
      if (Number(expires) <= Date.now()) return null;
      return { kind: 'person', personId, version: Number(version) };
    }
    if (!/^\d+$/.test(payload)) return null;
    if (!safeEqual(signature, hmac(sharedSecret(), payload))) return null;
    return Number(payload) > Date.now() ? { kind: 'shared' } : null;
  } catch {
    return null; // a secret isn't configured
  }
}

export function readSession(cookies: AstroCookies): SessionData | null {
  return parseSessionValue(cookies.get(SESSION_COOKIE)?.value);
}

/** Signature + expiry of either format. The middleware does the real check. */
export function isAuthenticated(cookies: AstroCookies): boolean {
  return readSession(cookies) !== null;
}

/** Shown in the header and recorded on approvals for the shared login. */
export const TEAM_LABEL = env('PUBLIC_TEAM_LABEL') || 'Team';

/** Role given to the shared team password (SHARED_LOGIN_ROLE, default facilitator). */
export function sharedLoginRole(): string {
  return (env('SHARED_LOGIN_ROLE') ?? '').trim().toLowerCase() || 'facilitator';
}
