// ── Carrier Monitoring Job ─────────────────────────────────────────────────────
// Re-checks FMCSA + SaferWatch for every active (in-transit) monitored load.
// Runs on a configurable interval (default 4 h). Alerts via email + DB on change.
// FMCSA unreachable → "Cannot Verify" alert (never a silent pass).
// Multi-tenant: each tenant's own FMCSA web key + configurable OOS thresholds.

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

export function startMonitoringJob(supabase) {
  const intervalHours = parseFloat(process.env.MONITOR_INTERVAL_HOURS || '4');
  const intervalMs    = intervalHours * 60 * 60 * 1000;

  console.log(`[MONITOR] Carrier monitoring started — interval: ${intervalHours}h (per-tenant FMCSA keys)`);
  // First run 60s after startup to let connections settle
  setTimeout(() => runMonitoringCheck(supabase), 60_000);
  setInterval(() => runMonitoringCheck(supabase), intervalMs);
}
