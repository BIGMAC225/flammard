-- Fulfillment settings (2026-10-24), part 1: job_snapshots.created_at, the
-- job's creation date straight from the TaxDome API (the poller already sorts
-- the /jobs walk by it). The weekly flow charts date arrivals from it, falling
-- back to intake_date / start_date for rows captured before this column
-- existed; completions are dated by completed_at, which was already stored.
-- Paste into the Neon SQL Editor and run. Additive and safe to run more than
-- once. A later part appends the fulfillment settings tables to this file.

alter table job_snapshots add column if not exists created_at timestamptz;

-- Fulfillment settings (2026-10-24), part 2: the settings page's own schema —
-- a hidden flag on td_pipelines, per-stage threshold overrides on
-- stage_type_map, the government_wait stall rule, the hidden-pipeline seeds
-- and a draft stage_type_map seeded from the 2026-10-23 stages export (titles
-- joined, never ids). Paste into the Neon SQL Editor and run. Additive and
-- safe to run more than once.

alter table td_pipelines add column if not exists hidden boolean not null default false;

-- warn_days overrides stall_rules.stuck_days (amber), stuck_days overrides
-- stall_rules.critical_days (red), ball_with overrides stall_rules.ball_with
-- ('none' means excluded); null means use the stall_rules default.
alter table stage_type_map add column if not exists warn_days integer;
alter table stage_type_map add column if not exists stuck_days integer;
alter table stage_type_map add column if not exists ball_with text;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'stage_type_map_ball_with_check') then
    alter table stage_type_map add constraint stage_type_map_ball_with_check
      check (ball_with is null or ball_with in ('firm', 'client', 'government', 'none'));
  end if;
end $$;

-- The government-wait stage type: long clock, the ball sits with the agency
-- (the seeded map rows override ball_with to 'government' per stage).
insert into stall_rules (stage_type, stuck_days, critical_days, ball_with)
values ('government_wait', 30, 60, 'client')
on conflict (stage_type) do nothing;

-- Seed the hidden flag for the pipelines that never carry client work. The
-- guard means a re-run never undoes a later unhide by Russell: once any
-- pipeline is hidden, this seed does nothing again.
update td_pipelines set hidden = true
where title in (
    'DO NOT USE',
    'Internal Tasks',
    'Misc - No stages',
    'Taxdome Backup Records',
    'Video Production - Tax Bites',
    '1040 Tax Return Pipeline (from webinar)',
    '1040 Tax Return Pipeline (from webinar) (2)',
    '1040 Tax Return Pipeline (from webinar) (4)',
    'EN (UK) - Payroll Processing'
  )
  and not exists (select 1 from td_pipelines where hidden);

