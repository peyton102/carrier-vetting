// ── FMCSA QCMobile API proxy ─────────────────────────────────────────────────
// GET /api/fmcsa/dot/:dot  — look up by DOT number
// GET /api/fmcsa/mc/:mc   — look up by MC number
//
// Uses the shared FMCSA_WEBKEY from .env — one key for the whole platform.

import express from 'express';

const router           = express.Router();
const BASE             = 'https://mobile.fmcsa.dot.gov/qc/services';
const SAFER_BASE       = 'https://safer.fmcsa.dot.gov';
const FMCSA_TIMEOUT_MS = 15_000;

function ms(start) { return `${Date.now() - start}ms`; }

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

function getWebKey() {
  return process.env.FMCSA_WEBKEY || null;
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
  const {
    phone:        saferPhone        = '',
    crashes:      saferCrashes      = null,
    oos:          saferOos          = null,
    inspections:  saferInsp         = null,
    snapshotDate: saferSnapshotDate = null,
    mileage:      saferMileage      = null,
  } = saferData;

  // National OOS averages: SAFER HTML only — QCMobile values are stale and must not be used.
  // If SAFER HTML parsing fails, leave blank; rules engine and PDF will show "Not reviewed (no data)".
  const natTruckOos  = saferOos?.truckNatAvg  != null ? saferOos.truckNatAvg  : '';
  const natDriverOos = saferOos?.driverNatAvg != null ? saferOos.driverNatAvg : '';

  // Carrier OOS rates: SAFER HTML snapshot (same date shown on cert); fall back to QCMobile.
  const truckOosPctStr  = saferInsp?.vehicleOosPct != null
    ? parseFloat(saferInsp.vehicleOosPct).toFixed(2)
    : c.vehicleOosRate != null ? parseFloat(c.vehicleOosRate).toFixed(2) : '';
  const driverOosPctStr = saferInsp?.driverOosPct  != null
    ? parseFloat(saferInsp.driverOosPct).toFixed(2)
    : c.driverOosRate  != null ? parseFloat(c.driverOosRate).toFixed(2)  : '';

  // Vehicle inspection count: SAFER HTML vehicle count; fall back to QCMobile
  const vehicleInspCount = saferInsp?.vehicleInsp ?? truckInsp;

  const fmcsaFields = {
    carrierName:          c.legalName   || '',
    dotNumber:            String(c.dotNumber || dot),
    mcNumber:             extractMcNumber(docketJson),
    authorityStatus:      normalizeAuthorityStatus(c),
    authorityGrantDate,
    safetyRating:         normalizeSafetyRating(c.safetyRating),
    powerUnits:           c.totalPowerUnits  != null ? String(c.totalPowerUnits)  : '',
    totalDrivers:         c.totalDrivers     != null ? String(c.totalDrivers)     : '',
    // SAFER HTML is the authoritative mileage source — QCMobile rarely has these fields.
    mcs150Mileage:        saferMileage?.mileage     != null ? String(saferMileage.mileage)     : (c.mcs150Mileage     != null ? String(c.mcs150Mileage)     : ''),
    mcs150MileageYear:    saferMileage?.mileageYear != null ? String(saferMileage.mileageYear) : (c.mcs150MileageYear != null ? String(c.mcs150MileageYear) : ''),
    inspections24mo:      String(vehicleInspCount),
    truckOosPct:          truckOosPctStr,
    driverOosPct:         driverOosPctStr,
    nationalAvgTruckOos:  natTruckOos,
    nationalAvgDriverOos: natDriverOos,
    nationalAvgOosAsOf:   saferOos?.asOf || '',
    fmcsaPhone:           saferPhone,   // parsed from SAFER HTML — QCMobile JSON has no phone field
    hasBrokerAuthority:   (c.brokerAuthorityStatus || '').toUpperCase() === 'A',
    saferSnapshotDate:    saferSnapshotDate || '',
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
    // SAFER HTML parsed inspection/OOS data — exposed for dual-source display on cert.
    // Frontend compares saferData.snapshotDate vs swInspectionsDate (from SW response) to
    // determine which source is more recent. SAFER wins on tie or when SW has no date.
    saferData: {
      snapshotDate:   saferSnapshotDate,
      vehicleInsp:    saferInsp?.vehicleInsp    ?? null,
      driverInsp:     saferInsp?.driverInsp     ?? null,
      vehicleOosInsp: saferInsp?.vehicleOosInsp ?? null,
      driverOosInsp:  saferInsp?.driverOosInsp  ?? null,
      vehicleOosPct:  saferInsp?.vehicleOosPct  ?? null,
      driverOosPct:   saferInsp?.driverOosPct   ?? null,
    },
  };
}

