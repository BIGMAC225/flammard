import type { APIRoute } from 'astro';
import { json, readBody } from '../../../lib/api';
import { passwordMatches, startSession } from '../../../lib/auth';
import { authStore } from '../../../lib/blobs';

// Single shared team password; see src/lib/auth.ts.
//
// One password guards everything, so attempts are throttled per client:
// each attempt is *reserved* in the counter before the password is checked
// (a conditional write, so parallel requests can't all slip under the
// limit), there's a delay on every miss, and a lock after MAX_FAILURES
// within WINDOW. Note for a shared office IP: ten wrong guesses lock that
// IP for 15 minutes for everyone behind it.
const MAX_FAILURES = 10;
const WINDOW_MS = 15 * 60 * 1000;
const FAIL_DELAY_MS = 800;

interface Failures {
  count: number;
  first: number;
}

// IPv6 clients get a whole /64, so count by prefix; IPv4 by address
function clientKey(request: Request, fallback: string | undefined): string {
  const ip = request.headers.get('x-nf-client-connection-ip') ?? fallback ?? 'unknown';
  const key = ip.includes(':') ? ip.split(':').slice(0, 4).join(':') : ip;
  return `login-attempts/${key.replace(/[^0-9a-f.:]/gi, '_')}`;
}

/**
 * Atomically bumps the attempt counter. Returns the count after this attempt,
 * or null if the store is unavailable (then we don't lock anyone out).
 */
async function reserveAttempt(key: string): Promise<number | null> {
  try {
    const store = authStore();
    for (let i = 0; i < 4; i++) {
      const current = await store.getWithMetadata(key, { type: 'json' });
      const now = Date.now();
      const prev = (current?.data as Failures | null) ?? null;
      const fresh = !prev || now - prev.first > WINDOW_MS;
      const next: Failures = fresh ? { count: 1, first: now } : { count: prev.count + 1, first: prev.first };
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

export const POST: APIRoute = async ({ request, cookies, clientAddress, url }) => {
  const { password, next } = await readBody(request);
  if (typeof password !== 'string' || !password) return json({ error: 'Password is required' }, 400);

  let address: string | undefined;
  try {
    address = clientAddress;
  } catch {
    address = undefined;
  }
  const key = clientKey(request, address);

  const attempts = await reserveAttempt(key);
  if (attempts !== null && attempts > MAX_FAILURES) {
    await new Promise((r) => setTimeout(r, FAIL_DELAY_MS));
    return json({ error: 'Too many attempts. Try again in a few minutes.' }, 429);
  }

  if (!passwordMatches(password)) {
    await new Promise((r) => setTimeout(r, FAIL_DELAY_MS));
    return json({ error: 'Incorrect password' }, 401);
  }

  // Success: the reservation counted against the window; clear it
  try {
    await authStore().delete(key);
  } catch {
    /* best effort */
  }
  startSession(cookies);

  // Only ever redirect within this site
  let redirectTo = '/dashboard';
  if (typeof next === 'string') {
    try {
      const target = new URL(next, url.origin);
      if (target.origin === url.origin && target.pathname.startsWith('/')) redirectTo = target.pathname + target.search;
    } catch {
      /* keep default */
    }
  }
  return json({ next: redirectTo });
};
