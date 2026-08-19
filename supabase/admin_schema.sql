-- ── Admin flag + invite token system ─────────────────────────────────────────
-- Run after vetting_schema.sql and tenant_settings_schema.sql.

-- Add admin flag and active flag to tenants.
-- Existing rows default to is_active=true (already working accounts).
alter table tenants
  add column if not exists is_admin  boolean not null default false,
  add column if not exists is_active boolean not null default true;

-- IMPORTANT: After running this, mark your own account as admin:
-- update tenants set is_admin = true where slug = 'your-slug';

-- One-time invite tokens. One row per pending invite.
create table if not exists invite_codes (
  id         uuid        primary key default gen_random_uuid(),
  email      text        not null,
  token      text        not null unique,
  expires_at timestamptz not null,
  used_at    timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists invite_codes_token_idx on invite_codes (token);

alter table invite_codes enable row level security;
-- Backend uses service-role key; no anon/authenticated policies needed.
