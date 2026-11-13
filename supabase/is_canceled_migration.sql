-- Add is_canceled flag to tenants.
-- Canceled accounts can log in and export records but cannot run new vettings.
ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS is_canceled BOOLEAN NOT NULL DEFAULT FALSE;
