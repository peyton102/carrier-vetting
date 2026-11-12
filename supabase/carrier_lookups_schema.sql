-- ── carrier_lookups: server-side source of truth for every FMCSA/SW/insurance/chameleon lookup
-- Run BEFORE the vetting_logs column additions below.
-- Records are insert-only — no updates or deletes permitted.
-- /run validates lookupId (tenant match + DOT match + age < 24h) before accepting a vetting run.

BEGIN;

CREATE TABLE IF NOT EXISTS public.carrier_lookups (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           text        NOT NULL REFERENCES public.tenants(slug),
  dot_number          text        NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),

  -- Raw responses from each source (null when unavailable or unreachable)
  raw_fmcsa           jsonb,
  raw_saferwatch      jsonb,
  raw_insurance       jsonb,
  raw_chameleon       jsonb,

  -- Processed auto-filled values: { fieldName: { value: string, sourceLabel: string } }
  -- Matches the _autoFilled format the PDF generator already knows how to use.
  -- At /run time, the server replaces the browser's _autoFilled with this.
  auto_filled         jsonb       NOT NULL DEFAULT '{}',

  -- Source attribution: { fieldName: 'fmcsa' | 'saferwatch' | 'insurance' | 'chameleon' }
  field_sources       jsonb       NOT NULL DEFAULT '{}',

  -- Complex non-scalar fields applied verbatim to carrier_data at /run:
  -- fmcsaChameleonMatches, fmcsaRegisteredEmail, bipdCancel* fields, etc.
  server_fields       jsonb       NOT NULL DEFAULT '{}',

  -- true when FMCSA was unreachable (503 cannotVerify) at lookup time
  fmcsa_cannot_verify boolean     NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS carrier_lookups_tenant_dot_idx
  ON public.carrier_lookups (tenant_id, dot_number, created_at DESC);

CREATE INDEX IF NOT EXISTS carrier_lookups_created_at_idx
  ON public.carrier_lookups (created_at DESC);

ALTER TABLE public.carrier_lookups ENABLE ROW LEVEL SECURITY;

-- ── Immutability triggers ──────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.carrier_lookups_insert_only()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'carrier_lookups rows are immutable and cannot be % (id: %)', TG_OP, OLD.id;
END $$;

DROP TRIGGER IF EXISTS carrier_lookups_no_update   ON public.carrier_lookups;
DROP TRIGGER IF EXISTS carrier_lookups_no_delete   ON public.carrier_lookups;
DROP TRIGGER IF EXISTS carrier_lookups_no_truncate ON public.carrier_lookups;

CREATE TRIGGER carrier_lookups_no_update
  BEFORE UPDATE ON public.carrier_lookups
  FOR EACH ROW EXECUTE FUNCTION public.carrier_lookups_insert_only();

CREATE TRIGGER carrier_lookups_no_delete
  BEFORE DELETE ON public.carrier_lookups
  FOR EACH ROW EXECUTE FUNCTION public.carrier_lookups_insert_only();

CREATE TRIGGER carrier_lookups_no_truncate
  BEFORE TRUNCATE ON public.carrier_lookups
  FOR EACH STATEMENT EXECUTE FUNCTION public.carrier_lookups_insert_only();

-- ── Add lookup_id reference + dispatcher_edits to vetting_logs ───────────────
-- lookup_id: FK to carrier_lookups (nullable for older rows pre-migration).
-- dispatcher_edits: { fieldName: { original, sourceLabel, submitted } } — fields the dispatcher
--   changed from auto-filled values. Stored for audit; used by PDF to show edit notes.

ALTER TABLE public.vetting_logs
  ADD COLUMN IF NOT EXISTS lookup_id        uuid REFERENCES public.carrier_lookups(id),
  ADD COLUMN IF NOT EXISTS dispatcher_edits jsonb;

CREATE INDEX IF NOT EXISTS vetting_logs_lookup_id_idx
  ON public.vetting_logs (lookup_id);

COMMENT ON TABLE public.carrier_lookups IS
  'Insert-only record of every FMCSA/SW/insurance/chameleon lookup the server performed. '
  'Each /run must supply a lookupId; the server replaces browser-supplied auto-filled values '
  'with the values saved here, preventing clients from spoofing OOS rates, insurance amounts, etc.';

COMMENT ON COLUMN public.carrier_lookups.auto_filled IS
  'Merged auto-filled field values: { fieldName: { value: string, sourceLabel: string } }. '
  'Exactly matches the _autoFilled format used by the PDF generator for dispatcher-edit notes.';

COMMENT ON COLUMN public.carrier_lookups.server_fields IS
  'Complex non-scalar fields (arrays/objects) applied verbatim to carrier_data at /run time: '
  'fmcsaChameleonMatches, fmcsaRegisteredEmail, bipdCancel* fields, insurance metadata, etc.';

COMMIT;
