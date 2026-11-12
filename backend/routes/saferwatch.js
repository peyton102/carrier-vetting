// ── SaferWatch CarrierLookup proxy ───────────────────────────────────────────
// GET /api/saferwatch/:dot
//
// Calls SaferWatch CarrierService32.php?Action=CarrierLookup, parses XML,
// and normalises the response into the same field names used by the vetting
// form — supplementing the FMCSA data with BASIC scores and insurance amounts
// that FMCSA cannot provide.
//
// Keys: SAFERWATCH_SERVICE_KEY and SAFERWATCH_CUSTOMER_KEY in root .env
// CRITICAL: server-side only — keys must never reach the frontend.

import express       from 'express';
import { XMLParser } from 'fast-xml-parser';
import { createClient } from '@supabase/supabase-js';
import { decrypt } from '../lib/encryption.js';

function getSupabase() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

// Resolve SaferWatch keys: prefer tenant's own stored credentials.
// Tenants in SAFERWATCH_SHARED_TENANTS (comma-separated env var) fall back to
// the shared operator keys from .env. All others get null — 503 returned to caller.
async function resolveSwKeys(tenantSlug) {
  const sharedTenants = (process.env.SAFERWATCH_SHARED_TENANTS || '')
    .split(',').map(s => s.trim()).filter(Boolean);

  try {
    const { data } = await getSupabase()
      .from('tenant_credentials')
      .select('sw_service_key, sw_customer_key')
      .eq('tenant_slug', tenantSlug)
      .maybeSingle();

    if (data?.sw_service_key && data?.sw_customer_key) {
      return {
        serviceKey:  decrypt(data.sw_service_key),
        customerKey: decrypt(data.sw_customer_key),
        source: 'tenant',
      };
    }
  } catch (_) { /* fall through */ }

  if (sharedTenants.includes(tenantSlug)) {
    return {
      serviceKey:  process.env.SAFERWATCH_SERVICE_KEY,
      customerKey: process.env.SAFERWATCH_CUSTOMER_KEY,
      source: 'shared',
    };
  }

  return { serviceKey: null, customerKey: null, source: 'none' };
}

const router  = express.Router();
const SW_BASE = 'https://www.saferwatch.com/webservices/CarrierService32.php';

function ms(start) { return `${Date.now() - start}ms`; }

// ── Helpers ───────────────────────────────────────────────────────────────────

// type: 'dot' (default) | 'mc'
function swLookupUrl(identifier, type, serviceKey, customerKey) {
  // SaferWatch: plain number = DOT, "MC" prefix = MC/docket number
  const number = type === 'mc' ? `MC${identifier}` : identifier;
  const p = new URLSearchParams({
    Action:      'CarrierLookup',
    ServiceKey:  serviceKey,
    CustomerKey: customerKey,
    number,
  });
  return `${SW_BASE}?${p}`;
}

// Normalize SW authority strings → vetting form values.
// Must check BOTH common and contract authority — a carrier can be legally
// authorized under contract authority even when common authority is None/Inactive.
function normalizeAuthority(commonAuth, contractAuth, revocation) {
  if ((revocation || '').toLowerCase() === 'yes') return 'Revocation Pending';
  const c = (commonAuth   || '').toLowerCase().trim();
  const k = (contractAuth || '').toLowerCase().trim();
  if (c === 'active')   return 'Active-Common';
  if (k === 'active')   return 'Active-Contract';
  // Only mark Inactive when we have a definitive inactive/none on both sides.
  // If both are blank (SW didn't return authority data), return '' so FMCSA value is preserved.
  if ((c === 'inactive' || c === 'none') && (k === 'inactive' || k === 'none' || k === '')) return 'Inactive';
  if ((k === 'inactive' || k === 'none') && (c === 'inactive' || c === 'none' || c === '')) return 'Inactive';
  if (c === '' && k === '') return '';  // unknown — don't overwrite FMCSA value
  return '';
}

