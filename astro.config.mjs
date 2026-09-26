import { defineConfig } from 'astro/config';
import netlify from '@astrojs/netlify';
import react from '@astrojs/react';
import tailwind from '@astrojs/tailwind';

export default defineConfig({
  output: 'server',
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
