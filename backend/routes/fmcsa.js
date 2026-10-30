// ── FMCSA QCMobile API proxy ─────────────────────────────────────────────────
// GET /api/fmcsa/dot/:dot  — look up by DOT number
// GET /api/fmcsa/mc/:mc   — look up by MC number
//
// Each tenant uses their own FMCSA web key stored in tenant_credentials.

import express from 'express';
import { createClient } from '@supabase/supabase-js';
import { decrypt } from '../lib/encryption.js';

const router           = express.Router();
const BASE             = 'https://mobile.fmcsa.dot.gov/qc/services';
const SAFER_BASE       = 'https://safer.fmcsa.dot.gov';
const FMCSA_TIMEOUT_MS = 15_000;

function isNetworkError(e) {
  return (
    e?.name === 'TimeoutError' ||
    e?.name === 'AbortError'   ||
    e?.code === 'ECONNREFUSED' ||
    e?.code === 'ENOTFOUND'    ||
    e?.code === 'ECONNRESET'
  );
}

async function fetchFmcsa(url) {
  return fetch(url, { signal: AbortSignal.timeout(FMCSA_TIMEOUT_MS) });
}

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

function buildPayload(c, dot, docketJson, authorityGrantDate, crashes24mo, saferPhone = '') {
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
    fmcsaPhone:           saferPhone,   // parsed from SAFER HTML — QCMobile JSON has no phone field
    hasBrokerAuthority:   (c.brokerAuthorityStatus || '').toUpperCase() === 'A',
  };

  const filledFields = Object.keys(fmcsaFields).filter(f => {
    const v = fmcsaFields[f];
    return v !== '' && v !== false && v != null;
  });

  // Best-effort: FMCSA outOfServiceDate present → active federal OOS order
  // SaferWatch (operation.outOfService) is more reliable; this catches it when SW is unavailable.
  const activeFederalOOS = !!c.outOfServiceDate;
  if (activeFederalOOS) filledFields.push('activeFederalOOS');

  const crashData = crashes24mo ?? { count: 0, items: [] };
  filledFields.push('crashes24mo');

  return {
    ...fmcsaFields,
    activeFederalOOS,
    crashes24mo: crashData,
    filledFields,
    manualFields: [
      'autoLiability', 'cargoInsurance', 'pendingInsuranceCancellation',
      'unsafeDrivingBasic', 'crashIndicatorBasic', 'hosBasic', 'vehicleMaintenanceBasic',
      'vehicleDriverObservedBasic', 'driverFitnessBasic', 'hazmatBasic',
      'drugAlcoholViolation', 'contactPhone', 'contactEmail',
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

// ── SAFER Company Snapshot — phone number ─────────────────────────────────────
// QCMobile /carriers/{dot} JSON does not include phone numbers.
// Phone is only available in the SAFER HTML snapshot (publicly accessible, no key needed).
// Row: <TH scope="ROW">Phone:</TH> <TD class="queryfield">(xxx) xxx-xxxx</TD>
function parseSaferPhone(html) {
  const m = html.match(
    /<TH[^>]*SCOPE="ROW"[^>]*>[\s\S]*?Phone:?[\s\S]*?<\/TH>\s*<TD[^>]*class="queryfield"[^>]*>([\s\S]*?)<\/TD>/i
  );
  if (!m) return '';
  return m[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, '').replace(/\s+/g, ' ').trim();
}

async function fetchSaferPhone(dot) {
  try {
    const url = `${SAFER_BASE}/query.asp?searchtype=ANY&query_type=queryCarrierSnapshot&query_param=USDOT&query_string=${dot}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(9_000) });
    if (!res.ok) return '';
    return parseSaferPhone(await res.text());
  } catch (_) { return ''; }
}

async function fetchGrantDate(dot, webKey) {
  try {
    const r = await fetchFmcsa(fmcsaUrl(`/carriers/${dot}/authority`, webKey));
    return r.ok ? extractGrantDate(await r.json()) : '';
  } catch (_) { return ''; }
}

async function fetchCrashes(dot, webKey) {
  try {
    const r = await fetchFmcsa(fmcsaUrl(`/carriers/${dot}/crashes`, webKey));
    if (!r.ok) return { count: 0, items: [] };
    const json = await r.json();

    // FMCSA returns crashes in various shapes depending on API version
    let all = [];
    if (Array.isArray(json?.content))                  all = json.content;
    else if (Array.isArray(json?.content?.crashes))    all = json.content.crashes;
    else if (Array.isArray(json?.content?.crash))      all = json.content.crash;
    else if (Array.isArray(json?.content?.crashResults)) all = json.content.crashResults;

    // Filter to last 24 months
    const cutoffMs = Date.now() - 2 * 365.25 * 24 * 60 * 60 * 1000;
    const recent = all.filter(c => {
      const dateStr = c.reportDate || c.accDate || c.date || '';
      if (!dateStr) return false;
      const d = new Date(dateStr);
      return !isNaN(d.getTime()) && d.getTime() >= cutoffMs;
    });

    return {
      count: recent.length,
      items: recent.map(c => ({
        date:       c.reportDate || c.accDate || c.date || '',
        state:      c.reportState || c.state || '',
        fatalities: parseInt(c.fatal    ?? c.fatalities ?? 0, 10),
        injuries:   parseInt(c.injure   ?? c.injuries   ?? 0, 10),
        towaway:    !!(c.towAway ?? c.towaways ?? false),
        hazmatRel:  !!(c.hazmatRel ?? false),
      })),
    };
  } catch (_) {
    return { count: 0, items: [] };
  }
}

// ── DOT lookup ────────────────────────────────────────────────────────────────
router.get('/dot/:dot', async (req, res, next) => {
  try {
    const webKey = await getTenantWebKey(req.auth.tenant);
    if (!webKey) return res.status(503).json({ error: 'FMCSA web key not configured — add your key in Settings' });

    const dot = req.params.dot.replace(/\D/g, '');
    if (!dot) return res.status(400).json({ error: 'Invalid DOT number' });

    const [carrierRes, docketRes] = await Promise.all([
      fetchFmcsa(fmcsaUrl(`/carriers/${dot}`, webKey)),
      fetchFmcsa(fmcsaUrl(`/carriers/${dot}/docket-numbers`, webKey)),
    ]);

    if (carrierRes.status === 404) return res.status(404).json({ error: `DOT ${dot} not found in FMCSA database` });
    if (!carrierRes.ok) throw new Error(`FMCSA API HTTP ${carrierRes.status} for DOT ${dot}`);

    const c = (await carrierRes.json())?.content?.carrier;
    if (!c) return res.status(404).json({ error: 'FMCSA returned no carrier record for that DOT' });

    const docketJson = docketRes.ok ? await docketRes.json() : null;
    const [authorityGrantDate, crashes24mo, saferPhone] = await Promise.all([
      fetchGrantDate(dot, webKey),
      fetchCrashes(dot, webKey),
      fetchSaferPhone(dot),
    ]);

    res.json(buildPayload(c, dot, docketJson, authorityGrantDate, crashes24mo, saferPhone));
  } catch (e) {
    if (isNetworkError(e)) {
      return res.status(503).json({ cannotVerify: true, lastAttemptAt: new Date().toISOString(), error: e.message });
    }
    next(e);
  }
});

// ── MC number lookup ──────────────────────────────────────────────────────────
router.get('/mc/:mc', async (req, res, next) => {
  try {
    const webKey = await getTenantWebKey(req.auth.tenant);
    if (!webKey) return res.status(503).json({ error: 'FMCSA web key not configured — add your key in Settings' });

    const mc = req.params.mc.replace(/^(MC|FF)/i, '').replace(/\D/g, '');
    if (!mc) return res.status(400).json({ error: 'Invalid MC number' });

    const docketRes = await fetchFmcsa(fmcsaUrl(`/carriers/docket-number/${mc}`, webKey));
    if (docketRes.status === 404) return res.status(404).json({ error: `MC ${mc} not found in FMCSA database` });
    if (!docketRes.ok) throw new Error(`FMCSA API HTTP ${docketRes.status} for MC ${mc}`);

    const c = (await docketRes.json())?.content?.carrier;
    if (!c || !c.dotNumber) return res.status(404).json({ error: 'FMCSA returned no carrier record for that MC number' });

    const dot = String(c.dotNumber);
    const [docketsRes, authorityGrantDate, crashes24mo, saferPhone] = await Promise.all([
      fetchFmcsa(fmcsaUrl(`/carriers/${dot}/docket-numbers`, webKey)).then(r => r.ok ? r.json() : null),
      fetchGrantDate(dot, webKey),
      fetchCrashes(dot, webKey),
      fetchSaferPhone(dot),
    ]);

    res.json(buildPayload(c, dot, docketsRes, authorityGrantDate, crashes24mo, saferPhone));
  } catch (e) {
    if (isNetworkError(e)) {
      return res.status(503).json({ cannotVerify: true, lastAttemptAt: new Date().toISOString(), error: e.message });
    }
    next(e);
  }
});

// ── Legacy: keep /:dot working so existing bookmarks don't break ──────────────
router.get('/:dot', async (req, res, next) => {
  try {
    const webKey = await getTenantWebKey(req.auth.tenant);
    if (!webKey) return res.status(503).json({ error: 'FMCSA web key not configured — add your key in Settings' });

    const dot = req.params.dot.replace(/\D/g, '');
    if (!dot) return res.status(400).json({ error: 'Invalid DOT number' });

    const [carrierRes, docketRes] = await Promise.all([
      fetchFmcsa(fmcsaUrl(`/carriers/${dot}`, webKey)),
      fetchFmcsa(fmcsaUrl(`/carriers/${dot}/docket-numbers`, webKey)),
    ]);

    if (carrierRes.status === 404) return res.status(404).json({ error: `DOT ${dot} not found in FMCSA database` });
    if (!carrierRes.ok) throw new Error(`FMCSA API HTTP ${carrierRes.status} for DOT ${dot}`);

    const c = (await carrierRes.json())?.content?.carrier;
    if (!c) return res.status(404).json({ error: 'FMCSA returned no carrier record for that DOT' });

    const docketJson = docketRes.ok ? await docketRes.json() : null;
    const [authorityGrantDate, crashes24mo, saferPhone] = await Promise.all([
      fetchGrantDate(dot, webKey),
      fetchCrashes(dot, webKey),
      fetchSaferPhone(dot),
    ]);

    res.json(buildPayload(c, dot, docketJson, authorityGrantDate, crashes24mo, saferPhone));
  } catch (e) {
    if (isNetworkError(e)) {
      return res.status(503).json({ cannotVerify: true, lastAttemptAt: new Date().toISOString(), error: e.message });
    }
    next(e);
  }
});

export default router;