// ── SAFER Company Snapshot — phone, crashes, OOS national averages ─────────────
// These fields are not available from QCMobile JSON; parse directly from the
// publicly accessible SAFER HTML company snapshot page (no API key required).

export function parseSaferPhone(html) {
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
export function parseSaferCrashes(html) {
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
// SAFER structure: <TH>Nat'l Average %<br><span>as of DATE MM/DD/YYYY*</span></TH><TD>22.26%</TD><TD>6.67%</TD>...
//
// TR-based regexes fail here because the page has many nested TR/TH structures that
// span large sections. Instead, find the "Nat'l Average" text by character position,
// walk backward to its containing <TH opening tag, forward to its </TH> close, then
// extract the TDs that follow before the next </TR>.
export function parseSaferOosAverages(html) {
  try {
    // Find the exact position of "Nat'l Average" text
    const natIdx = html.search(/Nat.{0,5}l\s+Average/i);
    if (natIdx < 0) return null;

    // Walk backward from natIdx to find the <TH that contains this text
    const thOpenIdx = html.lastIndexOf('<TH', natIdx);
    if (thOpenIdx < 0) return null;

    // Skip past the TH opening tag (find '>')
    const thTagEnd   = html.indexOf('>', thOpenIdx) + 1;
    // Find the closing </TH> after the Nat'l Average text
    const thCloseIdx = html.indexOf('</TH>', natIdx);
    if (thCloseIdx < 0) return null;

    // Extract TH content and parse the "as of DATE MM/DD/YYYY" date
    const thContent = html.slice(thTagEnd, thCloseIdx);
    const thText    = thContent.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const asOfMatch = thText.match(/as\s+of\s+(?:DATE\s+)?([\d]{1,2}\/[\d]{1,2}\/[\d]{4})/i)
                   || thText.match(/as\s+of\s+(?:DATE\s+)?([\d]{4}-[\d]{2}-[\d]{2})/i);

    // Extract TDs between </TH> and the next </TR>
    const afterTh   = html.slice(thCloseIdx + 5); // skip past </TH>
    const trEndMatch = afterTh.match(/<\/TR>/i);
    const rowSlice   = trEndMatch ? afterTh.slice(0, trEndMatch.index) : afterTh.slice(0, 500);

    const tds = [...rowSlice.matchAll(/<TD[^>]*>([\s\S]*?)<\/TD>/gi)]
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

// Parse the FMCSA data snapshot date from the SAFER HTML page header.
// Returns "MM/DD/YYYY" string or null.
// Page header: "...FMCSA management information systems as of <FONT ...>10/31/2026</FONT>."
export function parseSaferSnapshotDate(html) {
  const m = html.match(/information\s+systems\s+as\s+of\s*(?:<[^>]+>)?\s*([\d]{1,2}\/[\d]{1,2}\/[\d]{4})/i);
  return m ? m[1] : null;
}

// Parse MCS-150 Mileage (Year) from the SAFER HTML company snapshot page.
// Exported for use in tests.
// SAFER structure (immediately after the MCS-150 Mileage (Year): label cell):
//   <TD valign=top><FONT ...><B>5,500,000 (2026)&nbsp;</TD>
// Returns { mileage: number, mileageYear: number } or null when not found.
export function parseSaferMileage(html) {
  try {
    const idx = html.search(/MCS-150\s+Mileage\s*\(Year\)\s*:/i);
    if (idx < 0) return null;
    const tdStart = html.indexOf('<TD', idx);
    if (tdStart < 0) return null;
    const tdEnd = html.indexOf('</TD>', tdStart);
    if (tdEnd < 0) return null;
    const text = html.slice(tdStart, tdEnd)
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const m = text.match(/^([\d,]+)\s*\((\d{4})\)/);
    if (!m) return null;
    const mileage     = parseInt(m[1].replace(/,/g, ''), 10);
    const mileageYear = parseInt(m[2], 10);
    if (isNaN(mileage) || isNaN(mileageYear)) return null;
    return { mileage, mileageYear };
  } catch (_) { return null; }
}

// Parse the first <TABLE summary="Inspections"> from SAFER HTML (24-month carrier data).
// Exported for use in tests.
// Columns: Inspection Type | Vehicle | Driver | Hazmat | IEP
// Rows: Inspections | Out of Service | Out of Service % | Nat'l Average %
// Returns { vehicleInsp, driverInsp, vehicleOosInsp, driverOosInsp, vehicleOosPct, driverOosPct }
// or null when the table cannot be found or parsed.
export function parseSaferInspections(html) {
  try {
    const tableMatch = html.match(/<TABLE[^>]*summary="Inspections"[^>]*>([\s\S]*?)<\/TABLE>/i);
    if (!tableMatch) return null;
    const tbl = tableMatch[1];

    const rows = [];
    const rowRe = /<TR[^>]*>([\s\S]*?)<\/TR>/gi;
    let m;
    while ((m = rowRe.exec(tbl)) !== null) rows.push(m[1]);

    const tdVals = (row) => [...row.matchAll(/<TD[^>]*>([\s\S]*?)<\/TD>/gi)]
      .map(td => td[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, '').replace(/%/g, '').trim());

    let vehicleInsp = null, driverInsp = null;
    let vehicleOosInsp = null, driverOosInsp = null;
    let vehicleOosPct = null, driverOosPct = null;

    for (const row of rows) {
      const th = row.match(/<TH[^>]*SCOPE="ROW"[^>]*>([\s\S]*?)<\/TH>/i);
      if (!th) continue;
      const label = th[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, '').trim();
      const cells = tdVals(row);
      if (!cells.length) continue;

      if (/^inspections$/i.test(label)) {
        vehicleInsp = parseInt(cells[0], 10);
        driverInsp  = parseInt(cells[1], 10);
      } else if (/^out of service$/i.test(label)) {
        vehicleOosInsp = parseInt(cells[0], 10);
        driverOosInsp  = parseInt(cells[1], 10);
      } else if (/^out of service\s*%$/i.test(label)) {
        vehicleOosPct = parseFloat(cells[0]);
        driverOosPct  = parseFloat(cells[1]);
      }
    }

    if (vehicleInsp === null && driverInsp === null) return null;
    return {
      vehicleInsp:    isNaN(vehicleInsp)    ? 0 : vehicleInsp,
      driverInsp:     isNaN(driverInsp)     ? 0 : driverInsp,
      vehicleOosInsp: isNaN(vehicleOosInsp) ? 0 : vehicleOosInsp,
      driverOosInsp:  isNaN(driverOosInsp)  ? 0 : driverOosInsp,
      vehicleOosPct:  isNaN(vehicleOosPct)  ? null : vehicleOosPct,
      driverOosPct:   isNaN(driverOosPct)   ? null : driverOosPct,
    };
  } catch (_) { return null; }
}

// Fetch SAFER snapshot HTML once and extract all data points.
// Retries once on timeout (SAFER occasionally drops connections under load).
function isSaferRetryable(e, status) {
  if (status != null) return status >= 500;
  return (
    e?.name === 'TimeoutError' ||
    e?.name === 'AbortError'   ||
    e?.code === 'ECONNRESET'   ||
    e?.code === 'ENOTFOUND'    ||
    e?.code === 'ECONNREFUSED'
  );
}

async function fetchSaferData(dot) {
  const url = `${SAFER_BASE}/query.asp?searchtype=ANY&query_type=queryCarrierSnapshot&query_param=USDOT&query_string=${dot}`;

  async function attempt() {
    const res = await fetch(url, { signal: AbortSignal.timeout(12_000) });
    if (!res.ok) {
      const err = new Error(`SAFER HTTP ${res.status}`);
      err._httpStatus = res.status;
      throw err;
    }
    return res.text();
  }

  let html = null;
  const tSafer = Date.now();
  try {
    html = await attempt();
    console.log(`[TIMING][FMCSA] SAFER HTML snapshot (DOT ${dot}): ${ms(tSafer)}`);
  } catch (e) {
    const reason = e?.message || String(e);
    if (isSaferRetryable(e, e?._httpStatus)) {
      console.warn(`[SAFER] DOT ${dot} — attempt 1 failed (${reason}), retrying in 2s`);
      await new Promise(r => setTimeout(r, 2000));
      try {
        html = await attempt();
        console.log(`[TIMING][FMCSA] SAFER HTML snapshot (DOT ${dot}): ${ms(tSafer)} (retry)`);
      } catch (e2) {
        console.error(`[SAFER] DOT ${dot} — attempt 2 failed (${e2?.message || e2}), giving up`);
        console.log(`[TIMING][FMCSA] SAFER HTML snapshot (DOT ${dot}): ${ms(tSafer)} (failed after retry)`);
      }
    } else {
      console.error(`[SAFER] DOT ${dot} — fetch failed (${reason}), not retryable`);
      console.log(`[TIMING][FMCSA] SAFER HTML snapshot (DOT ${dot}): ${ms(tSafer)} (failed)`);
    }
  }

  if (!html) return {};
  return {
    phone:        parseSaferPhone(html),
    crashes:      parseSaferCrashes(html),
    oos:          parseSaferOosAverages(html),
    inspections:  parseSaferInspections(html),
    snapshotDate: parseSaferSnapshotDate(html),
    mileage:      parseSaferMileage(html),
  };
}

async function fetchGrantDate(dot, webKey) {
  const t = Date.now();
  try {
    const r = await fetchFmcsa(fmcsaUrl(`/carriers/${dot}/authority`, webKey));
    const result = r.ok ? extractGrantDate(await r.json()) : '';
    console.log(`[TIMING][FMCSA] QCMobile authority (DOT ${dot}): ${ms(t)}`);
    return result;
  } catch (_) {
    console.log(`[TIMING][FMCSA] QCMobile authority (DOT ${dot}): ${ms(t)} (failed)`);
    return '';
  }
}

// ── Exported core lookup functions (used by /api/lookup combined endpoint) ───

export async function fmcsaDotLookup(dot, webKey) {
  const tTotal = Date.now();
  console.log(`[TIMING][FMCSA] DOT ${dot}: wave 1 start — carrier + docket-numbers in parallel`);
  const tWave1 = Date.now();
  const [carrierRes, docketRes] = await Promise.all([
    fetchFmcsa(fmcsaUrl(`/carriers/${dot}`, webKey)),
    fetchFmcsa(fmcsaUrl(`/carriers/${dot}/docket-numbers`, webKey)),
  ]);
  console.log(`[TIMING][FMCSA] DOT ${dot}: wave 1 (carrier+docket parallel): ${ms(tWave1)}`);

  if (carrierRes.status === 404) {
    const err = new Error(`DOT ${dot} not found in FMCSA database`); err.httpStatus = 404; throw err;
  }
  if (!carrierRes.ok) throw new Error(`FMCSA API HTTP ${carrierRes.status} for DOT ${dot}`);

  const c = (await carrierRes.json())?.content?.carrier;
  if (!c) { const err = new Error('FMCSA returned no carrier record for that DOT'); err.httpStatus = 404; throw err; }

  const docketJson = docketRes.ok ? await docketRes.json() : null;

  const tWave2 = Date.now();
  const [authorityGrantDate, saferData] = await Promise.all([
    fetchGrantDate(dot, webKey),
    fetchSaferData(dot),
  ]);
  console.log(`[TIMING][FMCSA] DOT ${dot}: wave 2 (authority+SAFER parallel): ${ms(tWave2)}`);
  console.log(`[TIMING][FMCSA] DOT ${dot}: total: ${ms(tTotal)}`);
  return buildPayload(c, dot, docketJson, authorityGrantDate, saferData);
}

export async function fmcsaMcLookup(mc, webKey) {
  const docketRes = await fetchFmcsa(fmcsaUrl(`/carriers/docket-number/${mc}`, webKey));
  if (docketRes.status === 404) { const e = new Error(`MC ${mc} not found in FMCSA database`); e.httpStatus = 404; throw e; }
  if (!docketRes.ok) throw new Error(`FMCSA API HTTP ${docketRes.status} for MC ${mc}`);

  // GET /carriers/docket-number/{mc} returns the carrier at content directly
  // (no .carrier wrapper), unlike GET /carriers/{dot} which uses content.carrier.
  // Accept both shapes for resilience.
  const json = await docketRes.json();
  const c = json?.content?.carrier ?? json?.content;
  if (!c || typeof c !== 'object' || !c.dotNumber) {
    console.error('[FMCSA] MC', mc, 'docket lookup: unexpected response —', JSON.stringify(json).slice(0, 300));
    const e = new Error('FMCSA returned no carrier record for that MC number'); e.httpStatus = 404; throw e;
  }

  const dot = String(c.dotNumber);
  const [docketsRes, authorityGrantDate, saferData] = await Promise.all([
    fetchFmcsa(fmcsaUrl(`/carriers/${dot}/docket-numbers`, webKey)).then(r => r.ok ? r.json() : null),
    fetchGrantDate(dot, webKey),
    fetchSaferData(dot),
  ]);
  return buildPayload(c, dot, docketsRes, authorityGrantDate, saferData);
}

export { getWebKey };

// ── DOT lookup ────────────────────────────────────────────────────────────────
router.get('/dot/:dot', async (req, res, next) => {
  try {
    const webKey = getWebKey();
    if (!webKey) return res.status(503).json({ error: 'FMCSA web key not configured — set FMCSA_WEBKEY in .env' });
    const dot = req.params.dot.replace(/\D/g, '');
    if (!dot) return res.status(400).json({ error: 'Invalid DOT number' });
    const result = await fmcsaDotLookup(dot, webKey);
    res.json(result);
  } catch (e) {
    if (isNetworkError(e)) return res.status(503).json({ cannotVerify: true, lastAttemptAt: new Date().toISOString(), error: e.message });
    if (e.httpStatus) return res.status(e.httpStatus).json({ error: e.message });
    next(e);
  }
});

// ── MC number lookup ──────────────────────────────────────────────────────────
router.get('/mc/:mc', async (req, res, next) => {
  try {
    const webKey = getWebKey();
    if (!webKey) return res.status(503).json({ error: 'FMCSA web key not configured — set FMCSA_WEBKEY in .env' });
    const mc = req.params.mc.replace(/^(MC|FF)/i, '').replace(/\D/g, '');
    if (!mc) return res.status(400).json({ error: 'Invalid MC number' });
    const result = await fmcsaMcLookup(mc, webKey);
    res.json(result);
  } catch (e) {
    if (isNetworkError(e)) return res.status(503).json({ cannotVerify: true, lastAttemptAt: new Date().toISOString(), error: e.message });
    if (e.httpStatus) return res.status(e.httpStatus).json({ error: e.message });
    next(e);
  }
});

// ── Legacy: keep /:dot working so existing bookmarks don't break ──────────────
router.get('/:dot', async (req, res, next) => {
  try {
    const webKey = getWebKey();
    if (!webKey) return res.status(503).json({ error: 'FMCSA web key not configured — set FMCSA_WEBKEY in .env' });

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