// Normalize SW safety rating strings → vetting form values
function normalizeSafetyRating(raw) {
  const r = (raw || '').toLowerCase().trim();
  if (r === 'satisfactory')   return 'Satisfactory';
  if (r === 'conditional')    return 'Conditional';
  if (r === 'unsatisfactory') return 'Unsatisfactory';
  return 'None/Unrated';  // "Not Rated", blank, or unknown
}

// Normalize date strings → YYYY-MM-DD for <input type="date">
function normalizeDate(raw) {
  if (!raw) return '';
  const s = String(raw).trim();
  // MM/DD/YYYY
  const mdy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (mdy) return `${mdy[3]}-${mdy[1].padStart(2, '0')}-${mdy[2].padStart(2, '0')}`;
  // Already YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  // Fallback: Date.parse
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return '';
}

// Strip currency formatting → plain number string.
// Round to nearest $1,000 — insurance policies are always issued in whole-thousand amounts;
// this prevents floating-point cents from SaferWatch causing near-miss threshold failures
// (e.g. SaferWatch returning $749,995 when the policy is $750,000).
function parseMoney(raw) {
  if (raw == null || raw === '') return '';
  const n = parseFloat(String(raw).replace(/[$,\s]/g, ''));
  if (isNaN(n)) return '';
  return String(Math.round(n / 1000) * 1000);
}

// Round OOS rate to 2 dp → string (matches FMCSA rounding)
function fmtOos(raw) {
  if (raw == null || raw === '') return '';
  const n = parseFloat(raw);
  return isNaN(n) ? '' : n.toFixed(2);
}

function str(v) { return v != null ? String(v) : ''; }

