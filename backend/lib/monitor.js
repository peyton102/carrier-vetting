// ── Carrier Monitoring Job ─────────────────────────────────────────────────────
// Re-checks FMCSA + SaferWatch for every active (in-transit) monitored load.
// Runs on a configurable interval (default 4 h). Alerts via email + DB on change.
// FMCSA unreachable → "Cannot Verify" alert (never a silent pass).
// FMCSA key is per-tenant (tenant_credentials). SaferWatch uses per-tenant or shared env keys.
// All pass/fail decisions use the same runVettingRules() as initial vetting —
// no separate OOS or authority logic here.

import nodemailer    from 'nodemailer';
import { XMLParser } from 'fast-xml-parser';
import { fetchSettings }   from './settings.js';
import { decrypt }         from './encryption.js';
import { runVettingRules } from './rules_engine.js';

const FMCSA_BASE = 'https://mobile.fmcsa.dot.gov/qc/services';
const SW_BASE    = 'https://www.saferwatch.com/webservices/CarrierService32.php';

// ── Shared helpers (mirrors saferwatch.js) ────────────────────────────────────

function str(v) { return v != null ? String(v) : ''; }

function parseMoney(raw) {
  if (raw == null || raw === '') return '';
  const n = parseFloat(String(raw).replace(/[$,\s]/g, ''));
  return isNaN(n) ? '' : String(n);
}

function normalizeDate(raw) {
  if (!raw) return '';
  const s = String(raw).trim();
  const mdy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (mdy) return `${mdy[3]}-${mdy[1].padStart(2, '0')}-${mdy[2].padStart(2, '0')}`;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return '';
}

function extractCargo(certData) {
  const empty = { amount: '', expiration: '' };
  if (!certData) return empty;
  const certs    = certData.Certificate;
  if (!certs) return empty;
  const certList = Array.isArray(certs) ? certs : [certs];
  for (const cert of certList) {
    const covs = cert.Coverage;
    if (!covs) continue;
    const covList = Array.isArray(covs) ? covs : [covs];
    for (const cov of covList) {
      if (/cargo/i.test(cov.type || '')) {
        return {
          amount:     parseMoney(cov.coverageLimit),
          expiration: normalizeDate(str(cov.expirationDate)),
        };
      }
    }
  }
  return empty;
}

function extractPendingCancellation(certData) {
  if (!certData) return { pending: false, cancellationDate: null };
  const certs    = certData.Certificate;
  if (!certs) return { pending: false, cancellationDate: null };
  const certList = Array.isArray(certs) ? certs : [certs];
  const today    = new Date();
  for (const cert of certList) {
    const covs = cert.Coverage;
    if (!covs) continue;
    const covList = Array.isArray(covs) ? covs : [covs];
    for (const cov of covList) {
      const raw = str(cov.cancellationDate);
      if (!raw) continue;
      const d = new Date(raw);
      if (!isNaN(d.getTime()) && d > today) {
        return { pending: true, cancellationDate: normalizeDate(raw) };
      }
    }
  }
  return { pending: false, cancellationDate: null };
}

function extractAutoLiabilityExpiration(certData) {
  if (!certData) return '';
  const certs    = certData.Certificate;
  if (!certs) return '';
  const certList = Array.isArray(certs) ? certs : [certs];
  for (const cert of certList) {
    const covs = cert.Coverage;
    if (!covs) continue;
    const covList = Array.isArray(covs) ? covs : [covs];
    for (const cov of covList) {
      if (/liab|bipd|auto/i.test(cov.type || '')) {
        return normalizeDate(str(cov.expirationDate));
      }
    }
  }
  return '';
}

// ── FMCSA helpers ─────────────────────────────────────────────────────────────

function fmcsaUrl(path, webKey) {
  return `${FMCSA_BASE}${path}?webKey=${encodeURIComponent(webKey)}&type=json`;
}

function normalizeFMCSAAuthority(c) {
  if ((c.allowedToOperate || '').toUpperCase() === 'N') return 'Not Authorized';
  const common   = (c.commonAuthorityStatus   || '').toUpperCase();
  const contract = (c.contractAuthorityStatus || '').toUpperCase();
  if (common === 'R' || contract === 'R') return 'Revocation Pending';
  if (common   === 'A') return 'Active-Common';
  if (contract === 'A') return 'Active-Contract';
  if (common   === 'S' || contract === 'S') return 'Suspended';
  return 'Inactive';
}

function normalizeFMCSARating(raw) {
  if (!raw) return 'None/Unrated';
  const r = raw.trim();
  if (/^S$/i.test(r) || (/satisfactory/i.test(r) && !/un/i.test(r))) return 'Satisfactory';
  if (/^U$/i.test(r) || /unsatisfactory/i.test(r)) return 'Unsatisfactory';
  if (/^C$/i.test(r) || /conditional/i.test(r)) return 'Conditional';
  return 'None/Unrated';
}

