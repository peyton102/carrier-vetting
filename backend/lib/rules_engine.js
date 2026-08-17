// ── Carrier Vetting — Rules Engine ───────────────────────────────────────────
// All thresholds come from per-tenant settings fetched from the DB.
// Nothing is hardcoded. DEFAULT_SETTINGS are the starting point for new customers.

/**
 * Default settings applied when a tenant has not yet configured their own policy.
 * These values are also stored as DB column defaults in tenant_settings.
 */
export const DEFAULT_SETTINGS = {
  // BASIC thresholds (percentile, 1–100)
  basicUnsafeDrivingThreshold:       55,
  basicUnsafeDrivingAction:          'reject', // 'reject' = hard block | 'hold' = override-able
  basicCrashIndicatorThreshold:      55,
  basicCrashIndicatorAction:         'reject',
  basicHosThreshold:                 55,
  basicHosAction:                    'hold',
  basicVehicleMaintenanceThreshold:  55,
  basicVehicleMaintenanceAction:     'hold',
  basicDriverFitnessThreshold:       55,
  basicDriverFitnessAction:          'hold',
  basicControlledSubstanceThreshold: 55,
  basicControlledSubstanceAction:    'reject',
  // Insurance minimums (USD)
  autoLiabilityMin:  1_000_000,
  cargoMin:            100_000,
  // Authority age
  authorityMinDays:   365,
  authorityAgeAction: 'hold',  // 'hold' | 'block'
  // Safety ratings that trigger a block
  blockConditional:    true,
  blockUnsatisfactory: true,
  // OOS: flag if carrier rate >= national_avg * oosRateMultiplier
  oosRateMultiplier: 2,
};

/**
 * Run the tri-tier (RED / YELLOW / GREEN) vetting rules.
 *
 * @param {object} d    — carrier data fields from the vetting form
 * @param {object} cfg  — tenant settings, merged with DEFAULT_SETTINGS by caller
 * @returns {{ verdict, tier, reasons, notes, authorityDays, canOverride }}
 */
