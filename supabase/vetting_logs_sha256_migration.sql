-- ── vetting_logs: add pdf_sha256 + extend immutability trigger ────────────────
-- Allows pdf_url and pdf_sha256 to be set together in the one allowed update.
-- Safe to run twice (CREATE OR REPLACE + ADD COLUMN IF NOT EXISTS).

BEGIN;

-- 1. Add column
ALTER TABLE public.vetting_logs
  ADD COLUMN IF NOT EXISTS pdf_sha256 TEXT;

-- 2. Update the immutability trigger to also permit pdf_sha256 to change
--    alongside pdf_url in the single allowed NULL → non-null update.
CREATE OR REPLACE FUNCTION public.vetting_logs_block_update()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- One-time window: pdf_url (and optionally pdf_sha256) may be set from NULL.
  IF OLD.pdf_url IS NULL AND NEW.pdf_url IS NOT NULL THEN
    -- Everything except pdf_url and pdf_sha256 must be unchanged.
    IF (to_jsonb(NEW) - 'pdf_url' - 'pdf_sha256')
         IS DISTINCT FROM
       (to_jsonb(OLD) - 'pdf_url' - 'pdf_sha256')
    THEN
      RAISE EXCEPTION
        'vetting_logs: only pdf_url and pdf_sha256 may change on the one allowed update (record id: %)',
        OLD.id;
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'vetting_logs rows are immutable (record id: %)', OLD.id;
END $$;

COMMIT;
