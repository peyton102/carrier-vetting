// ── Carrier Vetting — Rules Engine ───────────────────────────────────────────
// All thresholds come from per-tenant settings fetched from the DB.
// DEFAULT_SETTINGS use FMCSA's published SMS intervention thresholds for
// property carriers. Tenants may adjust any value from the Settings page.

/**
 * Default settings — FMCSA SMS percentile intervention thresholds.
 * Applied when a tenant has no saved settings yet.
 */
export const DEFAULT_SETTINGS = {
  // ── BASIC thresholds (percentile 1–100) — FMCSA intervention thresholds ───
  basicUnsafeDrivingThreshold:             65,
  basicUnsafeDrivingAction:                'reject', // 'reject' = hard block | 'hold' = override-able
  basicCrashIndicatorThreshold:            65,
  basicCrashIndicatorAction:               'reject',
  basicHosThreshold:                       65,
  basicHosAction:                          'hold',
  basicVehicleMaintenanceThreshold:        80,
  basicVehicleMaintenanceAction:           'hold',
  basicDriverFitnessThreshold:             80,
  basicDriverFitnessAction:                'hold',
  basicControlledSubstanceThreshold:       50,
  basicControlledSubstanceAction:          'reject',
  basicVehicleDriverObservedThreshold:     65,
  basicVehicleDriverObservedAction:        'hold',
  basicHazmatThreshold:                    80,
  basicHazmatAction:                       'hold',
  // ── Insurance minimums (USD) ──────────────────────────────────────────────
  autoLiabilityMin:  1_000_000,
  cargoMin:            100_000,
  // ── Authority age ─────────────────────────────────────────────────────────
  authorityMinDays:   365,
  authorityAgeAction: 'hold',  // 'hold' | 'block'
  // ── Safety ratings that trigger a block ───────────────────────────────────
  blockConditional:    true,
  blockUnsatisfactory: true,
  // ── OOS yellow flag: carrier rate >= national_avg * multiplier → HOLD ─────
  oosRateMultiplier: 2,
  // ── OOS hard blocks (RED, no override): exceeding these → auto-REJECT ─────
  oosHardBlockTruck:  35,
  oosHardBlockDriver:  7,
  // ── Inspection volume minimum: fewer inspections → HOLD for manual review ─
  inspectionVolumeMin: 3,
};

// Federal auto liability floor — below this is always RED regardless of tenant setting.
// FMCSA minimum for most property carriers.
const FEDERAL_AUTO_LIABILITY_MIN = 750_000;

/**
 * Run the tri-tier (RED / YELLOW / GREEN) vetting rules.
 *
 * RED    → REJECT, canOverride: false — no one can override
 * YELLOW → HOLD,   canOverride: true  — manager name + reason required
 * GREEN  → APPROVE
 *
 * Safeguard rules (ported from Precision Transport logic):
 *  - No-Percentile: if all BASIC fields are blank → bypass BASIC checks;
 *    evaluate OOS rates, authority status, and insurance only.
 *  - Inspection Volume: fewer than inspectionVolumeMin inspections → HOLD
 *    for supervisor review (unless already RED).
 *  - Missing Data: blank inspection count → HOLD (cannot evaluate percentiles).
 *
 * @param {object} d    — carrier data fields from the vetting form
 * @param {object} cfg  — tenant settings, merged with DEFAULT_SETTINGS by caller
 * @returns {{ verdict, tier, reasons, notes, authorityDays, canOverride }}
 */