export function runVettingRules(d, cfg = DEFAULT_SETTINGS) {
  const red    = [];
  const yellow = [];
  const notes  = [];

  const authorityDays = d.authorityGrantDate
    ? Math.floor((Date.now() - new Date(d.authorityGrantDate).getTime()) / 86_400_000)
    : null;

  const status    = (d.authorityStatus    ?? '').toLowerCase();
  const rawRating = (d.safetyRating       ?? '').toLowerCase().replace(/\//g, '').replace(/\s/g, '');
  const grade     = (d.carrierAssureGrade ?? '').toUpperCase();

  // 'None', 'Unrated', 'None/Unrated', or empty → unrated branch
  const isUnrated = ['none', 'unrated', 'noneunrated', ''].includes(rawRating);

  // ── Always-RED: operating authority status ────────────────────────────────
  if (['inactive', 'suspended', 'revoked', 'not authorized'].includes(status)) {
    red.push(`Operating authority is ${d.authorityStatus} — carrier cannot operate legally`);
  }

  // ── Configurable: safety rating blocks ───────────────────────────────────
  if (!isUnrated) {
    if (cfg.blockConditional    && rawRating === 'conditional')    red.push('FMCSA safety rating is Conditional');
    if (cfg.blockUnsatisfactory && rawRating === 'unsatisfactory') red.push('FMCSA safety rating is Unsatisfactory');
  }

  // ── Configurable: auto liability minimum ─────────────────────────────────
  const autoLiab = parseFloat(d.autoLiability);
  if (!isNaN(autoLiab) && autoLiab < cfg.autoLiabilityMin) {
    red.push(`Auto liability $${fmtMoney(autoLiab)} is below this broker's $${fmtMoney(cfg.autoLiabilityMin)} minimum — hard fail`);
  }

  // ── Configurable: cargo insurance minimum ────────────────────────────────
  const cargo = parseFloat(d.cargoInsurance);
  if (!isNaN(cargo) && cargo < cfg.cargoMin) {
    red.push(`Cargo insurance $${fmtMoney(cargo)} is below this broker's $${fmtMoney(cfg.cargoMin)} minimum`);
  }

  // ── Always-RED: Carrier Assure grade F ───────────────────────────────────
  if (grade === 'F') {
    red.push('Carrier Assure grade F — automatic disqualification');
  }

  // ── Always-RED: active federal Out-of-Service order ──────────────────────
  if (d.activeFederalOOS) {
    red.push('Carrier has an active federal Out-of-Service order');
  }

  // ── Configurable: BASIC score checks ─────────────────────────────────────
  // Each BASIC has a per-tenant threshold and action ('reject' → RED, 'hold' → YELLOW).
  function checkBasic(rawVal, threshold, action, label) {
    const val = parseFloat(rawVal);
    if (isNaN(val) || val < threshold) return;
    const msg = `${label} BASIC ${val}% ≥ this broker's ${threshold}% threshold`;
    if (action === 'reject') red.push(msg);
    else yellow.push(msg);
  }

  checkBasic(d.unsafeDrivingBasic,        cfg.basicUnsafeDrivingThreshold,       cfg.basicUnsafeDrivingAction,       'Unsafe Driving');
  checkBasic(d.crashIndicatorBasic,       cfg.basicCrashIndicatorThreshold,      cfg.basicCrashIndicatorAction,      'Crash Indicator');
  checkBasic(d.hosBasic,                  cfg.basicHosThreshold,                 cfg.basicHosAction,                 'Hours of Service');
  checkBasic(d.vehicleMaintenanceBasic,   cfg.basicVehicleMaintenanceThreshold,  cfg.basicVehicleMaintenanceAction,  'Vehicle Maintenance');
  checkBasic(d.driverFitnessBasic,        cfg.basicDriverFitnessThreshold,       cfg.basicDriverFitnessAction,       'Driver Fitness');
  checkBasic(d.controlledSubstancesBasic, cfg.basicControlledSubstanceThreshold, cfg.basicControlledSubstanceAction, 'Controlled Substances/Alcohol');

  // ── Always-RED (unrated): Carrier Assure C/D and ghost-carrier pattern ───
  if (isUnrated) {
    if (['C', 'D'].includes(grade)) {
      red.push(`Unrated carrier with Carrier Assure grade ${grade} — auto-reject (C/D is red for unrated carriers)`);
    }
    const units = parseInt(d.powerUnits, 10);
    const insp  = parseInt(d.inspections24mo, 10);
    if (!isNaN(units) && !isNaN(insp) && units >= 5 && insp === 0) {
      red.push(`Ghost-carrier pattern: ${units} power units with 0 inspections in 24 months`);
    }
  }

  // ── Configurable: authority age ───────────────────────────────────────────
  if (authorityDays !== null && authorityDays < cfg.authorityMinDays) {
    const msg = `Authority age ${authorityDays} days is under this broker's ${cfg.authorityMinDays}-day minimum`;
    if (cfg.authorityAgeAction === 'block') {
      red.push(`${msg} — hard block`);
    } else {
      yellow.push(`${msg} — manager override required`);
    }
  }

  if (red.length > 0) {
    return { verdict: 'REJECT', tier: 'RED', reasons: red, notes, authorityDays, canOverride: false };
  }

  // ── YELLOW — HOLD for manager review (override allowed) ──────────────────

  if (!isUnrated && ['C', 'D'].includes(grade)) {
    yellow.push(`Carrier Assure grade ${grade} — manager review required`);
  }

  if (status === 'revocation pending') {
    yellow.push('Authority revocation is pending — carrier is at immediate risk of losing operating authority; confirm status before booking');
  }

  if (d.pendingInsuranceCancellation) {
    yellow.push('Pending insurance cancellation notice on file');
  }

  const avgTruck  = parseFloat(d.nationalAvgTruckOos)  || 5.5;
  const avgDriver = parseFloat(d.nationalAvgDriverOos) || 5.2;
  const mult      = parseFloat(cfg.oosRateMultiplier)  || 2;
  const truckOos  = parseFloat(d.truckOosPct);
  const driverOos = parseFloat(d.driverOosPct);
  if (!isNaN(truckOos) && truckOos >= avgTruck * mult) {
    yellow.push(`Truck OOS ${truckOos}% ≥ ${mult}x national average (${(avgTruck * mult).toFixed(1)}%)`);
  }
  if (!isNaN(driverOos) && driverOos >= avgDriver * mult) {
    yellow.push(`Driver OOS ${driverOos}% ≥ ${mult}x national average (${(avgDriver * mult).toFixed(1)}%)`);
  }

  // Unrated carrier — flag if 0 inspections explicitly entered
  if (isUnrated) {
    const insp = parseInt(d.inspections24mo, 10);
    if (!isNaN(insp) && insp === 0) {
      yellow.push('Unrated carrier with 0 vehicle inspections in 24 months — manual phone verification of equipment required');
    }
  }

  if (yellow.length > 0) {
    return { verdict: 'HOLD', tier: 'YELLOW', reasons: yellow, notes, authorityDays, canOverride: true };
  }

  return {
    verdict: 'APPROVE',
    tier: 'GREEN',
    reasons: ['All vetting criteria met — carrier approved for booking'],
    notes,
    authorityDays,
    canOverride: false,
  };
}

function fmtMoney(n) {
  return Number(n).toLocaleString('en-US');
}
