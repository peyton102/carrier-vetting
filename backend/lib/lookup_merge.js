// ── lookup_merge.js ───────────────────────────────────────────────────────────
// Pure functions for server-side merging of FMCSA + SaferWatch + insurance +
// chameleon lookup results.
//
// This is the server-side equivalent of applyLookupResults() in CarrierVetting.jsx.
// Saving the merged result to carrier_lookups at lookup time means /run can override
// whatever values the browser sends for auto-filled fields.
//
// No network calls, no DB — importable in offline tests.

// Parse a date string in MM/DD/YYYY or YYYY-MM-DD format → Date or null.
function parseDate(s) {
  if (!s) return null;
  const mdy = String(s).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (mdy) return new Date(`${mdy[3]}-${mdy[1].padStart(2, '0')}-${mdy[2].padStart(2, '0')}`);
  if (/^\d{4}-\d{2}-\d{2}/.test(String(s))) return new Date(String(s).slice(0, 10));
  return null;
}

// Fields whose values come from lookup sources and must never be taken from the browser.
// Scalar fields (strings/numbers/booleans) end up in auto_filled + _autoFilled (PDF edit notes).
// Complex fields (arrays/objects) go into server_fields and are applied verbatim.
export const SCALAR_AUTO_FIELDS = new Set([
  // FMCSA / SAFER
  'carrierName', 'dotNumber', 'mcNumber', 'authorityStatus', 'authorityGrantDate',
  'safetyRating', 'powerUnits', 'totalDrivers',
  'mcs150Mileage', 'mcs150MileageYear',
  'inspections24mo', 'truckOosPct', 'driverOosPct',
  'nationalAvgTruckOos', 'nationalAvgDriverOos', 'nationalAvgOosAsOf',
  'fmcsaPhone', 'hasBrokerAuthority', 'saferSnapshotDate',
  'activeFederalOOS', 'crashes24mo',
  // SaferWatch
  'unsafeDrivingBasic', 'hosBasic', 'vehicleMaintenanceBasic', 'driverFitnessBasic',
  'autoLiability', 'cargoInsurance',
  'autoLiabilityExpiration', 'cargoExpiration', 'insuranceDataAsOf',
  'drugAlcoholViolation',
  // Insurance (scalar)
  'bipdCancelPending', 'bipdCancelLapsed', 'pendingInsuranceCancellation',
  'bipdCancelEffectiveDate', 'bipdCancelTransDate',
  'bipdCancelInsuranceCompany', 'bipdCancelDaysUntil',
  // Chameleon — scalar
  'fmcsaChameleonNotReviewed', 'fmcsaEmailNotReviewed',
  'fmcsaChameleonTimedOut',
  'fmcsaRegisteredEmail', 'fmcsaEnforcementLoadedAt',
]);

// Complex fields — applied verbatim, not compared for edit detection.
export const COMPLEX_AUTO_FIELDS = new Set([
  'fmcsaChameleonMatches', 'fmcsaContactChange',
]);

const DATE_FIELDS = new Set([
  'authorityGrantDate', 'autoLiabilityExpiration', 'cargoExpiration',
  'bipdCancelEffectiveDate', 'bipdCancelTransDate',
]);

function sanitizeDate(val) {
  if (!val) return '';
  const s = String(val);
  if (s === '0000-00-00' || s === 'NaN' || s === 'Invalid Date') return '';
  const d = new Date(s);
  return isNaN(d.getTime()) ? '' : s;
}

