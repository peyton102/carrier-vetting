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

// Increment when the cache result shape changes (new fields added/removed) so stale
// cache entries are automatically invalidated rather than served with missing fields.
const CACHE_VERSION = '2';

function ms(start) { return `${Date.now() - start}ms`; }

function socrataUrl(ds, where, select, limit) {
  const token  = process.env.SOCRATA_APP_TOKEN ?? '';
  const params = new URLSearchParams({ '$where': where, '$select': select, '$limit': String(limit) });
  if (token) params.set('$$app_token', token);
  return `${SOCRATA_BASE}/${ds}.json?${params}`;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Fetch Socrata with up to 3 attempts; backs off 2s then 4s on 429 or transient errors.
// Any persistent failure is re-thrown — callers wrap in try/catch → notReviewed fallback.
async function sq(ds, where, select, limit = 10, label = '') {
  const url = socrataUrl(ds, where, select, limit);
  const tag = label ? ` [${label}]` : '';
  let delay   = 2_000;
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    const t = Date.now();
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (r.status === 429) throw new Error(`Socrata ${ds} rate limited`);
      if (!r.ok)            throw new Error(`Socrata ${ds} HTTP ${r.status}`);
      const j = await r.json();
      if (!Array.isArray(j)) throw new Error(`Socrata ${ds}: ${JSON.stringify(j).slice(0, 80)}`);
      console.log(`[TIMING][CHAM] Socrata ${ds}${tag}: ${ms(t)}${attempt > 0 ? ` (attempt ${attempt + 1})` : ''}`);
      return j;
    } catch (e) {
      lastErr = e;
      console.log(`[TIMING][CHAM] Socrata ${ds}${tag}: ${ms(t)} (attempt ${attempt + 1} failed: ${e.message})`);
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
  const tTotal  = Date.now();
  const reasons    = [];
  const isInactive = ccRow?.status_code === 'I';

  // Safety rating from CC row — no extra query needed
  if (ccRow?.safety_rating === 'U') {
    reasons.push({ type: 'rating', description: 'Safety rating: Unsatisfactory', date: null, rescindDate: null, stillActive: isInactive, eventDate: null });
  }
  if (ccRow?.safety_rating === 'C') {
    reasons.push({ type: 'rating', description: 'Safety rating: Conditional',   date: null, rescindDate: null, stillActive: isInactive, eventDate: null });
  }

  // Run all 6 Supabase queries in parallel
  const tQueries = Date.now();
  const [
    { data: oosRows },
    { data: revRows },
    { data: noticeRows },
    { data: motusRows },
    { data: motusNoticeRows },
    { data: lapsedRow },
  ] = await Promise.all([
    supabase.from('oos_orders')              .select('oos_reason,oos_date,rescind_date')  .eq('dot_number', dot).limit(5),
    supabase.from('safer_revocations')       .select('order_type_desc,effective_date')    .eq('dot_number', dot).limit(5),
    supabase.from('safer_revocation_notices').select('order_type_desc,serve_date')        .eq('dot_number', dot).limit(5),
    supabase.from('motus_suspensions')       .select('order_type_desc,effective_date')    .eq('dot_number', dot).limit(5),
    supabase.from('motus_suspension_notices').select('order_type_desc,serve_date')        .eq('dot_number', dot).limit(5),
    supabase.from('insurance_cancellations') .select('effective_date').eq('dot_number', dot).eq('status', 'lapsed').maybeSingle(),
  ]);
  console.log(`[TIMING][CHAM]   Supabase 6 queries parallel (linked DOT ${dot}): ${ms(tQueries)}`);

  // OOS orders
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
  for (const r of (revRows ?? [])) {
    const d = r.effective_date ?? null;
    reasons.push({ type: 'revocation', description: r.order_type_desc, date: d, rescindDate: null, stillActive: isInactive, eventDate: d });
  }

  // SAFER revocation notices — order served but no effective date on record.
  // stillActive: false → informational only, never HOLD.
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

  // Motus involuntary suspensions — confirmed (order1_effective_date present)
  for (const m of (motusRows ?? [])) {
    const d = m.effective_date ?? null;
    reasons.push({ type: 'suspension', description: m.order_type_desc, date: d, rescindDate: null, stillActive: isInactive, eventDate: d });
  }

  // Motus suspension notices — informational only
  for (const n of (motusNoticeRows ?? [])) {
    const serveLabel = n.serve_date ? `served ${n.serve_date}` : '(serve date unknown)';
    reasons.push({
      type:        'suspension_notice',
      description: `Suspension notice ${serveLabel} — no effective date on record`,
      date:        null,
      rescindDate: null,
      stillActive: false,
      eventDate:   null,
    });
  }

  // Lapsed BIPD — insurance_cancellations table (refreshed daily from FMCSA BMC-35)
  if (lapsedRow) {
    reasons.push({ type: 'lapsed_bipd', description: 'Lapsed BIPD insurance, no replacement on file', date: lapsedRow.effective_date ?? null, rescindDate: null, stillActive: true, eventDate: lapsedRow.effective_date ?? null });
  }

  console.log(`[TIMING][CHAM]   getBadReasons total (linked DOT ${dot}): ${ms(tTotal)} — 6 parallel Supabase queries`);
  return reasons;
}

// Checks that all enforcement mirror tables were loaded successfully within the
// last 48 hours. Returns { ok, loadedAt }.
//
// 48 h limit: tolerates one missed nightly run without failing every vetting the next day.
// Empty or stale tables must never be treated as "no bad history" — that would make
// every linked carrier appear informational. Any failure → notReviewed response.
// The oldest of the timestamps is returned as loadedAt (weakest-link freshness).
//
// safer_revocations and safer_revocation_notices read daily_load_status (not the rows)
// so a dataset-unchanged skip night still counts as fresh — the nightly job writes to
// daily_load_status even when no new rows are upserted.
async function getEnforcementTableStatus(supabase) {
  const MAX_AGE_MS = 48 * 60 * 60 * 1000;  // 48 h: tolerates one missed nightly run
  const now        = Date.now();

  const tStatus = Date.now();
  const [oos, motus, rev, revNotice] = await Promise.all([
    supabase.from('oos_orders')       .select('last_verified_at').order('last_verified_at', { ascending: false }).limit(1).maybeSingle(),
    supabase.from('motus_suspensions').select('last_verified_at').order('last_verified_at', { ascending: false }).limit(1).maybeSingle(),
    supabase.from('daily_load_status').select('last_verified_at').eq('table_name', 'safer_revocations').maybeSingle(),
    supabase.from('daily_load_status').select('last_verified_at').eq('table_name', 'safer_revocation_notices').maybeSingle(),
  ]);
  console.log(`[TIMING][CHAM] Supabase enforcement table status (4 parallel): ${ms(tStatus)}`);

  const timestamps = [
    oos.data?.last_verified_at,
    motus.data?.last_verified_at,
    rev.data?.last_verified_at,
    revNotice.data?.last_verified_at,
  ];

  for (const ts of timestamps) {
    if (!ts || now - new Date(ts).getTime() > MAX_AGE_MS) return { ok: false, loadedAt: null };
  }

  return { ok: true, loadedAt: [...timestamps].sort()[0] };  // oldest = weakest link
}

// ── Contact snapshot normalization ────────────────────────────────────────────
// Formatting differences (phone formatting, street abbreviations, extra spaces)
// must NOT trigger a HOLD — only genuine data changes should.
const STREET_ABBREV = new Map([
  ['STREET','ST'],  ['AVENUE','AVE'],    ['BOULEVARD','BLVD'], ['DRIVE','DR'],
  ['ROAD','RD'],    ['LANE','LN'],       ['COURT','CT'],       ['CIRCLE','CIR'],
  ['HIGHWAY','HWY'],['PLACE','PL'],      ['SUITE','STE'],      ['TERRACE','TER'],
  ['TRAIL','TRL'],  ['PARKWAY','PKWY'],  ['EXPRESSWAY','EXPY'],
]);
function normPhone(s)  { return (s ?? '').replace(/\D/g, ''); }
function normText(s)   { return (s ?? '').trim().toUpperCase().replace(/\s+/g, ' '); }
function normStreet(s) { return normText(s).split(' ').map(w => STREET_ABBREV.get(w) ?? w).join(' '); }

const CONTACT_FIELDS = [
  { key: 'phone',             label: 'Phone',     norm: normPhone  },
  { key: 'email_address',     label: 'Email',     norm: normText   },
  { key: 'phy_street',        label: 'Street',    norm: normStreet },
  { key: 'phy_city',          label: 'City',      norm: normText   },
  { key: 'phy_state',         label: 'State',     norm: normText   },
  { key: 'company_officer_1', label: 'Officer 1', norm: normText   },
  { key: 'company_officer_2', label: 'Officer 2', norm: normText   },
];

// Compare carrier's current CC contact fields against stored snapshot + 60-day change log.
//
// Returns:
//   { firstSeen }              — first time this DOT has been seen; no HOLD
//   { recentChanges, ... }     — one or more changes detected in the last 60 days; HOLD
//   null                       — snapshot exists, no changes in last 60 days
//
// All DB writes are fire-and-forget — never block the vetting response.
// The snapshot stores the latest known values; carrier_contact_changes is append-only.
async function checkContactSnapshot(dot, self, supabase) {
  const CHANGE_WINDOW_MS = 60 * 24 * 60 * 60 * 1000;
  const now              = new Date().toISOString();
  const lookbackCutoff   = new Date(Date.now() - CHANGE_WINDOW_MS).toISOString();

  // Read snapshot + recent changes log in parallel
  const t = Date.now();
  const [snapRes, changesRes] = await Promise.all([
    supabase.from('carrier_contact_snapshots')
      .select('phone,email_address,phy_street,phy_city,phy_state,company_officer_1,company_officer_2,first_seen_at')
      .eq('dot_number', dot)
      .maybeSingle(),
    supabase.from('carrier_contact_changes')
      .select('field_label,old_value,new_value,detected_at')
      .eq('dot_number', dot)
      .gte('detected_at', lookbackCutoff)
      .order('detected_at', { ascending: true }),
  ]);
  console.log(`[TIMING][CHAM] Supabase snapshot + changes read (DOT ${dot}): ${ms(t)}`);

  const snap         = snapRes.data;
  const priorChanges = changesRes.data ?? [];

  const snapPayload = {
    phone:             self.phone             ?? null,
    email_address:     self.email_address     ?? null,
    phy_street:        self.phy_street        ?? null,
    phy_city:          self.phy_city          ?? null,
    phy_state:         self.phy_state         ?? null,
    company_officer_1: self.company_officer_1 ?? null,
    company_officer_2: self.company_officer_2 ?? null,
    mcs150_date:       self.mcs150_date       ?? null,
    last_seen_at:      now,
  };

  if (!snap) {
    // First time — insert snapshot with first_seen_at; no HOLD
    supabase.from('carrier_contact_snapshots')
      .insert({ dot_number: dot, ...snapPayload, first_seen_at: now })
      .then(({ error }) => { if (error) console.warn('[CHAM] Snapshot insert failed:', error.message); })
      .catch(e => console.warn('[CHAM] Snapshot insert exception:', e.message));
    return { firstSeen: now };
  }

  // Detect normalized field changes
  const newDiffs = [];
  for (const { key, label, norm } of CONTACT_FIELDS) {
    if (norm(snap[key]) !== norm(self[key])) {
      newDiffs.push({ field_name: key, field_label: label, old_value: snap[key] ?? null, new_value: self[key] ?? null, detected_at: now });
    }
  }

  // Update snapshot — always refresh last_seen_at; set last_changed_at if fields changed
  supabase.from('carrier_contact_snapshots')
    .update({ ...snapPayload, ...(newDiffs.length > 0 ? { last_changed_at: now } : {}) })
    .eq('dot_number', dot)
    .then(({ error }) => { if (error) console.warn('[CHAM] Snapshot update failed:', error.message); })
    .catch(e => console.warn('[CHAM] Snapshot update exception:', e.message));

  // Append new change log rows (insert-only)
  if (newDiffs.length > 0) {
    supabase.from('carrier_contact_changes')
      .insert(newDiffs.map(d => ({ dot_number: dot, field_name: d.field_name, field_label: d.field_label, old_value: d.old_value, new_value: d.new_value, detected_at: d.detected_at })))
      .then(({ error }) => { if (error) console.warn('[CHAM] Change log insert failed:', error.message); })
      .catch(e => console.warn('[CHAM] Change log insert exception:', e.message));
  }

  // Combine historical log entries + newly detected (which weren't in the DB query yet)
  const recentChanges = [
    ...priorChanges,
    ...newDiffs.map(d => ({ field_label: d.field_label, old_value: d.old_value, new_value: d.new_value, detected_at: d.detected_at })),
  ];

  if (recentChanges.length === 0) return null;

  // Include MCS-150 date if recently updated alongside a contact change
  const mcs150Date   = self.mcs150_date ?? null;
  const mcs150Recent = (() => {
    if (!mcs150Date) return false;
    const dt = new Date(mcs150Date);
    if (isNaN(dt.getTime())) return false;
    return dt.getTime() > Date.now() - CHANGE_WINDOW_MS;
  })();

  return { recentChanges, mcs150Recent, mcs150Date };
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
  const tTotal = Date.now();
  const dot = req.params.dot.replace(/\D/g, '');
  if (!dot) return res.status(400).json({ error: 'Invalid DOT' });

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  let t = Date.now();
  const cfg          = await fetchSettings(req.auth.tenant);
  console.log(`[TIMING][CHAM] DOT ${dot}: fetchSettings: ${ms(t)}`);
  const lookbackDays = parseInt(cfg.chameleonLookbackDays, 10) || 1095;

  // 24-hour cache: FMCSA contact data updates at most daily.
  // Same DOT vetted by many brokers = one set of Socrata queries per 24 h.
  const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
  t = Date.now();
  const { data: cached } = await supabase
    .from('chameleon_cache')
    .select('pulled_at,result')
    .eq('dot_number', dot)
    .maybeSingle();
  console.log(`[TIMING][CHAM] DOT ${dot}: Supabase chameleon_cache read: ${ms(t)}`);
  if (cached &&
      (Date.now() - new Date(cached.pulled_at).getTime()) < CACHE_TTL_MS &&
      cached.result?.cacheVersion === CACHE_VERSION) {
    console.log(`[TIMING][CHAM] DOT ${dot}: cache HIT — returning cached result, /chameleon total: ${ms(tTotal)}`);
    return res.json({ ...cached.result, pulledAt: cached.pulled_at, fromCache: true });
  }
  console.log(`[TIMING][CHAM] DOT ${dot}: cache MISS — running full lookup`);

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
    // 1. Fetch carrier's own CC row to get contact fields.
    // dot_number is a Number column in Socrata — no quotes; string-quoted equality
    // causes a full-table type-converting scan (~6s vs ~200ms with numeric literal).
    const selfRows = await sq(CC_DS,
      `dot_number=${dot}`,
      'dot_number,legal_name,phone,email_address,company_officer_1,company_officer_2,phy_street,phy_city,phy_state,safety_rating,mcs150_date',
      1,
      `self CC row`
    );
    if (!selfRows.length) return res.json({ notReviewed: false, matches: [], fmcsaRegisteredEmail: null });
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
      // upper() on a text column is fast in Socrata (~200ms) and needed for correctness:
      // different carriers can store the same email in different cases.
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

    // 2. Run all field searches AND snapshot check in parallel.
    // Results are processed in original search order so first-match-wins attribution
    // is deterministic (same as the old sequential loop).
    const excludeSelf = ` AND dot_number!='${esc(dot)}'`;
    const [searchResults, contactChange] = await Promise.all([
      Promise.all(searches.map(s =>
        sq(CC_DS,
          s.where + excludeSelf,
          'dot_number,legal_name,status_code,safety_rating,phy_city,phy_state',
          SHARED_SERVICE_THRESHOLD + 1,
          `search field=${s.field}`
        ).then(rows => ({ s, rows }))
      )),
      checkContactSnapshot(dot, self, supabase),
    ]);

    // Build deduped list of unique linked carriers to check (in original search order)
    const matchMap   = new Map();  // key: dot number or __shared_${field}_${val}
    const toCheck    = [];         // { linkedDot, row, s } — unique DOTs only

    for (const { s, rows } of searchResults) {
      if (rows.length > SHARED_SERVICE_THRESHOLD) {
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

      for (const row of rows) {
        const linkedDot = row.dot_number;
        if (matchMap.has(linkedDot)) continue;  // already captured via another field
        matchMap.set(linkedDot, null);           // reserve slot; filled below
        toCheck.push({ linkedDot, row, s });
      }
    }

    // Check all unique linked carriers in parallel
    const badReasonsAll = await Promise.all(
      toCheck.map(({ linkedDot, row }) => getBadReasons(linkedDot, row, supabase))
    );
    for (let i = 0; i < toCheck.length; i++) {
      const { linkedDot, row, s } = toCheck[i];
      const badReasons = badReasonsAll[i];
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

    const matches  = [...matchMap.values()];
    const pulledAt = new Date().toISOString();
    console.log(`[TIMING][CHAM] DOT ${dot}: /chameleon total: ${ms(tTotal)} — ${searches.length} searches, ${matches.length} matches`);
    // Cache only complete successful results — never cache notReviewed or errors
    const fmcsaRegisteredEmail = self.email_address || null;
    supabase.from('chameleon_cache')
      .upsert({ dot_number: dot, pulled_at: pulledAt,
                result: { cacheVersion: CACHE_VERSION, notReviewed: false, matches, enforcementTablesLoadedAt, fmcsaRegisteredEmail, contactChange } },
               { onConflict: 'dot_number' })
      .then(({ error }) => { if (error) console.warn('[CHAMELEON] Cache write failed:', error.message); })
      .catch(e => console.warn('[CHAMELEON] Cache write exception:', e.message));
    return res.json({ notReviewed: false, matches, pulledAt, enforcementTablesLoadedAt, fmcsaRegisteredEmail, contactChange });

  } catch (e) {
    console.error('[CHAMELEON] error for DOT', dot, ':', e.message);
    return res.json({ notReviewed: true });
  }
});

export default router;