// Extract cargo coverage from parsed CertData node.
// CertData > Certificate[] > Coverage[] where type contains "Cargo"
function extractCargo(certData) {
  const empty = { amount: '', expiration: '' };
  if (!certData) return empty;
  const certs = certData.Certificate;
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

// Extract auto liability (BIPD) expiration from CertData
function extractAutoLiabilityExpiration(certData) {
  if (!certData) return '';
  const certs = certData.Certificate;
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

// Detect pending insurance cancellation from CertData Coverage.cancellationDate.
// A cancellationDate that is in the future means a BMC cancellation notice is on file.
// Returns { pending: boolean, cancellationDate: string|null }
function extractPendingCancellation(certData) {
  if (!certData) return { pending: false, cancellationDate: null };
  const certs = certData.Certificate;
  if (!certs) return { pending: false, cancellationDate: null };
  const certList = Array.isArray(certs) ? certs : [certs];
  const today = new Date();
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

// ── Exported core lookup function (used by /api/lookup combined endpoint) ────
// identifier: DOT number string (or MC number when lookupType='mc')
// Returns the full SW payload (same shape as res.json() below), or throws.
export async function swLookup(identifier, lookupType, tenantSlug) {
  const tTotal = Date.now();
  const tKeys  = Date.now();
  const { serviceKey, customerKey } = await resolveSwKeys(tenantSlug);
  console.log(`[TIMING][SW] Supabase tenant_credentials read: ${ms(tKeys)}`);

  if (!serviceKey || !customerKey) {
    return { ok: false, error: 'SaferWatch API key not configured — add your SaferWatch key in Settings' };
  }

  const url    = swLookupUrl(identifier, lookupType ?? 'dot', serviceKey, customerKey);
  const tFetch = Date.now();
  const swRes  = await fetch(url, { signal: AbortSignal.timeout(12_000) });
  console.log(`[TIMING][SW] SaferWatch HTTP (${identifier}): ${ms(tFetch)}`);
  if (!swRes.ok) throw new Error(`SaferWatch HTTP ${swRes.status}`);

  const xmlText = await swRes.text();
  const parser  = new XMLParser({
    ignoreAttributes:    false,
    attributeNamePrefix: '@_',
    isArray: (name) => ['Certificate', 'Coverage'].includes(name),
  });
  const parsed = parser.parse(xmlText);
  const root   = parsed['CarrierService32.CarrierLookup'];
  if (!root) throw new Error('Unexpected SaferWatch XML — root element is not CarrierService32.CarrierLookup');

  const wrapper  = root.ResponseDO || {};
  const status   = str(wrapper.status);
  const action   = str(wrapper.action);
  const code     = str(wrapper.code);
  const dispMsg  = str(wrapper.displayMsg);
  const techMsg  = str(wrapper.techMsg);
  const swInspectionsDate = str(wrapper.retrievalDate || wrapper.dataDate || wrapper.asOfDate || '') || null;

  if (status !== 'APPROVED' || action !== 'OK') {
    console.warn('[SW] Non-OK response:', { status, action, code, dispMsg, techMsg });
    return { ok: false, status, action, code, error: dispMsg || techMsg || `SaferWatch: status=${status} action=${action}` };
  }

  const details = root.CarrierDetails;
  if (!details) return { ok: false, error: 'SaferWatch: no CarrierDetails in response' };

  const identity   = details.Identity       || {};
  const authority  = details.Authority      || {};
  const safety     = details.Safety         || {};
  const inspection = details.Inspection     || {};
  const operation  = details.Operation      || {};
  const equipment  = details.Equipment      || {};
  const insurance  = details.FMCSAInsurance || {};
  const certData   = details.CertData       || null;
  const riskAssess = details.RiskAssessment || {};

  const cargo               = extractCargo(certData);
  const certStatus          = str(certData?.['@_status'] || certData?.status || '');
  const pendingCancellation = extractPendingCancellation(certData);
  const insuranceDataAsOf   = new Date().toISOString();

  const csAlert   = str(safety.controlSubAlert).trim().toLowerCase();
  const csPct     = parseFloat(str(safety.controlSubPCT));
  const drvInspUS = parseInt(str(inspection.inspectDrvUS || ''), 10);
  const vehInspUS = parseInt(str(inspection.inspectVehUS || ''), 10);
  const hasInsp   = !isNaN(drvInspUS) && drvInspUS > 0;
  const drvSufficientBasic = !isNaN(drvInspUS) && drvInspUS >= 3;
  const drvSufficientFit   = !isNaN(drvInspUS) && drvInspUS >= 5;
  const vehSufficient      = !isNaN(vehInspUS) && vehInspUS >= 5;
  const checkedDate = new Date().toISOString().slice(0, 10);

  let drugAlcoholViolation = null;
  let drugAlcoholSource    = null;
  if (csAlert === 'yes') {
    drugAlcoholViolation = true;
    drugAlcoholSource    = `Auto-filled from SaferWatch — violation detected` +
      ` (Controlled Substances BASIC alert: Yes` + (hasInsp ? `, ${drvInspUS} driver insp.` : '') + `)`;
  } else if (!isNaN(csPct) && csPct > 0 && hasInsp) {
    drugAlcoholViolation = true;
    drugAlcoholSource    = `Auto-filled from FMCSA records via SaferWatch — violation found` +
      ` (controlSubPCT: ${csPct}, ${drvInspUS} driver insp., below alert threshold)`;
  } else if (!isNaN(csPct) && csPct === 0 && hasInsp) {
    drugAlcoholViolation = false;
    drugAlcoholSource    = `Auto-filled from FMCSA records via SaferWatch — 0 violations found` +
      ` (controlSubPCT: 0, ${drvInspUS} driver insp.), checked ${checkedDate}`;
  } else if (!isNaN(drvInspUS) && drvInspUS === 0) {
    drugAlcoholViolation = null;
    drugAlcoholSource    = `SaferWatch: no driver inspections on record — answer required`;
  }

  const swFields = {
    carrierName: str(identity.legalName),
    authorityStatus:    normalizeAuthority(str(authority.commonAuthority), str(authority.contractAuthority), str(authority.commonAuthorityRevocation)),
    authorityGrantDate: normalizeDate(str(authority.authGrantDate)),
    safetyRating: normalizeSafetyRating(str(safety.rating)),
    unsafeDrivingBasic:      drvSufficientBasic ? str(safety.unsafeDrvPCT) : '',
    hosBasic:                drvSufficientBasic ? str(safety.hosPCT)       : '',
    vehicleMaintenanceBasic: vehSufficient      ? str(safety.vehMaintPCT)  : '',
    autoLiability:  parseMoney(insurance.bipdOnFile),
    cargoInsurance: cargo.amount,
    truckOosPct:  fmtOos(inspection.inspectVehOOSPctUS),
    driverOosPct: fmtOos(inspection.inspectDrvOOSPctUS),
    inspections24mo: str(inspection.inspectTotalUS),
    powerUnits: str(equipment.totalPower),
    activeFederalOOS: str(operation.outOfService).toLowerCase() === 'yes',
    autoLiabilityExpiration: extractAutoLiabilityExpiration(certData),
    cargoExpiration:         cargo.expiration,
    insuranceDataAsOf,
  };

  const filledFields = Object.entries(swFields)
    .filter(([, v]) => v !== '' && v !== false && v != null)
    .map(([k]) => k);

  console.log(`[TIMING][SW] swLookup total (${identifier}): ${ms(tTotal)}`);
  return {
    ok: true,
    ...swFields,
    filledFields,
    drugAlcoholViolation,
    drugAlcoholSource,
    certStatus,
    bipdRequired: parseMoney(insurance.bipdRequired),
    riskAssessment: { overall: str(riskAssess.Overall), authority: str(riskAssess.Authority), insurance: str(riskAssess.Insurance), safety: str(riskAssess.Safety) },
    alerts: { unsafeDriving: str(safety.unsafeDrvAlert), hos: str(safety.hosAlert), vehicleMaintenance: str(safety.vehMaintAlert), controlledSubstances: str(safety.controlSubAlert), driverFitness: str(safety.drvFitAlert) },
    swInspectionsDate,
    inspectVehUS:  isNaN(vehInspUS) ? null : vehInspUS,
    inspectDrvUS:  isNaN(drvInspUS) ? null : drvInspUS,
    basicDataSufficiency: { unsafeDriving: isNaN(drvInspUS) ? null : (drvSufficientBasic ? 'ok' : 'insufficient'), hos: isNaN(drvInspUS) ? null : (drvSufficientBasic ? 'ok' : 'insufficient'), vehicleMaintenance: isNaN(vehInspUS) ? null : (vehSufficient ? 'ok' : 'insufficient'), driverFitness: isNaN(drvInspUS) ? null : (drvSufficientFit ? 'ok' : 'insufficient'), crashIndicator: null, vehicleDriverObserved: null, hazmat: null },
    extraBasics: { controlledSubstancesPct: str(safety.controlSubPCT), driverFitnessPct: drvSufficientFit ? str(safety.drvFitPCT) : '' },
    rawBasics: { unsafeDrivingPct: str(safety.unsafeDrvPCT), hosPct: str(safety.hosPCT), vehicleMaintenancePct: str(safety.vehMaintPCT), driverFitnessPct: str(safety.drvFitPCT) },
    _raw: { identity, authority, safety, inspection, operation, equipment, insurance, certStatus },
  };
}

// ── Route ─────────────────────────────────────────────────────────────────────

router.get('/:dot', async (req, res, next) => {
  try {
    const lookupType = req.query.type === 'mc' ? 'mc' : 'dot';
    const identifier = req.params.dot.replace(/\D/g, '');
    if (!identifier) return res.status(400).json({ ok: false, error: 'Invalid DOT/MC number' });
    const result = await swLookup(identifier, lookupType, req.auth.tenant);
    res.json(result);
  } catch (e) {
    console.error('[SW ERROR]', e.message);
    next(e);
  }
});

export default router;
