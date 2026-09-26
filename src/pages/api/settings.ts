import type { APIRoute } from 'astro';
import { randomBytes } from 'node:crypto';
import { json, principal, readBody, requirePermission } from '../../lib/api';
import { sql } from '../../lib/db';
import { isMonthDay, quarterWarnings } from '../../lib/quarters';
import { getSettings, publicSettings } from '../../lib/settings';

// Company settings (one row). GET is open to everyone signed in and never
// includes the webhook secret, only whether one is set. PATCH needs
// settings.manage; any subset of the fields may be sent.

export const GET: APIRoute = async () => {
  return json({ settings: publicSettings(await getSettings()) });
};

const DOMAIN = /^[a-z0-9.-]+\.[a-z]{2,}$/;

function validTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const PATCH: APIRoute = async ({ request, locals }) => {
  const denied = requirePermission(locals, 'settings.manage');
  if (denied) return denied;
  const body = await readBody(request);
  const sets: Record<string, unknown> = {};
  const bad = (msg: string) => json({ error: msg }, 400);

  if ('company_name' in body) {
    if (typeof body.company_name !== 'string' || !body.company_name.trim()) return bad('Company name is required');
    sets.company_name = body.company_name.trim().slice(0, 120);
  }
  if ('week_start' in body) {
    const n = Number(body.week_start);
    if (!Number.isInteger(n) || n < 0 || n > 6) return bad('Week start must be a day from Sunday (0) to Saturday (6)');
    sets.week_start = n;
  }
  if ('timezone' in body) {
    const tz = typeof body.timezone === 'string' ? body.timezone.trim() : '';
    if (!tz || tz.length > 64 || !validTimeZone(tz)) return bad('Unknown timezone; use an IANA name such as America/Chicago');
    sets.timezone = tz;
  }
  for (const q of ['q1_start', 'q2_start', 'q3_start', 'q4_start'] as const) {
    if (!(q in body)) continue;
    if (!isMonthDay(body[q])) return bad(`${q.slice(0, 2).toUpperCase()} start must be a valid month and day (MM-DD)`);
    sets[q] = body[q];
  }
  if ('fiscal_year_named_by' in body) {
    if (body.fiscal_year_named_by !== 'start' && body.fiscal_year_named_by !== 'end') return bad('Fiscal year naming must be "start" or "end"');
    sets.fiscal_year_named_by = body.fiscal_year_named_by;
  }
  if ('email_domain' in body) {
    const v = body.email_domain;
    if (v === null || (typeof v === 'string' && !v.trim())) sets.email_domain = null;
    else {
      const d = typeof v === 'string' ? v.trim().toLowerCase().replace(/^@/, '') : '';
      if (!DOMAIN.test(d) || d.length > 120) return bad('Email domain must look like example.com');
      sets.email_domain = d;
    }
  }
  if ('recap_webhook_url' in body) {
    const v = body.recap_webhook_url;
    if (v === null || (typeof v === 'string' && !v.trim())) sets.recap_webhook_url = null;
    else {
      const u = typeof v === 'string' ? v.trim() : '';
      let ok = false;
      try {
        ok = new URL(u).protocol === 'https:';
      } catch {
        ok = false;
      }
      if (!ok || !/^https:\/\//.test(u) || u.length > 2000) return bad('The webhook URL must be a full https:// address');
      sets.recap_webhook_url = u;
    }
  }
  let generated: string | undefined;
  if (body.generate_secret === true) {
    generated = randomBytes(32).toString('hex');
    sets.recap_webhook_secret = generated;
  } else if ('recap_webhook_secret' in body && body.recap_webhook_secret !== undefined) {
    const v = body.recap_webhook_secret;
    if (v === null) sets.recap_webhook_secret = null;
    else if (typeof v !== 'string' || v.trim().length < 16 || v.length > 200) return bad('The webhook secret must be 16 to 200 characters');
    else sets.recap_webhook_secret = v.trim();
  }

  const current = await getSettings();
  const warnings = quarterWarnings({
    q1_start: (sets.q1_start as string) ?? current.q1_start,
    q2_start: (sets.q2_start as string) ?? current.q2_start,
    q3_start: (sets.q3_start as string) ?? current.q3_start,
    q4_start: (sets.q4_start as string) ?? current.q4_start,
    fiscal_year_named_by: (sets.fiscal_year_named_by as 'start' | 'end') ?? current.fiscal_year_named_by,
  });

  const cols = Object.keys(sets);
  if (cols.length) {
    const p = principal(locals);
    const params: unknown[] = cols.map((c) => sets[c]);
    params.push(p.kind === 'person' ? p.id : null);
    const assignments = cols.map((c, i) => `${c} = $${i + 1}`).join(', ');
    try {
      // The row exists after the P0 upgrade; the insert covers a half-set-up database
      await sql().transaction([
        sql().query('insert into company_settings (id) values (true) on conflict (id) do nothing'),
        sql().query(
          `update company_settings set ${assignments}, updated_by = $${params.length}, updated_at = now() where id`,
          params
        ),
      ]);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown error';
      return json({ error: `Settings were not saved: ${message}` }, 400);
    }
  }

  const settings = publicSettings(await getSettings());
  return json({ settings, ...(generated ? { generated_secret: generated } : {}), ...(warnings.length ? { warnings } : {}) });
};