// Returns all fields needed by runVettingRules for a live FMCSA check.
async function fetchFMCSASnapshot(dot, webKey) {
  const res = await fetch(fmcsaUrl(`/carriers/${dot}`, webKey), {
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 404) throw new Error(`DOT ${dot} not found in FMCSA`);
  if (!res.ok) throw new Error(`FMCSA HTTP ${res.status}`);
  const json = await res.json();
  const c    = json?.content?.carrier || json?.content;
  if (!c) throw new Error('FMCSA returned no carrier record');

  return {
    carrierName:          c.legalName || '',
    authorityStatus:      normalizeFMCSAAuthority(c),
    safetyRating:         normalizeFMCSARating(c.safetyRating),
    powerUnits:           c.totalPowerUnits != null ? String(c.totalPowerUnits) : '',
    inspections24mo:      c.vehicleInsp    != null ? String(c.vehicleInsp)      : '',
    truckOosPct:          c.vehicleOosRate != null ? parseFloat(c.vehicleOosRate).toFixed(2) : '',
    driverOosPct:         c.driverOosRate  != null ? parseFloat(c.driverOosRate).toFixed(2)  : '',
    nationalAvgTruckOos:  c.vehicleOosRateNationalAverage != null ? String(c.vehicleOosRateNationalAverage) : '',
    nationalAvgDriverOos: c.driverOosRateNationalAverage  != null ? String(c.driverOosRateNationalAverage)  : '',
    activeFederalOOS:     !!c.outOfServiceDate,
    hasBrokerAuthority:   (c.brokerAuthorityStatus || '').toUpperCase() === 'A',
    fmcsaPhone:           c.telephone || c.mcsPhone || c.phone || '',
  };
}

// ── SaferWatch helpers ────────────────────────────────────────────────────────

// Resolve per-tenant SW keys from DB, falling back to shared env keys.
async function resolveSwKeys(tid, supabase) {
  try {
    const { data } = await supabase
      .from('tenant_credentials')
      .select('sw_service_key, sw_customer_key')
      .eq('tenant_slug', tid)
      .single();
    if (data?.sw_service_key && data?.sw_customer_key) {
      return {
        serviceKey:  decrypt(data.sw_service_key),
        customerKey: decrypt(data.sw_customer_key),
      };
    }
  } catch (_) { /* fall through to shared env keys */ }
  return {
    serviceKey:  process.env.SAFERWATCH_SERVICE_KEY,
    customerKey: process.env.SAFERWATCH_CUSTOMER_KEY,
  };
}

// Returns full SW snapshot including BASIC scores, insurance amounts, and expiry dates.
// Returns null (not an error) when keys are not configured.
async function fetchSaferWatchSnapshot(dot, swKeys) {
  const { serviceKey, customerKey } = swKeys;
  if (!serviceKey || !customerKey) return null;

  const p = new URLSearchParams({
    Action:      'CarrierLookup',
    ServiceKey:  serviceKey,
    CustomerKey: customerKey,
    number:      dot,
  });
  const res = await fetch(`${SW_BASE}?${p}`, { signal: AbortSignal.timeout(12_000) });
  if (!res.ok) throw new Error(`SaferWatch HTTP ${res.status}`);

  const xml    = await res.text();
  const parser = new XMLParser({
    ignoreAttributes:    false,
    attributeNamePrefix: '@_',
    isArray: (name) => ['Certificate', 'Coverage'].includes(name),
  });
  const parsed = parser.parse(xml);
  const root   = parsed['CarrierService32.CarrierLookup'];
  if (!root) throw new Error('Unexpected SaferWatch XML structure');

  const wrapper = root.ResponseDO || {};
  if (str(wrapper.status) !== 'APPROVED' || str(wrapper.action) !== 'OK') {
    throw new Error(`SaferWatch: ${str(wrapper.displayMsg) || str(wrapper.techMsg) || 'non-OK response'}`);
  }

  const details = root.CarrierDetails;
  if (!details) throw new Error('SaferWatch: no CarrierDetails');

  const safety     = details.Safety         || {};
  const inspection = details.Inspection     || {};
  const operation  = details.Operation      || {};
  const equipment  = details.Equipment      || {};
  const insurance  = details.FMCSAInsurance || {};
  const certData   = details.CertData       || null;

  const cargo    = extractCargo(certData);
  const pending  = extractPendingCancellation(certData);

  return {
    unsafeDrivingBasic:              str(safety.unsafeDrvPCT),
    hosBasic:                        str(safety.hosPCT),
    vehicleMaintenanceBasic:         str(safety.vehMaintPCT),
    driverFitnessBasic:              str(safety.drvFitPCT),
    autoLiability:                   parseMoney(insurance.bipdOnFile),
    cargoInsurance:                  cargo.amount,
    autoLiabilityExpiration:         extractAutoLiabilityExpiration(certData),
    cargoExpiration:                 cargo.expiration,
    truckOosPct:                     str(inspection.inspectVehOOSPctUS),
    driverOosPct:                    str(inspection.inspectDrvOOSPctUS),
    inspections24mo:                 str(inspection.inspectTotalUS),
    powerUnits:                      str(equipment.totalPower),
    activeFederalOOS:                str(operation.outOfService).toLowerCase() === 'yes',
    pendingInsuranceCancellation:    pending.pending,
    insuranceCancellationDate:       pending.cancellationDate,
    insuranceDataAsOf:               new Date().toISOString(),
  };
}

// ── Merge FMCSA + SW snapshots into a runVettingRules-compatible object ────────
// authorityGrantDate is intentionally left blank — authority age is not re-checked
// during monitoring. Monitoring only detects degradation from an already-approved state.

function buildCarrierSnapshot(fmcsa, sw) {
  const snap = {
    // From FMCSA (authoritative for authority/rating/OOS/inspections)
    carrierName:               fmcsa.carrierName,
    authorityStatus:           fmcsa.authorityStatus,
    authorityGrantDate:        '',   // skip age re-check during monitoring
    safetyRating:              fmcsa.safetyRating,
    powerUnits:                fmcsa.powerUnits,
    inspections24mo:           fmcsa.inspections24mo,
    truckOosPct:               fmcsa.truckOosPct,
    driverOosPct:              fmcsa.driverOosPct,
    nationalAvgTruckOos:       fmcsa.nationalAvgTruckOos,
    nationalAvgDriverOos:      fmcsa.nationalAvgDriverOos,
    activeFederalOOS:          fmcsa.activeFederalOOS,
    hasBrokerAuthority:        fmcsa.hasBrokerAuthority ?? false,
    fmcsaPhone:                fmcsa.fmcsaPhone ?? '',
    // Drug/alcohol is checked at booking only — never set to false in monitoring
    drugAlcoholViolation:      null,
    // Contact fields not monitorable (dispatcher enters these at booking)
    contactPhone:              '',
    contactEmail:              '',
    // Not monitorable without SW — blank unless SW provides them
    autoLiability:             '',
    cargoInsurance:            '',
    autoLiabilityExpiration:   '',
    cargoExpiration:           '',
    unsafeDrivingBasic:        '',
    crashIndicatorBasic:       '',
    hosBasic:                  '',
    vehicleMaintenanceBasic:   '',
    vehicleDriverObservedBasic: '',
    driverFitnessBasic:        '',
    hazmatBasic:               '',
    // Not relevant during monitoring
    carrierAssureGrade:        '',
    pendingInsuranceCancellation: false,
    fmcsaCannotVerify:         false,
    // Flag so rules engine skips null drugAlcoholViolation HOLD
    _monitoringContext:        true,
  };

  if (sw) {
    // SW is more granular for OOS/inspection counts — prefer when present
    if (sw.truckOosPct)    snap.truckOosPct    = sw.truckOosPct;
    if (sw.driverOosPct)   snap.driverOosPct   = sw.driverOosPct;
    if (sw.inspections24mo) snap.inspections24mo = sw.inspections24mo;
    if (sw.powerUnits)     snap.powerUnits     = sw.powerUnits;
    // SW operation.outOfService is more reliable than FMCSA outOfServiceDate
    if (sw.activeFederalOOS) snap.activeFederalOOS = sw.activeFederalOOS;
    // BASIC scores (only available from SW)
    if (sw.unsafeDrivingBasic)      snap.unsafeDrivingBasic      = sw.unsafeDrivingBasic;
    if (sw.hosBasic)                snap.hosBasic                = sw.hosBasic;
    if (sw.vehicleMaintenanceBasic) snap.vehicleMaintenanceBasic = sw.vehicleMaintenanceBasic;
    if (sw.driverFitnessBasic)      snap.driverFitnessBasic      = sw.driverFitnessBasic;
    // Insurance amounts, expiry dates, and pending cancellation (only available from SW)
    if (sw.autoLiability)                snap.autoLiability                = sw.autoLiability;
    if (sw.cargoInsurance)               snap.cargoInsurance               = sw.cargoInsurance;
    if (sw.autoLiabilityExpiration)      snap.autoLiabilityExpiration      = sw.autoLiabilityExpiration;
    if (sw.cargoExpiration)              snap.cargoExpiration              = sw.cargoExpiration;
    if (sw.pendingInsuranceCancellation) snap.pendingInsuranceCancellation = sw.pendingInsuranceCancellation;
    if (sw.insuranceCancellationDate)    snap.insuranceCancellationDate    = sw.insuranceCancellationDate;
    if (sw.insuranceDataAsOf)            snap.insuranceDataAsOf            = sw.insuranceDataAsOf;
  }

  return snap;
}

// ── Override suppression ──────────────────────────────────────────────────────
// Maps a reason string to a stable category key. Used to detect whether a
// monitoring reason was already present (and overridden) during initial vetting.

function categorizeReason(text) {
  if (/Auto liability insurance expired/i.test(text))        return 'auto_insurance_expired';
  if (/Auto liability insurance expires/i.test(text))        return 'auto_insurance_expiry';
  if (/Cargo insurance expired/i.test(text))                 return 'cargo_insurance_expired';
  if (/Cargo insurance expires/i.test(text))                 return 'cargo_insurance_expiry';
  if (/authority age/i.test(text))                           return 'authority_age';
  if (/Operating authority/i.test(text))                     return 'authority_status';
  if (/FMCSA safety rating/i.test(text))                     return 'safety_rating';
  if (/Vehicle OOS rate.*absolute floor/i.test(text))        return 'oos_truck_floor';
  if (/Vehicle OOS rate.*hard limit/i.test(text))            return 'oos_truck_hard';
  if (/Truck OOS.*national average/i.test(text))             return 'oos_truck_yellow';
  if (/Driver OOS rate.*hard limit/i.test(text))             return 'oos_driver_hard';
  if (/Driver OOS.*national average/i.test(text))            return 'oos_driver_yellow';
  if (/active federal Out-of-Service/i.test(text))           return 'active_oos';
  if (/Ghost-carrier/i.test(text))                           return 'ghost_carrier';
  if (/Only \d+ vehicle inspection/i.test(text))             return 'low_volume';
  if (/Inspection count not provided/i.test(text))           return 'no_inspection_count';
  if (/no BASIC percentile scores/i.test(text))              return 'no_basic_data';
  if (/Unsafe Driving BASIC/i.test(text))                    return 'basic_unsafe_driving';
  if (/Crash Indicator BASIC/i.test(text))                   return 'basic_crash_indicator';
  if (/Hours of Service BASIC/i.test(text))                  return 'basic_hos';
  if (/Vehicle Maintenance BASIC/i.test(text))               return 'basic_vehicle_maintenance';
  if (/Vehicle Driver-Observed BASIC/i.test(text))           return 'basic_vehicle_driver_observed';
  if (/Driver Fitness BASIC/i.test(text))                    return 'basic_driver_fitness';
  if (/Hazardous Materials BASIC/i.test(text))               return 'basic_hazmat';
  if (/drug.*alcohol|alcohol.*drug/i.test(text))             return 'drug_alcohol_violation';
  if (/broker authority/i.test(text))                        return 'broker_authority';
  if (/contact.*mismatch|phone.*mismatch/i.test(text))       return 'contact_mismatch';
  if (/free.*email|personal.*email/i.test(text))             return 'free_email';
  if (/Carrier Assure grade/i.test(text))                    return 'carrier_assure_grade';
  if (/Pending insurance cancellation/i.test(text))          return 'pending_cancellation';
  if (/FMCSA.*unreachable/i.test(text))                      return 'fmcsa_cannot_verify';
  // Fallback: use raw text prefix — guarantees unknown reasons always alert
  return `unknown:${text.slice(0, 40)}`;
}

// When a lower-severity reason was overridden, a higher-severity escalation
// of the same issue should still trigger an alert.
// Key = overridden category, Value = escalated categories that must still alert.
const ESCALATIONS = {
  'auto_insurance_expiry':  ['auto_insurance_expired'],
  'cargo_insurance_expiry': ['cargo_insurance_expired'],
  'oos_truck_yellow':       ['oos_truck_floor', 'oos_truck_hard'],
  'oos_driver_yellow':      ['oos_driver_hard'],
  'authority_age':          ['authority_status'],  // age HOLD → authority revoked RED
};

/**
 * Given the current vetting reasons and the reasons that were overridden at
 * booking time, return only the reasons that need a new alert:
 *  - New category not present at override time → alert
 *  - Same category as overridden reason → suppress
 *  - Escalation of an overridden reason (HOLD → RED) → alert
 */
function filterAlertableReasons(currentReasons, overriddenReasons) {
  if (!overriddenReasons?.length) return currentReasons;

  const overriddenCats = new Set(overriddenReasons.map(categorizeReason));

  // Build set of categories that are escalations of any overridden category
  const escalatedFromOverride = new Set();
  for (const overCat of overriddenCats) {
    for (const escalated of (ESCALATIONS[overCat] || [])) {
      escalatedFromOverride.add(escalated);
    }
  }

  return currentReasons.filter(reason => {
    const cat = categorizeReason(reason);
    if (escalatedFromOverride.has(cat)) return true;  // severity increased → alert
    if (overriddenCats.has(cat))        return false; // same issue, already overridden → suppress
    return true;                                       // new issue → alert
  });
}

// Reword insurance-expiry reasons for monitoring context (carrier is already on a load).
function monitorReason(text) {
  return text.replace(/— confirm renewal before booking/gi,
    '— confirm renewal, carrier is on an active load');
}

// ── Email ─────────────────────────────────────────────────────────────────────

/**
 * Resolve the to-address list. Uses alertRecipients from settings if non-empty,
 * otherwise falls back to the tenant account email.
 */
function resolveRecipients(settings, tenantEmail) {
  const raw = (settings?.alertRecipients ?? '').trim();
  if (raw) {
    const list = raw.split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
    if (list.length) return list.join(', ');
  }
  return tenantEmail || null;
}

async function sendAlertEmail(load, issues, alertType, settings, tenantEmail) {
  const to = resolveRecipients(settings, tenantEmail);
  if (!process.env.SMTP_HOST || !to) return;

  const transport = nodemailer.createTransport({
    host:   process.env.SMTP_HOST,
    port:   parseInt(process.env.SMTP_PORT || '587'),
    secure: false,
    auth:   { user: process.env.SMTP_USERNAME, pass: process.env.SMTP_PASSWORD },
  });

  const isCannotVerify = alertType === 'cannot_verify';
  const subject = isCannotVerify
    ? `CANNOT VERIFY — ${load.carrier_name || load.dot_number} (Load ${load.load_ref})`
    : `CARRIER ALERT — ${load.carrier_name || load.dot_number} (Load ${load.load_ref}) — Status Changed`;

  const now       = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
  const issueList = issues.map(i => `<li>${i}</li>`).join('');

  const html = `
    <p><strong>${isCannotVerify ? 'Cannot Verify Carrier Status' : 'Carrier Status Change Detected'}</strong></p>
    <p><strong>Carrier:</strong> ${load.carrier_name || 'Unknown'} — DOT ${load.dot_number}</p>
    <p><strong>Load Ref:</strong> ${load.load_ref}</p>
    <p><strong>Detected at:</strong> ${now} ET</p>
    <ul>${issueList}</ul>
    <p>${isCannotVerify
      ? 'Do not assume the carrier is still in good standing. Verify manually before the load delivers.'
      : 'Review this carrier immediately and decide whether to continue the load.'}</p>
  `;

  const from = process.env.FROM_EMAIL
    ? `"${process.env.FROM_NAME || 'Carrier Vetting'}" <${process.env.FROM_EMAIL}>`
    : process.env.SMTP_USERNAME;

  await transport.sendMail({ from, to, subject, html });
  transport.close();
}

// ── Core check (monitored loads) ──────────────────────────────────────────────

async function checkSingleLoad(load, settings, tenantEmail, supabase, webKey, swKeys) {
  let issues    = [];
  let alertType = null;
  let newStatus = 'ok';

  // Fetch original vetting reasons if the load was booked with an override.
  // We suppress re-alerting on the same issues the manager already approved.
  let overriddenReasons = [];
  if (load.vetting_log_id) {
    try {
      const { data: origLog } = await supabase
        .from('vetting_logs')
        .select('verdict, reasons')
        .eq('id', load.vetting_log_id)
        .single();
      if (origLog?.verdict === 'APPROVED WITH OVERRIDE') {
        overriddenReasons = origLog.reasons || [];
      }
    } catch (_) { /* non-fatal — missing log just means no suppression */ }
  }

  try {
    // FMCSA: primary check — failure triggers cannot_verify, not a silent pass
    const fmcsaSnap = await fetchFMCSASnapshot(load.dot_number, webKey);

    // SaferWatch: secondary — adds BASIC scores, insurance amounts, expiry dates
    let swSnap = null;
    try {
      swSnap = await fetchSaferWatchSnapshot(load.dot_number, swKeys);
    } catch (swErr) {
      console.warn(`[MONITOR] SaferWatch unavailable for DOT ${load.dot_number}: ${swErr.message}`);
    }

    const carrierData = buildCarrierSnapshot(fmcsaSnap, swSnap);
    const result      = runVettingRules(carrierData, settings);

    if (result.tier !== 'GREEN') {
      const alertable = filterAlertableReasons(result.reasons, overriddenReasons)
        .map(monitorReason);
      if (alertable.length > 0) {
        alertType = 'status_change';
        newStatus = 'alert';
        issues    = alertable;
      }
    }
  } catch (fmcsaErr) {
    alertType = 'cannot_verify';
    newStatus  = 'cannot_verify';
    const lastOk = load.last_checked_at
      ? new Date(load.last_checked_at).toLocaleString('en-US', { timeZone: 'America/New_York' }) + ' ET'
      : 'never verified';
    issues = [
      `FMCSA is currently unreachable — carrier status cannot be confirmed. Last successful check: ${lastOk}. Do not assume the carrier is still in good standing.`,
    ];
  }

  const update = {
    last_checked_at: new Date().toISOString(),
    last_status:     newStatus,
    last_issues:     issues.length ? issues : null,
  };
  if (alertType) update.last_alert_at = new Date().toISOString();

  await supabase.from('monitored_loads').update(update).eq('id', load.id);

  if (alertType) {
    await supabase.from('monitoring_alerts').insert({
      tenant_id:         load.tenant_id,
      monitored_load_id: load.id,
      load_ref:          load.load_ref,
      carrier_name:      load.carrier_name,
      dot_number:        load.dot_number,
      alert_type:        alertType,
      issues,
    });

    try {
      await sendAlertEmail(load, issues, alertType, settings, tenantEmail);
      console.log(`[MONITOR] Alert email sent — load ${load.load_ref} (${alertType})`);
    } catch (emailErr) {
      console.error('[MONITOR] Email send failed:', emailErr.message);
    }

    console.log(`[MONITOR] ALERT [${load.tenant_id}] — ${load.load_ref}: ${issues[0]}`);
  } else {
    console.log(`[MONITOR] OK [${load.tenant_id}] — load ${load.load_ref} (DOT ${load.dot_number})`);
  }
}

// ── Main job ──────────────────────────────────────────────────────────────────

/**
 * Check all active monitored loads (or only loads for a specific tenant).
 * Each tenant's FMCSA web key is fetched from their credentials record.
 */
export async function runMonitoringCheck(supabase, tenantId = null) {
  let query = supabase.from('monitored_loads').select('*').is('delivered_at', null);
  if (tenantId) query = query.eq('tenant_id', tenantId);
  const { data: loads, error } = await query;

  if (error) { console.error('[MONITOR] DB error:', error.message); return; }
  if (!loads?.length) { console.log('[MONITOR] No active loads.'); return; }

  console.log(`[MONITOR] Checking ${loads.length} active load(s)…`);

  // Group loads by tenant to fetch credentials + settings once per tenant
  const byTenant = {};
  for (const load of loads) {
    (byTenant[load.tenant_id] ??= []).push(load);
  }

  for (const [tid, tenantLoads] of Object.entries(byTenant)) {
    let settings, tenantEmail, webKey, swKeys;
    try {
      [settings] = await Promise.all([fetchSettings(tid)]);

      const [tenantRow, credRow] = await Promise.all([
        supabase.from('tenants').select('email').eq('slug', tid).single(),
        supabase.from('tenant_credentials')
          .select('fmcsa_webkey, sw_service_key, sw_customer_key')
          .eq('tenant_slug', tid).single(),
      ]);

      tenantEmail = tenantRow.data?.email ?? null;
      webKey      = credRow.data?.fmcsa_webkey  ? decrypt(credRow.data.fmcsa_webkey)  : null;
      swKeys = {
        serviceKey:  credRow.data?.sw_service_key  ? decrypt(credRow.data.sw_service_key)  : process.env.SAFERWATCH_SERVICE_KEY,
        customerKey: credRow.data?.sw_customer_key ? decrypt(credRow.data.sw_customer_key) : process.env.SAFERWATCH_CUSTOMER_KEY,
      };
    } catch (e) {
      console.warn(`[MONITOR] Could not fetch data for tenant ${tid}: ${e.message}`);
      continue;
    }

    if (!webKey) {
      console.warn(`[MONITOR] Tenant ${tid} has no FMCSA web key — skipping ${tenantLoads.length} load(s)`);
      continue;
    }

    for (const load of tenantLoads) {
      await checkSingleLoad(load, settings, tenantEmail, supabase, webKey, swKeys);
    }
  }
}

// ── Watched-carrier inspection polling ───────────────────────────────────────
// Polls FMCSA inspection records for every active watched carrier.
// Detects net-new inspections with OOS violations, then runs the full rules engine
// to decide whether to auto-block. Alerts when runVettingRules returns RED or YELLOW.

async function fetchFMCSAInspections(dot, webKey) {
  const url = `${FMCSA_BASE}/carriers/${dot}/inspections?webKey=${encodeURIComponent(webKey)}&type=json`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`FMCSA inspections HTTP ${res.status} for DOT ${dot}`);
  const json  = await res.json();
  const items = json?.content;
  if (Array.isArray(items)) return items;
  if (Array.isArray(items?.inspection)) return items.inspection;
  return [];
}

