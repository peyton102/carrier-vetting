// ── Tenant settings helpers ───────────────────────────────────────────────────
// Shared between vetting.js and settings route.

import { createClient } from '@supabase/supabase-js';
import { DEFAULT_SETTINGS } from './rules_engine.js';

function getSupabase() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

/** Map a DB row (snake_case columns) to a JS settings object (camelCase). */
export function rowToCfg(row) {
  if (!row) return {};
  return {
    basicUnsafeDrivingThreshold:       row.basic_unsafe_driving_threshold,
    basicUnsafeDrivingAction:          row.basic_unsafe_driving_action,
    basicCrashIndicatorThreshold:      row.basic_crash_indicator_threshold,
    basicCrashIndicatorAction:         row.basic_crash_indicator_action,
    basicHosThreshold:                 row.basic_hos_threshold,
    basicHosAction:                    row.basic_hos_action,
    basicVehicleMaintenanceThreshold:  row.basic_vehicle_maintenance_threshold,
    basicVehicleMaintenanceAction:     row.basic_vehicle_maintenance_action,
    basicDriverFitnessThreshold:       row.basic_driver_fitness_threshold,
    basicDriverFitnessAction:          row.basic_driver_fitness_action,
    basicControlledSubstanceThreshold: row.basic_controlled_substance_threshold,
    basicControlledSubstanceAction:    row.basic_controlled_substance_action,
    autoLiabilityMin:                  row.auto_liability_min,
    cargoMin:                          row.cargo_min,
    authorityMinDays:                  row.authority_min_days,
    authorityAgeAction:                row.authority_age_action,
    blockConditional:                  row.block_conditional,
    blockUnsatisfactory:               row.block_unsatisfactory,
    oosRateMultiplier:                 row.oos_rate_multiplier,
  };
}

/**
 * Fetch settings for a tenant from the DB, merged with DEFAULT_SETTINGS.
 * Returns DEFAULT_SETTINGS if the tenant has no saved settings yet.
 */
export async function fetchSettings(tenantSlug) {
  const { data } = await getSupabase()
    .from('tenant_settings')
    .select('*')
    .eq('tenant_slug', tenantSlug)
    .maybeSingle();
  return { ...DEFAULT_SETTINGS, ...(data ? rowToCfg(data) : {}) };
}
