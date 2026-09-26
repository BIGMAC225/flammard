-- One-time seed of J Heath & Co people (emails, roles, teams; no passwords).
-- Safe to run more than once: a person whose name or email already exists is skipped.
--
-- >>> EMAIL DOMAIN: edit 'jheathcpa.com' on the next line if the firm's address domain differs <<<
with cfg as (select lower('jheathcpa.com')::text as domain),
set_domain as (
  update company_settings s set email_domain = cfg.domain, updated_at = now()
  from cfg where s.id and s.email_domain is null
  returning s.id
)
insert into people (name, email, role, teams, aliases)
select v.name, v.local || '@' || cfg.domain, v.role, v.teams, v.aliases
from cfg
cross join (values
  ('Russell Heath',   'russell',    'owner',  array['leadership', 'management']::text[], array[]::text[]),
  ('Jude Heath',      'judej',      'admin',  array['leadership']::text[],               array[]::text[]),
  ('Jennifer Louise', 'jennifer',   'admin',  array['leadership']::text[],               array[]::text[]),
  ('Xixi',            'xihong.ma',  'member', array['management']::text[],               array['Shishi']::text[]),
  ('Kayla',           'kayla',      'member', array['management']::text[],               array[]::text[]),
  ('Nicole',          'nicole',     'member', array['management']::text[],               array[]::text[])
) as v(name, local, role, teams, aliases)
where not exists (
  select 1 from people p
  where lower(btrim(p.name)) = lower(v.name) or p.email = v.local || '@' || cfg.domain
);
