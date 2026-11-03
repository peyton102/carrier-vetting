-- Chameleon check lookback window setting.
-- Bad events (OOS, revocation) older than this many days AND no longer active
-- are shown as informational rather than triggering HOLD.
-- Default 1095 = 3 years.

ALTER TABLE tenant_settings
  ADD COLUMN IF NOT EXISTS chameleon_lookback_days integer NOT NULL DEFAULT 1095;
