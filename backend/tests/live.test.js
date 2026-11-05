// Live SAFER checks — read-only, never writes to DB, never calls the backend server.
// Fetches the public SAFER HTML snapshot for 6 known DOTs and validates:
//   1. The production parsers (from fmcsa.js) don't crash on live data
//   2. OOS % is internally consistent: shown % ≈ OOS inspections / total inspections × 100
//   3. National averages are within a sane range
//   4. Crash counts and snapshot date parse without error
//
// Network failures → SKIP (not FAIL) so offline rule tests still pass cleanly.

import {
  parseSaferInspections,
  parseSaferOosAverages,
  parseSaferCrashes,
  parseSaferSnapshotDate,
} from '../routes/fmcsa.js';

const SAFER_BASE = 'https://safer.fmcsa.dot.gov';

const DOTS = [
  '2939905',
  '190174',
  '2640993',
  '4494929',
  '4192031',
  '1835635',
];

function isNetworkError(e) {
  return (
    e?.name === 'TimeoutError' ||
    e?.name === 'AbortError'   ||
    e?.code === 'ECONNREFUSED' ||
    e?.code === 'ENOTFOUND'    ||
    e?.code === 'ECONNRESET'
  );
}

async function fetchSafer(dot) {
  const url = `${SAFER_BASE}/query.asp?searchtype=ANY&query_type=queryCarrierSnapshot&query_param=USDOT&query_string=${dot}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw Object.assign(new Error(`SAFER HTTP ${res.status}`), { _status: res.status });
  return res.text();
}

async function checkDot(dot) {
  const name = `DOT ${dot}`;
  let html;

  try {
    html = await fetchSafer(dot);
  } catch (e) {
    if (isNetworkError(e) || e._status >= 500) {
      return { name, pass: false, skip: true, error: `SAFER unreachable: ${e.message}` };
    }
    return { name, pass: false, error: `fetch failed: ${e.message}` };
  }

  const findings = [];

  try {
    // ── Inspections + OOS rates ───────────────────────────────────────────────
    const insp = parseSaferInspections(html);

    if (insp !== null) {
      // Vehicle OOS math: shown % should equal OOS count / total count × 100 (±0.5 rounding)
      if (insp.vehicleInsp > 0 && insp.vehicleOosPct != null && insp.vehicleOosInsp != null) {
        const computed = (insp.vehicleOosInsp / insp.vehicleInsp) * 100;
        const diff     = Math.abs(insp.vehicleOosPct - computed);
        if (diff >= 0.6) {
          findings.push(
            `truck OOS math mismatch: table shows ${insp.vehicleOosPct}% ` +
            `but ${insp.vehicleOosInsp}/${insp.vehicleInsp} = ${computed.toFixed(2)}% (diff ${diff.toFixed(2)})`
          );
        }
      }

      // Driver OOS math
      if (insp.driverInsp > 0 && insp.driverOosPct != null && insp.driverOosInsp != null) {
        const computed = (insp.driverOosInsp / insp.driverInsp) * 100;
        const diff     = Math.abs(insp.driverOosPct - computed);
        if (diff >= 0.6) {
          findings.push(
            `driver OOS math mismatch: table shows ${insp.driverOosPct}% ` +
            `but ${insp.driverOosInsp}/${insp.driverInsp} = ${computed.toFixed(2)}% (diff ${diff.toFixed(2)})`
          );
        }
      }

      // No negative counts
      for (const [k, v] of Object.entries(insp)) {
        if (typeof v === 'number' && v < 0) findings.push(`${k} is negative: ${v}`);
      }
    }

    // ── National OOS averages ─────────────────────────────────────────────────
    const oos = parseSaferOosAverages(html);
    if (oos === null) {
      findings.push('national OOS averages not found (parser returned null — layout may have changed)');
    } else {
      const truck  = parseFloat(oos.truckNatAvg);
      const driver = parseFloat(oos.driverNatAvg);
      if (isNaN(truck))                      findings.push(`truck national avg is NaN: ${oos.truckNatAvg}`);
      else if (truck < 1 || truck > 50)      findings.push(`truck national avg out of range 1–50: ${truck}`);
      if (isNaN(driver))                     findings.push(`driver national avg is NaN: ${oos.driverNatAvg}`);
      else if (driver < 0.5 || driver > 20)  findings.push(`driver national avg out of range 0.5–20: ${driver}`);
    }

    // ── Crashes ───────────────────────────────────────────────────────────────
    const crashes = parseSaferCrashes(html);
    if (crashes !== null) {
      if (crashes.count < 0)                                     findings.push(`crash count negative: ${crashes.count}`);
      if (crashes.fatal < 0 || crashes.injury < 0 || crashes.tow < 0) findings.push('crash sub-count negative');
      const subTotal = crashes.fatal + crashes.injury + crashes.tow;
      if (crashes.count > 0 && subTotal === 0)                   findings.push(`crash count ${crashes.count} but all sub-counts are 0`);
    }

    // ── Snapshot date ─────────────────────────────────────────────────────────
    const snap = parseSaferSnapshotDate(html);
    if (snap !== null) {
      const parsed = new Date(snap);
      if (isNaN(parsed.getTime())) findings.push(`snapshot date unparseable: "${snap}"`);
    }

  } catch (e) {
    findings.push(`parser threw: ${e.message}`);
  }

  if (findings.length > 0) {
    return { name, pass: false, error: findings.join(' | ') };
  }
  return { name, pass: true };
}

export async function runAll() {
  // Run all 6 DOTs in parallel — SAFER is a public read-only endpoint
  return Promise.all(DOTS.map(checkDot));
}
