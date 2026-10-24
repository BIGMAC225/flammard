import type { APIRoute } from 'astro';
// .ts extensions: tests load this module under plain Node (type stripping),
// which resolves relative imports literally
import { json } from '../../../lib/api.ts';
import { handleL10Export } from '../../../lib/l10-export.ts';

// GET /api/export/l10?team=<slug> — the read-only weekly L10 export for the
// scheduled prep worker: Scorecard, current-quarter Rocks, open Issues, open
// To-Dos and the last meeting as one JSON document. No session; the caller
// sends `Authorization: Bearer <L10_EXPORT_TOKEN>`. See docs/L10_EXPORT.md.
//
// ALL exists because Astro answers a method with no exported handler with a
// 404, and this route must be 405 for everything but GET.

export const GET: APIRoute = (ctx) => handleL10Export(ctx);

export const ALL: APIRoute = () => json({ error: 'method not allowed' }, 405);