// ─────────────────────────────────────────────────────────────────────────────
// mergeResults
//
// Accepts raw responses from each source and returns:
//   autoFilled   — { fieldName: { value: string, sourceLabel } } for scalar fields
//   fieldSources — { fieldName: 'fmcsa' | 'saferwatch' | 'insurance' | 'chameleon' }
//   serverFields — { fieldName: any } for complex fields (applied verbatim at /run)
//   merged       — flat object of all auto-filled values (scalar + complex, by field name)
//
// All four objects together represent the server's authoritative view of the carrier.
// ─────────────────────────────────────────────────────────────────────────────
export function mergeResults({ fmcsa, sw, insurance, chameleon }) {
  const autoFilled   = {};  // { field: { value: string, sourceLabel } }
  const fieldSources = {};  // { field: 'fmcsa' | 'saferwatch' | ... }
  const serverFields = {};  // complex non-scalar fields, applied verbatim
  const merged       = {};  // flat merged values

  function setScalar(field, rawVal, source, sourceLabel) {
    if (rawVal === null || rawVal === undefined) return;
    const str = String(rawVal);
    if (str === '') return;
    autoFilled[field]   = { value: str, sourceLabel };
    fieldSources[field] = source;
    merged[field]       = rawVal;  // keep original type
  }

  function setComplex(field, val) {
    if (val === undefined) return;
    serverFields[field] = val;
    merged[field]       = val;
  }

  // ── FMCSA / SAFER ──────────────────────────────────────────────────────────
  const fmcsaOk = !!fmcsa && !fmcsa.cannotVerify;
  if (fmcsaOk) {
    for (const field of (fmcsa.filledFields ?? [])) {
      let val = fmcsa[field];
      if (DATE_FIELDS.has(field)) val = sanitizeDate(val);
      if (val !== '' && val != null) setScalar(field, val, 'fmcsa', 'FMCSA');
    }
    // activeFederalOOS and hasBrokerAuthority are always in filledFields from fmcsa.js,
    // but guard anyway in case of format changes.
    if (autoFilled.activeFederalOOS === undefined) {
      setScalar('activeFederalOOS', fmcsa.activeFederalOOS ?? false, 'fmcsa', 'FMCSA');
    }
    if (autoFilled.hasBrokerAuthority === undefined) {
      setScalar('hasBrokerAuthority', fmcsa.hasBrokerAuthority ?? false, 'fmcsa', 'FMCSA');
    }
  }

  // ── SaferWatch ─────────────────────────────────────────────────────────────
  const swOk = sw?.ok !== false && !!sw;

  // ── OOS source winner (matches frontend applyLookupResults) ───────────────
  // SAFER wins on tie or when SW has no date.
  const saferSnapshotDate = fmcsa?.saferSnapshotDate || null;
  const swDate            = swOk ? (sw.swInspectionsDate || null) : null;
  const saferDateObj      = parseDate(saferSnapshotDate);
  const swDateObj         = parseDate(swDate);
  const useSafer          = !swDateObj || (saferDateObj != null && saferDateObj >= swDateObj);

  const saferVehicleOosPct = fmcsa?.saferData?.vehicleOosPct != null
    ? parseFloat(fmcsa.saferData.vehicleOosPct).toFixed(2) : null;
  const saferDriverOosPct  = fmcsa?.saferData?.driverOosPct  != null
    ? parseFloat(fmcsa.saferData.driverOosPct).toFixed(2)  : null;
  const swTruckOosPct  = swOk && sw.truckOosPct  ? sw.truckOosPct  : null;
  const swDriverOosPct = swOk && sw.driverOosPct ? sw.driverOosPct : null;

  const winTruckOos  = useSafer ? saferVehicleOosPct : swTruckOosPct;
  const winDriverOos = useSafer ? saferDriverOosPct  : swDriverOosPct;
  const altTruckOos  = useSafer ? swTruckOosPct  : saferVehicleOosPct;
  const altDriverOos = useSafer ? swDriverOosPct : saferDriverOosPct;

  // Build OOS source label for PDF / autoFilledNote
  let oosWinLabel;
  if (useSafer) {
    oosWinLabel = saferSnapshotDate
      ? `SAFER (as of ${saferSnapshotDate})`
      : 'FMCSA (QCMobile — no snapshot date)';
  } else {
    oosWinLabel = swDate ? `SaferWatch (as of ${swDate})` : 'SaferWatch';
  }
  const oosAltLabel = useSafer
    ? (swDate ? `SaferWatch (as of ${swDate}, older)` : (swOk ? 'SaferWatch (no date, older)' : null))
    : (saferSnapshotDate ? `SAFER (as of ${saferSnapshotDate}, older)` : null);

  if (winTruckOos  != null) setScalar('truckOosPct',  winTruckOos,  useSafer ? 'fmcsa' : 'saferwatch', oosWinLabel);
  if (winDriverOos != null) setScalar('driverOosPct', winDriverOos, useSafer ? 'fmcsa' : 'saferwatch', oosWinLabel);

  // Store OOS alt values in serverFields (not form inputs; used by PDF for "other source" note)
  serverFields.oosWinLabel        = oosWinLabel  || '';
  serverFields.truckOosPctAlt     = (altTruckOos  != null && altTruckOos  !== winTruckOos)  ? altTruckOos  : '';
  serverFields.truckOosPctAltSrc  = (altTruckOos  != null && altTruckOos  !== winTruckOos)  ? oosAltLabel  : '';
  serverFields.driverOosPctAlt    = (altDriverOos != null && altDriverOos !== winDriverOos) ? altDriverOos : '';
  serverFields.driverOosPctAltSrc = (altDriverOos != null && altDriverOos !== winDriverOos) ? oosAltLabel  : '';

  // Driver inspection count from SAFER (for cert display)
  const saferDrvInspCount = fmcsa?.saferData?.driverInsp ?? null;
  if (saferDrvInspCount != null) {
    serverFields.driverInspections24mo = String(saferDrvInspCount);
  }

  // Winning inspection counts for BASIC gate recomputation
  const winVehInsp = useSafer
    ? (fmcsa?.saferData?.vehicleInsp ?? (swOk ? sw.inspectVehUS : null))
    : ((swOk ? sw.inspectVehUS : null) ?? fmcsa?.saferData?.vehicleInsp);
  const winDrvInsp = useSafer
    ? (saferDrvInspCount ?? (swOk ? sw.inspectDrvUS : null))
    : ((swOk ? sw.inspectDrvUS : null) ?? saferDrvInspCount);

  if (swOk) {
    for (const field of (sw.filledFields ?? [])) {
      // OOS rates already set from the winner above; skip SW overwrite
      if (field === 'truckOosPct' || field === 'driverOosPct') continue;
      // If SAFER won, keep SAFER's inspection count
      if (useSafer && field === 'inspections24mo') continue;
      const val = sw[field];
      if (val !== '' && val != null && val !== false) {
        const dateVal = DATE_FIELDS.has(field) ? sanitizeDate(val) : val;
        if (dateVal !== '') setScalar(field, dateVal, 'saferwatch', 'SaferWatch');
      }
    }

    if (sw.activeFederalOOS === true) {
      setScalar('activeFederalOOS', true, 'saferwatch', 'SaferWatch');
    }

    if (sw.insuranceDataAsOf) {
      setScalar('insuranceDataAsOf', sw.insuranceDataAsOf, 'saferwatch', 'SaferWatch');
    }

    // driverFitnessBasic from SW extraBasics (gate: ≥5 driver insp using winning count)
    const drvFitPct = sw.extraBasics?.driverFitnessPct;
    const effDrvInsp = winDrvInsp ?? sw.inspectDrvUS;
    if (drvFitPct != null && drvFitPct !== '' &&
        effDrvInsp != null && !isNaN(Number(effDrvInsp)) && Number(effDrvInsp) >= 5) {
      setScalar('driverFitnessBasic', drvFitPct, 'saferwatch', 'SaferWatch');
    }

    // drugAlcoholViolation (may be null = dispatcher must answer; keep null in that case)
    if (sw.drugAlcoholViolation !== undefined) {
      if (sw.drugAlcoholViolation !== null) {
        setScalar('drugAlcoholViolation', sw.drugAlcoholViolation, 'saferwatch', 'SaferWatch');
      }
      // Store the SW drug/alcohol source string for display
      serverFields.swDrugAlcohol = {
        value:  sw.drugAlcoholViolation,
        source: sw.drugAlcoholSource ?? null,
      };
    }

    // BASIC gate recomputation: if SAFER's winning inspection count is higher than
    // what SW used for its gate checks, flip the gate and populate from rawBasics.
    const swSufficiency = sw.basicDataSufficiency ?? {};
    const finalBasicSufficiency = {
      unsafeDriving:         winDrvInsp == null ? (swSufficiency.unsafeDriving ?? null)      : (winDrvInsp >= 3 ? 'ok' : 'insufficient'),
      hos:                   winDrvInsp == null ? (swSufficiency.hos ?? null)                : (winDrvInsp >= 3 ? 'ok' : 'insufficient'),
      vehicleMaintenance:    winVehInsp == null ? (swSufficiency.vehicleMaintenance ?? null) : (winVehInsp >= 5 ? 'ok' : 'insufficient'),
      driverFitness:         winDrvInsp == null ? (swSufficiency.driverFitness ?? null)      : (winDrvInsp >= 5 ? 'ok' : 'insufficient'),
      crashIndicator:        swSufficiency.crashIndicator        ?? null,
      vehicleDriverObserved: swSufficiency.vehicleDriverObserved ?? null,
      hazmat:                swSufficiency.hazmat                ?? null,
    };
    serverFields._basicSufficiency = finalBasicSufficiency;

    if (sw.rawBasics) {
      const gateFlips = [
        ['unsafeDrivingBasic',      'unsafeDriving',      sw.rawBasics.unsafeDrivingPct],
        ['hosBasic',                'hos',                sw.rawBasics.hosPct],
        ['vehicleMaintenanceBasic', 'vehicleMaintenance', sw.rawBasics.vehicleMaintenancePct],
        ['driverFitnessBasic',      'driverFitness',      sw.rawBasics.driverFitnessPct],
      ];
      for (const [formField, suffKey, rawPct] of gateFlips) {
        if (swSufficiency[suffKey] === 'insufficient' &&
            finalBasicSufficiency[suffKey] === 'ok' &&
            rawPct != null && rawPct !== '') {
          setScalar(formField, rawPct, 'saferwatch', 'SaferWatch');
        }
      }
    }

    // Store SW metadata in serverFields for the frontend
    serverFields.swInspectionsDate       = swDate;
    serverFields.swInspectVehUS          = sw.inspectVehUS ?? null;
    serverFields.swInspectDrvUS          = sw.inspectDrvUS ?? null;
    serverFields.swBasicDataSufficiency  = finalBasicSufficiency;
    serverFields.swRawBasics             = sw.rawBasics ?? null;
    serverFields.swAlerts                = sw.alerts ?? null;
    serverFields.swRiskAssessment        = sw.riskAssessment ?? null;
    serverFields.swCertStatus            = sw.certStatus ?? null;
    serverFields.swBipdRequired          = sw.bipdRequired ?? null;
    serverFields.swErr                   = null;
  } else {
    // SW failed
    serverFields.swErr = sw?.error ?? 'SaferWatch lookup failed — manual entry required for BASIC scores and insurance';
  }

  // Store SAFER HTML data for the frontend display
  serverFields.saferData        = fmcsa?.saferData ?? null;
  serverFields.saferSnapshotDate = saferSnapshotDate;
  serverFields.useSafer          = useSafer;
  serverFields.winVehInsp        = winVehInsp ?? null;
  serverFields.winDrvInsp        = winDrvInsp ?? null;

  // ── Insurance ──────────────────────────────────────────────────────────────
  if (insurance && !insurance.notReviewed) {
    const pending = insurance.bipdCancelPending ?? false;
    const lapsed  = insurance.bipdCancelLapsed  ?? false;
    setScalar('bipdCancelPending',    pending, 'insurance', 'FMCSA BMC-35');
    setScalar('bipdCancelLapsed',     lapsed,  'insurance', 'FMCSA BMC-35');
    setScalar('pendingInsuranceCancellation', !!(pending || lapsed), 'insurance', 'FMCSA BMC-35');
    if (insurance.effectiveDate) {
      setScalar('bipdCancelEffectiveDate', insurance.effectiveDate, 'insurance', 'FMCSA BMC-35');
    }
    if (insurance.transDate) {
      setScalar('bipdCancelTransDate', insurance.transDate, 'insurance', 'FMCSA BMC-35');
    }
    if (insurance.insuranceCompany) {
      setScalar('bipdCancelInsuranceCompany', insurance.insuranceCompany, 'insurance', 'FMCSA BMC-35');
    }
    if (insurance.daysUntil != null) {
      setScalar('bipdCancelDaysUntil', insurance.daysUntil, 'insurance', 'FMCSA BMC-35');
    }
  }
  serverFields.insuranceNotReviewed = !!(insurance?.notReviewed);

  // ── Chameleon ──────────────────────────────────────────────────────────────
  if (chameleon) {
    const notReviewed = !!(chameleon.notReviewed);
    setScalar('fmcsaChameleonNotReviewed', notReviewed,                 'chameleon', 'FMCSA');
    setScalar('fmcsaEmailNotReviewed',     notReviewed,                 'chameleon', 'FMCSA');
    setScalar('fmcsaChameleonTimedOut',    !!(chameleon.timedOut),      'chameleon', 'FMCSA');
    if (!notReviewed) {
      setComplex('fmcsaChameleonMatches', chameleon.matches ?? []);
      setComplex('fmcsaContactChange',    chameleon.contactChange ?? null);
      if (chameleon.fmcsaRegisteredEmail != null) {
        setScalar('fmcsaRegisteredEmail', chameleon.fmcsaRegisteredEmail, 'chameleon', 'FMCSA');
      }
      if (chameleon.enforcementTablesLoadedAt) {
        setScalar('fmcsaEnforcementLoadedAt', chameleon.enforcementTablesLoadedAt, 'chameleon', 'FMCSA');
      }
    } else {
      setComplex('fmcsaChameleonMatches', null);
      setComplex('fmcsaContactChange', null);
    }
  }

  return { autoFilled, fieldSources, serverFields, merged };
}