async function sendBlockAlertEmail(carrier, newOosInspections, issues, settings, tenantEmail) {
  const to = resolveRecipients(settings, tenantEmail);
  if (!process.env.SMTP_HOST || !to) {
    console.warn('[MONITOR:WATCH] SMTP not configured or no recipient — block alert not emailed');
    return;
  }

  const transport = nodemailer.createTransport({
    host:   process.env.SMTP_HOST,
    port:   parseInt(process.env.SMTP_PORT || '587'),
    secure: false,
    auth:   { user: process.env.SMTP_USERNAME, pass: process.env.SMTP_PASSWORD },
  });

  const now          = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
  const carrierLabel = `${carrier.carrier_name || 'Unknown'} — DOT ${carrier.dot_number}`;
  const subject      = `CARRIER AUTO-BLOCKED — ${carrierLabel} — New OOS Inspection`;

  const vOos = i => i.vehicleOosViolations ?? i.oosVehicle ?? i.vehicleOos ?? 0;
  const dOos = i => i.driverOosViolations  ?? i.oosDrives  ?? i.driverOos  ?? 0;

  const inspRows = newOosInspections.map(i => `
    <tr>
      <td style="padding:4px 8px;border:1px solid #e5e7eb">${i.inspDate || '—'}</td>
      <td style="padding:4px 8px;border:1px solid #e5e7eb">${i.reportState || '—'}</td>
      <td style="padding:4px 8px;border:1px solid #e5e7eb">Level ${i.level || '—'}</td>
      <td style="padding:4px 8px;border:1px solid #e5e7eb">
        ${vOos(i)} vehicle / ${dOos(i)} driver OOS
      </td>
      <td style="padding:4px 8px;border:1px solid #e5e7eb">${i.reportNumber || '—'}</td>
    </tr>`).join('');

  const issueList = issues.map(i => `<li style="margin-bottom:4px">${i}</li>`).join('');

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:640px">
      <div style="background:#dc2626;color:#fff;padding:12px 18px;border-radius:8px 8px 0 0;
                  font-weight:700;font-size:16px">
        CARRIER AUTO-BLOCKED — New OOS Roadside Inspection
      </div>
      <div style="border:1px solid #e5e7eb;border-top:none;padding:18px;border-radius:0 0 8px 8px">
        <p><strong>Carrier:</strong> ${carrierLabel}</p>
        ${carrier.mc_number ? `<p><strong>MC:</strong> ${carrier.mc_number}</p>` : ''}
        <p><strong>Blocked at:</strong> ${now} ET</p>
        <p><strong>Reason:</strong></p>
        <ul style="margin:0 0 16px 0">${issueList}</ul>
        <p><strong>New OOS Inspections (${newOosInspections.length}):</strong></p>
        <table style="border-collapse:collapse;width:100%;font-size:12px">
          <thead>
            <tr style="background:#f3f4f6">
              <th style="padding:4px 8px;border:1px solid #e5e7eb;text-align:left">Date</th>
              <th style="padding:4px 8px;border:1px solid #e5e7eb;text-align:left">State</th>
              <th style="padding:4px 8px;border:1px solid #e5e7eb;text-align:left">Level</th>
              <th style="padding:4px 8px;border:1px solid #e5e7eb;text-align:left">OOS Violations</th>
              <th style="padding:4px 8px;border:1px solid #e5e7eb;text-align:left">Report #</th>
            </tr>
          </thead>
          <tbody>${inspRows}</tbody>
        </table>
        <p style="margin-top:16px;color:#dc2626;font-weight:700">
          This carrier has been automatically hard-blocked in the vetting system.
          Do not book until the block is reviewed and manually lifted in the Settings.
        </p>
      </div>
    </div>`;

  const from = process.env.FROM_EMAIL
    ? `"${process.env.FROM_NAME || 'Carrier Vetting'}" <${process.env.FROM_EMAIL}>`
    : process.env.SMTP_USERNAME;

  await transport.sendMail({ from, to, subject, html });
  transport.close();
}

async function checkWatchedCarrier(carrier, settings, tenantEmail, supabase, webKey, swKeys) {
  console.log(`[MONITOR:WATCH] Checking DOT ${carrier.dot_number} (${carrier.carrier_name || '?'}) [${carrier.tenant_id}]`);

  let inspections;
  try {
    inspections = await fetchFMCSAInspections(carrier.dot_number, webKey);
  } catch (err) {
    console.warn(`[MONITOR:WATCH] DOT ${carrier.dot_number} inspections fetch failed: ${err.message}`);
    await supabase.from('watched_carriers')
      .update({ last_checked_at: new Date().toISOString() })
      .eq('id', carrier.id);
    return;
  }

  const reportNum      = i => String(i.reportNumber || i.reportNum || i.rptNumber || '');
  const allNums        = inspections.map(reportNum).filter(Boolean);
  const known          = new Set(carrier.last_report_numbers || []);
  const newInspections = inspections.filter(i => !known.has(reportNum(i)) && reportNum(i) !== '');

  const baseUpdate = {
    last_checked_at:       new Date().toISOString(),
    last_report_numbers:   allNums,
    last_inspection_count: inspections.length,
  };

  if (newInspections.length === 0) {
    await supabase.from('watched_carriers').update(baseUpdate).eq('id', carrier.id);
    console.log(`[MONITOR:WATCH] DOT ${carrier.dot_number} — no new inspections`);
    return;
  }

  console.log(`[MONITOR:WATCH] DOT ${carrier.dot_number} — ${newInspections.length} new inspection(s)`);

  const vOos = i => i.vehicleOosViolations ?? i.oosVehicle ?? i.vehicleOos ?? 0;
  const dOos = i => i.driverOosViolations  ?? i.oosDrives  ?? i.driverOos  ?? 0;
  const newOosInspections = newInspections.filter(i => vOos(i) > 0 || dOos(i) > 0);

  if (newOosInspections.length === 0) {
    await supabase.from('watched_carriers').update(baseUpdate).eq('id', carrier.id);
    console.log(`[MONITOR:WATCH] DOT ${carrier.dot_number} — ${newInspections.length} new clean inspection(s) — no action`);
    return;
  }

  // New OOS inspections found — fetch current snapshot and run the full rules engine
  let fmcsaSnap;
  try {
    fmcsaSnap = await fetchFMCSASnapshot(carrier.dot_number, webKey);
  } catch (err) {
    console.warn(`[MONITOR:WATCH] DOT ${carrier.dot_number} snapshot fetch failed: ${err.message}`);
    await supabase.from('watched_carriers').update(baseUpdate).eq('id', carrier.id);
    return;
  }

  let swSnap = null;
  try {
    swSnap = await fetchSaferWatchSnapshot(carrier.dot_number, swKeys);
  } catch (swErr) {
    console.warn(`[MONITOR:WATCH] SaferWatch unavailable for DOT ${carrier.dot_number}: ${swErr.message}`);
  }

  const carrierData = buildCarrierSnapshot(fmcsaSnap, swSnap);
  const result      = runVettingRules(carrierData, settings);

  baseUpdate.last_truck_oos_pct    = carrierData.truckOosPct  ? parseFloat(carrierData.truckOosPct)  : null;
  baseUpdate.last_driver_oos_pct   = carrierData.driverOosPct ? parseFloat(carrierData.driverOosPct) : null;
  baseUpdate.last_inspection_count = parseInt(carrierData.inspections24mo, 10) || inspections.length;

  if (result.tier === 'GREEN') {
    // New OOS inspections exist but didn't push the carrier over any threshold — log, no block
    await supabase.from('watched_carriers').update(baseUpdate).eq('id', carrier.id);
    console.log(`[MONITOR:WATCH] DOT ${carrier.dot_number} — new OOS inspections but still GREEN — no action`);
    return;
  }

  // RED or YELLOW — block the carrier and alert
  const issues = [
    ...result.reasons,
    ...newOosInspections.map(i =>
      `New OOS inspection: ${i.inspDate || '?'}, ${i.reportState || '?'}, ` +
      `Level ${i.level || '?'} — ${vOos(i)} vehicle OOS, ${dOos(i)} driver OOS ` +
      `(Report #${reportNum(i) || '?'})`
    ),
  ];

  // Determine primary threshold type for the block record
  const hardBlockTruck  = parseFloat(settings.oosHardBlockTruck)  || 35;
  const hardBlockDriver = parseFloat(settings.oosHardBlockDriver) || 7;
  const tOos = parseFloat(carrierData.truckOosPct);
  const dOosVal = parseFloat(carrierData.driverOosPct);

  let thresholdType  = 'new_oos_inspection';
  let thresholdValue = null;
  let actualValue    = null;
  if (!isNaN(tOos) && tOos > hardBlockTruck) {
    thresholdType  = 'truck_oos';
    thresholdValue = hardBlockTruck;
    actualValue    = tOos;
  } else if (!isNaN(dOosVal) && dOosVal > hardBlockDriver) {
    thresholdType  = 'driver_oos';
    thresholdValue = hardBlockDriver;
    actualValue    = dOosVal;
  }

  const { error: blockErr } = await supabase.from('carrier_blocks').insert({
    tenant_id:         carrier.tenant_id,
    dot_number:        carrier.dot_number,
    carrier_name:      carrier.carrier_name,
    mc_number:         carrier.mc_number,
    blocked_by:        'system',
    block_reason:      issues.join('; '),
    threshold_type:    thresholdType,
    threshold_value:   thresholdValue,
    actual_value:      actualValue,
    violation_details: { newInspections, newOosInspections, carrierData, vettingResult: result },
  });
  if (blockErr) console.error('[MONITOR:WATCH] Block insert failed:', blockErr.message);

  await supabase.from('watched_carriers').update(baseUpdate).eq('id', carrier.id);

  try {
    await sendBlockAlertEmail(carrier, newOosInspections, issues, settings, tenantEmail);
    console.log(`[MONITOR:WATCH] Block alert emailed — DOT ${carrier.dot_number} [${carrier.tenant_id}]`);
  } catch (emailErr) {
    console.error('[MONITOR:WATCH] Email send failed:', emailErr.message);
  }

  console.log(`[MONITOR:WATCH] BLOCKED [${carrier.tenant_id}] — DOT ${carrier.dot_number}: ${issues[0]}`);
}

