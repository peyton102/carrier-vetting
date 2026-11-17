// GET /api/insurance/cancellation/:dot
// Reads from the insurance_cancellations cache table.
// "Not reviewed" = table is empty (daily refresh job has never run).
// "No pending" = table has data but no row for this DOT (job has run, carrier clean).
// Never returns false/No when we have no data.

import express from 'express';
import { createClient } from '@supabase/supabase-js';

const router = express.Router();

const SOCRATA_BASE        = 'https://data.transportation.gov/resource';
const INSUR_ACTIVE_DS     = 'c5y8-a4uz';   // Active BIPD filings (BMC-35, BMC-91, BMC-91X)
const INSUR_HISTORY_DS    = '3uet-3z4i';   // Historical BIPD filings
const HISTORY_TIMEOUT_MS  = 5_000;          // Per-lookup Socrata timeout for history

function getSupabase() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

function daysUntil(dateStr) {
  if (!dateStr) return null;
  const exp = new Date(dateStr + 'T00:00:00Z');
  if (isNaN(exp.getTime())) return null;
  const now = new Date();
  const todayMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.floor((exp.getTime() - todayMs) / 86_400_000);
}

function ms(start) { return `${Date.now() - start}ms`; }

// Convert YYYYMMDD or YYYY-MM-DD to MM/DD/YYYY for display
function fmtDate(raw) {
  if (!raw) return '';
  const s = String(raw).replace(/-/g, '');
  if (s.length < 8) return raw;
  return `${s.slice(4, 6)}/${s.slice(6, 8)}/${s.slice(0, 4)}`;
}

// ── Insurance history — Socrata per-DOT query ───────────────────────────────
// Queries both the active (c5y8-a4uz) and history (3uet-3z4i) datasets for a
// single DOT's BMC-91/91X filings over the last 12 months.  Runs with its own
// time cap so a slow Socrata response never blocks the lookup.
//
// Returns { currentInsurer, currentPolicyNo, currentPolicyStartDate,
//           insurerChanges12mo, timeline, policyStartedRecently }
// or { historyNotReviewed: true, reason } on timeout/error.

