import type { CompanySettings } from '../types';
import { one, sql } from './db';

// Company settings: one row (id = true) in company_settings. Server only —
// the full row includes the recap webhook secret; send publicSettings() to
// the browser.

export type ServerSettings = CompanySettings & { recap_webhook_secret: string | null };

// Used if the row is missing (the upgrade inserts it, so only on a half-set-up database)
const DEFAULTS: ServerSettings = {
  company_name: 'J Heath & Co',
  week_start: 2,
  timezone: 'America/Chicago',
  q1_start: '02-01',
  q2_start: '05-01',
  q3_start: '08-01',
  q4_start: '11-01',
  fiscal_year_named_by: 'start',
  email_domain: null,
  recap_webhook_url: null,
  recap_webhook_secret: null,
  recap_webhook_secret_set: false,
  text_only_owner_names: [],
  updated_at: new Date(0).toISOString(),
};

export async function getSettings(): Promise<ServerSettings> {
  const row = await one<Record<string, any>>(
    sql()`select company_name, week_start, timezone, q1_start, q2_start, q3_start, q4_start,
                 fiscal_year_named_by, email_domain, recap_webhook_url, recap_webhook_secret,
                 text_only_owner_names, updated_at
          from company_settings where id`
  );
  if (!row) return { ...DEFAULTS };
  return {
    company_name: row.company_name,
    week_start: Number(row.week_start),
    timezone: row.timezone,
    q1_start: row.q1_start,
    q2_start: row.q2_start,
    q3_start: row.q3_start,
    q4_start: row.q4_start,
    fiscal_year_named_by: row.fiscal_year_named_by,
    email_domain: row.email_domain ?? null,
    recap_webhook_url: row.recap_webhook_url ?? null,
    recap_webhook_secret: row.recap_webhook_secret ?? null,
    recap_webhook_secret_set: !!row.recap_webhook_secret,
    text_only_owner_names: row.text_only_owner_names ?? [],
    updated_at: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
  };
}

/** The settings safe to send to the browser: the secret replaced by recap_webhook_secret_set. */
export function publicSettings(s: ServerSettings | CompanySettings): CompanySettings {
  const { recap_webhook_secret, ...rest } = s as ServerSettings;
  return { ...rest, recap_webhook_secret_set: !!recap_webhook_secret || !!rest.recap_webhook_secret_set };
}