/**
 * Check all active watched carriers (or only carriers for a specific tenant).
 * Per-tenant FMCSA key fetched from tenant_credentials.
 */
export async function runWatchedCarriersCheck(supabase, tenantId = null) {
  let query = supabase.from('watched_carriers').select('*').eq('is_active', true);
  if (tenantId) query = query.eq('tenant_id', tenantId);
  const { data: carriers, error } = await query;

  if (error) { console.error('[MONITOR:WATCH] DB error:', error.message); return; }
  if (!carriers?.length) { console.log('[MONITOR:WATCH] No watched carriers.'); return; }

  console.log(`[MONITOR:WATCH] Checking ${carriers.length} watched carrier(s)…`);

  const byTenant = {};
  for (const c of carriers) {
    (byTenant[c.tenant_id] ??= []).push(c);
  }

  for (const [tid, tenantCarriers] of Object.entries(byTenant)) {
    let settings, tenantEmail, webKey, swKeys;
    try {
      [settings] = await Promise.all([fetchSettings(tid)]);

      const [tenantRow, credRow] = await Promise.all([
        supabase.from('tenants').select('email').eq('slug', tid).single(),
        supabase.from('tenant_credentials')
          .select('fmcsa_webkey, sw_service_key, sw_customer_key')
          .eq('tenant_slug', tid).single(),
      ]);

      tenantEmail = tenantRow.data?.email ?? null;
      webKey      = credRow.data?.fmcsa_webkey  ? decrypt(credRow.data.fmcsa_webkey)  : null;
      swKeys = {
        serviceKey:  credRow.data?.sw_service_key  ? decrypt(credRow.data.sw_service_key)  : process.env.SAFERWATCH_SERVICE_KEY,
        customerKey: credRow.data?.sw_customer_key ? decrypt(credRow.data.sw_customer_key) : process.env.SAFERWATCH_CUSTOMER_KEY,
      };
    } catch (e) {
      console.warn(`[MONITOR:WATCH] Could not fetch data for tenant ${tid}: ${e.message}`);
      continue;
    }

    if (!webKey) {
      console.warn(`[MONITOR:WATCH] Tenant ${tid} has no FMCSA web key — skipping ${tenantCarriers.length} carrier(s)`);
      continue;
    }

    for (const carrier of tenantCarriers) {
      try {
        await checkWatchedCarrier(carrier, settings, tenantEmail, supabase, webKey, swKeys);
      } catch (err) {
        console.error(`[MONITOR:WATCH] Unhandled error for DOT ${carrier.dot_number}: ${err.message}`);
      }
    }
  }
}

