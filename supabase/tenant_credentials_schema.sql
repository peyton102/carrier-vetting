-- ── Per-tenant encrypted API credentials ──────────────────────────────────────
-- Stores SaferWatch credentials encrypted at the application layer (AES-256-GCM).
-- Values are never stored in plaintext — format: iv:authTag:ciphertext (base64).
-- Run after tenants table exists.

create table if not exists tenant_credentials (
  tenant_slug      text        primary key references tenants(slug) on delete cascade,
  -- AES-256-GCM encrypted. Format: base64(iv):base64(authTag):base64(ciphertext)
  -- Decryptable only with ENCRYPTION_KEY env var. Unreadable from a raw DB dump.
  sw_service_key   text,
  sw_customer_key  text,
  sw_configured_at timestamptz,
  updated_at       timestamptz not null default now()
);

alter table tenant_credentials enable row level security;
-- Backend uses the service-role key which bypasses RLS.
-- Application code always scopes queries to req.auth.tenant (from verified JWT).

comment on table tenant_credentials is
  'Per-tenant API credentials, encrypted at the application layer with AES-256-GCM. '
  'The ENCRYPTION_KEY env var is the sole decryption secret — it never touches the DB. '
  'GET /api/credentials/* endpoints return configured status only, never plaintext keys.';
