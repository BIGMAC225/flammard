import { defineMiddleware } from 'astro:middleware';
import { createSupabaseServerClient } from './lib/supabase-server';

const PROTECTED = ['/dashboard'];
const AUTH_ONLY = ['/login'];

export const onRequest = defineMiddleware(async (context, next) => {
  const { pathname } = new URL(context.request.url);

  const needsAuth = PROTECTED.some((p) => pathname.startsWith(p));
  const isAuthPage = AUTH_ONLY.includes(pathname);

  if (!needsAuth && !isAuthPage) return next();

  const supabase = createSupabaseServerClient(context.request, context.cookies);
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (needsAuth && !user) {
    const next = encodeURIComponent(pathname + new URL(context.request.url).search);
    return context.redirect(`/login?next=${next}`);
  }

  if (isAuthPage && user) {
    return context.redirect('/dashboard');
  }

  return next();
});
