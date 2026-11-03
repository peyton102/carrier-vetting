-- Chameleon identity-linkage cache and enforcement mirror tables.
-- Apply once; service role bypasses RLS for all reads/writes.

-- ── Chameleon result cache ─────────────────────────────────────────────────────
-- Keyed by DOT number (not per-tenant — FMCSA contact data is public).
-- 24-hour TTL enforced in application code (chameleon.js).

CREATE TABLE IF NOT EXISTS chameleon_cache (
  dot_number  text        PRIMARY KEY,
  pulled_at   timestamptz NOT NULL DEFAULT now(),
  result      jsonb       NOT NULL
);
ALTER TABLE chameleon_cache ENABLE ROW LEVEL SECURITY;

-- ── OOS orders (p2mt-9ige) ────────────────────────────────────────────────────
-- All OOS orders within the last 4 years, or still active (rescind_date IS NULL).
-- Refreshed daily by monitor.js refreshOosOrders().

CREATE TABLE IF NOT EXISTS oos_orders (
  dot_number       text        NOT NULL,
  oos_reason       text        NOT NULL DEFAULT '',
  oos_date         date        NOT NULL,
  rescind_date     date,
  last_verified_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE oos_orders ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS oos_orders_dot ON oos_orders (dot_number);
CREATE UNIQUE INDEX IF NOT EXISTS oos_orders_natural
  ON oos_orders (dot_number, oos_date, oos_reason);

-- ── SAFER-era involuntary revocations (sa6p-acbp) ─────────────────────────────
-- Pre-filtered at load time to order2_type_desc LIKE '%INVOLUNTARY%'.
-- Refreshed daily by monitor.js refreshSaferRevocations().

CREATE TABLE IF NOT EXISTS safer_revocations (
  dot_number       text        NOT NULL,
  order_type_desc  text        NOT NULL DEFAULT '',
  effective_date   date        NOT NULL,
  last_verified_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE safer_revocations ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS safer_revocations_dot ON safer_revocations (dot_number);
CREATE UNIQUE INDEX IF NOT EXISTS safer_revocations_natural
  ON safer_revocations (dot_number, effective_date, order_type_desc);

-- ── Motus-era involuntary suspensions (wb4f-neki) ─────────────────────────────
-- Pre-filtered at load time to order1_type_desc LIKE '%INVOLUNTARY%'.
-- Refreshed daily by monitor.js refreshMotusSuspensions().

CREATE TABLE IF NOT EXISTS motus_suspensions (
  dot_number       text        NOT NULL,
  order_type_desc  text        NOT NULL DEFAULT '',
  effective_date   date        NOT NULL,
  last_verified_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE motus_suspensions ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS motus_suspensions_dot ON motus_suspensions (dot_number);
CREATE UNIQUE INDEX IF NOT EXISTS motus_suspensions_natural
  ON motus_suspensions (dot_number, effective_date, order_type_desc);
