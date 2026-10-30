-- ── v4 vetting_logs + vetting_overrides migration ────────────────────────────
-- 1. Adds warnings JSONB and rules_version TEXT to vetting_logs
-- 2. Replaces old immutability triggers with strict version:
--      - ONLY allows pdf_url to transition NULL → non-null (once)
--      - All other columns must be identical to their original values
-- 3. Creates append-only vetting_overrides table with insert-only trigger
--
-- Safe to run twice (all statements are IF NOT EXISTS / OR REPLACE).

BEGIN;

-- ── Schema additions ──────────────────────────────────────────────────────────

ALTER TABLE public.vetting_logs
  ADD COLUMN IF NOT EXISTS rules_version TEXT,
  ADD COLUMN IF NOT EXISTS warnings      JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS tenant_id     TEXT;  -- already exists on live DB; no-op if so

-- ── Drop old trigger functions ────────────────────────────────────────────────

DROP TRIGGER IF EXISTS vetting_logs_no_update   ON public.vetting_logs;
DROP TRIGGER IF EXISTS vetting_logs_no_delete   ON public.vetting_logs;
DROP TRIGGER IF EXISTS vetting_logs_no_truncate ON public.vetting_logs;
DROP FUNCTION IF EXISTS public.vetting_logs_block_update()      CASCADE;
DROP FUNCTION IF EXISTS public.vetting_logs_block_delete()      CASCADE;
DROP FUNCTION IF EXISTS public.vetting_logs_enforce_immutable() CASCADE;

-- ── Immutability: UPDATE ──────────────────────────────────────────────────────
-- A row is immutable EXCEPT for one allowed window:
--   When pdf_url transitions NULL → non-null (first and only cert generation),
--   ALL other columns must be identical to their stored values.
-- After pdf_url is set, no further updates are permitted at all.

CREATE OR REPLACE FUNCTION public.vetting_logs_block_update()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.pdf_url IS NULL AND NEW.pdf_url IS NOT NULL THEN
    -- Verify nothing else changed (exclude pdf_url from comparison)
    IF (to_jsonb(NEW) - 'pdf_url') IS DISTINCT FROM (to_jsonb(OLD) - 'pdf_url') THEN
      RAISE EXCEPTION
        'vetting_logs: only pdf_url may change on the one allowed update (record id: %)', OLD.id;
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'vetting_logs rows are immutable (record id: %)', OLD.id;
END $$;

-- ── Immutability: DELETE / TRUNCATE ──────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.vetting_logs_block_delete()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'vetting_logs rows cannot be deleted or truncated';
END $$;

-- ── Attach triggers ───────────────────────────────────────────────────────────

CREATE TRIGGER vetting_logs_no_update
  BEFORE UPDATE ON public.vetting_logs
  FOR EACH ROW EXECUTE FUNCTION public.vetting_logs_block_update();

CREATE TRIGGER vetting_logs_no_delete
  BEFORE DELETE ON public.vetting_logs
  FOR EACH ROW EXECUTE FUNCTION public.vetting_logs_block_delete();

CREATE TRIGGER vetting_logs_no_truncate
  BEFORE TRUNCATE ON public.vetting_logs
  FOR EACH STATEMENT EXECUTE FUNCTION public.vetting_logs_block_delete();

-- ── vetting_overrides — append-only override log ──────────────────────────────
-- Records manager overrides separately from vetting_logs so vetting_logs.verdict
-- is never mutated. Effective verdict = resulting_verdict when present, else
-- vetting_logs.verdict.

CREATE TABLE IF NOT EXISTS public.vetting_overrides (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  record_id          UUID        NOT NULL REFERENCES public.vetting_logs(id) ON DELETE RESTRICT,
  tenant_id          TEXT        NOT NULL,
  override_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  manager            TEXT        NOT NULL,
  reason             TEXT        NOT NULL,
  resulting_verdict  TEXT        NOT NULL DEFAULT 'APPROVED WITH OVERRIDE'
);

CREATE INDEX IF NOT EXISTS vetting_overrides_record_id_idx
  ON public.vetting_overrides (record_id);

CREATE INDEX IF NOT EXISTS vetting_overrides_tenant_id_idx
  ON public.vetting_overrides (tenant_id);

ALTER TABLE public.vetting_overrides ENABLE ROW LEVEL SECURITY;

-- ── Immutability: vetting_overrides is insert-only ────────────────────────────

CREATE OR REPLACE FUNCTION public.vetting_overrides_insert_only()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'vetting_overrides rows are immutable and cannot be % d', TG_OP;
END $$;

DROP TRIGGER IF EXISTS vetting_overrides_no_update   ON public.vetting_overrides;
DROP TRIGGER IF EXISTS vetting_overrides_no_delete   ON public.vetting_overrides;
DROP TRIGGER IF EXISTS vetting_overrides_no_truncate ON public.vetting_overrides;

CREATE TRIGGER vetting_overrides_no_update
  BEFORE UPDATE ON public.vetting_overrides
  FOR EACH ROW EXECUTE FUNCTION public.vetting_overrides_insert_only();

CREATE TRIGGER vetting_overrides_no_delete
  BEFORE DELETE ON public.vetting_overrides
  FOR EACH ROW EXECUTE FUNCTION public.vetting_overrides_insert_only();

CREATE TRIGGER vetting_overrides_no_truncate
  BEFORE TRUNCATE ON public.vetting_overrides
  FOR EACH STATEMENT EXECUTE FUNCTION public.vetting_overrides_insert_only();

COMMIT;