-- Draft stage map from the 2026-10-23 stages export (117 of its 195 stages
-- classify; the rest stay unmapped). Joined on titles — some carry an en dash,
-- a leading/trailing space or a double space, all preserved byte for byte and
-- single quotes escaped by doubling — so nothing depends on TaxDome ids;
-- on conflict keeps any row Russell has since edited.
insert into stage_type_map (pipeline_id, stage_id, stage_type, warn_days, stuck_days, ball_with)
select p.id, s.id, v.stage_type, v.warn_days, v.stuck_days, v.ball_with
from (values
  ('1040 Tax Return Pipeline (from webinar)', 'Waiting for organizer', 'documents', 14, 30, 'client'),
  ('1040 Tax Return Pipeline (from webinar)', 'In prep', 'preparation', 7, 14, 'firm'),
  ('1040 Tax Return Pipeline (from webinar)', 'Missing info', 'missing_info', 14, 30, 'client'),
  ('1040 Tax Return Pipeline (from webinar)', 'Prep post missing info', 'missing_info', 14, 30, 'client'),
  ('1040 Tax Return Pipeline (from webinar)', 'Prep post extension', 'preparation', 7, 14, 'firm'),
  ('1040 Tax Return Pipeline (from webinar)', 'Manager Review', 'review', 5, 10, 'firm'),
  ('1040 Tax Return Pipeline (from webinar)', 'Invoice + signature', 'client_review_sign', 14, 30, 'client'),
  ('1040 Tax Return Pipeline (from webinar)', 'E-filing', 'filing', 3, 7, 'firm'),
  ('1040 Tax Return Pipeline (from webinar)', '1040 Complete', 'delivery', 3, 7, 'firm'),
  ('1040 Tax Return Pipeline (from webinar) (2)', 'Waiting for organizer', 'documents', 14, 30, 'client'),
  ('1040 Tax Return Pipeline (from webinar) (2)', 'In prep', 'preparation', 7, 14, 'firm'),
  ('1040 Tax Return Pipeline (from webinar) (2)', 'Missing info', 'missing_info', 14, 30, 'client'),
  ('1040 Tax Return Pipeline (from webinar) (2)', 'Prep post missing info', 'missing_info', 14, 30, 'client'),
  ('1040 Tax Return Pipeline (from webinar) (2)', 'Prep post extension', 'preparation', 7, 14, 'firm'),
  ('1040 Tax Return Pipeline (from webinar) (2)', 'Manager Review', 'review', 5, 10, 'firm'),
  ('1040 Tax Return Pipeline (from webinar) (2)', 'Invoice + signature', 'client_review_sign', 14, 30, 'client'),
  ('1040 Tax Return Pipeline (from webinar) (2)', 'E-filing', 'filing', 3, 7, 'firm'),
  ('1040 Tax Return Pipeline (from webinar) (2)', '1040 Complete', 'delivery', 3, 7, 'firm'),
  ('1040 Tax Return Pipeline (from webinar) (4)', 'Waiting for organizer', 'documents', 14, 30, 'client'),
  ('1040 Tax Return Pipeline (from webinar) (4)', 'In prep', 'preparation', 7, 14, 'firm'),
  ('1040 Tax Return Pipeline (from webinar) (4)', 'Missing info', 'missing_info', 14, 30, 'client'),
  ('1040 Tax Return Pipeline (from webinar) (4)', '1st review', 'review', 5, 10, 'firm'),
  ('1040 Tax Return Pipeline (from webinar) (4)', 'Manager Review', 'review', 5, 10, 'firm'),
  ('1040 Tax Return Pipeline (from webinar) (4)', 'Invoice + signature', 'client_review_sign', 14, 30, 'client'),
  ('1040 Tax Return Pipeline (from webinar) (4)', 'E-filing', 'filing', 3, 7, 'firm'),
  ('1040 Tax Return Pipeline (from webinar) (4)', '1040 Complete', 'delivery', 3, 7, 'firm'),
  ('1040 Tax Return Pipeline (from webinar) (4)', 'Prep post extension', 'preparation', 7, 14, 'firm'),
  ('1099 Preparation', 'Prepare 1099s', 'preparation', 7, 14, 'firm'),
  ('1099 Preparation', 'Review 1099s', 'review', 5, 10, 'firm'),
  ('1099 Preparation', 'Prepare Invoice', 'preparation', 7, 14, 'firm'),
  ('1099 Preparation', 'Review and Send Invoice', 'review', 5, 10, 'firm'),
  ('1120 – Corporate Income Tax Return', 'Organizer Sent / Contract Signed', 'documents', 14, 30, 'client'),
  ('1120 – Corporate Income Tax Return', 'In Prep', 'preparation', 7, 14, 'firm'),
  ('1120 – Corporate Income Tax Return', 'In Review', 'review', 5, 10, 'firm'),
  ('After the Fact Payroll Preparation', 'Prepare Payroll Tax Returns in Accountant''s Office', 'preparation', 7, 14, 'firm'),
  ('After the Fact Payroll Preparation', 'Review Prepared Payroll Returns', 'review', 5, 10, 'firm'),
  ('After the Fact Payroll Preparation', 'Prepare Invoice', 'preparation', 7, 14, 'firm'),
  ('After the Fact Payroll Preparation', 'Review and send invoice', 'review', 5, 10, 'firm'),
  ('Bi-Weekly Payroll', 'Draft & Review Invoice ', 'review', 5, 10, 'firm'),
  ('Cash Flow Management', 'Review All Cash Flow Reports - 1', 'review', 5, 10, 'firm'),
  ('EN (UK) - Payroll Processing', 'Prepare Payroll', 'preparation', 7, 14, 'firm'),
  ('Easy Task Tax Prep', 'Prepare', 'preparation', 7, 14, 'firm'),
  ('Easy Task Tax Prep', 'Review', 'review', 5, 10, 'firm'),
  ('Easy Task Tax Prep', 'Send Signature Request to Client', 'client_review_sign', 14, 30, 'client'),
  ('Easy Task Tax Prep', 'Efile', 'filing', 3, 7, 'firm'),
  ('Easy Task Tax Prep', 'Review Invoice', 'review', 5, 10, 'firm'),
  ('Full Year Quarterly Tax Estimate', '1st Qtr Estimate Prep', 'preparation', 7, 14, 'firm'),
  ('Full Year Quarterly Tax Estimate', '1st Qtr Estimate Review', 'review', 5, 10, 'firm'),
  ('Full Year Quarterly Tax Estimate', '2nd Qtr Estimate Prep', 'preparation', 7, 14, 'firm'),
  ('Full Year Quarterly Tax Estimate', '2nd Qtr Estimate Review', 'review', 5, 10, 'firm'),
  ('Full Year Quarterly Tax Estimate', '3rd Qtr Estimate Prep', 'preparation', 7, 14, 'firm'),
  ('Full Year Quarterly Tax Estimate', '3rd Qtr Estimate Review', 'review', 5, 10, 'firm'),
  ('Full Year Quarterly Tax Estimate', '4th Qtr Estimate Prep', 'preparation', 7, 14, 'firm'),
  ('Full Year Quarterly Tax Estimate', '4th Qtr Estimate Review', 'review', 5, 10, 'firm'),
  ('Internal Tasks', 'Assign Task', 'intake', 3, 7, 'firm'),
  ('Misc - No stages', 'To Do', 'intake', 3, 7, 'firm'),
  ('Monthly Accounting', 'Prepare monthly bookkeeping', 'preparation', 7, 14, 'firm'),
  ('Monthly Accounting', 'Initial review', 'review', 5, 10, 'firm'),
  ('Monthly Accounting', 'XiXi Review', 'review', 5, 10, 'firm'),
  ('Monthly Accounting', 'Review bookkeeping and prepare reports to send to client', 'review', 5, 10, 'firm'),
  ('Monthly Accounting', 'Review Invoice', 'review', 5, 10, 'firm'),
  ('Monthly Accounting', 'Archive once complete', 'delivery', 3, 7, 'firm'),
  ('Monthly Bookkeeping', 'Review Documents', 'review', 5, 10, 'firm'),
  ('Monthly Bookkeeping', 'Prepare the Draft Reports', 'preparation', 7, 14, 'firm'),
  ('Monthly Bookkeeping', 'Review Draft Reports', 'review', 5, 10, 'firm'),
  ('Monthly Bookkeeping', 'Client Review', 'review', 5, 10, 'firm'),
  ('Notice Response', 'Prepare Response', 'preparation', 7, 14, 'firm'),
  ('Notice Response', 'Review Response', 'review', 5, 10, 'firm'),
  ('Notice Response', 'Waiting for Government Response', 'government_wait', 30, 60, 'government'),
  ('Notice Response REVAMPED', 'Prepare Response', 'preparation', 7, 14, 'firm'),
  ('Notice Response REVAMPED', 'Review Response', 'review', 5, 10, 'firm'),
  ('Notice Response REVAMPED', ' Signer Review', 'review', 5, 10, 'firm'),
  ('Notice Response REVAMPED', 'Waiting for Government Response', 'government_wait', 30, 60, 'government'),
  ('Quarterly Tax Estimate', 'Prepare estimate', 'preparation', 7, 14, 'firm'),
  ('Quarterly Tax Estimate', 'Review estimate', 'review', 5, 10, 'firm'),
  ('Reasonable Comp Worksheet', 'Prepare ', 'preparation', 7, 14, 'firm'),
  ('Reasonable Comp Worksheet', 'Review ', 'review', 5, 10, 'firm'),
  ('Reasonable Comp Worksheet', 'Review Invoice ', 'review', 5, 10, 'firm'),
  ('Sales Tax', 'Prepare sales tax returns', 'preparation', 7, 14, 'firm'),
  ('Sales Tax', 'XiXi Review ', 'review', 5, 10, 'firm'),
  ('Sales Tax', 'Efile and Process', 'filing', 3, 7, 'firm'),
  ('Sales Tax', 'Archive once complete', 'delivery', 3, 7, 'firm'),
  ('Tax Preparation', 'Send out organizer from Lacerte', 'documents', 14, 30, 'client'),
  ('Tax Preparation', 'Prepare Return', 'preparation', 7, 14, 'firm'),
  ('Tax Preparation', 'Perform Admin Review', 'review', 5, 10, 'firm'),
  ('Tax Preparation', 'Review Return', 'review', 5, 10, 'firm'),
  ('Tax Preparation', 'Missing Information and Open Questions', 'missing_info', 14, 30, 'client'),
  ('Tax Preparation', 'Update for Missing Information In', 'missing_info', 14, 30, 'client'),
  ('Tax Preparation', 'Review Updated Return - Is it ready for signature?', 'client_review_sign', 14, 30, 'client'),
  ('Tax Preparation', 'Review Invoice', 'review', 5, 10, 'firm'),
  ('Tax Preparation', 'Send Signature Request to Client', 'client_review_sign', 14, 30, 'client'),
  ('Tax Preparation', 'Efile Return (Jennifer)', 'filing', 3, 7, 'firm'),
  ('Tax Preparation', 'Efile Return (Jude)', 'filing', 3, 7, 'firm'),
  ('Tax Preparation', 'Process Return for Client Delivery', 'delivery', 3, 7, 'firm'),
  ('Tax Preparation', 'Processed Return Review - XixI', 'review', 5, 10, 'firm'),
  ('Tax Preparation  - No Deposit Requested', 'Send out organizer from Lacerte', 'documents', 14, 30, 'client'),
  ('Tax Preparation  - No Deposit Requested', 'Prepare Return', 'preparation', 7, 14, 'firm'),
  ('Tax Preparation  - No Deposit Requested', 'Perform Admin Review', 'review', 5, 10, 'firm'),
  ('Tax Preparation  - No Deposit Requested', 'Review Return', 'review', 5, 10, 'firm'),
  ('Tax Preparation  - No Deposit Requested', 'Missing Information and Open Questions', 'missing_info', 14, 30, 'client'),
  ('Tax Preparation  - No Deposit Requested', 'Update for Missing Information In', 'missing_info', 14, 30, 'client'),
  ('Tax Preparation  - No Deposit Requested', 'Review Updated Return - Is it ready for signature?', 'client_review_sign', 14, 30, 'client'),
  ('Tax Preparation  - No Deposit Requested', 'Review Invoice', 'review', 5, 10, 'firm'),
  ('Tax Preparation  - No Deposit Requested', 'Send Signature Request to Client', 'client_review_sign', 14, 30, 'client'),
  ('Tax Preparation  - No Deposit Requested', 'Efile Return (Jennifer)', 'filing', 3, 7, 'firm'),
  ('Tax Preparation  - No Deposit Requested', 'Efile Return (Jude)', 'filing', 3, 7, 'firm'),
  ('Tax Preparation  - No Deposit Requested', 'Process Return for Client Delivery', 'delivery', 3, 7, 'firm'),
  ('Tax Preparation  - No Deposit Requested', 'Review Processed Return - XiXi', 'review', 5, 10, 'firm'),
  ('Taxdome Backup Records', 'Prep', 'preparation', 7, 14, 'firm'),
  ('Taxdome Backup Records', 'Logged & complete', 'delivery', 3, 7, 'firm'),
  ('Video Production - Tax Bites', 'Review Script', 'review', 5, 10, 'firm'),
  ('Video Production - Tax Bites', 'Send Video for Review', 'review', 5, 10, 'firm'),
  ('WC Audit', 'Prep Audit ', 'preparation', 7, 14, 'firm'),
  ('WC Audit', 'Review Audit', 'review', 5, 10, 'firm'),
  ('WC Audit', 'FINAL Review', 'review', 5, 10, 'firm'),
  ('WC Audit', 'Prepare Invoice', 'preparation', 7, 14, 'firm'),
  ('WC Audit', 'Review and send invoice', 'review', 5, 10, 'firm')
) as v(pipeline_title, stage_title, stage_type, warn_days, stuck_days, ball_with)
join td_pipelines p on p.title = v.pipeline_title
join td_pipeline_stages s on s.pipeline_id = p.id and s.title = v.stage_title
on conflict do nothing;
