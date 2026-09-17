-- ── tenant_settings v2 migration ─────────────────────────────────────────────
-- Adds: 2 new BASICs (vehicle_driver_observed, hazmat), OOS hard blocks,
--        and inspection volume minimum.
-- Run this in the Supabase SQL editor after the original tenant_settings table exists.

-- New BASIC: Vehicle Driver-Observed
alter table tenant_settings
  add column if not exists basic_vehicle_driver_observed_threshold int not null default 65
    check (basic_vehicle_driver_observed_threshold between 1 and 100),
  add column if not exists basic_vehicle_driver_observed_action text not null default 'hold'
    check (basic_vehicle_driver_observed_action in ('reject','hold'));

-- New BASIC: Hazardous Materials
alter table tenant_settings
  add column if not exists basic_hazmat_threshold int not null default 80
    check (basic_hazmat_threshold between 1 and 100),
  add column if not exists basic_hazmat_action text not null default 'hold'
    check (basic_hazmat_action in ('reject','hold'));

-- OOS hard block thresholds (auto-REJECT, no override path)
alter table tenant_settings
  add column if not exists oos_hard_block_truck  numeric not null default 35.0,
  add column if not exists oos_hard_block_driver numeric not null default 7.0;

-- Inspection volume minimum for reliable BASIC percentile evaluation
alter table tenant_settings
  add column if not exists inspection_volume_min int not null default 3;

-- Also update existing DEFAULT thresholds to FMCSA intervention values
-- (only affects tenants who have NOT yet customised — existing rows keep their values)
-- If you want to reset ALL tenants to FMCSA defaults, uncomment the UPDATE below:
-- update tenant_settings set
--   basic_unsafe_driving_threshold       = 65,
--   basic_crash_indicator_threshold      = 65,
--   basic_hos_threshold                  = 65,
--   basic_vehicle_maintenance_threshold  = 80,
--   basic_driver_fitness_threshold       = 80,
--   basic_controlled_substance_threshold = 50;
