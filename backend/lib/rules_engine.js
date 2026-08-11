// ── Precision Transport — Carrier Vetting Rules Engine ──────────────────────
// Change ONLY these constants to update all thresholds sitewide.

// Per-BASIC thresholds (set 1% below CSA intervention levels per company policy)
export const THRESHOLD_UNSAFE_DRIVING      = 65;  // RED
export const THRESHOLD_CRASH_INDICATOR     = 55;  // RED  (unchanged)
export const THRESHOLD_HOS                 = 65;  // YELLOW
export const THRESHOLD_DRIVER_FITNESS      = 80;  // YELLOW
export const THRESHOLD_CONTROLLED_SUBSTANCE = 80; // RED  (drugs/alcohol)
export const THRESHOLD_VEHICLE_MAINTENANCE = 79;  // YELLOW

export const AUTHORITY_MIN_DAYS       = 365;
export const AUTO_LIABILITY_MIN       = 750_000;   // hard block below this (federal minimum)
export const AUTO_LIABILITY_PREFERRED = 1_000_000; // soft note if below this but above MIN
export const CARGO_MIN                = 100_000;

/**
 * Run the tri-tier (RED / YELLOW / GREEN) vetting rules.
 *
 * @param {object} d  carrier data fields from manual entry form
 * @returns {{ verdict, tier, reasons, notes, authorityDays, canOverride }}
 */
