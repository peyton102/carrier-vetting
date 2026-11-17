-- v5: FMCSA insurance tracking — insurer churn threshold + monitoring snapshots
-- Run manually in Supabase SQL editor.

-- 1. Insurance churn threshold setting
ALTER TABLE tenant_settings
  ADD COLUMN IF NOT EXISTS insurer_churn_threshold integer NOT NULL DEFAULT 3;

-- 2. Monitoring snapshot columns on monitored_loads
ALTER TABLE monitored_loads
  ADD COLUMN IF NOT EXISTS last_insurer          text,
  ADD COLUMN IF NOT EXISTS last_authority_status  text,
  ADD COLUMN IF NOT EXISTS last_fmcsa_liability   integer;

-- 3. Monitoring snapshot columns on watched_carriers
ALTER TABLE watched_carriers
  ADD COLUMN IF NOT EXISTS last_insurer          text,
  ADD COLUMN IF NOT EXISTS last_authority_status  text,
  ADD COLUMN IF NOT EXISTS last_fmcsa_liability   integer;