// ── Insurance cancellation refresh (daily) ────────────────────────────────────
// Queries FMCSA data.transportation.gov c5y8-a4uz for active BMC-35 BIPD filings.
// Applies superseding check: if carrier also has BMC-91/91X with effective_date
// >= the BMC-35 effective_date, the cancellation is covered by new policy → skipped.
// Stores one row per DOT (soonest effective_date) in insurance_cancellations table.
// Deny-all RLS; service role writes bypass RLS.

const SOCRATA_BASE    = 'https://data.transportation.gov/resource';
const INSUR_ACTIVE_DS = 'c5y8-a4uz';
const OOS_DS          = 'p2mt-9ige';   // OOS orders
const REVOKE_DS       = 'sa6p-acbp';   // SAFER-era revocation history
const MOTUS_DS        = 'wb4f-neki';   // Motus-era revoke/suspend history

function toYmd(date = new Date()) {
  return date.getFullYear().toString() +
    (date.getMonth() + 1).toString().padStart(2, '0') +
    date.getDate().toString().padStart(2, '0');
}

function ymdToIso(ymd) {
  if (!ymd || String(ymd).length < 8) return null;
  const s = String(ymd);
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

// (count check is inlined inside refreshInsuranceCancellations — no separate helper needed)

async function fetchAllSocrata(dataset, whereClause, tag) {
  const limit   = 5000;
  const results = [];
  let   offset  = 0;
  let   pageNum = 0;
  while (true) {
    const url = `${SOCRATA_BASE}/${dataset}.json?$where=${encodeURIComponent(whereClause)}&$limit=${limit}&$offset=${offset}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`Socrata HTTP ${res.status} for ${dataset}`);
    const page = await res.json();
    pageNum++;
    results.push(...page);
    console.log(`[${tag}] Page ${pageNum}: ${page.length} rows fetched (running total: ${results.length})`);
    if (page.length < limit) break;
    offset += limit;
  }
  return results;
}

// Races a load function against a hard time limit.  On timeout, logs "Load failed"
// so the load never goes silent even if a Supabase call hangs indefinitely.
export async function withLoadTimeout(tag, fn, timeoutMs = 10 * 60 * 1000) {
  const timer = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`timed out after ${timeoutMs / 60000}min`)), timeoutMs)
  );
  try {
    await Promise.race([fn(), timer]);
  } catch (e) {
    console.error(`[${tag}] Load failed: ${e.message}`);
  }
}

// Deletes stale rows in batches via the delete_stale_batch() Postgres function so each
// DELETE is a small, index-backed statement that fits within Supabase's statement timeout.
// Returns true if sweep completed without error.
async function batchedSweep(supabase, tag, table, cutoff) {
  let total = 0;
  while (true) {
    const { data, error } = await supabase.rpc('delete_stale_batch', {
      p_table: table, p_cutoff: cutoff, p_batch_size: 500,
    });
    if (error) {
      console.error(`[${tag}] Sweep error: ${error.message}`);
      return false;
    }
    total += data ?? 0;
    if ((data ?? 0) < 500) break;
  }
  if (total > 0) console.log(`[${tag}] Sweep removed ${total} stale rows`);
  return true;
}

export async function refreshInsuranceCancellations(supabase) {
  console.log('[INSUR] Starting BIPD cancellation refresh…');
  const todayYmd     = toYmd();
  // Fetch ALL BMC-35 rows (past + future) so we can flag lapsed carriers too.
  const bmc35Where   = `ins_form_code='BMC-35' AND ins_type_code='1'`;
  const jobStartedAt = new Date().toISOString();

  try {
    // Count expected rows BEFORE fetching so we can detect any truncation.
    const countUrl = `${SOCRATA_BASE}/${INSUR_ACTIVE_DS}.json?$select=count(*)&$where=${encodeURIComponent(bmc35Where)}`;
    const countRes = await fetch(countUrl, { signal: AbortSignal.timeout(30_000) });
    if (!countRes.ok) throw new Error(`Socrata count HTTP ${countRes.status}`);
    const countData     = await countRes.json();
    const expectedBmc35 = parseInt(countData[0]?.count ?? '0', 10);
    console.log(`[INSUR] Expected BMC-35 total: ${expectedBmc35}`);
    if (expectedBmc35 === 0) throw new Error('count query returned 0 rows — $where filter may be broken');

    // Fetch all active BIPD records (BMC-35 and BMC-91/91X) in parallel
    const [bmc35, activePolicies] = await Promise.all([
      fetchAllSocrata(INSUR_ACTIVE_DS, bmc35Where, 'INSUR-BMC35'),
      fetchAllSocrata(INSUR_ACTIVE_DS,
        `ins_form_code IN('BMC-91','BMC-91X') AND ins_type_code='1'`, 'INSUR-ACTIVE'),
    ]);

    // Count check: if we got fewer rows than the count query reported, the fetch was
    // truncated (network error, API hiccup, undocumented limit). Clear the table so
    // every carrier shows "Not reviewed (no data)" until the next successful run.
    // Never silently serve stale or partial data as a definitive answer.
    if (bmc35.length < expectedBmc35) {
      console.error(
        `[INSUR] INCOMPLETE: fetched ${bmc35.length} of ${expectedBmc35} BMC-35 rows — ` +
        `clearing table; carriers will show "Not reviewed" until next successful run`
      );
      await supabase.from('insurance_cancellations').delete().gte('last_verified_at', '1970-01-01T00:00:00Z');
      return;
    }

    console.log(`[INSUR] BMC-35: ${bmc35.length} (confirmed ${expectedBmc35}), active policies: ${activePolicies.length}`);
    const pendingCount = bmc35.filter(r => String(r.effective_date ?? '').slice(0, 8) >= todayYmd).length;
    console.log(`[INSUR]   → ${pendingCount} pending (future), ${bmc35.length - pendingCount} past-effective`);

    // Build superseding lookup: docket_number → max effective_date of BMC-91/91X
    const activeMaxByDocket = new Map();
    for (const pol of activePolicies) {
      const docket = pol.docket_number;
      if (!docket) continue;
      const effYmd = String(pol.effective_date ?? '0').slice(0, 8);
      const prev   = activeMaxByDocket.get(docket) ?? '0';
      if (effYmd > prev) activeMaxByDocket.set(docket, effYmd);
    }

    // Filter superseded records; group by DOT keeping soonest effective_date
    const byDot = new Map();  // dot_number → row object
    let supersededCount = 0;

    for (const rec of bmc35) {
      const dot    = rec.usdot_number ? String(rec.usdot_number).trim() : null;
      const docket = rec.docket_number;
      const effYmd = String(rec.effective_date ?? '').slice(0, 8);
      if (!dot || !effYmd) continue;

      // Superseding check: does this carrier have a BMC-91/91X with
      // effective_date >= this BMC-35's effective_date?
      const latestActive = activeMaxByDocket.get(docket) ?? '0';
      if (latestActive >= effYmd) {
        supersededCount++;
        console.log(`[INSUR] DOT ${dot} BMC-35 ${effYmd} superseded by BMC-91X ${latestActive}`);
        continue;
      }

      // Classify: pending = cancellation not yet effective; lapsed = already effective, no replacement.
      const status = effYmd >= todayYmd ? 'pending' : 'lapsed';

      // Keep soonest effective_date per DOT (soonest = most urgent).
      // Pending rows take priority over lapsed rows for the same DOT:
      // if they coexist it means a replacement was filed then cancelled again,
      // so the pending cancellation is the actionable item.
      const existing = byDot.get(dot);
      const replaces = !existing ||
        (status === 'pending' && existing.status === 'lapsed') ||
        (status === existing.status && effYmd < existing._effYmd);
      if (replaces) {
        byDot.set(dot, {
          _effYmd:           effYmd,  // internal sort key, removed before upsert
          dot_number:        dot,
          docket_number:     docket,
          effective_date:    ymdToIso(effYmd),
          trans_date:        ymdToIso(String(rec.trans_date ?? '').slice(0, 8)),
          insurance_company: rec.insurance_company_name ?? null,
          max_cov_amount:    rec.max_cov_amount != null ? parseFloat(rec.max_cov_amount) : null,
          policy_no:         rec.policy_no ?? null,
          status,
          last_verified_at:  new Date().toISOString(),
        });
      }
    }

    const lapsedDots  = [...byDot.values()].filter(r => r.status === 'lapsed').length;
    const pendingDots = byDot.size - lapsedDots;
    console.log(`[INSUR] ${byDot.size} unique DOTs to store: ${pendingDots} pending, ${lapsedDots} lapsed (${supersededCount} superseded)`);

    // Upsert survivors (strip internal _effYmd key)
    if (byDot.size > 0) {
      const rows = [...byDot.values()].map(({ _effYmd, ...r }) => r);
      for (let i = 0; i < rows.length; i += 200) {
        const { error } = await supabase
          .from('insurance_cancellations')
          .upsert(rows.slice(i, i + 200), { onConflict: 'dot_number' });
        if (error) console.error('[INSUR] Upsert error:', error.message);
      }
    }

    // Mark-and-sweep: delete rows that weren't touched this run.
    // Those are carriers whose BMC-35 was superseded by a new policy — they're now clean.
    await batchedSweep(supabase, 'INSUR', 'insurance_cancellations', jobStartedAt);

    console.log('[INSUR] Refresh complete');
  } catch (e) {
    console.error('[INSUR] Refresh failed:', e.message);
  }
}

// ── OOS / revocation / suspension daily mirrors ───────────────────────────────
// Loads enforcement datasets into Supabase so chameleon.js can query them without
// issuing per-vetting Socrata calls. Same mark-and-sweep pattern as insurance_cancellations.

function fourYearsAgoIso() {
  const d = new Date();
  d.setFullYear(d.getFullYear() - 4);
  return d.toISOString().slice(0, 10);
}

export async function refreshOosOrders(supabase) {
  console.log('[OOS] Starting OOS orders refresh…');
  const jobStartedAt = new Date().toISOString();
  // Load all active (unrescinded) orders plus any order in the last 4 years (covers the
  // longest reasonable chameleonLookbackDays setting + one year buffer).
  const cutoff  = fourYearsAgoIso();
  const where   = `rescind_date IS NULL OR oos_date >= '${cutoff}'`;

  try {
    const countUrl = `${SOCRATA_BASE}/${OOS_DS}.json?$select=count(*)&$where=${encodeURIComponent(where)}`;
    const countRes = await fetch(countUrl, { signal: AbortSignal.timeout(30_000) });
    if (!countRes.ok) throw new Error(`Socrata count HTTP ${countRes.status}`);
    const countData = await countRes.json();
    const expected  = parseInt(countData[0]?.count ?? '0', 10);
    console.log(`[OOS] Expected rows: ${expected}`);
    if (expected === 0) throw new Error('count query returned 0 rows — $where filter may be broken');

    const rows = await fetchAllSocrata(OOS_DS, where, 'OOS');

    if (rows.length < expected) {
      console.error(`[OOS] INCOMPLETE: fetched ${rows.length} of ${expected} — aborting, table unchanged`);
      return;
    }

    // Deduplicate on conflict key before upserting — Socrata sometimes returns
    // the same (dot_number, oos_date, oos_reason) in one batch, which causes
    // "ON CONFLICT DO UPDATE command cannot affect row a second time".
    const seen = new Map();
    for (const r of rows) {
      if (!r.dot_number || !r.oos_date) continue;
      const key = `${String(r.dot_number).trim()}|${r.oos_date.slice(0, 10)}|${r.oos_reason ?? ''}`;
      seen.set(key, {
        dot_number:       String(r.dot_number).trim(),
        oos_reason:       r.oos_reason ?? '',
        oos_date:         r.oos_date.slice(0, 10),
        rescind_date:     r.rescind_date?.slice(0, 10) ?? null,
        last_verified_at: jobStartedAt,
      });
    }
    const dbRows = [...seen.values()];
    console.log(`[OOS] ${rows.length} raw → ${dbRows.length} after dedup`);

    let upsertError = false;
    for (let i = 0; i < dbRows.length; i += 200) {
      const { error } = await supabase
        .from('oos_orders')
        .upsert(dbRows.slice(i, i + 200), { onConflict: 'dot_number,oos_date,oos_reason' });
      if (error) {
        console.error(`[OOS] Upsert error at offset ${i}: ${error.message}`);
        upsertError = true;
        break;
      }
    }

    if (upsertError) {
      console.error('[OOS] Load failed — skipping sweep, last_verified_at NOT updated');
      return;
    }

    await batchedSweep(supabase, 'OOS', 'oos_orders', jobStartedAt);

    console.log(`[OOS] Refresh complete — ${dbRows.length} rows`);
  } catch (e) {
    console.error('[OOS] Refresh failed:', e.message);
  }
}

export async function refreshSaferRevocations(supabase) {
  console.log('[REVOKE] Starting SAFER revocations refresh…');
  const jobStartedAt = new Date().toISOString();
  // Involuntary only + last 4 years — filters out the ~1.3M historical voluntary rows
  // that caused OOM on the free Render instance.
  // ALL columns in sa6p-acbp are plain text; order2_effective_date is stored as MM/DD/YYYY.
  // date_extract_y() silently returns 0 on text columns.  ISO >= comparisons also fail
  // because '12/...' < '20...' as strings.  Match the year as the last 4 chars instead.
  // Include IS NULL rows (order issued, effective date not yet set).
  const currentYear = new Date().getFullYear();
  const cutoffYear  = currentYear - 4;
  const yearFilters = [];
  for (let y = cutoffYear; y <= currentYear; y++) yearFilters.push(`order2_effective_date LIKE '%/${y}'`);
  const where = `upper(order2_type_desc) LIKE '%INVOLUNTARY%' AND (order2_effective_date IS NULL OR ${yearFilters.join(' OR ')})`;

  try {
    const countUrl = `${SOCRATA_BASE}/${REVOKE_DS}.json?$select=count(*)&$where=${encodeURIComponent(where)}`;
    const countRes = await fetch(countUrl, { signal: AbortSignal.timeout(30_000) });
    if (!countRes.ok) throw new Error(`Socrata count HTTP ${countRes.status}`);
    const countData = await countRes.json();
    const expected  = parseInt(countData[0]?.count ?? '0', 10);
    console.log(`[REVOKE] Expected rows: ${expected}`);
    if (expected === 0) throw new Error('count query returned 0 rows — $where filter may be broken');

    // Stream page-by-page: upsert each page immediately instead of holding all rows in memory.
    // seenKeys is intentionally scoped per-page; cross-page duplicates are handled by
    // ON CONFLICT DO UPDATE so last_verified_at stays current and the sweep won't delete them.
    const limit       = 5000;
    let   offset      = 0;
    let   fetched     = 0;
    let   upsertError = false;

    while (true) {
      const url = `${SOCRATA_BASE}/${REVOKE_DS}.json?$where=${encodeURIComponent(where)}&$limit=${limit}&$offset=${offset}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`Socrata HTTP ${res.status} for ${REVOKE_DS}`);
      const page = await res.json();
      if (page.length === 0) break;
      fetched += page.length;

      // Fresh Set each page — freed by GC before the next page loads.
      const pageKeys = new Set();
      const dbPage   = [];
      for (const r of page) {
        if (!r.dot_number || !r.order2_effective_date) continue;
        const key = `${String(r.dot_number).trim()}|${r.order2_effective_date.slice(0, 10)}|${r.order2_type_desc ?? ''}`;
        if (pageKeys.has(key)) continue;
        pageKeys.add(key);
        dbPage.push({
          dot_number:       String(r.dot_number).trim(),
          order_type_desc:  r.order2_type_desc ?? '',
          effective_date:   r.order2_effective_date.slice(0, 10),
          last_verified_at: jobStartedAt,
        });
      }

      const pageNum = Math.floor(offset / limit) + 1;
      console.log(`[REVOKE] Page ${pageNum}: ${page.length} rows fetched, ${dbPage.length} unique (running total: ${fetched})`);
      if (pageNum % 10 === 0) {
        const m = process.memoryUsage();
        console.log(`[REVOKE] Memory at page ${pageNum} — RSS: ${Math.round(m.rss / 1048576)} MB, heap: ${Math.round(m.heapUsed / 1048576)}/${Math.round(m.heapTotal / 1048576)} MB`);
      }

      if (dbPage.length > 0) {
        const { error } = await supabase
          .from('safer_revocations')
          .upsert(dbPage, { onConflict: 'dot_number,effective_date,order_type_desc' });
        if (error) {
          console.error(`[REVOKE] Upsert error at offset ${offset}: ${error.message}`);
          upsertError = true;
          break;
        }
        console.log(`[REVOKE] Page ${pageNum}: saved ${dbPage.length} rows`);
      }

      if (page.length < limit) break;
      offset += limit;
    }

    if (upsertError) {
      console.error('[REVOKE] Load failed — skipping sweep, last_verified_at NOT updated');
      return;
    }

    if (fetched < expected) {
      console.error(`[REVOKE] INCOMPLETE: fetched ${fetched} of ${expected} — aborting, table unchanged`);
      return;
    }

    await batchedSweep(supabase, 'REVOKE', 'safer_revocations', jobStartedAt);

    console.log(`[REVOKE] Refresh complete — ${fetched} rows`);
  } catch (e) {
    console.error('[REVOKE] Refresh failed:', e.message);
  }
}

