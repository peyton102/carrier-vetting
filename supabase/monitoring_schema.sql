-- ── Carrier Monitoring Tables ─────────────────────────────────────────────────
-- Tracks active loads in-transit and fires alerts when carrier status changes.
-- Run this in the Supabase SQL editor.

create table if not exists monitored_loads (
  id                   uuid        primary key default gen_random_uuid(),
  tenant_id            text        not null references tenants(slug) on delete cascade,
  vetting_log_id       uuid,
  load_ref             text        not null,
  dot_number           text        not null,
  carrier_name         text,
  mc_number            text,
  started_by           text,
  check_interval_hours numeric     default 4,
  last_checked_at      timestamptz,
  last_status          text        default 'pending',
  last_issues          jsonb,
  last_alert_at        timestamptz,
  delivered_at         timestamptz,
  created_at           timestamptz default now()
);

create table if not exists monitoring_alerts (
  id                 uuid        primary key default gen_random_uuid(),
  tenant_id          text        not null references tenants(slug) on delete cascade,
  monitored_load_id  uuid        references monitored_loads(id) on delete cascade,
  load_ref           text,
  carrier_name       text,
  dot_number         text,
  alert_type         text,       -- 'status_change' | 'cannot_verify'
  issues             jsonb,
  is_acknowledged    boolean     default false,
  acknowledged_at    timestamptz,
  created_at         timestamptz default now()
);

-- Indexes for common queries
create index if not exists monitored_loads_tenant_active
  on monitored_loads(tenant_id) where delivered_at is null;

create index if not exists monitoring_alerts_tenant_unacked
  on monitoring_alerts(tenant_id) where is_acknowledged = false;
