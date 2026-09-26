import { defineConfig } from 'astro/config';
import netlify from '@astrojs/netlify';
import react from '@astrojs/react';
import tailwind from '@astrojs/tailwind';

export default defineConfig({
  output: 'server',
  // Zapier posts multipart with no Origin header; the built-in CSRF check
  // would 403 it. Mutating routes are protected by the SameSite=Lax session
  // cookie or the webhook's bearer secret instead.
  security: { checkOrigin: false },
  adapter: netlify({ edgeMiddleware: false }),
  integrations: [
    react(),
    tailwind({ applyBaseStyles: false }),
  ],
  vite: {
    ssr: {
      // pdf-parse (pdf.js) resolves its worker at runtime and pulls in a
      // native canvas module; leave them to Node instead of bundling them.
      external: ['pdf-parse', 'pdf-parse/worker', 'pdfjs-dist', '@napi-rs/canvas'],
    },
  },
});