export async function fetchInsuranceHistory(dot) {
  const t = Date.now();
  try {
    const cutoff = new Date();
    cutoff.setFullYear(cutoff.getFullYear() - 1);
    const cutoffYmd = cutoff.toISOString().slice(0, 10);

    // Query both datasets in parallel — all BIPD filings (ins_type_code='1') for this DOT.
    // BMC-91, BMC-91X, BMC-82 = active policies; BMC-35 = cancellation notice (not coverage).
    const where = `usdot_number='${dot}' AND ins_type_code='1'`;
    const fields = '$select=insurance_company_name,policy_no,effective_date,trans_date,ins_form_code';
    const order  = '$order=effective_date DESC';
    const limit  = '$limit=100';

    const [activeRes, historyRes] = await Promise.all([
      fetch(
        `${SOCRATA_BASE}/${INSUR_ACTIVE_DS}.json?$where=${encodeURIComponent(where)}&${fields}&${order}&${limit}`,
        { signal: AbortSignal.timeout(HISTORY_TIMEOUT_MS) }
      ),
      fetch(
        `${SOCRATA_BASE}/${INSUR_HISTORY_DS}.json?$where=${encodeURIComponent(where)}&${fields}&${order}&${limit}`,
        { signal: AbortSignal.timeout(HISTORY_TIMEOUT_MS) }
      ),
    ]);

    const [activeRows, historyRows] = await Promise.all([
      activeRes.ok ? activeRes.json() : [],
      historyRes.ok ? historyRes.json() : [],
    ]);

    // Merge + deduplicate by (company, effective_date, policy_no, formCode)
    const POLICY_FORMS = new Set(['BMC-91', 'BMC-91X', 'BMC-82']);
    const seen = new Set();
    const all = [];
    for (const row of [...activeRows, ...historyRows]) {
      const eff      = String(row.effective_date ?? '').slice(0, 10);
      const company  = (row.insurance_company_name ?? '').trim();
      const policyNo = (row.policy_no ?? '').trim();
      const formCode = (row.ins_form_code ?? '').trim();
      const key = `${company}|${eff}|${policyNo}|${formCode}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const isPolicy = POLICY_FORMS.has(formCode);
      all.push({ date: fmtDate(eff), rawDate: eff, company, policyNo, formCode, isPolicy });
    }

    // Sort by effective date descending
    all.sort((a, b) => b.rawDate.localeCompare(a.rawDate));

    // Policies only (BMC-91, 91X, 82) — BMC-35 is a cancellation notice, not coverage
    const policies = all.filter(r => r.isPolicy);
    const current = policies[0] || null;

    // Filter to last 12 months for churn count (policies only)
    const recent = all.filter(r => r.rawDate >= cutoffYmd);
    const recentPolicies = policies.filter(r => r.rawDate >= cutoffYmd);
    const distinctInsurers = new Set(recentPolicies.map(r => r.company.toUpperCase()).filter(Boolean));

    // Policy started recently? (most recent filing within 30 days)
    let policyStartedRecently = false;
    if (current?.rawDate) {
      // daysUntil expects YYYY-MM-DD; rawDate is YYYYMMDD — convert
      const isoDate = current.rawDate.replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3');
      const daysSince = daysUntil(isoDate);
      if (daysSince !== null) {
        const daysAgo = -daysSince;
        if (daysAgo >= 0 && daysAgo <= 30) policyStartedRecently = true;
      }
    }

    console.log(`[TIMING][INSUR] Socrata insurance history (DOT ${dot}): ${ms(t)} — ${all.length} filings, ${distinctInsurers.size} distinct insurers (12mo)`);

    return {
      currentInsurer:         current?.company || null,
      currentPolicyNo:        current?.policyNo || null,
      currentPolicyStartDate: current?.date || null,
      insurerChanges12mo:     distinctInsurers.size,
      timeline:               recent,
      policyStartedRecently,
    };
  } catch (e) {
    const isTimeout = e?.name === 'TimeoutError' || e?.name === 'AbortError';
    const reason    = isTimeout ? 'FMCSA slow to respond' : e.message;
    console.warn(`[INSUR] Insurance history for DOT ${dot} failed (${ms(t)}): ${reason}`);
    return { historyNotReviewed: true, reason };
  }
}

// Exported for use by /api/lookup combined endpoint.
export async function insuranceLookup(dot, supabase) {
  try {
    const tCount = Date.now();
    const { count, error: countErr } = await supabase
      .from('insurance_cancellations')
      .select('*', { count: 'exact', head: true });
    console.log(`[TIMING][INSUR] Supabase insurance_cancellations count (DOT ${dot}): ${ms(tCount)}`);
    if (countErr) throw countErr;
    if (!count) return { notReviewed: true };

    // Fetch cancellation row + insurance history in parallel
    const [rowResult, history] = await Promise.all([
      (async () => {
        const tRow = Date.now();
        const { data: row, error: rowErr } = await supabase
          .from('insurance_cancellations')
          .select('*')
          .eq('dot_number', dot)
          .maybeSingle();
        console.log(`[TIMING][INSUR] Supabase insurance_cancellations row (DOT ${dot}): ${ms(tRow)}`);
        if (rowErr) throw rowErr;
        return row;
      })(),
      fetchInsuranceHistory(dot),
    ]);

    const base = !rowResult
      ? { bipdCancelPending: false, bipdCancelLapsed: false }
      : rowResult.status === 'lapsed'
        ? { bipdCancelPending: false, bipdCancelLapsed: true, effectiveDate: rowResult.effective_date, insuranceCompany: rowResult.insurance_company }
        : { bipdCancelPending: true, bipdCancelLapsed: false, effectiveDate: rowResult.effective_date, transDate: rowResult.trans_date, insuranceCompany: rowResult.insurance_company, daysUntil: daysUntil(rowResult.effective_date) };

    return { ...base, history };
  } catch (e) {
    console.error('[INSURANCE] cancellation lookup error:', e.message);
    return { notReviewed: true };
  }
}

router.get('/cancellation/:dot', async (req, res) => {
  const dot = req.params.dot.replace(/\D/g, '');
  if (!dot) return res.status(400).json({ error: 'Invalid DOT number' });
  const result = await insuranceLookup(dot, getSupabase());
  res.json(result);
});

export default router;
