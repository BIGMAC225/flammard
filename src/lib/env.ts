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
  return runtime || (import.meta.env as Record<string, string | undefined>)[name] || undefined;
}
