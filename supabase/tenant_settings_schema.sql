-- ── Per-tenant vetting threshold configuration ───────────────────────────────
-- All rules-engine checks must read from this table — never hardcoded.
-- Sensible defaults: all BASICs at 55%, $1M auto, $100K cargo, 365-day authority.
-- Run this after tenants table exists.

create table if not exists tenant_settings (
  tenant_slug  text primary key references tenants(slug) on delete cascade,

  -- BASIC alert thresholds (1–100 percentile)
  basic_unsafe_driving_threshold       int      not null default 55
    check (basic_unsafe_driving_threshold between 1 and 100),
  basic_crash_indicator_threshold      int      not null default 55
    check (basic_crash_indicator_threshold between 1 and 100),
  basic_hos_threshold                  int      not null default 55
    check (basic_hos_threshold between 1 and 100),
  basic_vehicle_maintenance_threshold  int      not null default 55
    check (basic_vehicle_maintenance_threshold between 1 and 100),
  basic_driver_fitness_threshold       int      not null default 55
    check (basic_driver_fitness_threshold between 1 and 100),
  basic_controlled_substance_threshold int      not null default 55
    check (basic_controlled_substance_threshold between 1 and 100),

  -- Action when BASIC exceeds threshold: 'reject' (hard block) | 'hold' (override-able)
  basic_unsafe_driving_action          text     not null default 'reject'
    check (basic_unsafe_driving_action in ('reject','hold')),
  basic_crash_indicator_action         text     not null default 'reject'
    check (basic_crash_indicator_action in ('reject','hold')),
  basic_hos_action                     text     not null default 'hold'
    check (basic_hos_action in ('reject','hold')),
  basic_vehicle_maintenance_action     text     not null default 'hold'
    check (basic_vehicle_maintenance_action in ('reject','hold')),
  basic_driver_fitness_action          text     not null default 'hold'
    check (basic_driver_fitness_action in ('reject','hold')),
  basic_controlled_substance_action    text     not null default 'reject'
    check (basic_controlled_substance_action in ('reject','hold')),

  -- Insurance minimums (USD)
  auto_liability_min                   int      not null default 1000000,
  cargo_min                            int      not null default 100000,

  -- Authority age minimum
  authority_min_days                   int      not null default 365,
  -- 'hold' = manager-override-able; 'block' = hard reject
  authority_age_action                 text     not null default 'hold'
    check (authority_age_action in ('hold','block')),

  -- Safety rating blocks
  block_conditional                    boolean  not null default true,
  block_unsatisfactory                 boolean  not null default true,

  -- OOS rate: flag if carrier OOS% >= national_avg * oos_rate_multiplier
  oos_rate_multiplier                  numeric  not null default 2.0,

  updated_at  timestamptz not null default now()
);

comment on table tenant_settings is
  'Per-tenant vetting thresholds and rules. One row per tenant. '
  'Upserted on save; new tenants get column defaults (sensible starting policy). '
  'The rules engine and PDF generator read exclusively from this table — '
  'no threshold values are hardcoded anywhere in the application. '
  'Required for defensible per-broker policy under Montgomery v. Caribe Transport.';

alter table tenant_settings enable row level security;
-- Backend uses the service-role key which bypasses RLS.
-- No anon/authenticated policies are needed.
