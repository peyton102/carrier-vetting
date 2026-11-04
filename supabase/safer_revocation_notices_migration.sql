-- safer_revocation_notices: rows from sa6p-acbp where order2_effective_date IS NULL.
-- These are revocation orders that were served (order1_serve_date) but have no recorded
-- effective date, meaning the revocation may never have taken effect (dismissed, contested,
-- or simply not finalised). Treated as informational only — never HOLD-worthy.
-- Populated daily alongside safer_revocations by monitor.js refreshSaferRevocations().

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

-- Add safer_revocation_notices to the delete_stale_batch allowlist so the
-- mark-and-sweep can remove rows that disappeared from the upstream dataset.
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
