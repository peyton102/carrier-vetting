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

const router  = express.Router();
const SW_BASE = 'https://www.saferwatch.com/webservices/CarrierService32.php';

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

// Strip currency formatting → plain number string
function parseMoney(raw) {
  if (raw == null || raw === '') return '';
  const n = parseFloat(String(raw).replace(/[$,\s]/g, ''));
  return isNaN(n) ? '' : String(n);
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

// ── Route ─────────────────────────────────────────────────────────────────────

router.get('/:dot', async (req, res, next) => {
  try {
    const serviceKey  = process.env.SAFERWATCH_SERVICE_KEY;
    const customerKey = process.env.SAFERWATCH_CUSTOMER_KEY;

    if (!serviceKey || !customerKey) {
      return res.status(503).json({
        ok: false,
        error: 'SAFERWATCH_SERVICE_KEY / SAFERWATCH_CUSTOMER_KEY not configured — add to .env and restart',
      });
    }

    // ?type=mc when the caller is looking up by MC number
    const lookupType = req.query.type === 'mc' ? 'mc' : 'dot';
    const identifier = req.params.dot.replace(/\D/g, '');
    if (!identifier) return res.status(400).json({ ok: false, error: 'Invalid DOT/MC number' });

    // ── Fetch ──────────────────────────────────────────────────────────────
    const url   = swLookupUrl(identifier, lookupType, serviceKey, customerKey);
    const swRes = await fetch(url, { signal: AbortSignal.timeout(12_000) });
    if (!swRes.ok) throw new Error(`SaferWatch HTTP ${swRes.status}`);

    const xmlText = await swRes.text();
    // Log first 1000 chars for debugging — remove once confirmed working
    console.log('[SW RAW XML]', xmlText.slice(0, 1000));

    // ── Parse XML ──────────────────────────────────────────────────────────
    const parser = new XMLParser({
      ignoreAttributes:    false,
      attributeNamePrefix: '@_',
      // Force array for nodes that may repeat in the response
      isArray: (name) => ['Certificate', 'Coverage'].includes(name),
    });
    const parsed = parser.parse(xmlText);

    // ── Validate wrapper ───────────────────────────────────────────────────
    // Actual root element is <CarrierService32.CarrierLookup>; ResponseDO
    // and CarrierDetails are siblings inside it (not nested in ResponseDO).
    const root = parsed['CarrierService32.CarrierLookup'];
    if (!root) {
      throw new Error('Unexpected SaferWatch XML — root element is not CarrierService32.CarrierLookup');
    }

    const wrapper = root.ResponseDO || {};
    const status  = str(wrapper.status);
    const action  = str(wrapper.action);
    const code    = str(wrapper.code);
    const dispMsg = str(wrapper.displayMsg);
    const techMsg = str(wrapper.techMsg);

    if (status !== 'APPROVED' || action !== 'OK') {
      console.warn('[SW] Non-OK response:', { status, action, code, dispMsg, techMsg });
      return res.json({
        ok: false,
        status, action, code,
        error: dispMsg || techMsg || `SaferWatch: status=${status} action=${action}`,
      });
    }

    const details = root.CarrierDetails;
    if (!details) {
      return res.json({ ok: false, error: 'SaferWatch: no CarrierDetails in response' });
    }

    // ── Extract sections ───────────────────────────────────────────────────
    const identity   = details.Identity       || {};
    const authority  = details.Authority      || {};
    const safety     = details.Safety         || {};
    const inspection = details.Inspection     || {};
    const operation  = details.Operation      || {};
    const equipment  = details.Equipment      || {};
    const insurance  = details.FMCSAInsurance || {};
    const certData   = details.CertData       || null;
    const riskAssess = details.RiskAssessment || {};

    const cargo      = extractCargo(certData);
    const certStatus = str(certData?.['@_status'] || certData?.status || '');

    // ── Normalise into vetting form field names ────────────────────────────
    const swFields = {
      // Identity
      carrierName: str(identity.legalName),

      // Authority
      authorityStatus:    normalizeAuthority(
        str(authority.commonAuthority),
        str(authority.contractAuthority),
        str(authority.commonAuthorityRevocation)
      ),
      authorityGrantDate: normalizeDate(str(authority.authGrantDate)),

      // Safety rating
      safetyRating: normalizeSafetyRating(str(safety.rating)),

      // BASIC percentile scores — the primary gap FMCSA cannot fill
      unsafeDrivingBasic:      str(safety.unsafeDrvPCT),
      hosBasic:                str(safety.hosPCT),
      vehicleMaintenanceBasic: str(safety.vehMaintPCT),

      // Insurance amounts — was entirely manual before
      autoLiability:  parseMoney(insurance.bipdOnFile),
      cargoInsurance: cargo.amount,

      // OOS rates (2 dp, matching FMCSA formatting)
      truckOosPct:  fmtOos(inspection.inspectVehOOSPctUS),
      driverOosPct: fmtOos(inspection.inspectDrvOOSPctUS),

      // Total inspections
      inspections24mo: str(inspection.inspectTotalUS),

      // Power units
      powerUnits: str(equipment.totalPower),

      // Active federal OOS — boolean
      activeFederalOOS: str(operation.outOfService).toLowerCase() === 'yes',
    };

    // Fields with actual values (non-empty string, or boolean true)
    const filledFields = Object.entries(swFields)
      .filter(([, v]) => v !== '' && v !== false && v != null)
      .map(([k]) => k);

    res.json({
      ok: true,
      ...swFields,
      filledFields,

      // Metadata for the banner — not written to form fields
      certStatus,
      cargoExpiration: cargo.expiration,
      bipdRequired:    parseMoney(insurance.bipdRequired),
      riskAssessment: {
        overall:   str(riskAssess.Overall),
        authority: str(riskAssess.Authority),
        insurance: str(riskAssess.Insurance),
        safety:    str(riskAssess.Safety),
      },
      // Alert flags (Yes = SW flagged as over threshold) — cross-check only
      alerts: {
        unsafeDriving:        str(safety.unsafeDrvAlert),
        hos:                  str(safety.hosAlert),
        vehicleMaintenance:   str(safety.vehMaintAlert),
        controlledSubstances: str(safety.controlSubAlert),
        driverFitness:        str(safety.drvFitAlert),
      },
      // Captured but not mapped to current form fields (future expansion)
      extraBasics: {
        controlledSubstancesPct: str(safety.controlSubPCT),
        driverFitnessPct:        str(safety.drvFitPCT),
      },
      // Raw sections for side-by-side debug comparison
      _raw: { identity, authority, safety, inspection, operation, equipment, insurance, certStatus },
    });

  } catch (e) {
    console.error('[SW ERROR]', e.message);
    next(e);
  }
});

export default router;
