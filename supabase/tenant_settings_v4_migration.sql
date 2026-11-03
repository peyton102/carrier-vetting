-- v4: add bipd_cancel_days threshold (default 30 days)
-- Carriers with BMC-35 effective date within this many days → HOLD

ALTER TABLE tenant_settings
  ADD COLUMN IF NOT EXISTS bipd_cancel_days integer NOT NULL DEFAULT 30;
