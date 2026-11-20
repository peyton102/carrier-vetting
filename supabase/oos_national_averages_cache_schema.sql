-- Single-row cache for OOS national averages parsed from SAFER HTML.
-- These values change monthly; caching avoids the yellow-flag check being
-- silently disabled when SAFER is temporarily unavailable.
-- Only one row ever exists (id = 'current').

CREATE TABLE IF NOT EXISTS oos_national_averages_cache (
  id              text        PRIMARY KEY DEFAULT 'current',
  truck_avg       numeric     NOT NULL,
  driver_avg      numeric     NOT NULL,
  as_of           text,                        -- "MM/DD/YYYY" from SAFER HTML
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT single_row CHECK (id = 'current')
);

ALTER TABLE oos_national_averages_cache ENABLE ROW LEVEL SECURITY;
