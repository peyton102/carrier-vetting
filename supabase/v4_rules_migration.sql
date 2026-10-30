-- v4 Rules Migration
-- Removes Controlled Substances/Alcohol BASIC percentile columns and
-- Safety Rating block toggle columns from tenant_settings.
-- These checks are now hardcoded in the rules engine:
--   • Controlled Substances → required yes/no at booking (drugAlcoholViolation)
--   • Conditional/Unsatisfactory safety ratings → always REJECT, no override

ALTER TABLE tenant_settings
  DROP COLUMN IF EXISTS basic_controlled_substance_threshold,
  DROP COLUMN IF EXISTS basic_controlled_substance_action,
  DROP COLUMN IF EXISTS block_conditional,
  DROP COLUMN IF EXISTS block_unsatisfactory;