export async function refreshMotusSuspensions(supabase) {
  console.log('[MOTUS] Starting Motus suspensions refresh…');
  const jobStartedAt = new Date().toISOString();
  const where        = `upper(order1_type_desc) LIKE '%INVOLUNTARY%'`;

  try {
    const countUrl = `${SOCRATA_BASE}/${MOTUS_DS}.json?$select=count(*)&$where=${encodeURIComponent(where)}`;
    const countRes = await fetch(countUrl, { signal: AbortSignal.timeout(30_000) });
    if (!countRes.ok) throw new Error(`Socrata count HTTP ${countRes.status}`);
    const countData = await countRes.json();
    const expected  = parseInt(countData[0]?.count ?? '0', 10);
    console.log(`[MOTUS] Expected rows: ${expected}`);
    if (expected === 0) throw new Error('count query returned 0 rows — $where filter may be broken');

    const rows = await fetchAllSocrata(MOTUS_DS, where, 'MOTUS');

    if (rows.length < expected) {
      console.error(`[MOTUS] INCOMPLETE: fetched ${rows.length} of ${expected} — aborting, table unchanged`);
      return;
    }

    // Deduplicate on conflict key before upserting — same "cannot affect row a second time" risk.
    const seen = new Map();
    for (const r of rows) {
      if (!r.usdot_number || !r.order1_effective_date) continue;
      const key = `${String(r.usdot_number).trim()}|${r.order1_effective_date.slice(0, 10)}|${r.order1_type_desc ?? ''}`;
      seen.set(key, {
        dot_number:       String(r.usdot_number).trim(),
        order_type_desc:  r.order1_type_desc ?? '',
        effective_date:   r.order1_effective_date.slice(0, 10),
        last_verified_at: jobStartedAt,
      });
    }
    const dbRows = [...seen.values()];
    console.log(`[MOTUS] ${rows.length} raw → ${dbRows.length} after dedup`);

    let upsertError = false;
    for (let i = 0; i < dbRows.length; i += 200) {
      const { error } = await supabase
        .from('motus_suspensions')
        .upsert(dbRows.slice(i, i + 200), { onConflict: 'dot_number,effective_date,order_type_desc' });
      if (error) {
        console.error(`[MOTUS] Upsert error at offset ${i}: ${error.message}`);
        upsertError = true;
        break;
      }
    }

    if (upsertError) {
      console.error('[MOTUS] Load failed — skipping sweep, last_verified_at NOT updated');
      return;
    }

    await batchedSweep(supabase, 'MOTUS', 'motus_suspensions', jobStartedAt);

    console.log(`[MOTUS] Refresh complete — ${dbRows.length} rows`);
  } catch (e) {
    console.error('[MOTUS] Refresh failed:', e.message);
  }
}

export function startMonitoringJob(supabase) {
  const intervalHours = parseFloat(process.env.MONITOR_INTERVAL_HOURS || '4');
  const intervalMs    = intervalHours * 60 * 60 * 1000;

  console.log(`[MONITOR] Carrier monitoring started — interval: ${intervalHours}h (per-tenant FMCSA keys)`);
  // Daily enforcement-table loads (INSUR/OOS/REVOKE/MOTUS) are handled by the
  // separate Render cron job (backend/scripts/daily-loads.js) so an OOM during a
  // load can never kill this web process.

  // First run 60s after startup to let connections settle.
  setTimeout(() => {
    runMonitoringCheck(supabase);
    runWatchedCarriersCheck(supabase);
  }, 60_000);
  setInterval(() => {
    runMonitoringCheck(supabase);
    runWatchedCarriersCheck(supabase);
  }, intervalMs);
}