export function runVettingRules(d) {
  const red    = [];
  const yellow = [];
  const notes  = [];  // informational only — does not affect verdict or require override

  // Authority age in calendar days
  const authorityDays = d.authorityGrantDate
    ? Math.floor((Date.now() - new Date(d.authorityGrantDate).getTime()) / 86_400_000)
    : null;

  const status   = (d.authorityStatus      ?? '').toLowerCase();
  const rawRating = (d.safetyRating        ?? '').toLowerCase().replace(/\//g, '').replace(/\s/g, '');
  const grade    = (d.carrierAssureGrade   ?? '').toUpperCase();

  // "None", "Unrated", "None/Unrated", or empty → unrated branch
  const isUnrated = ['none', 'unrated', 'noneunrated', ''].includes(rawRating);

  // ── RED — Immediate REJECT (no override path) ───────────────────────────

  if (['inactive', 'suspended', 'revoked', 'not authorized'].includes(status)) {
    red.push(`Operating authority is ${d.authorityStatus} — carrier cannot operate legally`);
  }

  if (!isUnrated) {
    if (rawRating === 'conditional')    red.push('FMCSA safety rating is Conditional');
    if (rawRating === 'unsatisfactory') red.push('FMCSA safety rating is Unsatisfactory');
  }

  const autoLiab = parseFloat(d.autoLiability);
  if (!isNaN(autoLiab)) {
    if (autoLiab < AUTO_LIABILITY_MIN) {
      red.push(`Auto liability $${fmtMoney(autoLiab)} is below the federal minimum of $${fmtMoney(AUTO_LIABILITY_MIN)} — hard fail`);
    } else if (autoLiab < AUTO_LIABILITY_PREFERRED) {
      notes.push(`Auto liability $${fmtMoney(autoLiab)} meets the federal minimum ($${fmtMoney(AUTO_LIABILITY_MIN)}) but is below our preferred $${fmtMoney(AUTO_LIABILITY_PREFERRED)} threshold — informational only, no override required`);
    }
  }

  const cargo = parseFloat(d.cargoInsurance);
  if (!isNaN(cargo) && cargo < CARGO_MIN) {
    red.push(`Cargo insurance $${fmtMoney(cargo)} is below the $100,000 minimum`);
  }

  if (grade === 'F') {
    red.push('Carrier Assure grade F — automatic disqualification');
  }

  if (d.activeFederalOOS) {
    red.push('Carrier has an active federal Out-of-Service order');
  }

  const unsafeDriving = parseFloat(d.unsafeDrivingBasic);
  if (!isNaN(unsafeDriving) && unsafeDriving >= THRESHOLD_UNSAFE_DRIVING) {
    red.push(`Unsafe Driving BASIC ${unsafeDriving}% ≥ alert threshold of ${THRESHOLD_UNSAFE_DRIVING}%`);
  }

  const crashInd = parseFloat(d.crashIndicatorBasic);
  if (!isNaN(crashInd) && crashInd >= THRESHOLD_CRASH_INDICATOR) {
    red.push(`Crash Indicator BASIC ${crashInd}% ≥ alert threshold of ${THRESHOLD_CRASH_INDICATOR}%`);
  }

  const controlledSub = parseFloat(d.controlledSubstancesBasic);
  if (!isNaN(controlledSub) && controlledSub >= THRESHOLD_CONTROLLED_SUBSTANCE) {
    red.push(`Controlled Substances/Alcohol BASIC ${controlledSub}% ≥ alert threshold of ${THRESHOLD_CONTROLLED_SUBSTANCE}%`);
  }

  // Unrated-specific REDs: C/D → reject; ghost-carrier pattern → reject
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

  if (red.length > 0) {
    return { verdict: 'REJECT', tier: 'RED', reasons: red, notes, authorityDays, canOverride: false };
  }

  // ── YELLOW — HOLD for manager review (override allowed) ─────────────────

  if (authorityDays !== null && authorityDays < AUTHORITY_MIN_DAYS) {
    yellow.push(
      `Authority age ${authorityDays} days is under the ${AUTHORITY_MIN_DAYS}-day minimum — manager override required`
    );
  }

  if (!isUnrated) {
    // Grade C/D: yellow for rated carriers
    if (['C', 'D'].includes(grade)) {
      yellow.push(`Carrier Assure grade ${grade} — manager review required`);
    }
  }

  // BASIC score YELLOW checks apply to ALL carriers (rated or unrated)
  // Unsafe Driving + Crash Indicator are already RED-tier for all carriers above.
  const hos = parseFloat(d.hosBasic);
  if (!isNaN(hos) && hos >= THRESHOLD_HOS) {
    yellow.push(`Hours of Service BASIC ${hos}% ≥ alert threshold of ${THRESHOLD_HOS}%`);
  }
  const vm = parseFloat(d.vehicleMaintenanceBasic);
  if (!isNaN(vm) && vm >= THRESHOLD_VEHICLE_MAINTENANCE) {
    yellow.push(`Vehicle Maintenance BASIC ${vm}% ≥ alert threshold of ${THRESHOLD_VEHICLE_MAINTENANCE}%`);
  }
  const driverFitness = parseFloat(d.driverFitnessBasic);
  if (!isNaN(driverFitness) && driverFitness >= THRESHOLD_DRIVER_FITNESS) {
    yellow.push(`Driver Fitness BASIC ${driverFitness}% ≥ alert threshold of ${THRESHOLD_DRIVER_FITNESS}%`);
  }

  if (status === 'revocation pending') {
    yellow.push('Authority revocation is pending — carrier is at immediate risk of losing operating authority; confirm status before booking');
  }

  if (d.pendingInsuranceCancellation) {
    yellow.push('Pending insurance cancellation notice on file');
  }

  const avgTruck  = parseFloat(d.nationalAvgTruckOos)  || 5.5;
  const avgDriver = parseFloat(d.nationalAvgDriverOos) || 5.2;
  const truckOos  = parseFloat(d.truckOosPct);
  const driverOos = parseFloat(d.driverOosPct);
  if (!isNaN(truckOos) && truckOos >= avgTruck * 2) {
    yellow.push(`Truck OOS ${truckOos}% ≥ double national average (${(avgTruck * 2).toFixed(1)}%)`);
  }
  if (!isNaN(driverOos) && driverOos >= avgDriver * 2) {
    yellow.push(`Driver OOS ${driverOos}% ≥ double national average (${(avgDriver * 2).toFixed(1)}%)`);
  }

  // Unrated carrier — only flag specific concerns; do not auto-HOLD
  // (~70% of carriers are unrated; being unrated alone is not disqualifying)
  if (isUnrated) {
    const insp = parseInt(d.inspections24mo, 10);
    // Only flag if inspections were explicitly entered as 0 (not just blank)
    if (!isNaN(insp) && insp === 0) {
      yellow.push(
        'Unrated carrier with 0 vehicle inspections in 24 months — manual phone verification of equipment required'
      );
    }
  }

  if (yellow.length > 0) {
    return { verdict: 'HOLD', tier: 'YELLOW', reasons: yellow, notes, authorityDays, canOverride: true };
  }

  // ── GREEN — APPROVE ──────────────────────────────────────────────────────
  return {
    verdict: 'APPROVE',
    tier: 'GREEN',
    reasons: ['All Precision Transport vetting criteria met — carrier approved for booking'],
    notes,
    authorityDays,
    canOverride: false,
  };
}

function fmtMoney(n) {
  return Number(n).toLocaleString('en-US');
}
