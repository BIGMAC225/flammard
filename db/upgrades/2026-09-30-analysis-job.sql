-- Background meeting analysis: when a run started and why it failed.
-- Additive and re-runnable.
alter table meetings add column if not exists analysis_started_at timestamptz;
alter table meetings add column if not exists analysis_error text;
