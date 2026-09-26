import type { APIRoute } from 'astro';
import { json, readBody } from '../../../lib/api';
import { passwordMatches, startSession } from '../../../lib/auth';
import { authStore } from '../../../lib/blobs';

// Single shared team password; see src/lib/auth.ts.
//
// One password guards everything, so failed attempts are throttled per IP:
// a short delay on every miss, and a lock after MAX_FAILURES within WINDOW.
const MAX_FAILURES = 10;
const WINDOW_MS = 15 * 60 * 1000;
const FAIL_DELAY_MS = 800;

interface Failures {
  count: number;
  first: number;
}

async function readFailures(key: string): Promise<Failures> {
  try {
    const f = (await authStore().get(key, { type: 'json' })) as Failures | null;
    if (!f || Date.now() - f.first > WINDOW_MS) return { count: 0, first: Date.now() };
    return f;
  } catch {
    return { count: 0, first: Date.now() }; // throttle store unavailable — don't lock people out
  }
}

export const POST: APIRoute = async ({ request, cookies, clientAddress, url }) => {
  const { password, next } = await readBody(request);
  if (typeof password !== 'string' || !password) return json({ error: 'Password is required' }, 400);

  const ip = request.headers.get('x-nf-client-connection-ip') ?? clientAddress ?? 'unknown';
  const key = `login-failures/${ip.replace(/[^0-9a-f.:]/gi, '_')}`;
  const failures = await readFailures(key);
  if (failures.count >= MAX_FAILURES) {
    return json({ error: 'Too many attempts. Try again in a few minutes.' }, 429);
  }

  if (!passwordMatches(password)) {
    await authStore()
      .setJSON(key, { count: failures.count + 1, first: failures.first })
      .catch(() => {});
    await new Promise((r) => setTimeout(r, FAIL_DELAY_MS));
    return json({ error: 'Incorrect password' }, 401);
  }

  if (failures.count) await authStore().delete(key).catch(() => {});
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
