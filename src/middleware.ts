import { defineMiddleware } from 'astro:middleware';
import { endSession, SESSION_COOKIE } from './lib/auth';
import { bootstrapOpen, loadPrincipal } from './lib/people';
import { allowedTeams, checkRoute, routeNeedsBootstrapCheck } from './lib/permissions';
import { isTeam, setTeam, TEAM_COOKIE } from './lib/teams';

// The one place sign-in and roles are enforced (spec §3.6):
//   1. public paths skip everything
//   2. /dashboard and /api resolve the session to a principal (401 / redirect)
//   3. non-GET /api requests from another origin are refused
//   4. the route-rule table in lib/permissions.ts (403)
//   5. the team cookie is coerced to a team the principal may see
// Route handlers still call requireAuth(cookies); that's now a second check.

const PUBLIC_EXACT = new Set(['/', '/login', '/api/auth/login', '/api/auth/setup', '/api/auth/logout']);
const isPublic = (p: string) => PUBLIC_EXACT.has(p) || p.startsWith('/setup/') || p.startsWith('/api/integrations/');
const isGuarded = (p: string) => p === '/dashboard' || p.startsWith('/dashboard/') || p.startsWith('/api/');
const isSafeMethod = (m: string) => m === 'GET' || m === 'HEAD' || m === 'OPTIONS';

const jsonError = (error: string, status: number) =>
  new Response(JSON.stringify({ error }), { status, headers: { 'Content-Type': 'application/json' } });

const forbiddenPage = () =>
  new Response(
    `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Not allowed</title>
<style>body{font-family:system-ui,sans-serif;background:#f8f6f1;color:#1d2433;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:16px}main{max-width:28rem;text-align:center}a{color:#1d4ed8}</style></head>
<body><main><h1>You don't have access to this page</h1><p>Your role doesn't include it. Ask an admin if you think it should.</p><p><a href="/dashboard">Back to the dashboard</a></p></main></body></html>`,
    { status: 403, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
  );

/** True when the request's Origin header (if any) is this site. */
function sameOrigin(request: Request, url: URL): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return true;
  let host: string;
  try {
    host = new URL(origin).host;
  } catch {
    return false;
  }
  const own = new Set([url.host]);
  for (const h of [request.headers.get('host'), request.headers.get('x-forwarded-host')]) {
    if (h) own.add(h.split(',')[0].trim());
  }
  return own.has(host);
}

export const onRequest = defineMiddleware(async (context, next) => {
  const url = new URL(context.request.url);
  const { search } = url;
  const method = context.request.method.toUpperCase();

  // Decide on the path Astro will actually route: percent-decoded, with
  // repeated slashes collapsed and case folded, so "/%61pi/%70eople" or
  // "//API/people" can't slip past the guards below. Anything that doesn't
  // decode cleanly (bad escapes, double encoding) is refused.
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return new Response('Bad request', { status: 400 });
  }
  if (/[%\\\0]/.test(pathname)) return new Response('Bad request', { status: 400 });
  pathname = pathname.replace(/\/{2,}/g, '/').toLowerCase();

  // Signed-in visitors skip the login page (as before)
  if (pathname === '/login') {
    const principal = await loadPrincipal(context.cookies);
    if (principal) return context.redirect('/dashboard');
    if (context.cookies.has(SESSION_COOKIE)) endSession(context.cookies); // stale or disabled session
    return next();
  }

  if (isPublic(pathname) || !isGuarded(pathname)) return next();

  const isApi = pathname.startsWith('/api/');
  const principal = await loadPrincipal(context.cookies);
  if (!principal) {
    if (context.cookies.has(SESSION_COOKIE)) endSession(context.cookies);
    return isApi ? jsonError('Unauthorized', 401) : context.redirect(`/login?next=${encodeURIComponent(pathname + search)}`);
  }

  if (isApi && !isSafeMethod(method) && !sameOrigin(context.request, url)) {
    return jsonError('Cross-site request refused', 403);
  }

  let open = false;
  if (routeNeedsBootstrapCheck(pathname, principal)) {
    try {
      open = await bootstrapOpen();
    } catch {
      open = false;
    }
  }
  const verdict = checkRoute(method, pathname, principal, { bootstrapOpen: open });
  if (!verdict.ok) return isApi ? jsonError("You don't have permission to do that", 403) : forbiddenPage();

  // Keep the active team to one this principal may see
  const allowed = allowedTeams(principal);
  const raw = context.cookies.get(TEAM_COOKIE)?.value;
  const effective = isTeam(raw) ? raw : 'leadership';
  if (!allowed.includes(effective)) setTeam(context.cookies, allowed[0]);

  context.locals.principal = principal;
  return next();
});
