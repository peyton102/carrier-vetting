// ── FMCSA QCMobile API proxy ─────────────────────────────────────────────────
// GET /api/fmcsa/dot/:dot  — look up by DOT number
// GET /api/fmcsa/mc/:mc   — look up by MC number
//
// Each tenant uses their own FMCSA web key stored in tenant_credentials.

import express from 'express';
import { createClient } from '@supabase/supabase-js';
import { decrypt } from '../lib/encryption.js';

const router = express.Router();
const BASE   = 'https://mobile.fmcsa.dot.gov/qc/services';

function getSupabase() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

async function getTenantWebKey(tenantSlug) {
  const { data } = await getSupabase()
    .from('tenant_credentials')
    .select('fmcsa_webkey')
    .eq('tenant_slug', tenantSlug)
    .single();
  if (!data?.fmcsa_webkey) return null;
  return decrypt(data.fmcsa_webkey);
}

function fmcsaUrl(path, webKey) {
  return `${BASE}${path}?webKey=${encodeURIComponent(webKey)}`;
}

// allowedToOperate: Y=carrier may operate, N=not permitted
// *AuthorityStatus codes: A=Active, I=Inactive/Revoked, R=Revocation Pending
function normalizeAuthorityStatus(c) {
  if ((c.allowedToOperate || '').toUpperCase() === 'N') return 'Not Authorized';
  const common   = (c.commonAuthorityStatus   || '').toUpperCase();
  const contract = (c.contractAuthorityStatus || '').toUpperCase();
  if (common === 'R' || contract === 'R') return 'Revocation Pending';
  if (common   === 'A') return 'Active-Common';
  if (contract === 'A') return 'Active-Contract';
  if (common   === 'S' || contract === 'S') return 'Suspended';
  return 'Inactive';
}

function normalizeSafetyRating(raw) {
  if (!raw) return 'None/Unrated';
  const r     = raw.trim();
  const upper = r.toUpperCase();
  if (upper === 'S' || (/satisfactory/i.test(r) && !/un/i.test(r))) return 'Satisfactory';
  if (upper === 'U' || /unsatisfactory/i.test(r))                    return 'Unsatisfactory';
  if (upper === 'C' || /conditional/i.test(r))                       return 'Conditional';
  return 'None/Unrated';
}

function extractMcNumber(docketJson) {
  const items = docketJson?.content?.item;
  if (Array.isArray(items)) {
    const mc = items.find(i => (i.prefix || '').toUpperCase() === 'MC');
    if (mc) {
      if (mc.docketNumber) return mc.docketNumber.replace(/^MC/i, '');
      if (mc.docketNumberId != null) return String(mc.docketNumberId);
    }
  }
  const direct = docketJson?.content?.docketNumber;
  if (direct) return String(direct).replace(/^MC/i, '');
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
  return dates[0].toISOString().slice(0, 10);
}

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
      'vehicleDriverObservedBasic', 'driverFitnessBasic', 'hazmatBasic', 'controlledSubstancesBasic',
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

async function fetchGrantDate(dot, webKey) {
  try {
    const r = await fetch(fmcsaUrl(`/carriers/${dot}/authority`, webKey));
    return r.ok ? extractGrantDate(await r.json()) : '';
  } catch (_) { return ''; }
}

// ── DOT lookup ────────────────────────────────────────────────────────────────
router.get('/dot/:dot', async (req, res, next) => {
  try {
    const webKey = await getTenantWebKey(req.auth.tenant);
    if (!webKey) return res.status(503).json({ error: 'FMCSA web key not configured — add your key in Settings' });

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

    const docketJson         = docketRes.ok ? await docketRes.json() : null;
    const authorityGrantDate = await fetchGrantDate(dot, webKey);

    res.json(buildPayload(c, dot, docketJson, authorityGrantDate));
  } catch (e) { next(e); }
});

// ── MC number lookup ──────────────────────────────────────────────────────────
router.get('/mc/:mc', async (req, res, next) => {
  try {
    const webKey = await getTenantWebKey(req.auth.tenant);
    if (!webKey) return res.status(503).json({ error: 'FMCSA web key not configured — add your key in Settings' });

    const mc = req.params.mc.replace(/^(MC|FF)/i, '').replace(/\D/g, '');
    if (!mc) return res.status(400).json({ error: 'Invalid MC number' });

    const docketRes = await fetch(fmcsaUrl(`/carriers/docket-number/${mc}`, webKey));
    if (docketRes.status === 404) return res.status(404).json({ error: `MC ${mc} not found in FMCSA database` });
    if (!docketRes.ok) throw new Error(`FMCSA API HTTP ${docketRes.status} for MC ${mc}`);

    const c = (await docketRes.json())?.content?.carrier;
    if (!c || !c.dotNumber) return res.status(404).json({ error: 'FMCSA returned no carrier record for that MC number' });

    const dot = String(c.dotNumber);
    const [docketsRes, authorityGrantDate] = await Promise.all([
      fetch(fmcsaUrl(`/carriers/${dot}/docket-numbers`, webKey)).then(r => r.ok ? r.json() : null),
      fetchGrantDate(dot, webKey),
    ]);

    res.json(buildPayload(c, dot, docketsRes, authorityGrantDate));
  } catch (e) { next(e); }
});

// ── Legacy: keep /:dot working so existing bookmarks don't break ──────────────
router.get('/:dot', async (req, res, next) => {
  try {
    const webKey = await getTenantWebKey(req.auth.tenant);
    if (!webKey) return res.status(503).json({ error: 'FMCSA web key not configured — add your key in Settings' });

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

    const docketJson         = docketRes.ok ? await docketRes.json() : null;
    const authorityGrantDate = await fetchGrantDate(dot, webKey);

    res.json(buildPayload(c, dot, docketJson, authorityGrantDate));
  } catch (e) { next(e); }
});

export default router;
