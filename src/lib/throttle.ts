import { createHash } from 'node:crypto';
import { authStore } from './blobs';

// Sign-in throttling (moved out of api/auth/login.ts and generalised to a key).
//
// Each attempt is *reserved* in a counter before the password is checked (a
// conditional write in the Blobs `auth` store, so parallel requests can't all
// slip under the limit), there's a delay on every miss, and a lock after
// MAX_FAILURES within WINDOW_MS. Two keys are used by sign-in and setup: the
// client IP (IPv4 address or IPv6 /64) and, for sign-in, the email address.
// Note for a shared office IP: ten wrong guesses lock that IP for 15 minutes
// for everyone behind it.

export const MAX_FAILURES = 10;
export const WINDOW_MS = 15 * 60 * 1000;
export const FAIL_DELAY_MS = 800;

interface Failures {
  count: number;
  first: number;
}

// IPv6 clients get a whole /64, so count by prefix; IPv4 by address
function ipv6Prefix(ip: string): string {
  // expand "::" so the first four hextets are really the /64
  const [head, tail = ''] = ip.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const groups = [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
  return groups.slice(0, 4).map((g) => g.padStart(4, '0')).join(':');
}

/** Counter key for the requesting client (same key format as before P0). */
export function ipKey(request: Request, clientAddress?: string): string {
  const ip = request.headers.get('x-nf-client-connection-ip') ?? clientAddress ?? 'unknown';
  const key = ip.includes(':') ? ipv6Prefix(ip) : ip;
  return `login-attempts/${key.replace(/[^0-9a-f.:]/gi, '_')}`;
}

/** Counter key for one email address (hashed, lower-cased). */
export function emailKey(email: string): string {
  return `login-attempts/email/${createHash('sha256').update(email.trim().toLowerCase()).digest('hex')}`;
}

/** Astro's clientAddress throws when the adapter can't tell; this doesn't. */
export function safeClientAddress(ctx: { clientAddress: string }): string | undefined {
  try {
    return ctx.clientAddress;
  } catch {
    return undefined;
  }
}

/**
 * Atomically bumps the attempt counter. Returns the count after this attempt,
 * or null if the store is unavailable (then we don't lock anyone out).
 */
export async function reserveAttempt(key: string): Promise<number | null> {
  try {
    const store = authStore();
    for (let i = 0; i < 4; i++) {
      const current = await store.getWithMetadata(key, { type: 'json' });
      const now = Date.now();
      const prev = (current?.data as Failures | null) ?? null;
      const fresh = !prev || now - prev.first > WINDOW_MS;
      const next: Failures = fresh ? { count: 1, first: now } : { count: prev.count + 1, first: prev.first };
      if (current && !current.etag) continue; // no etag → the write couldn't be conditional; re-read
      const result = current
        ? await store.setJSON(key, next, { onlyIfMatch: current.etag })
        : await store.setJSON(key, next, { onlyIfNew: true });
      if (result.modified) return next.count;
      // someone else wrote in between — re-read and try again
    }
    return MAX_FAILURES + 1; // couldn't reserve after retries: treat as too busy
  } catch {
    return null;
  }
}

/**
 * Reserves an attempt on every key; true when any of them is over the limit
 * (the caller should then wait failDelay() and answer 429).
 */
export async function tooManyAttempts(keys: string[]): Promise<boolean> {
  const counts = await Promise.all(keys.map(reserveAttempt));
  return counts.some((c) => c !== null && c > MAX_FAILURES);
}

/** Clears counters after a successful sign-in (best effort). */
export async function clearAttempts(keys: string[]): Promise<void> {
  try {
    const store = authStore();
    await Promise.all(keys.map((k) => store.delete(k)));
  } catch {
    /* best effort */
  }
}

/** The delay applied to every miss. */
export const failDelay = () => new Promise<void>((r) => setTimeout(r, FAIL_DELAY_MS));
