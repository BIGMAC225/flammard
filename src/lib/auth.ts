import { createHmac, timingSafeEqual } from 'node:crypto';
import type { AstroCookies } from 'astro';

// One shared team password (SHARED_PASSWORD). A successful login sets a
// signed, HttpOnly cookie; nothing about the user is stored server-side.

export const SESSION_COOKIE = 'flammard_session';
const SESSION_DAYS = 30;

function secret(): string {
  const s = import.meta.env.SESSION_SECRET || import.meta.env.SHARED_PASSWORD;
  if (!s) throw new Error('SHARED_PASSWORD is not configured');
  return `flammard:${s}`;
}

const sign = (payload: string) => createHmac('sha256', secret()).update(payload).digest('base64url');

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export function passwordMatches(candidate: string): boolean {
  const expected = import.meta.env.SHARED_PASSWORD;
  return !!expected && safeEqual(candidate, expected);
}

export function startSession(cookies: AstroCookies): void {
  const expires = Date.now() + SESSION_DAYS * 86_400_000;
  const payload = String(expires);
  cookies.set(SESSION_COOKIE, `${payload}.${sign(payload)}`, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: import.meta.env.PROD,
    expires: new Date(expires),
  });
}

export function endSession(cookies: AstroCookies): void {
  cookies.delete(SESSION_COOKIE, { path: '/' });
}

export function isAuthenticated(cookies: AstroCookies): boolean {
  const raw = cookies.get(SESSION_COOKIE)?.value;
  if (!raw) return false;
  const dot = raw.lastIndexOf('.');
  if (dot < 1) return false;
  const payload = raw.slice(0, dot);
  const signature = raw.slice(dot + 1);
  try {
    if (!safeEqual(signature, sign(payload))) return false;
  } catch {
    return false;
  }
  return Number(payload) > Date.now();
}

/** Shown in the header and recorded on approvals. */
export const TEAM_LABEL = import.meta.env.PUBLIC_TEAM_LABEL || 'Team';
