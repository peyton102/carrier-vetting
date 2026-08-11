-- ── Multi-tenant schema migration ────────────────────────────────────────────
-- Run this in the Supabase SQL editor AFTER vetting_schema.sql.
-- Creates organizations + users tables and adds org_id to vetting_logs.

-- ── Organizations ─────────────────────────────────────────────────────────────
create table if not exists organizations (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  slug       text not null unique,
  created_at timestamptz not null default now()
);

-- ── Users ─────────────────────────────────────────────────────────────────────
create table if not exists users (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organizations(id) on delete cascade,
  email         text not null unique,
  password_hash text not null,
  name          text not null,
  role          text not null default 'dispatcher'
                check (role in ('admin', 'dispatcher')),
  created_at    timestamptz not null default now()
);

create index if not exists users_org_id_idx on users (org_id);
create index if not exists users_email_idx  on users (email);

-- ── Add org_id to vetting_logs ────────────────────────────────────────────────
alter table vetting_logs
  add column if not exists org_id uuid references organizations(id);

create index if not exists vetting_logs_org_id_idx on vetting_logs (org_id);

-- ── RLS ───────────────────────────────────────────────────────────────────────
-- Backend uses the service-role key which bypasses RLS.
-- Tenant isolation is enforced at the application layer (org_id scoping).
alter table organizations enable row level security;
alter table users         enable row level security;

-- ── Seed example (run manually, replace values) ───────────────────────────────
-- To bootstrap your first tenant, run:
--   node backend/scripts/create-user.js
-- Or manually:
--
-- insert into organizations (name, slug) values ('Precision Freight', 'precision-freight');
--
-- -- Then get the org id:
-- select id from organizations where slug = 'precision-freight';
--
-- -- Hash your password first with: node -e "import('bcryptjs').then(b=>b.default.hash('yourpass',10).then(console.log))"
-- insert into users (org_id, email, password_hash, name, role)
-- values ('<org-id>', 'admin@example.com', '<bcrypt-hash>', 'Admin', 'admin');
