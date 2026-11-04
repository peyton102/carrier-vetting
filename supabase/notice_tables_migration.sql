-- Notice tables migration — run this once in the Supabase SQL editor.
-- Supersedes safer_revocation_notices_migration.sql (idempotent; safe to run even if
-- safer_revocation_notices already exists from an earlier run of that file).
--
-- Creates two "notice" tables for enforcement orders that were served but have no
-- recorded effective date — meaning the action may never have taken effect.
-- Both tables are informational only; chameleon.js never raises a HOLD from them.
--
-- safer_revocation_notices  — sa6p-acbp rows where order2_effective_date IS NULL
-- motus_suspension_notices  — wb4f-neki rows where order1_effective_date IS NULL
--
-- Also replaces delete_stale_batch() to add both tables to the allowlist.

-- ── safer_revocation_notices ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS safer_revocation_notices (
  id               bigserial   PRIMARY KEY,
  dot_number       text        NOT NULL,
  docket_number    text        NOT NULL DEFAULT '',
  type_license     text        NOT NULL DEFAULT '',
  order_type_desc  text        NOT NULL DEFAULT '',
  serve_date       text,                              -- raw MM/DD/YYYY from order1_serve_date; null if absent
  last_verified_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE safer_revocation_notices ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS safer_revocation_notices_dot
  ON safer_revocation_notices (dot_number);

CREATE UNIQUE INDEX IF NOT EXISTS safer_revocation_notices_natural
  ON safer_revocation_notices (dot_number, docket_number, type_license);

CREATE INDEX IF NOT EXISTS safer_revocation_notices_last_verified
  ON safer_revocation_notices (last_verified_at);

-- ── motus_suspension_notices ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS motus_suspension_notices (
  id               bigserial   PRIMARY KEY,
  dot_number       text        NOT NULL,
  docket_number    text        NOT NULL DEFAULT '',
  op_auth_type     text        NOT NULL DEFAULT '',
  order_type_desc  text        NOT NULL DEFAULT '',
  serve_date       text,                              -- YYYYMMDD from order1_serve_date; null if absent
  last_verified_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE motus_suspension_notices ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS motus_suspension_notices_dot
  ON motus_suspension_notices (dot_number);

CREATE UNIQUE INDEX IF NOT EXISTS motus_suspension_notices_natural
  ON motus_suspension_notices (dot_number, docket_number, op_auth_type);

CREATE INDEX IF NOT EXISTS motus_suspension_notices_last_verified
  ON motus_suspension_notices (last_verified_at);

-- ── daily_load_status ─────────────────────────────────────────────────────────
-- Lightweight freshness signal written by refreshSaferRevocations on both full
-- loads and skips.  Lets getEnforcementTableStatus in chameleon.js tell the
-- difference between "data loaded today" and "skipped because dataset unchanged"
-- without touching every row in the 434K-row enforcement tables.
-- Guards the REVOKE skip: skip only fires when BOTH table entries exist here,
-- ensuring safer_revocation_notices is always populated on first run.

CREATE TABLE IF NOT EXISTS daily_load_status (
  table_name       text        PRIMARY KEY,
  last_verified_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE daily_load_status ENABLE ROW LEVEL SECURITY;

-- ── delete_stale_batch — updated allowlist (6 tables) ────────────────────────

CREATE OR REPLACE FUNCTION delete_stale_batch(
  p_table      text,
  p_cutoff     timestamptz,
  p_batch_size int DEFAULT 500
)
RETURNS int LANGUAGE plpgsql SECURITY INVOKER AS $func$
DECLARE deleted int;
BEGIN
  IF p_table NOT IN (
    'oos_orders',
    'safer_revocations',
    'safer_revocation_notices',
    'motus_suspensions',
    'motus_suspension_notices',
    'insurance_cancellations'
  ) THEN
    RAISE EXCEPTION 'delete_stale_batch: table % not allowed', p_table;
  END IF;
  EXECUTE format(
    'DELETE FROM %I WHERE ctid IN (SELECT ctid FROM %I WHERE last_verified_at < $1 LIMIT $2)',
    p_table, p_table
  ) USING p_cutoff, p_batch_size;
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN deleted;
END;
$func$;

REVOKE EXECUTE ON FUNCTION delete_stale_batch(text, timestamptz, int) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION delete_stale_batch(text, timestamptz, int) TO service_role;
