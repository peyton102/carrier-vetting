-- Migration v3: add alert_recipients column to tenant_settings
-- Run this in the Supabase SQL editor once.

ALTER TABLE tenant_settings
  ADD COLUMN IF NOT EXISTS alert_recipients text NOT NULL DEFAULT '';
