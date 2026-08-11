-- ── Carrier Vetting — Immutable Audit Log ──────────────────────────────────
-- Run this in the Supabase SQL editor (after schema.sql).
-- Records are insert-only. Corrections create a new row; the old one stays.

create table if not exists vetting_logs (
  id               uuid        primary key default gen_random_uuid(),
  created_at       timestamptz not null default now(),

  -- Run metadata
  load_ref         text        not null,
  dispatcher       text        not null,

  -- Carrier identity
  carrier_name     text,
  dot_number       text,
  mc_number        text,

  -- Verdict
  verdict          text        not null
                   check (verdict in ('APPROVE','HOLD','REJECT','APPROVED WITH OVERRIDE')),
  tier             text        not null
                   check (tier in ('GREEN','YELLOW','RED')),
  reasons          jsonb       not null,

  -- Full data snapshot (for reconstruction and audit)
  carrier_data     jsonb       not null,

  -- Override details (null when not applicable)
  override_manager text,
  override_reason  text,
  override_at      timestamptz,

  -- PDF storage
  pdf_url          text
);

-- Indexes for common queries
create index if not exists vetting_logs_created_at_idx on vetting_logs (created_at desc);
create index if not exists vetting_logs_dot_idx        on vetting_logs (dot_number);
create index if not exists vetting_logs_load_ref_idx   on vetting_logs (load_ref);

-- Enable RLS (the backend uses the service-role key which bypasses RLS,
-- but RLS must be enabled to allow policy declarations)
alter table vetting_logs enable row level security;

-- No SELECT / UPDATE / DELETE policies for the anon/authenticated role.
-- The service-role key the backend uses bypasses all policies.
-- Application code enforces insert-only by never calling update/delete
-- on this table (the one exception: pdf_url update immediately after insert,
-- done in the same request in routes/vetting.js).

comment on table vetting_logs is
  'Immutable carrier vetting audit trail. One row per vetting run. '
  'Corrections create a new row — the old record is never modified or deleted. '
  '5-year legal retention. Per: Montgomery v. Caribe Transport.';
