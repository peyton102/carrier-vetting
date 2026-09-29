-- ── Watched Carriers, Carrier Blocks, Used Carriers ──────────────────────────
-- Run in Supabase SQL editor after monitoring_schema.sql.
-- Multi-tenant versions of tables from the CRM monitoring system.

-- ── Used carriers ─────────────────────────────────────────────────────────────
-- Records every carrier that was booked (PDF generated + saved).
-- Auto-populated by /api/vetting/mark-used after PDF delivery.

CREATE TABLE IF NOT EXISTS used_carriers (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         text        NOT NULL REFERENCES tenants(slug) ON DELETE CASCADE,
  used_at           timestamptz NOT NULL DEFAULT now(),
  carrier_name      text,
  dot_number        text,
  mc_number         text,
  load_ref          text,
  dispatcher        text,
  verdict           text,
  tier              text,
  vetting_record_id uuid
);

ALTER TABLE used_carriers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_full_access_used_carriers" ON used_carriers
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE INDEX IF NOT EXISTS idx_used_carriers_tenant
  ON used_carriers(tenant_id, used_at DESC);

-- ── Watched carriers ──────────────────────────────────────────────────────────
-- Permanent per-carrier monitoring, independent of specific loads.
-- Auto-populated when a carrier is marked as used (mark-used route).
-- Also allows manual adds from the Monitoring page.
-- Unique per (tenant, DOT) — upsert on conflict re-activates the record.

CREATE TABLE IF NOT EXISTS watched_carriers (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             text        NOT NULL REFERENCES tenants(slug) ON DELETE CASCADE,
  dot_number            text        NOT NULL,
  carrier_name          text,
  mc_number             text,
  added_at              timestamptz NOT NULL DEFAULT now(),
  added_by              text        NOT NULL DEFAULT 'system',
  is_active             boolean     NOT NULL DEFAULT true,
  -- Inspection snapshot updated each poll run
  last_checked_at       timestamptz,
  last_report_numbers   text[]      NOT NULL DEFAULT '{}',
  last_truck_oos_pct    numeric,
  last_driver_oos_pct   numeric,
  last_inspection_count integer,
  CONSTRAINT uq_watched_tenant_dot UNIQUE (tenant_id, dot_number)
);

ALTER TABLE watched_carriers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_full_access_watched" ON watched_carriers
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE INDEX IF NOT EXISTS idx_watched_tenant_dot_active
  ON watched_carriers(tenant_id, dot_number) WHERE is_active = true;

-- ── Carrier blocks ────────────────────────────────────────────────────────────
-- Immutable audit log of hard blocks created by the monitoring system.
-- is_active=false when manually lifted; original block record is never deleted.

CREATE TABLE IF NOT EXISTS carrier_blocks (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         text        NOT NULL REFERENCES tenants(slug) ON DELETE CASCADE,
  dot_number        text        NOT NULL,
  carrier_name      text,
  mc_number         text,
  blocked_at        timestamptz NOT NULL DEFAULT now(),
  blocked_by        text        NOT NULL DEFAULT 'system',
  block_reason      text        NOT NULL,
  -- threshold_type: 'truck_oos' | 'driver_oos' | 'new_oos_inspection'
  threshold_type    text        NOT NULL,
  threshold_value   numeric,
  actual_value      numeric,
  violation_details jsonb,
  is_active         boolean     NOT NULL DEFAULT true,
  lifted_at         timestamptz,
  lifted_by         text,
  lifted_reason     text
);

ALTER TABLE carrier_blocks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_full_access_blocks" ON carrier_blocks
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE INDEX IF NOT EXISTS idx_blocks_tenant_dot
  ON carrier_blocks(tenant_id, dot_number);
CREATE INDEX IF NOT EXISTS idx_blocks_tenant_dot_active
  ON carrier_blocks(tenant_id, dot_number) WHERE is_active = true;
