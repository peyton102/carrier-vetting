// ── Carrier Monitoring Job ─────────────────────────────────────────────────────
// Re-checks FMCSA + SaferWatch for every active (in-transit) monitored load.
// Runs on a configurable interval (default 4 h). Alerts via email + DB on change.
// FMCSA unreachable → "Cannot Verify" alert (never a silent pass).
// FMCSA key is per-tenant (tenant_credentials). SaferWatch uses operator env keys.

import nodemailer    from 'nodemailer';
import { XMLParser } from 'fast-xml-parser';
import { fetchSettings } from './settings.js';
import { decrypt } from './encryption.js';

const FMCSA_BASE = 'https://mobile.fmcsa.dot.gov/qc/services';
const SW_BASE    = 'https://www.saferwatch.com/webservices/CarrierService32.php';

// ── FMCSA helpers ─────────────────────────────────────────────────────────────

function fmcsaUrl(path, webKey) {
  return `${FMCSA_BASE}${path}?webKey=${webKey}&type=json`;
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

async function fetchFMCSASnapshot(dot, webKey) {
  const res = await fetch(fmcsaUrl(`/carriers/${dot}`, webKey), {
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 404) throw new Error(`DOT ${dot} not found in FMCSA`);
  if (!res.ok) throw new Error(`FMCSA HTTP ${res.status}`);
  const json = await res.json();
  const c = json?.content?.carrier || json?.content;
  if (!c) throw new Error('FMCSA returned no carrier record');
  return {
    authorityStatus: normalizeFMCSAAuthority(c),
    safetyRating:    normalizeFMCSARating(c.safetyRating),
  };
}

// ── SaferWatch helpers ────────────────────────────────────────────────────────

function str(v) { return v != null ? String(v) : ''; }

function swUrl(dot, serviceKey, customerKey) {
  const p = new URLSearchParams({
    Action:      'CarrierLookup',
    ServiceKey:  serviceKey,
    CustomerKey: customerKey,
    number:      dot,
  });
  return `${SW_BASE}?${p}`;
}

async function fetchSaferWatchSnapshot(dot) {
  const serviceKey  = process.env.SAFERWATCH_SERVICE_KEY;
  const customerKey = process.env.SAFERWATCH_CUSTOMER_KEY;
  if (!serviceKey || !customerKey) return null;

  const res = await fetch(swUrl(dot, serviceKey, customerKey), {
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) throw new Error(`SaferWatch HTTP ${res.status}`);

  const xml    = await res.text();
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
  const parsed = parser.parse(xml);
  const root   = parsed['CarrierService32.CarrierLookup'];
  if (!root) throw new Error('Unexpected SaferWatch XML structure');

  const wrapper = root.ResponseDO || {};
  if (str(wrapper.status) !== 'APPROVED' || str(wrapper.action) !== 'OK') {
    throw new Error(`SaferWatch: ${str(wrapper.displayMsg) || str(wrapper.techMsg) || 'non-OK response'}`);
  }

  const details = root.CarrierDetails;
  if (!details) throw new Error('SaferWatch: no CarrierDetails');

  const insp  = details.Inspection || {};
  const toNum = (v) => { const n = parseFloat(v); return isNaN(n) ? NaN : n; };
  return {
    truckOosPct:  toNum(insp.inspectVehOOSPctUS),
    driverOosPct: toNum(insp.inspectDrvOOSPctUS),
  };
}

// ── Issue checking (uses tenant settings) ─────────────────────────────────────

function checkFMCSASnapshot(snap, settings) {
  const issues = [];
  const bad = ['inactive', 'suspended', 'not authorized', 'revocation pending'];
  if (bad.includes(snap.authorityStatus.toLowerCase())) {
    issues.push(`Operating authority changed to "${snap.authorityStatus}" — carrier may no longer operate legally`);
  }
  if (settings.blockConditional    && snap.safetyRating === 'Conditional') {
    issues.push('FMCSA safety rating changed to Conditional');
  }
  if (settings.blockUnsatisfactory && snap.safetyRating === 'Unsatisfactory') {
    issues.push('FMCSA safety rating changed to Unsatisfactory');
  }
  return issues;
}

function checkOOSSnapshot(snap, settings) {
  const issues         = [];
  const hardBlockTruck = parseFloat(settings.oosHardBlockTruck)  || 35;
  const mult           = parseFloat(settings.oosRateMultiplier)  || 2;
  const nationalTruck  = 5.5;
  const nationalDriver = 5.2;

  // Hard block threshold takes priority over the multiplier check
  if (!isNaN(snap.truckOosPct) && snap.truckOosPct > hardBlockTruck) {
    issues.push(`Vehicle OOS rate ${snap.truckOosPct.toFixed(2)}% now exceeds the ${hardBlockTruck}% hard block`);
  } else if (!isNaN(snap.truckOosPct) && snap.truckOosPct >= nationalTruck * mult) {
    issues.push(`Vehicle OOS rate ${snap.truckOosPct.toFixed(2)}% now exceeds ${mult}x national average (${(nationalTruck * mult).toFixed(1)}%)`);
  }
  if (!isNaN(snap.driverOosPct) && snap.driverOosPct >= nationalDriver * mult) {
    issues.push(`Driver OOS rate ${snap.driverOosPct.toFixed(2)}% now exceeds ${mult}x national average (${(nationalDriver * mult).toFixed(1)}%)`);
  }
  return issues;
}

// ── Email ─────────────────────────────────────────────────────────────────────

async function sendAlertEmail(load, issues, alertType, tenantEmail) {
  if (!process.env.SMTP_HOST || !tenantEmail) return;

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

  await transport.sendMail({ from, to: tenantEmail, subject, html });
  transport.close();
}

// ── Core check ────────────────────────────────────────────────────────────────

async function checkSingleLoad(load, settings, tenantEmail, supabase, webKey) {
  let issues    = [];
  let alertType = null;
  let newStatus = 'ok';

  try {
    // FMCSA: primary check — failure triggers cannot_verify, not a pass
    const fmcsaSnap = await fetchFMCSASnapshot(load.dot_number, webKey);
    issues.push(...checkFMCSASnapshot(fmcsaSnap, settings));

    // SaferWatch: secondary — failure is logged, not alerted on its own
    try {
      const swSnap = await fetchSaferWatchSnapshot(load.dot_number);
      if (swSnap) issues.push(...checkOOSSnapshot(swSnap, settings));
    } catch (swErr) {
      console.warn(`[MONITOR] SaferWatch unavailable for DOT ${load.dot_number}: ${swErr.message}`);
    }

    if (issues.length > 0) { alertType = 'status_change'; newStatus = 'alert'; }
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
      await sendAlertEmail(load, issues, alertType, tenantEmail);
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
    let settings, tenantEmail, webKey;
    try {
      [settings] = await Promise.all([fetchSettings(tid)]);

      const [tenantRow, credRow] = await Promise.all([
        supabase.from('tenants').select('email').eq('slug', tid).single(),
        supabase.from('tenant_credentials').select('fmcsa_webkey').eq('tenant_slug', tid).single(),
      ]);

      tenantEmail = tenantRow.data?.email ?? null;
      webKey      = credRow.data?.fmcsa_webkey ? decrypt(credRow.data.fmcsa_webkey) : null;
    } catch (e) {
      console.warn(`[MONITOR] Could not fetch data for tenant ${tid}: ${e.message}`);
      continue;
    }

    if (!webKey) {
      console.warn(`[MONITOR] Tenant ${tid} has no FMCSA web key — skipping ${tenantLoads.length} load(s)`);
      continue;
    }

    for (const load of tenantLoads) {
      await checkSingleLoad(load, settings, tenantEmail, supabase, webKey);
    }
  }
}

// ── Watched-carrier inspection polling ───────────────────────────────────────
// Polls FMCSA inspection records for every active watched carrier.
// Detects net-new inspections with OOS violations, auto-blocks the carrier,
// and emails the tenant when thresholds are crossed.

async function fetchFMCSAInspections(dot, webKey) {
  const url = `${FMCSA_BASE}/carriers/${dot}/inspections?webKey=${webKey}&type=json`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`FMCSA inspections HTTP ${res.status} for DOT ${dot}`);
  const json  = await res.json();
  const items = json?.content;
  if (Array.isArray(items)) return items;
  if (Array.isArray(items?.inspection)) return items.inspection;
  return [];
}

async function fetchFMCSAOosRates(dot, webKey) {
  const res = await fetch(fmcsaUrl(`/carriers/${dot}`, webKey), {
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`FMCSA HTTP ${res.status}`);
  const json = await res.json();
  const c    = json?.content?.carrier || json?.content;
  if (!c) throw new Error('FMCSA returned no carrier record');
  return {
    truckOosPct:  c.vehicleOosRate != null ? parseFloat(c.vehicleOosRate) : NaN,
    driverOosPct: c.driverOosRate  != null ? parseFloat(c.driverOosRate)  : NaN,
    inspCount:    c.vehicleInsp    != null ? parseInt(c.vehicleInsp, 10)  : 0,
  };
}

async function sendBlockAlertEmail(carrier, newOosInspections, issues, tenantEmail) {
  if (!process.env.SMTP_HOST || !tenantEmail) {
    console.warn('[MONITOR:WATCH] SMTP not configured or no tenant email — block alert not emailed');
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

  const inspRows = newOosInspections.map(i => `
    <tr>
      <td style="padding:4px 8px;border:1px solid #e5e7eb">${i.inspDate || '—'}</td>
      <td style="padding:4px 8px;border:1px solid #e5e7eb">${i.reportState || '—'}</td>
      <td style="padding:4px 8px;border:1px solid #e5e7eb">Level ${i.level || '—'}</td>
      <td style="padding:4px 8px;border:1px solid #e5e7eb">
        ${i.vehicleOosViolations ?? 0} vehicle / ${i.driverOosViolations ?? 0} driver OOS
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

  await transport.sendMail({ from, to: tenantEmail, subject, html });
  transport.close();
}

async function checkWatchedCarrier(carrier, settings, tenantEmail, supabase, webKey) {
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

  // New OOS inspections — re-fetch aggregate rates (FMCSA computes these with time-weighting)
  let stats = { truckOosPct: NaN, driverOosPct: NaN, inspCount: inspections.length };
  try {
    stats = await fetchFMCSAOosRates(carrier.dot_number, webKey);
  } catch (err) {
    console.warn(`[MONITOR:WATCH] DOT ${carrier.dot_number} OOS rate fetch failed: ${err.message}`);
  }

  baseUpdate.last_truck_oos_pct     = isNaN(stats.truckOosPct)  ? null : stats.truckOosPct;
  baseUpdate.last_driver_oos_pct    = isNaN(stats.driverOosPct) ? null : stats.driverOosPct;
  baseUpdate.last_inspection_count  = stats.inspCount || inspections.length;

  const hardBlockTruck  = parseFloat(settings.oosHardBlockTruck)  || 35;
  const hardBlockDriver = parseFloat(settings.oosHardBlockDriver) || 7;

  const issues = [];
  if (!isNaN(stats.truckOosPct) && stats.truckOosPct > hardBlockTruck) {
    issues.push(
      `Vehicle OOS rate ${stats.truckOosPct.toFixed(1)}% now exceeds the ` +
      `${hardBlockTruck}% hard-block threshold`
    );
  }
  if (!isNaN(stats.driverOosPct) && stats.driverOosPct > hardBlockDriver) {
    issues.push(
      `Driver OOS rate ${stats.driverOosPct.toFixed(1)}% now exceeds the ` +
      `${hardBlockDriver}% hard-block threshold`
    );
  }
  for (const i of newOosInspections) {
    issues.push(
      `New OOS inspection: ${i.inspDate || '?'}, ${i.reportState || '?'}, ` +
      `Level ${i.level || '?'} — ${vOos(i)} vehicle OOS, ${dOos(i)} driver OOS ` +
      `(Report #${reportNum(i) || '?'})`
    );
  }

  let thresholdType  = 'new_oos_inspection';
  let thresholdValue = null;
  let actualValue    = null;
  if (!isNaN(stats.truckOosPct) && stats.truckOosPct > hardBlockTruck) {
    thresholdType  = 'truck_oos';
    thresholdValue = hardBlockTruck;
    actualValue    = stats.truckOosPct;
  } else if (!isNaN(stats.driverOosPct) && stats.driverOosPct > hardBlockDriver) {
    thresholdType  = 'driver_oos';
    thresholdValue = hardBlockDriver;
    actualValue    = stats.driverOosPct;
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
    violation_details: { newInspections, newOosInspections, stats },
  });
  if (blockErr) console.error('[MONITOR:WATCH] Block insert failed:', blockErr.message);

  await supabase.from('watched_carriers').update(baseUpdate).eq('id', carrier.id);

  try {
    await sendBlockAlertEmail(carrier, newOosInspections, issues, tenantEmail);
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
    let settings, tenantEmail, webKey;
    try {
      [settings] = await Promise.all([fetchSettings(tid)]);

      const [tenantRow, credRow] = await Promise.all([
        supabase.from('tenants').select('email').eq('slug', tid).single(),
        supabase.from('tenant_credentials').select('fmcsa_webkey').eq('tenant_slug', tid).single(),
      ]);

      tenantEmail = tenantRow.data?.email ?? null;
      webKey      = credRow.data?.fmcsa_webkey ? decrypt(credRow.data.fmcsa_webkey) : null;
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
        await checkWatchedCarrier(carrier, settings, tenantEmail, supabase, webKey);
      } catch (err) {
        console.error(`[MONITOR:WATCH] Unhandled error for DOT ${carrier.dot_number}: ${err.message}`);
      }
    }
  }
}

export function startMonitoringJob(supabase) {
  const intervalHours = parseFloat(process.env.MONITOR_INTERVAL_HOURS || '4');
  const intervalMs    = intervalHours * 60 * 60 * 1000;

  console.log(`[MONITOR] Carrier monitoring started — interval: ${intervalHours}h (per-tenant FMCSA keys)`);
  // First run 60s after startup to let connections settle
  setTimeout(() => {
    runMonitoringCheck(supabase);
    runWatchedCarriersCheck(supabase);
  }, 60_000);
  setInterval(() => {
    runMonitoringCheck(supabase);
    runWatchedCarriersCheck(supabase);
  }, intervalMs);
}
