import express from 'express';
import { createClient } from '@supabase/supabase-js';
import { DEFAULT_SETTINGS } from '../lib/rules_engine.js';
import { fetchSettings, rowToCfg } from '../lib/settings.js';

const router = express.Router();

function getSupabase() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

// ── GET /api/settings — return current settings merged with defaults ───────────
router.get('/', async (req, res, next) => {
  try {
    const settings = await fetchSettings(req.auth.tenant);
    res.json(settings);
  } catch (e) { next(e); }
});

// ── PUT /api/settings — upsert settings for this tenant ───────────────────────
router.put('/', async (req, res, next) => {
  try {
    const slug = req.auth.tenant;
    const b    = req.body;
    const D    = DEFAULT_SETTINGS;

    const row = {
      tenant_slug:                          slug,
      basic_unsafe_driving_threshold:       clamp(b.basicUnsafeDrivingThreshold,       D.basicUnsafeDrivingThreshold,       1, 100),
      basic_unsafe_driving_action:          oneOf(b.basicUnsafeDrivingAction,          D.basicUnsafeDrivingAction,          ['reject','hold']),
      basic_crash_indicator_threshold:      clamp(b.basicCrashIndicatorThreshold,      D.basicCrashIndicatorThreshold,      1, 100),
      basic_crash_indicator_action:         oneOf(b.basicCrashIndicatorAction,         D.basicCrashIndicatorAction,         ['reject','hold']),
      basic_hos_threshold:                  clamp(b.basicHosThreshold,                 D.basicHosThreshold,                 1, 100),
      basic_hos_action:                     oneOf(b.basicHosAction,                    D.basicHosAction,                    ['reject','hold']),
      basic_vehicle_maintenance_threshold:  clamp(b.basicVehicleMaintenanceThreshold,  D.basicVehicleMaintenanceThreshold,  1, 100),
      basic_vehicle_maintenance_action:     oneOf(b.basicVehicleMaintenanceAction,     D.basicVehicleMaintenanceAction,     ['reject','hold']),
      basic_driver_fitness_threshold:       clamp(b.basicDriverFitnessThreshold,       D.basicDriverFitnessThreshold,       1, 100),
      basic_driver_fitness_action:          oneOf(b.basicDriverFitnessAction,          D.basicDriverFitnessAction,          ['reject','hold']),
      basic_controlled_substance_threshold: clamp(b.basicControlledSubstanceThreshold, D.basicControlledSubstanceThreshold, 1, 100),
      basic_controlled_substance_action:    oneOf(b.basicControlledSubstanceAction,    D.basicControlledSubstanceAction,    ['reject','hold']),
      auto_liability_min:                   posInt(b.autoLiabilityMin,  D.autoLiabilityMin),
      cargo_min:                            posInt(b.cargoMin,          D.cargoMin),
      authority_min_days:                   posInt(b.authorityMinDays,  D.authorityMinDays),
      authority_age_action:                 oneOf(b.authorityAgeAction,  D.authorityAgeAction,  ['hold','block']),
      block_conditional:                    boolOr(b.blockConditional,   D.blockConditional),
      block_unsatisfactory:                 boolOr(b.blockUnsatisfactory, D.blockUnsatisfactory),
      oos_rate_multiplier:                  floatMin(b.oosRateMultiplier, D.oosRateMultiplier, 1),
      updated_at:                           new Date().toISOString(),
    };

    const { data, error } = await getSupabase()
      .from('tenant_settings')
      .upsert(row, { onConflict: 'tenant_slug' })
      .select()
      .single();

    if (error) throw error;
    res.json({ ...DEFAULT_SETTINGS, ...rowToCfg(data) });
  } catch (e) { next(e); }
});

function clamp(v, def, min, max) {
  const n = parseInt(v, 10);
  return isNaN(n) ? def : Math.min(max, Math.max(min, n));
}
function posInt(v, def) {
  const n = parseInt(v, 10);
  return isNaN(n) || n < 0 ? def : n;
}
function floatMin(v, def, min) {
  const n = parseFloat(v);
  return isNaN(n) ? def : Math.max(min, n);
}
function oneOf(v, def, allowed) {
  return allowed.includes(v) ? v : def;
}
function boolOr(v, def) {
  return (v === undefined || v === null) ? def : !!v;
}

export default router;
