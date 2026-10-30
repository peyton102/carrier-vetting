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
function parseSaferCrashes(html) {
  try {
    // Find the crash section: TH containing "crash" + "24" followed by the TD content
    const sectionMatch = html.match(
      /<TH[^>]*>(?:(?!<\/TH>)[\s\S])*?[Cc]rash(?:(?!<\/TH>)[\s\S])*?24(?:(?!<\/TH>)[\s\S])*?<\/TH>([\s\S]*?)<\/TR>/i
    );
    if (!sectionMatch) return null;

    const sectionHtml = sectionMatch[1];
    const plain = sectionHtml
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    // Method 1: each label directly precedes its value (e.g. "Fatal: 0  Tow: 4")
    const adjacent = (label) => {
      const m = plain.match(new RegExp(`${label}[^\\d]{0,12}(\\d+)`, 'i'));
      return m ? parseInt(m[1], 10) : null;
    };

    let fatal  = adjacent('Fatal');
    let injury = adjacent('Injur');
    let tow    = adjacent('Tow');
    let total  = adjacent('Total');

    // Method 2: all headers listed first, then all values in the same order
    // e.g. "Fatal Injury Tow Total  0  0  4  4"
    if (total === null && fatal === null) {
      const labels = [
        { key: 'fatal',  re: /\bfatal\b/i  },
        { key: 'injury', re: /\binjur/i    },
        { key: 'tow',    re: /\btow\b/i    },
        { key: 'total',  re: /\btotal\b/i  },
      ];
      const found = labels
        .map(l => ({ ...l, pos: plain.search(l.re) }))
        .filter(l => l.pos >= 0)
        .sort((a, b) => a.pos - b.pos);

      if (found.length >= 2) {
        const lastPos = found[found.length - 1].pos;
        // find the label text length (up to next space or end)
        const afterAll = plain.slice(lastPos).replace(/^[a-z]+\s*/i, '');
        const nums = (afterAll.match(/\d+/g) || []).map(Number);
        if (nums.length >= found.length) {
          found.forEach((l, i) => {
            if (l.key === 'fatal')  fatal  = nums[i];
            if (l.key === 'injury') injury = nums[i];
            if (l.key === 'tow')    tow    = nums[i];
            if (l.key === 'total')  total  = nums[i];
          });
        }
      }
    }

    if (total === null && fatal === null) return null;

    const count = total ?? ((fatal ?? 0) + (injury ?? 0) + (tow ?? 0));
    return { count, fatal: fatal ?? 0, injury: injury ?? 0, tow: tow ?? 0 };
  } catch (_) { return null; }
}

// Parse live national OOS averages + "as of" date from SAFER HTML OOS section.
// Returns { truckNatAvg, driverNatAvg, asOf } or null when section not found.
function parseSaferOosAverages(html) {
  try {
    // Find the OOS rate section: TH containing "out of service" or "OOS"
    const sectionMatch = html.match(
      /<TH[^>]*>(?:(?!<\/TH>)[\s\S])*?(?:out\s*of\s*service|oos\s*rate)(?:(?!<\/TH>)[\s\S])*?<\/TH>([\s\S]*?)<\/TR>/i
    );
    if (!sectionMatch) return null;

    const plain = sectionMatch[1]
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    // Find "Natl" or "National" avg + two percentages (vehicle then driver)
    const natMatch = plain.match(
      /nat(?:ional|l\.?)[\s\S]{0,40}?(\d+\.?\d*)\s*%[\s\S]{0,60}?(\d+\.?\d*)\s*%/i
    );
    if (!natMatch) return null;

    // "as of MM/DD/YYYY"
    const asOfMatch = plain.match(/as\s+of\s+([\d]{1,2}\/[\d]{1,2}\/[\d]{4})/i)
                   || plain.match(/as\s+of\s+([\d]{4}-[\d]{2}-[\d]{2})/i);

    return {
      truckNatAvg:  natMatch[1],
      driverNatAvg: natMatch[2],
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