// ─────────────────────────────────────────────────────────────────────────────
// applyStricterEdits
//
// Apply dispatcher edits only when they make the verdict stricter.
// An edit can tighten a verdict but never loosen it.
//
// Returns a shallow copy of carrierData with stricter values applied.
// _dispatcherEdits is preserved on the result (always contains original server values).
// ─────────────────────────────────────────────────────────────────────────────

// Higher value = stricter (triggers HOLD/REJECT sooner)
const _STRICT_HIGHER = new Set([
  'truckOosPct', 'driverOosPct',
  'unsafeDrivingBasic', 'hosBasic', 'vehicleMaintenanceBasic',
  'driverFitnessBasic', 'crashIndicatorBasic', 'vehicleDriverObservedBasic', 'hazmatBasic',
]);
// Lower value = stricter (less coverage / fewer inspections is riskier)
const _STRICT_LOWER = new Set([
  'autoLiability', 'cargoInsurance', 'inspections24mo',
]);
const _STRICT_WORSE_RATING = new Set(['safetyRating']);
// true is stricter than false/null (violation or risk flag present)
const _STRICT_TRUE = new Set([
  'activeFederalOOS', 'hasBrokerAuthority', 'bipdCancelPending', 'pendingInsuranceCancellation',
  'drugAlcoholViolation',
]);
// Earlier date = stricter (expires / lapses sooner)
const _STRICT_EARLIER_DATE = new Set(['autoLiabilityExpiration', 'cargoExpiration']);
// Later date = stricter (more recent grant = younger authority = fewer days elapsed)
const _STRICT_LATER_DATE = new Set(['authorityGrantDate']);

