-- ── Tenants ───────────────────────────────────────────────────────────────────
-- Run this first, before vetting_schema.sql.
-- One row per tenant (org). Login is by email + password; slug is the tenant key
-- embedded in the JWT and used for all data scoping.

create table if not exists tenants (
  slug          text primary key,                   -- e.g. "precision-transport"
  email         text not null unique,               -- login email
  name          text not null,                      -- display name shown in the nav
  password_hash text not null,                      -- bcrypt hash
  created_at    timestamptz not null default now()
);

alter table tenants enable row level security;

-- ── Add tenant_id to vetting_logs (if vetting_schema.sql already ran) ─────────
-- tenant_id stores the tenant slug for data scoping.
alter table vetting_logs
  add column if not exists tenant_id text references tenants(slug);

create index if not exists vetting_logs_tenant_id_idx on vetting_logs (tenant_id);