export function runVettingRules(d, cfg = DEFAULT_SETTINGS) {
  const red    = [];
  const yellow = [];
  const notes  = [];

  // ── Pre-flight: inspection volume + BASIC data availability ─────────────────
  const inspCount = parseInt(d.inspections24mo, 10);
  const inspKnown = !isNaN(inspCount);
  const volMin    = parseInt(cfg.inspectionVolumeMin, 10) || 3;
  const lowVolume = inspKnown && inspCount < volMin;

  // "No-Percentile" check: all 8 BASIC fields blank → percentiles unavailable
  const basicValues = [
    d.unsafeDrivingBasic, d.hosBasic, d.crashIndicatorBasic,
    d.vehicleMaintenanceBasic, d.vehicleDriverObservedBasic,
    d.driverFitnessBasic, d.hazmatBasic, d.controlledSubstancesBasic,
  ];
  const hasBASICData = basicValues.some(v => v != null && v !== '' && !isNaN(parseFloat(v)));

  // Run BASIC RED/YELLOW checks only when: count is known, volume is
  // sufficient, and at least one BASIC score is entered.
  const runBASICChecks = hasBASICData && inspKnown && !lowVolume;

  // ── Authority age ─────────────────────────────────────────────────────────
  const authorityDays = d.authorityGrantDate
    ? Math.floor((Date.now() - new Date(d.authorityGrantDate).getTime()) / 86_400_000)
    : null;

  const status    = (d.authorityStatus    ?? '').toLowerCase();
  const rawRating = (d.safetyRating       ?? '').toLowerCase().replace(/\//g, '').replace(/\s/g, '');
  const grade     = (d.carrierAssureGrade ?? '').toUpperCase();
  const isUnrated = ['none', 'unrated', 'noneunrated', ''].includes(rawRating);

  // ── RED — Immediate REJECT (no override path) ────────────────────────────

  // Operating authority
  if (['inactive', 'suspended', 'revoked', 'not authorized'].includes(status)) {
    red.push(`Operating authority is ${d.authorityStatus} — carrier cannot operate legally`);
  }

  // FMCSA safety rating (only for rated carriers)
  if (!isUnrated) {
    if (cfg.blockConditional    && rawRating === 'conditional')    red.push('FMCSA safety rating is Conditional');
    if (cfg.blockUnsatisfactory && rawRating === 'unsatisfactory') red.push('FMCSA safety rating is Unsatisfactory');
  }

  // Auto liability — two-tier check
  const autoLiab = parseFloat(d.autoLiability);
  if (!isNaN(autoLiab)) {
    if (autoLiab < FEDERAL_AUTO_LIABILITY_MIN) {
      red.push(`Auto liability $${fmtMoney(autoLiab)} is below the federal minimum of $${fmtMoney(FEDERAL_AUTO_LIABILITY_MIN)} — hard fail`);
    } else if (autoLiab < cfg.autoLiabilityMin) {
      red.push(`Auto liability $${fmtMoney(autoLiab)} is below this broker's $${fmtMoney(cfg.autoLiabilityMin)} minimum — hard fail`);
    } else if (autoLiab < 1_000_000 && cfg.autoLiabilityMin > FEDERAL_AUTO_LIABILITY_MIN) {
      notes.push(`Auto liability $${fmtMoney(autoLiab)} meets the federal minimum ($${fmtMoney(FEDERAL_AUTO_LIABILITY_MIN)}) but is below the industry-standard $1,000,000 — informational only`);
    }
  }

  // Cargo insurance
  const cargo = parseFloat(d.cargoInsurance);
  if (!isNaN(cargo) && cargo < cfg.cargoMin) {
    red.push(`Cargo insurance $${fmtMoney(cargo)} is below this broker's $${fmtMoney(cfg.cargoMin)} minimum`);
  }

  // Carrier Assure grade F
  if (grade === 'F') {
    red.push('Carrier Assure grade F — automatic disqualification');
  }

  // Active federal OOS order
  if (d.activeFederalOOS) {
    red.push('Carrier has an active federal Out-of-Service order');
  }

  // Ghost-carrier pattern — applies to ALL carriers regardless of rated status
  const units = parseInt(d.powerUnits, 10);
  if (!isNaN(units) && inspKnown && units >= 5 && inspCount === 0) {
    red.push(`Ghost-carrier pattern: ${units} power units with 0 inspections in 24 months`);
  }

  // Unrated carrier with Carrier Assure C/D → hard reject
  if (isUnrated && ['C', 'D'].includes(grade)) {
    red.push(`Unrated carrier with Carrier Assure grade ${grade} — auto-reject`);
  }

  // OOS rate hard fails — apply regardless of BASIC availability or inspection volume
  const hardBlockTruck  = parseFloat(cfg.oosHardBlockTruck)  || 35;
  const hardBlockDriver = parseFloat(cfg.oosHardBlockDriver) || 7;
  const truckOos        = parseFloat(d.truckOosPct);
  const driverOos       = parseFloat(d.driverOosPct);
  if (!isNaN(truckOos) && truckOos > hardBlockTruck) {
    red.push(`Vehicle OOS rate ${truckOos}% exceeds the ${hardBlockTruck}% hard limit — automatic disqualification, no override`);
  }
  if (!isNaN(driverOos) && driverOos > hardBlockDriver) {
    red.push(`Driver OOS rate ${driverOos}% exceeds the ${hardBlockDriver}% hard limit — automatic disqualification, no override`);
  }

  // CSA BASIC checks — only when percentile data is present and reliable
  if (runBASICChecks) {
    checkBasic(red, yellow, d.unsafeDrivingBasic,         cfg.basicUnsafeDrivingThreshold,          cfg.basicUnsafeDrivingAction,          'Unsafe Driving');
    checkBasic(red, yellow, d.crashIndicatorBasic,        cfg.basicCrashIndicatorThreshold,         cfg.basicCrashIndicatorAction,         'Crash Indicator');
    checkBasic(red, yellow, d.hosBasic,                   cfg.basicHosThreshold,                    cfg.basicHosAction,                    'Hours of Service');
    checkBasic(red, yellow, d.vehicleMaintenanceBasic,    cfg.basicVehicleMaintenanceThreshold,     cfg.basicVehicleMaintenanceAction,     'Vehicle Maintenance');
    checkBasic(red, yellow, d.vehicleDriverObservedBasic, cfg.basicVehicleDriverObservedThreshold,  cfg.basicVehicleDriverObservedAction,  'Vehicle Driver-Observed');
    checkBasic(red, yellow, d.driverFitnessBasic,         cfg.basicDriverFitnessThreshold,          cfg.basicDriverFitnessAction,          'Driver Fitness');
    checkBasic(red, yellow, d.hazmatBasic,                cfg.basicHazmatThreshold,                 cfg.basicHazmatAction,                 'Hazardous Materials');
    checkBasic(red, yellow, d.controlledSubstancesBasic,  cfg.basicControlledSubstanceThreshold,    cfg.basicControlledSubstanceAction,    'Controlled Substances/Alcohol');
  }

  // Authority age — 'block' action goes into RED before the RED check below
  if (authorityDays !== null && authorityDays < cfg.authorityMinDays && cfg.authorityAgeAction === 'block') {
    red.push(`Authority age ${authorityDays} days is under this broker's ${cfg.authorityMinDays}-day minimum — hard block`);
  }

  if (red.length > 0) {
    return { verdict: 'REJECT', tier: 'RED', reasons: red, notes, authorityDays, canOverride: false };
  }

  // ── YELLOW — HOLD for manager review (override allowed) ─────────────────

  // Inspection volume safeguard — fewer than minimum inspections
  if (lowVolume) {
    yellow.push(
      `Only ${inspCount} vehicle inspection${inspCount === 1 ? '' : 's'} in 24 months ` +
      `(minimum ${volMin} required for reliable percentile evaluation) — ` +
      `route to supervisor for manual review`
    );
  }

  // Missing inspection count — cannot evaluate BASIC percentiles
  if (!inspKnown) {
    yellow.push('Inspection count not provided — cannot evaluate BASIC percentiles; route to manual review');
  }

  // Sufficient inspections but no BASIC scores entered — data gap
  if (inspKnown && !lowVolume && !hasBASICData) {
    yellow.push('Inspection volume sufficient but no BASIC percentile scores entered — route to manual review');
  }

  // Authority age — 'hold' action (block action was handled in RED above)
  if (authorityDays !== null && authorityDays < cfg.authorityMinDays && cfg.authorityAgeAction !== 'block') {
    yellow.push(`Authority age ${authorityDays} days is under this broker's ${cfg.authorityMinDays}-day minimum — manager override required`);
  }

  // Carrier Assure C/D — rated carriers only (unrated C/D is RED above)
  if (!isUnrated && ['C', 'D'].includes(grade)) {
    yellow.push(`Carrier Assure grade ${grade} — manager review required`);
  }

  // Revocation pending
  if (status === 'revocation pending') {
    yellow.push('Authority revocation is pending — carrier is at immediate risk of losing operating authority; confirm status before booking');
  }

  // Pending insurance cancellation
  if (d.pendingInsuranceCancellation) {
    yellow.push('Pending insurance cancellation notice on file');
  }

  // OOS rates above threshold but below the hard-fail limits
  const avgTruck  = parseFloat(d.nationalAvgTruckOos)  || 5.5;
  const avgDriver = parseFloat(d.nationalAvgDriverOos) || 5.2;
  const mult      = parseFloat(cfg.oosRateMultiplier)  || 2;
  if (!isNaN(truckOos)  && truckOos  >= avgTruck  * mult && truckOos  <= hardBlockTruck) {
    yellow.push(`Truck OOS ${truckOos}% ≥ ${mult}x national average (${(avgTruck * mult).toFixed(1)}%) — manager review required`);
  }
  if (!isNaN(driverOos) && driverOos >= avgDriver * mult && driverOos <= hardBlockDriver) {
    yellow.push(`Driver OOS ${driverOos}% ≥ ${mult}x national average (${(avgDriver * mult).toFixed(1)}%) — manager review required`);
  }

  if (yellow.length > 0) {
    return { verdict: 'HOLD', tier: 'YELLOW', reasons: yellow, notes, authorityDays, canOverride: true };
  }

  // ── GREEN — APPROVE ──────────────────────────────────────────────────────
  return {
    verdict: 'APPROVE',
    tier: 'GREEN',
    reasons: ['All vetting criteria met — carrier approved for booking'],
    notes,
    authorityDays,
    canOverride: false,
  };
}

function checkBasic(red, yellow, rawVal, threshold, action, label) {
  const val = parseFloat(rawVal);
  if (isNaN(val) || val < threshold) return;
  const msg = `${label} BASIC ${val}% ≥ this broker's ${threshold}% threshold`;
  if (action === 'reject') red.push(msg + ' — automatic disqualification, no override');
  else yellow.push(msg);
}

function fmtMoney(n) {
  return Number(n).toLocaleString('en-US');
}
