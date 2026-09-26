import { defineMiddleware } from 'astro:middleware';
import { isAuthenticated } from './lib/auth';

const PROTECTED = ['/dashboard'];
const AUTH_ONLY = ['/login'];

export const onRequest = defineMiddleware(async (context, next) => {
  const { pathname, search } = new URL(context.request.url);

  const needsAuth = PROTECTED.some((p) => pathname.startsWith(p));
  const isAuthPage = AUTH_ONLY.includes(pathname);

  if (!needsAuth && !isAuthPage) return next();

  const signedIn = isAuthenticated(context.cookies);

  if (needsAuth && !signedIn) {
    return context.redirect(`/login?next=${encodeURIComponent(pathname + search)}`);
  }

  if (isAuthPage && signedIn) {
    return context.redirect('/dashboard');
  }

  return next();
});
