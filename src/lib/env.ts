/**
 * Server-side secret lookup.
 *
 * Astro folds `import.meta.env.X` at build time: a variable that isn't set
 * during the build compiles to `undefined` for good, so a secret added in the
 * Netlify dashboard after the last deploy would never be seen. Reading
 * `process.env` first means runtime values always win.
 */
export function env(name: string): string | undefined {
  const runtime = typeof process !== 'undefined' ? process.env?.[name] : undefined;
  // import.meta.env only exists in the Astro build; plain Netlify functions
  // (netlify/functions/*) import this file too and have just process.env
  const built = (import.meta as { env?: Record<string, string | undefined> }).env;
  return runtime || built?.[name] || undefined;
}