const _RATING_RANK = { 'Unsatisfactory': 3, 'Conditional': 2, 'Satisfactory': 1 };

export function applyStricterEdits(carrierData, dispatcherEdits) {
  const result = { ...carrierData };
  for (const [field, { submitted }] of Object.entries(dispatcherEdits)) {
    if (_STRICT_HIGHER.has(field)) {
      const sv = parseFloat(result[field]), dv = parseFloat(submitted);
      if (!isNaN(sv) && !isNaN(dv) && dv > sv) result[field] = submitted;
    } else if (_STRICT_LOWER.has(field)) {
      const sv = parseFloat(result[field]), dv = parseFloat(submitted);
      if (!isNaN(sv) && !isNaN(dv) && dv < sv) result[field] = submitted;
    } else if (_STRICT_WORSE_RATING.has(field)) {
      const sr = _RATING_RANK[result[field]] ?? 0;
      const dr = _RATING_RANK[submitted]      ?? 0;
      if (dr > sr) result[field] = submitted;
    } else if (_STRICT_TRUE.has(field)) {
      const sv = result[field] === true  || result[field] === 'true';
      const dv = submitted    === 'true' || submitted    === true;
      if (dv && !sv) result[field] = true;
    } else if (field === 'authorityStatus') {
      // 'active' is the only passing value; any change away from it is stricter
      if (result[field] === 'active' && submitted !== 'active') result[field] = submitted;
    } else if (_STRICT_EARLIER_DATE.has(field)) {
      const sv = new Date(result[field]), dv = new Date(submitted);
      if (!isNaN(sv) && !isNaN(dv) && dv < sv) result[field] = submitted;
    } else if (_STRICT_LATER_DATE.has(field)) {
      const sv = new Date(result[field]), dv = new Date(submitted);
      if (!isNaN(sv) && !isNaN(dv) && dv > sv) result[field] = submitted;
    }
    // Fields with no clear stricter direction (e.g. powerUnits) are silently kept
    // as the server original — the edit is logged in _dispatcherEdits for the cert.
  }
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// validateLookupRow
//
// Pure check run after the DB row is fetched (tenant already enforced by the
// DB query's .eq('tenant_id', orgId) filter — a wrong-tenant id returns null).
//
// Returns an error string on failure, or null on success.
// ─────────────────────────────────────────────────────────────────────────────
export function validateLookupRow(row, browserDotNumber, nowMs, maxAgeMs) {
  if (!row) return 'Lookup not found — run a new lookup before submitting';

  const ageMs = nowMs - new Date(row.created_at).getTime();
  if (ageMs > maxAgeMs) return 'Lookup is older than 24 hours — run a new lookup';

  const submittedDot = String(browserDotNumber ?? '').replace(/\D/g, '');
  const savedDot     = String(row.dot_number   ?? '').replace(/\D/g, '');
  if (submittedDot && savedDot && submittedDot !== savedDot) {
    return `Lookup was for DOT ${savedDot} but submitted for DOT ${submittedDot} — run a new lookup`;
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// applyToSubmission
//
// Build the definitive carrier_data for /run:
//   - Start with the browser-submitted body (manual fields: loadRef, dispatcher,
//     contactPhone, contactEmail, BASIC scores the browser must enter, etc.)
//   - Override every scalar auto-filled field with the server's saved value
//   - Apply complex fields verbatim from serverFields
//   - Set _autoFilled to the server's autoFilled (the PDF generator uses this)
// ─────────────────────────────────────────────────────────────────────────────
export function applyToSubmission(savedLookup, browserBody) {
  const autoFilled   = savedLookup.auto_filled   ?? {};
  const serverFields = savedLookup.server_fields  ?? {};

  const data = { ...browserBody };

  // Apply scalar auto-filled fields (server always wins)
  for (const [field, { value }] of Object.entries(autoFilled)) {
    // Convert string back to native type for boolean fields
    if (['activeFederalOOS', 'hasBrokerAuthority', 'bipdCancelPending', 'bipdCancelLapsed',
         'pendingInsuranceCancellation', 'fmcsaChameleonNotReviewed',
         'fmcsaEmailNotReviewed', 'fmcsaChameleonTimedOut',
         'drugAlcoholViolation'].includes(field)) {
      data[field] = value === 'true' ? true : value === 'false' ? false : null;
    } else {
      data[field] = value;
    }
  }

  // Apply complex server fields
  for (const [field, val] of Object.entries(serverFields)) {
    // Only apply form-level complex fields; skip PDF metadata stored in serverFields
    if (COMPLEX_AUTO_FIELDS.has(field)) {
      data[field] = val;
    }
  }

  // Apply OOS display metadata from serverFields
  for (const f of ['oosWinLabel','truckOosPctAlt','truckOosPctAltSrc','driverOosPctAlt','driverOosPctAltSrc',
                   'driverInspections24mo','_basicSufficiency']) {
    if (serverFields[f] !== undefined) data[f] = serverFields[f];
  }

  // drugAlcohol source text (for PDF)
  if (serverFields.swDrugAlcohol?.source) {
    data.drugAlcoholSource = serverFields.swDrugAlcohol.source;
  }

  // Replace browser's _autoFilled with server's authoritative version
  data._autoFilled = autoFilled;

  // Mark as server-verified
  data.fmcsaLookupCompleted = true;
  data.fmcsa_cannot_verify  = savedLookup.fmcsa_cannot_verify ?? false;

  return data;
}

// ─────────────────────────────────────────────────────────────────────────────
// detectEdits
//
// Compare browser-sent values against server's auto-filled values.
// Returns { fieldName: { original, sourceLabel, submitted } } for fields that differ.
// Only checks scalar fields (string/number/boolean) — complex fields are always
// overridden silently, never flagged as "edited".
// ─────────────────────────────────────────────────────────────────────────────
export function detectEdits(autoFilled, browserBody) {
  const edits = {};
  for (const [field, { value: original, sourceLabel }] of Object.entries(autoFilled)) {
    const submitted = browserBody[field];
    if (submitted === undefined || submitted === null) continue;
    const submittedStr = String(submitted).trim();
    const originalStr  = String(original).trim();
    if (submittedStr === originalStr) continue;
    // Numeric equivalence: "20" vs "20.00"
    const sn = parseFloat(submittedStr), on = parseFloat(originalStr);
    if (!isNaN(sn) && !isNaN(on) && sn === on) continue;
    // Boolean equivalence: true/"true", false/"false"
    if ((submitted === true  || submittedStr === 'true')  && originalStr === 'true')  continue;
    if ((submitted === false || submittedStr === 'false') && originalStr === 'false') continue;
    edits[field] = { original, sourceLabel, submitted: String(submitted) };
  }
  return edits;
}
