-- ── Broker check audit log ────────────────────────────────────────────────────
-- Separate from vetting_logs — broker checks use only FMCSA public data,
-- never SaferWatch. Kept isolated intentionally for compliance clarity.

create table if not exists broker_check_logs (
  id          uuid        primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  tenant_id   text        not null references tenants(slug) on delete cascade,
  mc_number   text,
  broker_name text,
  dot_number  text,
  verdict     text        not null check (verdict in ('PASS', 'FAIL', 'ERROR')),
  reasons     jsonb,
  broker_data jsonb,
  bond_data   jsonb,
  data_source text        not null default 'FMCSA Public API'
);

create index if not exists broker_check_logs_tenant_idx on broker_check_logs (tenant_id, created_at desc);

alter table broker_check_logs enable row level security;

comment on table broker_check_logs is
  'Audit log for broker authority checks. Uses ONLY FMCSA public API data. '
  'SaferWatch/Truckstop data is never used in broker checks per reseller terms.';
