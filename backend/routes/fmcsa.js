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

function buildPayload(c, dot, docketJson, authorityGrantDate, saferData = {}) {
  const truckInsp = c.vehicleInsp    ?? 0;
  const truckOos  = c.vehicleOosInsp ?? 0;
  const { phone: saferPhone = '', crashes: saferCrashes = null, oos: saferOos = null } = saferData;

  // National OOS averages: SAFER HTML is live and authoritative; QCMobile values are stale.
  // Only fall back to QCMobile if SAFER HTML parsing fails entirely.
  const natTruckOos  = saferOos?.truckNatAvg  != null ? saferOos.truckNatAvg
                       : c.vehicleOosRateNationalAverage != null ? String(c.vehicleOosRateNationalAverage) : '';
  const natDriverOos = saferOos?.driverNatAvg != null ? saferOos.driverNatAvg
                       : c.driverOosRateNationalAverage  != null ? String(c.driverOosRateNationalAverage)  : '';

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
    nationalAvgTruckOos:  natTruckOos,
    nationalAvgDriverOos: natDriverOos,
    nationalAvgOosAsOf:   saferOos?.asOf || '',
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
  // Always include activeFederalOOS and hasBrokerAuthority in filledFields — they are always
  // evaluated from FMCSA data so the PDF certificate can show the source tag even when false.
  if (!filledFields.includes('activeFederalOOS')) filledFields.push('activeFederalOOS');
  if (!filledFields.includes('hasBrokerAuthority')) filledFields.push('hasBrokerAuthority');

  // Crashes: primary source is SAFER HTML (live totals); null = not available → "Not reviewed"
  if (saferCrashes != null) filledFields.push('crashes24mo');

  return {
    ...fmcsaFields,
    activeFederalOOS,
    crashes24mo: saferCrashes,   // null when unavailable — never default to 0
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

// ── SAFER Company Snapshot — phone, crashes, OOS national averages ─────────────
// These fields are not available from QCMobile JSON; parse directly from the
// publicly accessible SAFER HTML company snapshot page (no API key required).

function parseSaferPhone(html) {
  const m = html.match(
    /<TH[^>]*SCOPE="ROW"[^>]*>[\s\S]*?Phone:?[\s\S]*?<\/TH>\s*<TD[^>]*class="queryfield"[^>]*>([\s\S]*?)<\/TD>/i
  );
  if (!m) return '';
  return m[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, '').replace(/\s+/g, ' ').trim();
}

// Parse crash totals from SAFER HTML crash section.
// Returns { count, fatal, injury, tow } or null when section not found.
// SAFER uses <TABLE summary="Crashes"> with column headers Fatal|Injury|Tow|Total
// and a data row: <TH SCOPE="ROW">Crashes</TH><TD>...</TD>...
function parseSaferCrashes(html) {
  try {
    // Find the crash table by its summary attribute
    const tableMatch = html.match(/<TABLE[^>]*summary="Crashes"[^>]*>([\s\S]*?)<\/TABLE>/i);
    if (!tableMatch) return null;
    const tbl = tableMatch[1];

    // Extract all TR rows
    const rows = [];
    const rowRe = /<TR[^>]*>([\s\S]*?)<\/TR>/gi;
    let m;
    while ((m = rowRe.exec(tbl)) !== null) rows.push(m[1]);
    if (rows.length < 2) return null;

    // Header row: column names from TH cells (Type | Fatal | Injury | Tow | Total)
    const headers = [...rows[0].matchAll(/<TH[^>]*>([\s\S]*?)<\/TH>/gi)]
      .map(h => h[1].replace(/<[^>]+>/g, '').trim().toLowerCase());

    // Data row: TR containing <TH SCOPE="ROW">Crashes</TH>
    let dataTds = null;
    for (let i = 1; i < rows.length; i++) {
      if (/crashes/i.test(rows[i]) && /<TH[^>]*/i.test(rows[i])) {
        dataTds = [...rows[i].matchAll(/<TD[^>]*>([\s\S]*?)<\/TD>/gi)]
          .map(td => td[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, '').trim());
        break;
      }
    }
    if (!dataTds || dataTds.length === 0) return null;

    // headers[0] = "type" (the row-header column); data TDs start at column index 1.
    // dataTds[0] = Fatal value, dataTds[1] = Injury, dataTds[2] = Tow, dataTds[3] = Total
    const findVal = (label) => {
      const idx = headers.findIndex(h => h.includes(label));
      if (idx < 1) return null;
      const n = parseInt(dataTds[idx - 1], 10);
      return isNaN(n) ? null : n;
    };

    const fatal  = findVal('fatal');
    const injury = findVal('injur');
    const tow    = findVal('tow');
    const total  = findVal('total');

    if (total === null && fatal === null && tow === null) return null;
    return {
      count:  total  ?? ((fatal ?? 0) + (injury ?? 0) + (tow ?? 0)),
      fatal:  fatal  ?? 0,
      injury: injury ?? 0,
      tow:    tow    ?? 0,
    };
  } catch (_) { return null; }
}

// Parse live national OOS averages + "as of" date from SAFER HTML OOS section.
// Returns { truckNatAvg, driverNatAvg, asOf } or null when section not found.
// SAFER structure: <TR><TH>Nat'l Average %<br><span>as of DATE MM/DD/YYYY*</span></TH><TD>22.26%</TD><TD>6.67%</TD>...
function parseSaferOosAverages(html) {
  try {
    // Find the TR containing "Nat'l Average" (the apostrophe may vary)
    const rowMatch = html.match(/<TR[^>]*>[\s\S]*?Nat.{0,5}l\s+Average[\s\S]*?<\/TR>/i);
    if (!rowMatch) return null;
    const rowHtml = rowMatch[0];

    // Extract date from the TH: "as of DATE 09/25/2026" — "DATE" is a literal keyword in SAFER HTML
    const thMatch  = rowHtml.match(/<TH[^>]*>([\s\S]*?)<\/TH>/i);
    const thText   = thMatch ? thMatch[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : '';
    const asOfMatch = thText.match(/as\s+of\s+(?:DATE\s+)?([\d]{1,2}\/[\d]{1,2}\/[\d]{4})/i)
                  || thText.match(/as\s+of\s+(?:DATE\s+)?([\d]{4}-[\d]{2}-[\d]{2})/i);

    // Extract TD values — first = vehicle/truck avg, second = driver avg
    const tds = [...rowHtml.matchAll(/<TD[^>]*>([\s\S]*?)<\/TD>/gi)]
      .map(td => td[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, '').replace(/\s+/g, ' ').trim());

    if (tds.length < 2) return null;
    const truck  = tds[0].replace('%', '').trim();
    const driver = tds[1].replace('%', '').trim();
    if (!truck || !driver || isNaN(parseFloat(truck)) || isNaN(parseFloat(driver))) return null;

    return {
      truckNatAvg:  truck,
      driverNatAvg: driver,
      asOf: asOfMatch ? asOfMatch[1] : null,
    };
  } catch (_) { return null; }
}

// Fetch SAFER snapshot HTML once and extract all three data points.
async function fetchSaferData(dot) {
  try {
    const url = `${SAFER_BASE}/query.asp?searchtype=ANY&query_type=queryCarrierSnapshot&query_param=USDOT&query_string=${dot}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(12_000) });
    if (!res.ok) return {};
    const html = await res.text();
    return {
      phone:   parseSaferPhone(html),
      crashes: parseSaferCrashes(html),
      oos:     parseSaferOosAverages(html),
    };
  } catch (_) { return {}; }
}

async function fetchGrantDate(dot, webKey) {
  try {
    const r = await fetchFmcsa(fmcsaUrl(`/carriers/${dot}/authority`, webKey));
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
      fetchFmcsa(fmcsaUrl(`/carriers/${dot}`, webKey)),
      fetchFmcsa(fmcsaUrl(`/carriers/${dot}/docket-numbers`, webKey)),
    ]);

    if (carrierRes.status === 404) return res.status(404).json({ error: `DOT ${dot} not found in FMCSA database` });
    if (!carrierRes.ok) throw new Error(`FMCSA API HTTP ${carrierRes.status} for DOT ${dot}`);

    const c = (await carrierRes.json())?.content?.carrier;
    if (!c) return res.status(404).json({ error: 'FMCSA returned no carrier record for that DOT' });

    const docketJson = docketRes.ok ? await docketRes.json() : null;
    const [authorityGrantDate, saferData] = await Promise.all([
      fetchGrantDate(dot, webKey),
      fetchSaferData(dot),
    ]);

    res.json(buildPayload(c, dot, docketJson, authorityGrantDate, saferData));
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
    const [docketsRes, authorityGrantDate, saferData] = await Promise.all([
      fetchFmcsa(fmcsaUrl(`/carriers/${dot}/docket-numbers`, webKey)).then(r => r.ok ? r.json() : null),
      fetchGrantDate(dot, webKey),
      fetchSaferData(dot),
    ]);

    res.json(buildPayload(c, dot, docketsRes, authorityGrantDate, saferData));
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
    const [authorityGrantDate, saferData] = await Promise.all([
      fetchGrantDate(dot, webKey),
      fetchSaferData(dot),
    ]);

    res.json(buildPayload(c, dot, docketJson, authorityGrantDate, saferData));
  } catch (e) {
    if (isNetworkError(e)) {
      return res.status(503).json({ cannotVerify: true, lastAttemptAt: new Date().toISOString(), error: e.message });
    }
    next(e);
  }
});

export default router;
