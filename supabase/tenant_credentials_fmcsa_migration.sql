-- ── tenant_credentials: add FMCSA web key columns ────────────────────────────
-- Run this in the Supabase SQL editor.
-- Adds encrypted FMCSA web key storage to the existing tenant_credentials table.

alter table tenant_credentials
  add column if not exists fmcsa_webkey       text,
  add column if not exists fmcsa_configured_at timestamptz;
