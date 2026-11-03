-- insurance_cancellations v2 migration
-- Adds status column to distinguish pending (future BMC-35) from lapsed (past BMC-35, no replacement).
-- Run once against the live database.

ALTER TABLE insurance_cancellations
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'lapsed'));

-- Backfill: rows already in the table are all pending (the old job only stored future dates).
-- After the next daily job run all rows will be re-classified correctly.
UPDATE insurance_cancellations SET status = 'pending' WHERE status IS DISTINCT FROM 'pending';
