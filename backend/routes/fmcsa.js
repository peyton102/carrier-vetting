// ── FMCSA QCMobile API proxy ─────────────────────────────────────────────────
// GET /api/fmcsa/:dot
// Fetches carrier data from the FMCSA public API and normalizes it into the
// same field names used by the vetting form so the frontend can auto-fill.
//
// WebKey registration: https://mobile.fmcsa.dot.gov/qc/services/users/register
// Set FMCSA_WEBKEY in .env

import express from 'express';

const router = express.Router();
const BASE   = 'https://mobile.fmcsa.dot.gov/qc/services';

function fmcsaUrl(path, webKey) {
  return `${BASE}${path}?webKey=${encodeURIComponent(webKey)}`;
}

// allowedToOperate: Y=carrier is legally permitted to operate, N=not permitted (master flag)
// *AuthorityStatus codes: A=Active, I=Inactive/Revoked, R=Revocation Pending, N=None/Not Registered
function normalizeAuthorityStatus(c) {
  // DEBUG — remove after confirming fix
  console.log('[FMCSA AUTH DEBUG]', {
    allowedToOperate:        c.allowedToOperate,
    commonAuthorityStatus:   c.commonAuthorityStatus,
    contractAuthorityStatus: c.contractAuthorityStatus,
    allKeys: Object.keys(c).filter(k => /allow|auth|operat|status/i.test(k)),
  });

  // Master flag must be checked first — if N the carrier cannot legally operate regardless of
  // what the individual authority-type statuses show (e.g. commonAuthorityStatus may still read
  // "A" in the L&I record while the carrier is under an OOS order or pending revocation enforcement).
  if ((c.allowedToOperate || '').toUpperCase() === 'N') return 'Not Authorized';

  const common   = (c.commonAuthorityStatus   || '').toUpperCase();
  const contract = (c.contractAuthorityStatus || '').toUpperCase();

  // R = Revocation Pending: authority is at immediate risk but not yet terminated.
  // Must be checked before Active because a carrier can have both A and R on different dockets.
  if (common === 'R' || contract === 'R') return 'Revocation Pending';
  if (common   === 'A') return 'Active-Common';
  if (contract === 'A') return 'Active-Contract';
  if (common   === 'S' || contract === 'S') return 'Suspended';
  // I = Inactive (authority has been revoked/terminated); N = None (never registered)
  return 'Inactive';
}

function normalizeSafetyRating(raw) {
  if (!raw) return 'None/Unrated';
  const r     = raw.trim();
  const upper = r.toUpperCase();
  // FMCSA API returns single-letter codes (S / U / C / N) or full strings
  if (upper === 'S' || (/satisfactory/i.test(r) && !/un/i.test(r))) return 'Satisfactory';
  if (upper === 'U' || /unsatisfactory/i.test(r))                    return 'Unsatisfactory';
  if (upper === 'C' || /conditional/i.test(r))                       return 'Conditional';
  return 'None/Unrated';
}

// Resolve MC number from docket-numbers endpoint response
function extractMcNumber(docketJson) {
  console.log('[FMCSA DOCKET DEBUG]', JSON.stringify(docketJson)?.slice(0, 500));

  // Structure 1: content.item[] with prefix field
  const items = docketJson?.content?.item;
  if (Array.isArray(items)) {
    const mc = items.find(i => (i.prefix || '').toUpperCase() === 'MC');
    if (mc) {
      if (mc.docketNumber) return mc.docketNumber.replace(/^MC/i, '');
      if (mc.docketNumberId != null) return String(mc.docketNumberId);
    }
  }

  // Structure 2: content.docketNumber directly (e.g. "MC1605225")
  const direct = docketJson?.content?.docketNumber;
  if (direct) return String(direct).replace(/^MC/i, '');

  // Structure 3: content is an array (actual FMCSA response shape)
  const arr = docketJson?.content;
  if (Array.isArray(arr)) {
    const mc = arr.find(i => (i.prefix || '').toUpperCase() === 'MC');
    if (mc) {
      if (mc.docketNumber != null) return String(mc.docketNumber).replace(/^MC/i, '');
      if (mc.docketNumberId != null) return String(mc.docketNumberId);
    }
  }

  return '';
}

