// ── Broker Authority Check ────────────────────────────────────────────────────
// GET /api/broker-check/:mc
//
// Checks broker authority and BMC-84 surety bond using ONLY the FMCSA public API.
// SaferWatch / Truckstop data is NEVER used here — isolated per reseller compliance terms.
// Logs every check to broker_check_logs for audit trail.

import express from 'express';
import { createClient } from '@supabase/supabase-js';

const router = express.Router();
const BASE   = 'https://mobile.fmcsa.dot.gov/qc/services';

function fmcsaUrl(path, webKey) {
  return `${BASE}${path}?webKey=${encodeURIComponent(webKey)}`;
}

function getSupabase() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

// Extract BMC-84 surety bond from FMCSA insurance response.
// Returns null if not found.
function extractBmc84Bond(insuranceJson) {
  const items = insuranceJson?.content;
  if (!Array.isArray(items)) return null;

  const entry = items.find(i =>
    /BMC.?84/i.test(i.typeDesc || '') ||
    /surety.*bond/i.test(i.typeDesc || '') ||
    /BMC.?84/i.test(i.insuranceType || '')
  );

  if (!entry) return null;

  const amount = parseFloat(String(entry.insuranceAmount || '0').replace(/[$,\s]/g, '')) || 0;
  return {
    amount,
    insurer:        entry.insurerName    || entry.companyName || '',
    policyNumber:   entry.policyNumber   || '',
    effectiveDate:  entry.effectiveDate  || '',
    expirationDate: entry.expirationDate || '',
    typeDesc:       entry.typeDesc       || '',
  };
}

// Normalize single-letter FMCSA broker authority code to readable string
function normalizeBrokerAuth(raw) {
  const s = (raw || '').toUpperCase().trim();
  if (s === 'A') return 'Active';
  if (s === 'I') return 'Inactive';
  if (s === 'R') return 'Revocation Pending';
  if (s === 'N' || s === '') return 'None';
  return raw || 'None';
}

// ── Route ─────────────────────────────────────────────────────────────────────

router.get('/:mc', async (req, res, next) => {
  const webKey = process.env.FMCSA_WEBKEY;
  if (!webKey) return res.status(503).json({ ok: false, error: 'FMCSA_WEBKEY not configured' });

  const mc = req.params.mc.replace(/^(MC|FF)/i, '').replace(/\D/g, '');
  if (!mc) return res.status(400).json({ ok: false, error: 'Invalid MC number' });

  const tenantId = req.auth.tenant;

  try {
    // ── Fetch carrier record by MC number ──────────────────────────────────
    const docketRes = await fetch(fmcsaUrl(`/carriers/docket-number/${mc}`, webKey), {
      signal: AbortSignal.timeout(12_000),
    });

    if (docketRes.status === 404) {
      return res.status(404).json({ ok: false, error: `MC ${mc} not found in FMCSA database` });
    }
    if (!docketRes.ok) throw new Error(`FMCSA API HTTP ${docketRes.status}`);

    const docketJson = await docketRes.json();
    console.log('[BROKER CHECK RAW]', JSON.stringify(docketJson)?.slice(0, 600));

    // FMCSA returns carrier data under content.carrier for dual-registered entities,
    // or directly under content for broker-only entities.
    const content = docketJson?.content;
    // FMCSA returns content as an array of { _links, carrier } objects
    const c = Array.isArray(content)
      ? content[0]?.carrier
      : content?.carrier ?? (content?.dotNumber ? content : null);
    if (!c || !c.dotNumber) {
      return res.status(404).json({ ok: false, error: 'FMCSA returned no record for that MC number' });
    }

    const dot = String(c.dotNumber);

    // ── Fetch insurance (BMC-84) in parallel ───────────────────────────────
    const insRes  = await fetch(fmcsaUrl(`/carriers/${dot}/insurance`, webKey), {
      signal: AbortSignal.timeout(12_000),
    });
    console.log('[BROKER INS STATUS]', insRes.status);
    const insText = await insRes.text();
    console.log('[BROKER INS RAW]', insText.slice(0, 1000));
    let insData = null;
    try { insData = JSON.parse(insText); } catch (_) {};
    const bond    = extractBmc84Bond(insData);

    // ── Verdict logic ──────────────────────────────────────────────────────
    const BOND_REQUIRED      = 75_000;
    const brokerAuthStatus   = normalizeBrokerAuth(c.brokerAuthorityStatus);
    const hasActiveBrokerAuth = brokerAuthStatus === 'Active';
    const hasBond            = bond && bond.amount >= BOND_REQUIRED;

    const reasons = [];
    if (!hasActiveBrokerAuth) {
      reasons.push(`Broker authority is "${brokerAuthStatus}" — must be Active`);
    }
    if (!bond) {
      reasons.push('No BMC-84 surety bond found in FMCSA records');
    } else if (!hasBond) {
      reasons.push(
        `BMC-84 bond $${bond.amount.toLocaleString()} is below required $${BOND_REQUIRED.toLocaleString()}`
      );
    }

    const verdict = reasons.length === 0 ? 'PASS' : 'FAIL';

    // ── Audit log ──────────────────────────────────────────────────────────
    await getSupabase()
      .from('broker_check_logs')
      .insert({
        tenant_id:   tenantId,
        mc_number:   mc,
        broker_name: c.legalName || '',
        dot_number:  dot,
        verdict,
        reasons:     reasons.length ? reasons : null,
        broker_data: {
          legalName:            c.legalName,
          dbaName:              c.dbaName,
          dotNumber:            dot,
          mcNumber:             mc,
          brokerAuthorityStatus: c.brokerAuthorityStatus,
          allowedToOperate:     c.allowedToOperate,
          phyCity:              c.phyCity,
          phyState:             c.phyState,
        },
        bond_data: bond,
      });

    res.json({
      ok: true,
      verdict,
      reasons,
      broker: {
        legalName:            c.legalName   || '',
        dbaName:              c.dbaName     || '',
        dotNumber:            dot,
        mcNumber:             mc,
        brokerAuthorityStatus: brokerAuthStatus,
        allowedToOperate:     c.allowedToOperate,
        phyCity:              c.phyCity     || '',
        phyState:             c.phyState    || '',
      },
      bond: bond
        ? { ...bond, meetsRequirement: hasBond, required: BOND_REQUIRED }
        : null,
    });

  } catch (e) {
    // Best-effort error log
    try {
      await getSupabase()
        .from('broker_check_logs')
        .insert({ tenant_id: tenantId, mc_number: mc, verdict: 'ERROR', reasons: [e.message] });
    } catch (_) { /* non-fatal */ }

    next(e);
  }
});

export default router;
