// GET /api/chameleon/:dot
//
// Checks FMCSA Company Census File (az4n-8mr2) for other carriers sharing the
// vetting carrier's phone, email, physical address, or officer name, then
// classifies each linked carrier as HOLD-worthy or informational.
//
// HOLD if the linked carrier "went bad" AND the bad event is recent/still active:
//   - OOS order              → oos_orders table         (daily mirror of p2mt-9ige)
//   - Involuntary revocation → safer_revocations table  (daily mirror of sa6p-acbp)
//   - Involuntary suspension → motus_suspensions table  (daily mirror of wb4f-neki)
//   - Safety rating U or C   → az4n-8mr2 (live, from CC row already fetched)
//   - Lapsed BIPD insurance  → insurance_cancellations  (daily mirror of FMCSA BMC-35)
//
// Tightened HOLD rule (isHoldWorthy):
//   condA — carrier is inactive OR bad event is still in effect (not rescinded)
//   condB — event is still active OR within chameleonLookbackDays (default 1095 = 3 yrs)
// Old/rescinded events on active carriers → informational only.
//
// Shared service: if >5 carriers share a field value, treat as dispatch/agent →
//   one summary informational entry, no individual HOLD checks.
//
// Officer rule: officer name match only counts if the linked carrier also shares
//   the vetting carrier's state, or shares phone, or shares street address.
//
// Cache: results stored in chameleon_cache for 24 h (same DOT vetted by many brokers
//   = 1 Socrata lookup per day). Response includes pulledAt timestamp.
// Retry: Socrata 429s retried up to 3× with 2s/4s backoff; persistent fail → notReviewed.

import express from 'express';
import { createClient } from '@supabase/supabase-js';
import { fetchSettings } from '../lib/settings.js';

const router = express.Router();

const SOCRATA_BASE = 'https://data.transportation.gov/resource';
const CC_DS = 'az4n-8mr2';  // Company Census File (live Socrata)
// OOS orders, revocations, and suspensions are mirrored into Supabase daily by
// monitor.js: p2mt-9ige → oos_orders | sa6p-acbp → safer_revocations | wb4f-neki → motus_suspensions

const SHARED_SERVICE_THRESHOLD = 5;  // >5 sharing same value → shared service

function socrataUrl(ds, where, select, limit) {
  const token  = process.env.SOCRATA_APP_TOKEN ?? '';
  const params = new URLSearchParams({ '$where': where, '$select': select, '$limit': String(limit) });
  if (token) params.set('$$app_token', token);
  return `${SOCRATA_BASE}/${ds}.json?${params}`;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Fetch Socrata with up to 3 attempts; backs off 2s then 4s on 429 or transient errors.
// Any persistent failure is re-thrown — callers wrap in try/catch → notReviewed fallback.
async function sq(ds, where, select, limit = 10) {
  const url = socrataUrl(ds, where, select, limit);
  let delay   = 2_000;
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (r.status === 429) throw new Error(`Socrata ${ds} rate limited`);
      if (!r.ok)            throw new Error(`Socrata ${ds} HTTP ${r.status}`);
      const j = await r.json();
      if (!Array.isArray(j)) throw new Error(`Socrata ${ds}: ${JSON.stringify(j).slice(0, 80)}`);
      return j;
    } catch (e) {
      lastErr = e;
      if (attempt < 2) { await sleep(delay); delay *= 2; }
    }
  }
  throw lastErr;
}

