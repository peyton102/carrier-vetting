-- Adds last_verified_at indexes on the four daily-load tables so sweep DELETEs
-- use an index scan instead of a full table scan (prevents statement timeout).
-- Also creates delete_stale_batch() RPC used by the JS batched-sweep helper.

CREATE INDEX IF NOT EXISTS oos_orders_last_verified
  ON oos_orders (last_verified_at);

CREATE INDEX IF NOT EXISTS safer_revocations_last_verified
  ON safer_revocations (last_verified_at);

CREATE INDEX IF NOT EXISTS motus_suspensions_last_verified
  ON motus_suspensions (last_verified_at);

CREATE INDEX IF NOT EXISTS insurance_cancellations_last_verified
  ON insurance_cancellations (last_verified_at);

-- Deletes up to p_batch_size rows with last_verified_at < p_cutoff from any table.
-- Called in a JS loop so each batch is a short, index-backed statement that fits
-- within Supabase's statement timeout.  Uses ctid to avoid needing the composite PK.
CREATE OR REPLACE FUNCTION delete_stale_batch(
  p_table      text,
  p_cutoff     timestamptz,
  p_batch_size int DEFAULT 500
)
RETURNS int LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE deleted int;
BEGIN
  EXECUTE format(
    'DELETE FROM %I WHERE ctid IN (SELECT ctid FROM %I WHERE last_verified_at < $1 LIMIT $2)',
    p_table, p_table
  ) USING p_cutoff, p_batch_size;
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN deleted;
END;
$$;