// Resolve earliest authority grant date from authority endpoint response
function extractGrantDate(authorityJson) {
  const items = authorityJson?.content?.item;
  if (!Array.isArray(items) || items.length === 0) return '';
  const dates = items
    .map(i => i.grantDate || i.statusDate || i.insertDate)
    .filter(Boolean)
    .map(d => new Date(d))
    .filter(d => !isNaN(d.getTime()))
    .sort((a, b) => a - b);
  if (!dates.length) return '';
  return dates[0].toISOString().slice(0, 10);   // YYYY-MM-DD
}

// ── Shared: normalize a carrier object (c) + ancillary data → vetting payload
function buildPayload(c, dot, docketJson, authorityGrantDate) {
  const truckInsp = c.vehicleInsp    ?? 0;
  const truckOos  = c.vehicleOosInsp ?? 0;

  const fmcsaFields = {
    carrierName:          c.legalName   || '',
    dotNumber:            String(c.dotNumber || dot),
    mcNumber:             extractMcNumber(docketJson),
    authorityStatus:      normalizeAuthorityStatus(c),
    authorityGrantDate,
    safetyRating:         normalizeSafetyRating(c.safetyRating),
    powerUnits:           c.totalPowerUnits != null ? String(c.totalPowerUnits) : '',
    inspections24mo:      String(truckInsp),
    truckOosPct:          c.vehicleOosRate != null ? parseFloat(c.vehicleOosRate).toFixed(2) : '',
    driverOosPct:         c.driverOosRate  != null ? parseFloat(c.driverOosRate).toFixed(2)  : '',
    nationalAvgTruckOos:  c.vehicleOosRateNationalAverage != null
                            ? String(c.vehicleOosRateNationalAverage) : '',
    nationalAvgDriverOos: c.driverOosRateNationalAverage != null
                            ? String(c.driverOosRateNationalAverage) : '',
  };

  const filledFields = Object.keys(fmcsaFields).filter(f => fmcsaFields[f] !== '');

  return {
    ...fmcsaFields,
    filledFields,
    manualFields: [
      'autoLiability', 'cargoInsurance', 'pendingInsuranceCancellation',
      'unsafeDrivingBasic', 'crashIndicatorBasic', 'hosBasic', 'vehicleMaintenanceBasic',
      'cleanInspections24mo',
      'carrierAssureGrade', 'fraudFlag', 'doubleBrokerFlag', 'chameleonFlag',
    ],
    _fmcsa: {
      legalName: c.legalName, dbaName: c.dbaName, statusCode: c.statusCode,
      allowedToOperate: c.allowedToOperate,
      commonAuthorityStatus: c.commonAuthorityStatus,
      contractAuthorityStatus: c.contractAuthorityStatus,
      brokerAuthorityStatus: c.brokerAuthorityStatus,
      safetyRating: c.safetyRating, safetyRatingDate: c.safetyRatingDate,
      powerUnits: c.powerUnits, totalDrivers: c.totalDrivers,
      vehicleInsp: truckInsp, vehicleOosInsp: truckOos,
      vehicleOosRate: c.vehicleOosRate, driverInsp: c.driverInsp,
      driverOosInsp: c.driverOosInsp, driverOosRate: c.driverOosRate,
      crashTotal: c.crashTotal, mcs150Date: c.mcs150Date,
    },
  };
}

// ── Shared: fetch authority grant date (non-fatal)
async function fetchGrantDate(dot, webKey) {
  try {
    const r = await fetch(fmcsaUrl(`/carriers/${dot}/authority`, webKey));
    return r.ok ? extractGrantDate(await r.json()) : '';
  } catch (_) { return ''; }
}

