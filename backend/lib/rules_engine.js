// ── Carrier Vetting — Rules Engine ───────────────────────────────────────────
// All thresholds come from per-tenant settings fetched from the DB.
// DEFAULT_SETTINGS use FMCSA's published SMS intervention thresholds for
// property carriers. Tenants may adjust any value from the Settings page.

// Increment when verdict logic changes so stored records can be identified.
export const RULES_VERSION = '4';

/**
 * Default settings — FMCSA SMS percentile intervention thresholds.
 * Applied when a tenant has no saved settings yet.
 *
 * Hardcoded (not in settings):
 *  - Conditional safety rating  → always RED, no override
 *  - Unsatisfactory safety rating → always RED, no override
 *  - Drug/alcohol violation (binary yes/no) → true = always RED, no override
 */
export const DEFAULT_SETTINGS = {
  // ── BASIC thresholds (percentile 1–100) — FMCSA intervention thresholds ───
  // Controlled Substances/Alcohol BASIC removed; replaced by binary drugAlcoholViolation field
  basicUnsafeDrivingThreshold:             65,
  basicUnsafeDrivingAction:                'reject',
  basicCrashIndicatorThreshold:            65,
  basicCrashIndicatorAction:               'reject',
  basicHosThreshold:                       65,
  basicHosAction:                          'hold',
  basicVehicleMaintenanceThreshold:        80,
  basicVehicleMaintenanceAction:           'hold',
  basicDriverFitnessThreshold:             80,
  basicDriverFitnessAction:                'hold',
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
  // ── OOS yellow flag: carrier rate >= national_avg * multiplier → HOLD ─────
  oosRateMultiplier: 2,
  // ── OOS hard blocks (RED, no override) ────────────────────────────────────
  oosHardBlockTruck:  35,
  oosHardBlockDriver:  7,
  // ── Inspection volume minimum ─────────────────────────────────────────────
  inspectionVolumeMin: 3,
  // ── Alert email recipients ────────────────────────────────────────────────
  alertRecipients: '',
};

// Federal auto liability floor — always RED regardless of tenant setting.
const FEDERAL_AUTO_LIABILITY_MIN = 750_000;

// FMCSA complaint portal — referenced in identity-check warnings.
const FMCSA_COMPLAINT_URL = 'https://nccdb.fmcsa.dot.gov';

// Absolute truck OOS floor — always RED regardless of tenant settings.
const ABSOLUTE_TRUCK_OOS_FLOOR = 20;

// Free email provider domains. Contact email on one of these triggers HOLD
// because the dispatcher cannot verify carrier identity by email domain alone.
const FREE_EMAIL_DOMAINS = new Set([
  'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'live.com',
  'aol.com', 'icloud.com', 'protonmail.com', 'proton.me', 'me.com',
  'ymail.com', 'msn.com', 'mail.com', 'inbox.com', 'gmx.com', 'gmx.net',
  'zoho.com', 'fastmail.com',
]);

/**
 * Classify an OOS rate into a severity level.
 * All comparisons use >= so the cert label and the rule always fire on the same value.
 * Exported and used by pdf_generator so both sides share one comparison.
 *
 * @param {number}      val        — OOS rate (e.g. 19.5 for 19.5%)
 * @param {number}      natAvg     — live national average OOS rate
 * @param {number}      multiplier — yellow threshold = natAvg × multiplier
 * @param {number}      hardBlock  — hard-block threshold (RED, no override)
 * @param {number|null} absFloor   — absolute floor (truck only; null = not applicable)
 * @returns {'hard_block'|'abs_floor'|'yellow'|'clear'|'unknown'}
 */
export function classifyOos(val, natAvg, multiplier, hardBlock, absFloor = null) {
  if (val == null || isNaN(val)) return 'unknown';
  if (val >= hardBlock)                         return 'hard_block';
  if (absFloor != null && val >= absFloor)      return 'abs_floor';
  if (natAvg > 0 && val >= natAvg * multiplier) return 'yellow';
  return 'clear';
}