function esc(s) { return String(s ?? '').replace(/'/g, "''"); }
function norm(s) { return String(s ?? '').toUpperCase().trim().replace(/\s+/g, ' '); }

function fmtPhone(p) {
  const d = String(p ?? '').replace(/\D/g, '');
  if (d.length === 10) return `(${d.slice(0,3)}) ${d.slice(3,6)}-${d.slice(6)}`;
  return p;
}

function statusLabel(code) {
  return code === 'A' ? 'Active' : code === 'I' ? 'Inactive' : code === 'P' ? 'Pending' : (code ?? 'Unknown');
}

// Returns array of bad-reason objects for a given DOT number.
// OOS orders, revocations, and suspensions are read from Supabase tables (daily mirrors).
// Each reason carries:
//   stillActive  — true if the event has not been resolved/rescinded
//   eventDate    — ISO date string used for lookback window comparison (or null)
//   rescindDate  — ISO date string when it was resolved, if applicable
//
// "stillActive" semantics per type:
//   oos         — explicit: !rescind_date
//   revocation  — proxy: carrier is currently inactive (status_code='I')
//   suspension  — proxy: carrier is currently inactive
//   rating      — proxy: carrier is currently inactive
//   lapsed_bipd — always true (removed from table when replaced by new policy)
async function getBadReasons(dot, ccRow, supabase) {
  const reasons    = [];
  const isInactive = ccRow?.status_code === 'I';

  // Safety rating from CC row — no extra query needed
  if (ccRow?.safety_rating === 'U') {
    reasons.push({ type: 'rating', description: 'Safety rating: Unsatisfactory', date: null, rescindDate: null, stillActive: isInactive, eventDate: null });
  }
  if (ccRow?.safety_rating === 'C') {
    reasons.push({ type: 'rating', description: 'Safety rating: Conditional',   date: null, rescindDate: null, stillActive: isInactive, eventDate: null });
  }

  // OOS orders — Supabase mirror of p2mt-9ige (refreshed daily)
  const { data: oosRows } = await supabase
    .from('oos_orders')
    .select('oos_reason,oos_date,rescind_date')
    .eq('dot_number', dot)
    .limit(5);
  for (const o of (oosRows ?? [])) {
    const rescindDate = o.rescind_date ?? null;
    reasons.push({
      type:        'oos',
      description: `OOS order: ${o.oos_reason ?? ''}`,
      date:        o.oos_date ?? null,
      rescindDate,
      stillActive: !rescindDate,
      eventDate:   o.oos_date ?? null,
    });
  }

  // SAFER involuntary revocations — confirmed (order2_effective_date present)
  const { data: revRows } = await supabase
    .from('safer_revocations')
    .select('order_type_desc,effective_date')
    .eq('dot_number', dot)
    .limit(5);
  for (const r of (revRows ?? [])) {
    const d = r.effective_date ?? null;
    reasons.push({ type: 'revocation', description: r.order_type_desc, date: d, rescindDate: null, stillActive: isInactive, eventDate: d });
  }

  // SAFER revocation notices — order served but no effective date on record.
  // The revocation may never have taken effect (dismissed, contested, not finalised).
  // stillActive: false → condA fails for active carriers → informational only, never HOLD.
  const { data: noticeRows } = await supabase
    .from('safer_revocation_notices')
    .select('order_type_desc,serve_date')
    .eq('dot_number', dot)
    .limit(5);
  for (const n of (noticeRows ?? [])) {
    const serveLabel = n.serve_date ? `served ${n.serve_date}` : '(serve date unknown)';
    reasons.push({
      type:        'revocation_notice',
      description: `Revocation notice ${serveLabel} — no effective date on record`,
      date:        null,
      rescindDate: null,
      stillActive: false,
      eventDate:   null,
    });
  }

  // Motus involuntary suspensions — Supabase mirror of wb4f-neki (refreshed daily)
  const { data: motusRows } = await supabase
    .from('motus_suspensions')
    .select('order_type_desc,effective_date')
    .eq('dot_number', dot)
    .limit(5);
  for (const m of (motusRows ?? [])) {
    const d = m.effective_date ?? null;
    reasons.push({ type: 'suspension', description: m.order_type_desc, date: d, rescindDate: null, stillActive: isInactive, eventDate: d });
  }

  // Lapsed BIPD — insurance_cancellations table (refreshed daily from FMCSA BMC-35)
  const { data: lapsedRow } = await supabase
    .from('insurance_cancellations')
    .select('effective_date')
    .eq('dot_number', dot)
    .eq('status', 'lapsed')
    .maybeSingle();
  if (lapsedRow) {
    reasons.push({ type: 'lapsed_bipd', description: 'Lapsed BIPD insurance, no replacement on file', date: lapsedRow.effective_date ?? null, rescindDate: null, stillActive: true, eventDate: lapsedRow.effective_date ?? null });
  }

  return reasons;
}

// Checks that all three enforcement mirror tables were loaded successfully within the
// last 25 hours. Returns { ok, loadedAt }.
//
// Empty or stale tables must never be treated as "no bad history" — that would make
// every linked carrier appear informational. Any failure → notReviewed response.
// The oldest of the three timestamps is returned as loadedAt (weakest-link freshness).
async function getEnforcementTableStatus(supabase) {
  const MAX_AGE_MS = 25 * 60 * 60 * 1000;  // 25 h covers daily job + scheduling drift
  const now        = Date.now();

  const [oos, rev, motus] = await Promise.all([
    supabase.from('oos_orders')        .select('last_verified_at').order('last_verified_at', { ascending: false }).limit(1).maybeSingle(),
    supabase.from('safer_revocations') .select('last_verified_at').order('last_verified_at', { ascending: false }).limit(1).maybeSingle(),
    supabase.from('motus_suspensions') .select('last_verified_at').order('last_verified_at', { ascending: false }).limit(1).maybeSingle(),
  ]);

  const timestamps = [
    oos.data?.last_verified_at,
    rev.data?.last_verified_at,
    motus.data?.last_verified_at,
  ];

  for (const ts of timestamps) {
    if (!ts || now - new Date(ts).getTime() > MAX_AGE_MS) return { ok: false, loadedAt: null };
  }

  return { ok: true, loadedAt: [...timestamps].sort()[0] };  // oldest = weakest link
}

// A match is HOLD-worthy when, for at least one bad reason:
//   condA — carrier is inactive OR the event is still active (not rescinded/reinstated)
//   condB — the event is still active OR it falls within the lookback window
//
// Old rescinded events on currently-active carriers become informational.
function isHoldWorthy(ccRow, reasons, lookbackDays) {
  const isInactive = ccRow?.status_code === 'I';
  const cutoff     = new Date();
  cutoff.setDate(cutoff.getDate() - (lookbackDays ?? 1095));

  return reasons.some(r => {
    const condA = isInactive || r.stillActive;
    if (!condA) return false;
    const eventDate = r.eventDate ? new Date(r.eventDate) : null;
    const condB     = r.stillActive || (eventDate !== null && eventDate >= cutoff);
    return condB;
  });
}

router.get('/:dot', async (req, res) => {
  const dot = req.params.dot.replace(/\D/g, '');
  if (!dot) return res.status(400).json({ error: 'Invalid DOT' });

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  const cfg          = await fetchSettings(req.auth.tenant);
  const lookbackDays = parseInt(cfg.chameleonLookbackDays, 10) || 1095;

  // 24-hour cache: FMCSA contact data updates at most daily.
  // Same DOT vetted by many brokers = one set of Socrata queries per 24 h.
  const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
  const { data: cached } = await supabase
    .from('chameleon_cache')
    .select('pulled_at,result')
    .eq('dot_number', dot)
    .maybeSingle();
  if (cached && (Date.now() - new Date(cached.pulled_at).getTime()) < CACHE_TTL_MS) {
    return res.json({ ...cached.result, pulledAt: cached.pulled_at, fromCache: true });
  }

  // Enforcement tables must be populated and fresh before proceeding.
  // Empty tables would make every linked carrier appear to have no bad history.
  // Never cache this response — the tables may populate on the next daily job run.
  const tableStatus = await getEnforcementTableStatus(supabase);
  if (!tableStatus.ok) {
    console.warn('[CHAMELEON] Enforcement tables empty or stale — notReviewed for DOT', dot);
    return res.json({ notReviewed: true });
  }
  const enforcementTablesLoadedAt = tableStatus.loadedAt;

  try {
    // 1. Fetch carrier's own CC row to get contact fields
    const selfRows = await sq(CC_DS,
      `dot_number='${esc(dot)}'`,
      'dot_number,legal_name,phone,email_address,company_officer_1,company_officer_2,phy_street,phy_city,phy_state,safety_rating',
      1
    );
    if (!selfRows.length) return res.json({ notReviewed: false, matches: [] });
    const self = selfRows[0];

    const selfPhone   = self.phone ?? '';
    const selfEmail   = norm(self.email_address);
    const selfStreet  = norm(self.phy_street);
    const selfCity    = norm(self.phy_city);
    const selfState   = (self.phy_state ?? '').toUpperCase();

    // Officer corroboration: a name match only counts if the matched carrier
    // also shares this carrier's state, phone, or street address.
    const corrobParts = [];
    if (selfState)  corrobParts.push(`phy_state='${esc(selfState)}'`);
    if (selfPhone)  corrobParts.push(`phone='${esc(selfPhone)}'`);
    if (selfStreet) corrobParts.push(`upper(phy_street)='${esc(selfStreet)}'`);
    const officerCorrobClause = corrobParts.length ? ` AND (${corrobParts.join(' OR ')})` : null;

    // Build list of searches: { field, displayVal, whereClause }
    const searches = [];

    if (selfPhone.replace(/\D/g, '').length >= 10) {
      searches.push({
        field:      'phone',
        displayVal: fmtPhone(selfPhone),
        where:      `phone='${esc(selfPhone)}'`,
      });
    }
    if (selfEmail) {
      searches.push({
        field:      'email',
        displayVal: self.email_address,
        where:      `upper(email_address)='${esc(selfEmail)}'`,
      });
    }
    if (selfStreet && selfCity && selfState) {
      searches.push({
        field:      'address',
        displayVal: `${self.phy_street}, ${self.phy_city}, ${selfState}`,
        where:      `upper(phy_street)='${esc(selfStreet)}' AND upper(phy_city)='${esc(selfCity)}' AND phy_state='${esc(selfState)}'`,
      });
    }
    if (officerCorrobClause) {
      for (const fld of ['company_officer_1', 'company_officer_2']) {
        const name = norm(self[fld]);
        if (name) {
          searches.push({
            field:      'officer',
            displayVal: self[fld],
            where:      `(upper(company_officer_1)='${esc(name)}' OR upper(company_officer_2)='${esc(name)}')${officerCorrobClause}`,
          });
        }
      }
    }

    // 2. Run each search; deduplicate results by linked DOT
    const matchMap = new Map();  // key: dot number or __shared_${field}_${val}

    for (const s of searches) {
      const excludeSelf = ` AND dot_number!='${esc(dot)}'`;
      // Fetch up to THRESHOLD+1 rows; if we hit THRESHOLD+1 it's a shared service
      const rows = await sq(CC_DS,
        s.where + excludeSelf,
        'dot_number,legal_name,status_code,safety_rating,phy_city,phy_state',
        SHARED_SERVICE_THRESHOLD + 1
      );

      if (rows.length > SHARED_SERVICE_THRESHOLD) {
        // Shared service — one summary informational entry per field value
        const key = `__shared_${s.field}_${s.displayVal}`;
        if (!matchMap.has(key)) {
          matchMap.set(key, {
            dot:          null,
            name:         `${SHARED_SERVICE_THRESHOLD}+ carriers`,
            status:       null,
            matchField:   s.field,
            matchValue:   s.displayVal,
            sharedService: true,
            isHold:        false,
            badReasons:    [],
          });
        }
        continue;
      }

      // ≤ threshold: check each individually
      for (const row of rows) {
        const linkedDot = row.dot_number;
        if (matchMap.has(linkedDot)) continue;  // already captured via another field

        const badReasons = await getBadReasons(linkedDot, row, supabase);
        matchMap.set(linkedDot, {
          dot:          linkedDot,
          name:         row.legal_name ?? '',
          status:       statusLabel(row.status_code),
          matchField:   s.field,
          matchValue:   s.displayVal,
          sharedService: false,
          isHold:        isHoldWorthy(row, badReasons, lookbackDays),
          badReasons,
        });
      }
    }

    const matches  = [...matchMap.values()];
    const pulledAt = new Date().toISOString();
    // Cache only complete successful results — never cache notReviewed or errors
    supabase.from('chameleon_cache')
      .upsert({ dot_number: dot, pulled_at: pulledAt,
                result: { notReviewed: false, matches, enforcementTablesLoadedAt } },
               { onConflict: 'dot_number' })
      .then(({ error }) => { if (error) console.warn('[CHAMELEON] Cache write failed:', error.message); })
      .catch(e => console.warn('[CHAMELEON] Cache write exception:', e.message));
    return res.json({ notReviewed: false, matches, pulledAt, enforcementTablesLoadedAt });

  } catch (e) {
    console.error('[CHAMELEON] error for DOT', dot, ':', e.message);
    return res.json({ notReviewed: true });
  }
});

export default router;
