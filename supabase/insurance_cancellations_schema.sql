-- insurance_cancellations table
-- Stores the SOONEST active BMC-35 (BIPD cancellation notice) per carrier.
-- One row per DOT number; refreshed daily by the monitoring job.
-- A row present = carrier has a pending cancellation (superseding check already applied).
-- Multiple BMC-35 filings for the same DOT → only the earliest effective_date is kept.

CREATE TABLE IF NOT EXISTS insurance_cancellations (
  dot_number            text        PRIMARY KEY,
  docket_number         text,
  effective_date        date        NOT NULL,   -- soonest BMC-35 effective date for this DOT
  trans_date            date,                   -- filing date of that soonest record
  insurance_company     text,                   -- insurer on that record
  max_cov_amount        numeric,
  policy_no             text,
  last_verified_at      timestamptz NOT NULL DEFAULT now(),
  created_at            timestamptz NOT NULL DEFAULT now()
);

-- Index for fast range queries (e.g. "cancellations within 30 days")
CREATE INDEX IF NOT EXISTS insurance_cancellations_effective_date_idx
  ON insurance_cancellations (effective_date);

-- RLS: deny-all for end users — backend reads via service role (bypasses RLS)
ALTER TABLE insurance_cancellations ENABLE ROW LEVEL SECURITY;
-- No policies: service role bypasses RLS entirely; no client-side access needed.

-- Upsert note (for the monitoring job):
--   ON CONFLICT (dot_number) DO UPDATE
--     SET effective_date     = LEAST(EXCLUDED.effective_date, insurance_cancellations.effective_date),
--         trans_date         = CASE WHEN EXCLUDED.effective_date < insurance_cancellations.effective_date
--                                   THEN EXCLUDED.trans_date
--                                   ELSE insurance_cancellations.trans_date END,
--         insurance_company  = CASE WHEN EXCLUDED.effective_date < insurance_cancellations.effective_date
--                                   THEN EXCLUDED.insurance_company
--                                   ELSE insurance_cancellations.insurance_company END,
--         -- ... same pattern for docket_number, max_cov_amount, policy_no ...
--         last_verified_at   = now()