/**
 * Run the tri-tier (RED / YELLOW / GREEN) vetting rules.
 *
 * RED    → REJECT, canOverride: false — no one can override
 * YELLOW → HOLD,   canOverride: true  — manager name + reason required
 * GREEN  → APPROVE
 *
 * IMPORTANT: Yellow checks always run even when red findings exist, so that a
 * REJECT cert lists every HOLD-level warning too (phone mismatch, free email, etc.).
 * The result shape is always:
 *   { verdict, tier, reasons, warnings, notes, authorityDays, canOverride }
 * where `warnings` is the yellow findings on a REJECT, empty on HOLD/APPROVE.
 *
 * Field behaviour:
 *  drugAlcoholViolation:
 *    true  → RED REJECT, no override
 *    false → clear
 *    null  → in monitoring context (_monitoringContext=true): informational note only.
 *            in initial vetting: HOLD (required field not answered).
 *            null NEVER counts as a pass.
 *
 *  fmcsaPhone empty (and not monitoring context, and FMCSA was reachable) → HOLD
 *  hasBrokerAuthority: true → HOLD
 *  contactPhone / fmcsaPhone: mismatch → HOLD
 *  contactEmail on free provider → HOLD
 *
 * @param {object} d    — carrier data fields
 * @param {object} cfg  — tenant settings, merged with DEFAULT_SETTINGS by caller
 * @returns {{ verdict, tier, reasons, warnings, notes, authorityDays, canOverride }}
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

  // "No-Percentile" check: all 7 remaining BASIC fields blank → percentiles unavailable
  const basicValues = [
    d.unsafeDrivingBasic, d.hosBasic, d.crashIndicatorBasic,
    d.vehicleMaintenanceBasic, d.vehicleDriverObservedBasic,
    d.driverFitnessBasic, d.hazmatBasic,
  ];
  const hasBASICData = basicValues.some(v => v != null && v !== '' && !isNaN(parseFloat(v)));

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

  // FMCSA safety rating — Conditional and Unsatisfactory are hardcoded REJECT.
  // These are non-negotiable safety requirements; no tenant setting can disable them.
  if (!isUnrated) {
    if (rawRating === 'conditional')    red.push('FMCSA safety rating is Conditional — automatic disqualification, no override');
    if (rawRating === 'unsatisfactory') red.push('FMCSA safety rating is Unsatisfactory — automatic disqualification, no override');
  }

  // Drug/alcohol violation — hardcoded REJECT, no override, no configurable threshold
  if (d.drugAlcoholViolation === true) {
    red.push('Drug/alcohol violation reported in the last 24 months — automatic disqualification, no override');
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

  // Insurance expiry — already expired → hard fail
  const autoExpDays = daysUntilExpiry(d.autoLiabilityExpiration);
  if (autoExpDays !== null && autoExpDays < 0) {
    red.push(`Auto liability insurance expired on ${d.autoLiabilityExpiration} (${Math.abs(autoExpDays)} day${Math.abs(autoExpDays) === 1 ? '' : 's'} ago) — carrier cannot legally haul`);
  }
  const cargoExpDays = daysUntilExpiry(d.cargoExpiration);
  if (cargoExpDays !== null && cargoExpDays < 0) {
    red.push(`Cargo insurance expired on ${d.cargoExpiration} (${Math.abs(cargoExpDays)} day${Math.abs(cargoExpDays) === 1 ? '' : 's'} ago)`);
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

  // OOS rate classification — uses classifyOos() so rule and cert label always use the same >= comparison
  const hardBlockTruck  = parseFloat(cfg.oosHardBlockTruck)  || 35;
  const hardBlockDriver = parseFloat(cfg.oosHardBlockDriver) || 7;
  const avgTruck  = parseFloat(d.nationalAvgTruckOos)  || 22.26;
  const avgDriver = parseFloat(d.nationalAvgDriverOos) || 6.67;
  const mult      = parseFloat(cfg.oosRateMultiplier)  || 2;
  const truckOos  = parseFloat(d.truckOosPct);
  const driverOos = parseFloat(d.driverOosPct);

  const truckOosClass  = classifyOos(truckOos,  avgTruck,  mult, hardBlockTruck,  ABSOLUTE_TRUCK_OOS_FLOOR);
  const driverOosClass = classifyOos(driverOos, avgDriver, mult, hardBlockDriver, null);

  if (truckOosClass === 'abs_floor') {
    red.push(`Vehicle OOS rate ${truckOos}% >= the ${ABSOLUTE_TRUCK_OOS_FLOOR}% absolute floor — automatic disqualification, no override (this threshold cannot be changed in Settings)`);
  }
  if (truckOosClass === 'hard_block') {
    red.push(`Vehicle OOS rate ${truckOos}% >= the ${hardBlockTruck}% hard limit — automatic disqualification, no override`);
  }
  if (driverOosClass === 'hard_block') {
    red.push(`Driver OOS rate ${driverOos}% >= the ${hardBlockDriver}% hard limit — automatic disqualification, no override`);
  }

  // CSA BASIC checks — 7 BASICs (Controlled Substances replaced by binary flag above)
  if (runBASICChecks) {
    checkBasic(red, yellow, d.unsafeDrivingBasic,         cfg.basicUnsafeDrivingThreshold,         cfg.basicUnsafeDrivingAction,         'Unsafe Driving');
    checkBasic(red, yellow, d.crashIndicatorBasic,        cfg.basicCrashIndicatorThreshold,        cfg.basicCrashIndicatorAction,        'Crash Indicator');
    checkBasic(red, yellow, d.hosBasic,                   cfg.basicHosThreshold,                   cfg.basicHosAction,                   'Hours of Service');
    checkBasic(red, yellow, d.vehicleMaintenanceBasic,    cfg.basicVehicleMaintenanceThreshold,    cfg.basicVehicleMaintenanceAction,    'Vehicle Maintenance');
    checkBasic(red, yellow, d.vehicleDriverObservedBasic, cfg.basicVehicleDriverObservedThreshold, cfg.basicVehicleDriverObservedAction, 'Vehicle Driver-Observed');
    checkBasic(red, yellow, d.driverFitnessBasic,         cfg.basicDriverFitnessThreshold,         cfg.basicDriverFitnessAction,         'Driver Fitness');
    checkBasic(red, yellow, d.hazmatBasic,                cfg.basicHazmatThreshold,                cfg.basicHazmatAction,                'Hazardous Materials');
  }

  // Authority age — 'block' action goes into RED
  if (authorityDays !== null && authorityDays < cfg.authorityMinDays && cfg.authorityAgeAction === 'block') {
    red.push(`Authority age ${authorityDays} days is under this broker's ${cfg.authorityMinDays}-day minimum — hard block`);
  }

  // ── YELLOW — HOLD for manager review (override allowed) ─────────────────
  // NOTE: yellow checks always run even when red findings exist, so a REJECT cert
  // lists every HOLD-level warning too (phone mismatch, free email, etc.).

  // FMCSA unreachable during initial lookup
  if (d.fmcsaCannotVerify === true || d.fmcsaCannotVerify === 'true') {
    const ts = d.fmcsaLastAttemptAt
      ? ` Last attempt: ${new Date(d.fmcsaLastAttemptAt).toLocaleString('en-US', { timeZone: 'America/New_York', timeZoneName: 'short' })}.`
      : '';
    yellow.push(
      `FMCSA was unreachable during initial lookup — carrier status could not be verified from live data.${ts}` +
      ' Manager authorization required to proceed.'
    );
  }

  // Drug/alcohol: null in initial vetting = required field not answered → HOLD.
  // null in monitoring context (_monitoringContext=true) = not re-evaluated → note only.
  // null NEVER counts as a pass.
  if (d.drugAlcoholViolation === null || d.drugAlcoholViolation === undefined) {
    if (d._monitoringContext === true) {
      notes.push('Drug/alcohol violation check: not re-evaluated during monitoring — checked at initial booking only');
    } else {
      yellow.push('Drug/alcohol violation question was not answered — this is a required field; complete it and re-run vetting');
    }
  }

  // No FMCSA phone on record — cannot verify carrier identity.
  // Skip in monitoring context (already flagged at initial vetting if applicable)
  // and when FMCSA was unreachable (phone unavailable through no fault of dispatcher).
  if (
    !d._monitoringContext &&
    !(d.fmcsaCannotVerify === true || d.fmcsaCannotVerify === 'true') &&
    (!d.fmcsaPhone || !String(d.fmcsaPhone).trim())
  ) {
    yellow.push('Cannot verify identity: no phone number found on FMCSA record for this DOT — confirm carrier identity manually before booking');
  }

  // Carrier also holds broker authority
  if (d.hasBrokerAuthority) {
    yellow.push('Carrier also holds active FMCSA broker authority — verify identity and double-broker risk before booking');
  }

  // Contact phone mismatch against FMCSA record
  if (d.contactPhone && d.fmcsaPhone) {
    const dispDigits  = String(d.contactPhone).replace(/\D/g, '');
    const fmcsaDigits = String(d.fmcsaPhone).replace(/\D/g, '');
    if (dispDigits && fmcsaDigits && dispDigits !== fmcsaDigits) {
      yellow.push(
        `Contact phone ${d.contactPhone} does not match FMCSA record (${d.fmcsaPhone}) — ` +
        `verify carrier identity before booking. ` +
        `Report suspicious activity: ${FMCSA_COMPLAINT_URL}`
      );
    }
  }

  // Contact email on free provider
  if (d.contactEmail) {
    const domain = String(d.contactEmail).split('@').pop().toLowerCase().trim();
    if (FREE_EMAIL_DOMAINS.has(domain)) {
      yellow.push(
        `Contact email uses a free provider (${domain}) — carrier identity cannot be verified by email domain. ` +
        `Confirm identity through FMCSA records or phone. ` +
        `Report suspicious activity: ${FMCSA_COMPLAINT_URL}`
      );
    }
  }

  // Inspection volume safeguard
  if (lowVolume) {
    yellow.push(
      `Only ${inspCount} vehicle inspection${inspCount === 1 ? '' : 's'} in 24 months ` +
      `(minimum ${volMin} required for reliable percentile evaluation) — ` +
      `route to supervisor for manual review`
    );
  }

  // Missing inspection count
  if (!inspKnown) {
    yellow.push('Inspection count not provided — cannot evaluate BASIC percentiles; route to manual review');
  }

  // Sufficient inspections but no BASIC scores
  if (inspKnown && !lowVolume && !hasBASICData) {
    yellow.push('Inspection volume sufficient but no BASIC percentile scores entered — route to manual review');
  }

  // Authority age — 'hold' action
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

  // Insurance expiry — within 30 days → HOLD
  if (autoExpDays !== null && autoExpDays >= 0 && autoExpDays <= 30) {
    yellow.push(`Auto liability insurance expires in ${autoExpDays} day${autoExpDays === 1 ? '' : 's'} (${d.autoLiabilityExpiration}) — confirm renewal before booking`);
  }
  if (cargoExpDays !== null && cargoExpDays >= 0 && cargoExpDays <= 30) {
    yellow.push(`Cargo insurance expires in ${cargoExpDays} day${cargoExpDays === 1 ? '' : 's'} (${d.cargoExpiration}) — confirm renewal before booking`);
  }

  // Pending insurance cancellation
  if (d.pendingInsuranceCancellation) {
    yellow.push('Pending insurance cancellation notice on file');
  }

  // OOS yellow-flag — classifyOos() result from above; already handles all range guards
  if (truckOosClass === 'yellow') {
    yellow.push(`Truck OOS ${truckOos}% >= ${mult}x national average (${(avgTruck * mult).toFixed(1)}%) — manager review required`);
  }
  if (driverOosClass === 'yellow') {
    yellow.push(`Driver OOS ${driverOos}% >= ${mult}x national average (${(avgDriver * mult).toFixed(1)}%) — manager review required`);
  }

  // ── Determine verdict ────────────────────────────────────────────────────
  if (red.length > 0) {
    // Return yellow findings as `warnings` so the cert and app can show all findings
    // even though the carrier is rejected. Do not block delivery.
    return { verdict: 'REJECT', tier: 'RED', reasons: red, warnings: yellow, notes, authorityDays, canOverride: false };
  }

  if (yellow.length > 0) {
    return { verdict: 'HOLD', tier: 'YELLOW', reasons: yellow, warnings: [], notes, authorityDays, canOverride: true };
  }

  // ── GREEN — APPROVE ──────────────────────────────────────────────────────
  return {
    verdict: 'APPROVE',
    tier: 'GREEN',
    reasons: ['All vetting criteria met — carrier approved for booking'],
    warnings: [],
    notes,
    authorityDays,
    canOverride: false,
  };
}

function checkBasic(red, yellow, rawVal, threshold, action, label) {
  const val = parseFloat(rawVal);
  if (isNaN(val) || val < threshold) return;
  const msg = `${label} BASIC ${val}% >= this broker's ${threshold}% threshold`;
  if (action === 'reject') red.push(msg + ' — automatic disqualification, no override');
  else yellow.push(msg);
}

function fmtMoney(n) {
  return Number(n).toLocaleString('en-US');
}

function daysUntilExpiry(dateStr) {
  if (!dateStr) return null;
  const exp = new Date(dateStr);
  if (isNaN(exp.getTime())) return null;
  const now = new Date();
  const todayMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.floor((exp.getTime() - todayMs) / 86_400_000);
}