// ── DOT lookup ────────────────────────────────────────────────────────────────
router.get('/dot/:dot', async (req, res, next) => {
  try {
    const webKey = process.env.FMCSA_WEBKEY;
    if (!webKey) return res.status(503).json({ error: 'FMCSA_WEBKEY not configured' });

    const dot = req.params.dot.replace(/\D/g, '');
    if (!dot) return res.status(400).json({ error: 'Invalid DOT number' });

    const [carrierRes, docketRes] = await Promise.all([
      fetch(fmcsaUrl(`/carriers/${dot}`, webKey)),
      fetch(fmcsaUrl(`/carriers/${dot}/docket-numbers`, webKey)),
    ]);

    if (carrierRes.status === 404) return res.status(404).json({ error: `DOT ${dot} not found in FMCSA database` });
    if (!carrierRes.ok) throw new Error(`FMCSA API HTTP ${carrierRes.status} for DOT ${dot}`);

    const c = (await carrierRes.json())?.content?.carrier;
    if (!c) return res.status(404).json({ error: 'FMCSA returned no carrier record for that DOT' });

    const docketJson       = docketRes.ok ? await docketRes.json() : null;
    const authorityGrantDate = await fetchGrantDate(dot, webKey);

    res.json(buildPayload(c, dot, docketJson, authorityGrantDate));
  } catch (e) { next(e); }
});

// ── MC number lookup ──────────────────────────────────────────────────────────
router.get('/mc/:mc', async (req, res, next) => {
  try {
    const webKey = process.env.FMCSA_WEBKEY;
    if (!webKey) return res.status(503).json({ error: 'FMCSA_WEBKEY not configured' });

    // Strip any MC/FF prefix the user may have typed (e.g. "MC1605225" → "1605225")
    const mc = req.params.mc.replace(/^(MC|FF)/i, '').replace(/\D/g, '');
    if (!mc) return res.status(400).json({ error: 'Invalid MC number' });

    // FMCSA docket-number endpoint returns the carrier record (same shape as DOT endpoint)
    const docketRes = await fetch(fmcsaUrl(`/carriers/docket-number/${mc}`, webKey));
    if (docketRes.status === 404) return res.status(404).json({ error: `MC ${mc} not found in FMCSA database` });
    if (!docketRes.ok) throw new Error(`FMCSA API HTTP ${docketRes.status} for MC ${mc}`);

    const c = (await docketRes.json())?.content?.carrier;
    if (!c || !c.dotNumber) return res.status(404).json({ error: 'FMCSA returned no carrier record for that MC number' });

    const dot = String(c.dotNumber);

    // Get docket numbers (for MC cross-check) + authority grant date in parallel
    const [docketsRes, authorityGrantDate] = await Promise.all([
      fetch(fmcsaUrl(`/carriers/${dot}/docket-numbers`, webKey)).then(r => r.ok ? r.json() : null),
      fetchGrantDate(dot, webKey),
    ]);

    res.json(buildPayload(c, dot, docketsRes, authorityGrantDate));
  } catch (e) { next(e); }
});

// ── Legacy: keep /:dot working so existing bookmarks/tests don't break ────────
router.get('/:dot', async (req, res, next) => {
  try {
    const webKey = process.env.FMCSA_WEBKEY;
    if (!webKey) return res.status(503).json({ error: 'FMCSA_WEBKEY not configured' });

    const dot = req.params.dot.replace(/\D/g, '');
    if (!dot) return res.status(400).json({ error: 'Invalid DOT number' });

    const [carrierRes, docketRes] = await Promise.all([
      fetch(fmcsaUrl(`/carriers/${dot}`, webKey)),
      fetch(fmcsaUrl(`/carriers/${dot}/docket-numbers`, webKey)),
    ]);

    if (carrierRes.status === 404) return res.status(404).json({ error: `DOT ${dot} not found in FMCSA database` });
    if (!carrierRes.ok) throw new Error(`FMCSA API HTTP ${carrierRes.status} for DOT ${dot}`);

    const c = (await carrierRes.json())?.content?.carrier;
    if (!c) return res.status(404).json({ error: 'FMCSA returned no carrier record for that DOT' });

    const docketJson       = docketRes.ok ? await docketRes.json() : null;
    const authorityGrantDate = await fetchGrantDate(dot, webKey);

    res.json(buildPayload(c, dot, docketJson, authorityGrantDate));
  } catch (e) { next(e); }
});

export default router;
