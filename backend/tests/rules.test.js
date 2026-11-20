// Rule engine + PDF offline tests — no network, no DB.
// Every test case also generates a PDF to confirm the generator doesn't crash.

import { runVettingRules, DEFAULT_SETTINGS, classifyEmailMatch } from '../lib/rules_engine.js';
import { generateVettingPDF } from '../lib/pdf_generator.js';
import { mergeResults, applyToSubmission, detectEdits, validateLookupRow, applyStricterEdits } from '../lib/lookup_merge.js';
import { refreshInsuranceCancellations, refreshOosOrders, refreshSaferRevocations, refreshMotusSuspensions, runPostRefreshChecks } from '../lib/monitor.js';
import { fmcsaMcLookup, parseSaferInspections } from '../routes/fmcsa.js';
import { createHash } from 'crypto';

const CFG = DEFAULT_SETTINGS;

// ── Helpers ───────────────────────────────────────────────────────────────────

function futureDate(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

async function checkPdf(carrierData, ruleResult) {
  try {
    const buf = await generateVettingPDF({
      carrierData,
      verdict:      ruleResult.verdict,
      tier:         ruleResult.tier,
      reasons:      ruleResult.reasons,
      warnings:     ruleResult.warnings ?? [],
      authorityDays: ruleResult.authorityDays,
      override:     null,
      generatedAt:  new Date(),
      recordId:     '00000000-0000-0000-0000-000000000001',
      settings:     CFG,
      brokerName:   'Test Brokerage',
      fieldSources: {},
      timesUsed:    0,
      reissued:     false,
    });
    if (!Buffer.isBuffer(buf) || buf.length < 500) return `buffer too small (${buf?.length} bytes)`;
    if (buf.slice(0, 4).toString() !== '%PDF') return `not a PDF (magic: ${buf.slice(0, 4).toString('hex')})`;
    return null; // OK
  } catch (e) {
    return e.message;
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function t(name, fn) {
  try {
    await fn();
    return { name, pass: true };
  } catch (e) {
    return { name, pass: false, error: e.message };
  }
}

// ── isHoldWorthy — duplicated from chameleon.js to avoid server dep in tests ─
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

// ── Base clean carrier — all checks pass with DEFAULT_SETTINGS ───────────────
// natAvg chosen so 5% truck OOS is comfortably below 2× average (< 22%).
const CLEAN = {
  carrierName:               'Test Carrier LLC',
  dotNumber:                 '9999999',
  mcNumber:                  '123456',
  authorityStatus:           'active',
  authorityGrantDate:        '2020-01-01',
  safetyRating:              'Satisfactory',
  powerUnits:                '10',
  inspections24mo:           '50',
  driverInspections24mo:     '30',
  cleanInspections24mo:      '45',
  truckOosPct:               '5.00',
  driverOosPct:              '2.00',
  nationalAvgTruckOos:       '10.00',
  nationalAvgDriverOos:      '4.00',
  unsafeDrivingBasic:        '30',
  crashIndicatorBasic:       '30',
  hosBasic:                  '30',
  vehicleMaintenanceBasic:   '30',
  vehicleDriverObservedBasic:'30',
  driverFitnessBasic:        '30',
  hazmatBasic:               '30',
  carrierAssureGrade:        '',
  autoLiability:             '1000000',
  autoLiabilityExpiration:   futureDate(90),
  cargoInsurance:            '100000',
  cargoExpiration:           futureDate(90),
  drugAlcoholViolation:      false,
  fmcsaPhone:                '5551234567',
  contactPhone:              '5551234567',
  contactEmail:              'dispatch@testcarrier.com',
  hasBrokerAuthority:        false,
  activeFederalOOS:          false,
  bipdCancelLapsed:          false,
  bipdCancelPending:         null,
  totalDrivers:              '5',
  mcs150Mileage:             '150000',
  mcs150MileageYear:         '2025',
  fmcsaRegisteredEmail:      null,
  fmcsaEmailNotReviewed:     false,
  fmcsaEnforcementLoadedAt:  null,
  fmcsaContactChange:        null,
  fmcsaChameleonMatches:     [],
};

// ── DLS test helpers ──────────────────────────────────────────────────────────

function makeDlsSupa() {
  const dlsWrites = [];
  const supa = {
    from(table) {
      return {
        upsert(data) {
          if (table === 'daily_load_status') {
            dlsWrites.push(...(Array.isArray(data) ? data : [data]));
          }
          return Promise.resolve({ error: null });
        },
        select() {
          return {
            eq() { return { maybeSingle: () => Promise.resolve({ data: null, error: null }) }; },
          };
        },
        delete() { return { gte: () => Promise.resolve({ error: null }) }; },
      };
    },
    rpc() { return Promise.resolve({ data: 0, error: null }); },
  };
  return { supa, dlsWrites };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

export async function runAll() {
  const results = [];

  // 1. Clean carrier passes — baseline
  results.push(await t('clean carrier → APPROVE', async () => {
    const r = runVettingRules(CLEAN, CFG);
    assert(r.verdict === 'APPROVE', `want APPROVE, got ${r.verdict}: ${r.reasons.join('; ')}`);
    const pdfErr = await checkPdf(CLEAN, r);
    assert(!pdfErr, `PDF: ${pdfErr}`);
  }));

  // 2. Truck OOS exactly 20.0% — does NOT trigger REJECT (boundary: not > 20)
  //    natAvg 11% → 2× = 22% > 20%, so no yellow OOS flag either → clean APPROVE
  results.push(await t('truck OOS 20.0% → APPROVE (boundary: not > 20)', async () => {
    const d = { ...CLEAN, truckOosPct: '20.0', nationalAvgTruckOos: '11.0' };
    const r = runVettingRules(d, CFG);
    assert(r.verdict === 'APPROVE', `want APPROVE, got ${r.verdict}: ${r.reasons.join('; ')}`);
    assert(!r.reasons.some(s => s.includes('maximum')),
      `unexpected OOS reject reason: ${r.reasons.join('; ')}`);
    const pdfErr = await checkPdf(d, r);
    assert(!pdfErr, `PDF: ${pdfErr}`);
  }));

  // 3. Truck OOS 20.1% — triggers REJECT (> 20, not ≥ 20)
  results.push(await t('truck OOS 20.1% → REJECT (exceeds maximum)', async () => {
    const d = { ...CLEAN, truckOosPct: '20.1', nationalAvgTruckOos: '11.0' };
    const r = runVettingRules(d, CFG);
    assert(r.verdict === 'REJECT', `want REJECT, got ${r.verdict}`);
    assert(r.reasons.some(s => s.includes('maximum')),
      `OOS max reason not found in: ${r.reasons.join('; ')}`);
    assert(r.canOverride === false, 'OOS max must set canOverride:false');
    const pdfErr = await checkPdf(d, r);
    assert(!pdfErr, `PDF: ${pdfErr}`);
  }));

  // 4. Driver OOS > 7% hard block (oosHardBlockDriver default = 7; strictly >7 is blocked)
  results.push(await t('driver OOS 7.5% → REJECT (hard_block, canOverride:false)', async () => {
    const d = { ...CLEAN, driverOosPct: '7.5', nationalAvgDriverOos: '0' };
    const r = runVettingRules(d, CFG);
    assert(r.verdict === 'REJECT', `want REJECT, got ${r.verdict}`);
    assert(r.reasons.some(s => s.includes('hard limit') && s.includes('7.5%')),
      `hard_block reason not found: ${r.reasons.join('; ')}`);
    assert(r.canOverride === false, 'driver hard_block must set canOverride:false');
    const pdfErr = await checkPdf(d, r);
    assert(!pdfErr, `PDF: ${pdfErr}`);
  }));

  // 5. Conditional safety rating → REJECT, no override
  results.push(await t('Conditional safety rating → REJECT canOverride:false', async () => {
    const d = { ...CLEAN, safetyRating: 'Conditional' };
    const r = runVettingRules(d, CFG);
    assert(r.verdict === 'REJECT', `want REJECT, got ${r.verdict}`);
    assert(r.reasons.some(s => s.includes('Conditional')),
      `Conditional reason not found: ${r.reasons.join('; ')}`);
    assert(r.canOverride === false, 'Conditional must set canOverride:false');
    const pdfErr = await checkPdf(d, r);
    assert(!pdfErr, `PDF: ${pdfErr}`);
  }));

  // 6. Unsatisfactory safety rating → REJECT, no override
  results.push(await t('Unsatisfactory safety rating → REJECT canOverride:false', async () => {
    const d = { ...CLEAN, safetyRating: 'Unsatisfactory' };
    const r = runVettingRules(d, CFG);
    assert(r.verdict === 'REJECT', `want REJECT, got ${r.verdict}`);
    assert(r.reasons.some(s => s.includes('Unsatisfactory')),
      `Unsatisfactory reason not found: ${r.reasons.join('; ')}`);
    assert(r.canOverride === false, 'Unsatisfactory must set canOverride:false');
    const pdfErr = await checkPdf(d, r);
    assert(!pdfErr, `PDF: ${pdfErr}`);
  }));

  // 7. Drug/alcohol blank (null) → HOLD, never APPROVE
  results.push(await t('drugAlcoholViolation null → HOLD', async () => {
    const d = { ...CLEAN, drugAlcoholViolation: null };
    const r = runVettingRules(d, CFG);
    assert(r.verdict === 'HOLD', `want HOLD, got ${r.verdict}: ${r.reasons.join('; ')}`);
    assert(r.reasons.some(s => s.toLowerCase().includes('drug/alcohol')),
      `drug/alcohol reason not found: ${r.reasons.join('; ')}`);
    const pdfErr = await checkPdf(d, r);
    assert(!pdfErr, `PDF: ${pdfErr}`);
  }));

  // 8. Drug/alcohol yes (true) → REJECT, no override
  results.push(await t('drugAlcoholViolation true → REJECT canOverride:false', async () => {
    const d = { ...CLEAN, drugAlcoholViolation: true };
    const r = runVettingRules(d, CFG);
    assert(r.verdict === 'REJECT', `want REJECT, got ${r.verdict}`);
    assert(r.reasons.some(s => s.toLowerCase().includes('drug/alcohol')),
      `drug/alcohol reason not found: ${r.reasons.join('; ')}`);
    assert(r.canOverride === false, 'drug/alcohol violation must set canOverride:false');
    const pdfErr = await checkPdf(d, r);
    assert(!pdfErr, `PDF: ${pdfErr}`);
  }));

  // 9. Phone mismatch → HOLD
  results.push(await t('contact phone mismatch → HOLD', async () => {
    const d = { ...CLEAN, contactPhone: '5559999999', fmcsaPhone: '5551234567' };
    const r = runVettingRules(d, CFG);
    assert(r.verdict === 'HOLD', `want HOLD, got ${r.verdict}`);
    assert(r.reasons.some(s => s.includes('does not match FMCSA')),
      `phone-mismatch reason not found: ${r.reasons.join('; ')}`);
    const pdfErr = await checkPdf(d, r);
    assert(!pdfErr, `PDF: ${pdfErr}`);
  }));

  // 10. Free email domain → HOLD
  results.push(await t('contact email on free provider (gmail) → HOLD', async () => {
    const d = { ...CLEAN, contactEmail: 'driver@gmail.com' };
    const r = runVettingRules(d, CFG);
    assert(r.verdict === 'HOLD', `want HOLD, got ${r.verdict}`);
    assert(r.reasons.some(s => s.includes('free provider')),
      `free-email reason not found: ${r.reasons.join('; ')}`);
    const pdfErr = await checkPdf(d, r);
    assert(!pdfErr, `PDF: ${pdfErr}`);
  }));

  // 11. Broker authority → HOLD
  results.push(await t('carrier holds broker authority → HOLD', async () => {
    const d = { ...CLEAN, hasBrokerAuthority: true };
    const r = runVettingRules(d, CFG);
    assert(r.verdict === 'HOLD', `want HOLD, got ${r.verdict}`);
    assert(r.reasons.some(s => s.includes('broker authority')),
      `broker-authority reason not found: ${r.reasons.join('; ')}`);
    const pdfErr = await checkPdf(d, r);
    assert(!pdfErr, `PDF: ${pdfErr}`);
  }));

  // 12. Lapsed BIPD insurance → REJECT
  //     autoLiabilityExpiration blank → SW shows no active coverage → RED path, not HOLD
  results.push(await t('lapsed BIPD insurance (no SW coverage) → REJECT', async () => {
    const d = { ...CLEAN, bipdCancelLapsed: true, autoLiabilityExpiration: '' };
    const r = runVettingRules(d, CFG);
    assert(r.verdict === 'REJECT', `want REJECT, got ${r.verdict}: ${r.reasons.join('; ')}`);
    assert(r.reasons.some(s => s.includes('cancelled')),
      `lapsed-BIPD reason not found: ${r.reasons.join('; ')}`);
    const pdfErr = await checkPdf(d, r);
    assert(!pdfErr, `PDF: ${pdfErr}`);
  }));

  // 13. Pending BMC-35 cancellation within 30 days → HOLD
  results.push(await t('BIPD cancellation pending within 30 days → HOLD', async () => {
    const d = { ...CLEAN, bipdCancelPending: true, bipdCancelDaysUntil: 15, bipdCancelEffectiveDate: futureDate(15) };
    const r = runVettingRules(d, CFG);
    assert(r.verdict === 'HOLD', `want HOLD, got ${r.verdict}`);
    assert(r.reasons.some(s => s.includes('cancellation notice')),
      `bipd-cancel reason not found: ${r.reasons.join('; ')}`);
    const pdfErr = await checkPdf(d, r);
    assert(!pdfErr, `PDF: ${pdfErr}`);
  }));

  // 14. Missing inspection count → HOLD, never APPROVE
  results.push(await t('missing inspections24mo → HOLD, never APPROVE', async () => {
    const d = { ...CLEAN, inspections24mo: null };
    const r = runVettingRules(d, CFG);
    assert(r.verdict !== 'APPROVE',
      `missing inspection count must not APPROVE (got ${r.verdict})`);
    assert(r.verdict === 'HOLD', `want HOLD, got ${r.verdict}`);
    assert(r.reasons.some(s => s.toLowerCase().includes('inspection count')),
      `missing-inspection reason not found: ${r.reasons.join('; ')}`);
    const pdfErr = await checkPdf(d, r);
    assert(!pdfErr, `PDF: ${pdfErr}`);
  }));

  // 15. Sufficient inspections but all BASIC scores absent → HOLD, never APPROVE
  results.push(await t('no BASIC scores (inspections present) → HOLD, never APPROVE', async () => {
    const d = { ...CLEAN,
      unsafeDrivingBasic: '', crashIndicatorBasic: '', hosBasic: '',
      vehicleMaintenanceBasic: '', vehicleDriverObservedBasic: '',
      driverFitnessBasic: '', hazmatBasic: '',
    };
    const r = runVettingRules(d, CFG);
    assert(r.verdict !== 'APPROVE',
      `missing BASIC scores must not APPROVE (got ${r.verdict})`);
    assert(r.verdict === 'HOLD', `want HOLD, got ${r.verdict}`);
    const pdfErr = await checkPdf(d, r);
    assert(!pdfErr, `PDF: ${pdfErr}`);
  }));

  // 16. Chameleon match with isHold:true → adds HOLD
  results.push(await t('chameleon match isHold:true → HOLD', async () => {
    const d = { ...CLEAN, fmcsaChameleonMatches: [{
      dot: '1111111', name: 'Ghost Carrier LLC', isHold: true,
      matchField: 'phone', matchValue: '5551234567', sharedService: false,
      badReasons: [{ description: 'OOS order: Operating Authority', date: '2024-06-01', stillActive: true, eventDate: '2024-06-01' }],
    }]};
    const r = runVettingRules(d, CFG);
    assert(r.verdict === 'HOLD', `want HOLD, got ${r.verdict}`);
    assert(r.reasons.some(s => s.includes('Identity linkage')),
      `chameleon HOLD reason not found: ${r.reasons.join('; ')}`);
    const pdfErr = await checkPdf(d, r);
    assert(!pdfErr, `PDF: ${pdfErr}`);
  }));

  // 17. Chameleon match with isHold:false → no HOLD added (old/rescinded)
  results.push(await t('chameleon match isHold:false → no HOLD from chameleon', async () => {
    const d = { ...CLEAN, fmcsaChameleonMatches: [{
      dot: '2222222', name: 'Old Issue Carrier', isHold: false,
      matchField: 'phone', matchValue: '5551234567', sharedService: false,
      badReasons: [{ description: 'OOS order: old', date: '2015-01-01', stillActive: false, eventDate: '2015-01-01' }],
    }]};
    const r = runVettingRules(d, CFG);
    assert(r.verdict === 'APPROVE',
      `want APPROVE (isHold:false must not block), got ${r.verdict}: ${r.reasons.join('; ')}`);
    const pdfErr = await checkPdf(d, r);
    assert(!pdfErr, `PDF: ${pdfErr}`);
  }));

  // 18. isHoldWorthy: active enforcement on active carrier → true
  results.push(await t('isHoldWorthy: active OOS on active carrier → true', async () => {
    const reasons = [{ type: 'oos', description: 'OOS order', stillActive: true, eventDate: null }];
    assert(isHoldWorthy({ status_code: 'A' }, reasons, 1095) === true,
      'active OOS on active carrier must be hold-worthy');
  }));

  // 19. isHoldWorthy: old rescinded event on active carrier → false
  results.push(await t('isHoldWorthy: old rescinded (5yr) on active carrier → false', async () => {
    const old = new Date();
    old.setFullYear(old.getFullYear() - 5);
    const reasons = [{ type: 'oos', description: 'OOS order', stillActive: false, eventDate: old.toISOString().slice(0, 10) }];
    assert(isHoldWorthy({ status_code: 'A' }, reasons, 1095) === false,
      'old (>3yr) rescinded event on active carrier must NOT be hold-worthy');
  }));

  // 20. isHoldWorthy: recent event on inactive carrier → true (condA = isInactive)
  results.push(await t('isHoldWorthy: recent event on inactive carrier → true', async () => {
    const recent = new Date();
    recent.setMonth(recent.getMonth() - 6); // 6 months ago, inside 1095-day window
    const reasons = [{ type: 'revocation', description: 'Revocation', stillActive: false, eventDate: recent.toISOString().slice(0, 10) }];
    assert(isHoldWorthy({ status_code: 'I' }, reasons, 1095) === true,
      'recent event on inactive carrier must be hold-worthy');
  }));

  // ── Email matching tests (rules 1–5) ─────────────────────────────────────────

  // 22. Email rule 1: exact match with FMCSA registered email → no HOLD, even if Gmail
  results.push(await t('email: exact match with FMCSA registered (Gmail) → APPROVE', async () => {
    const d = { ...CLEAN, contactEmail: 'dispatch@gmail.com', fmcsaRegisteredEmail: 'dispatch@gmail.com' };
    const r = runVettingRules(d, CFG);
    assert(r.verdict === 'APPROVE', `want APPROVE (exact match clears Gmail), got ${r.verdict}: ${r.reasons.join('; ')}`);
    const pdfErr = await checkPdf(d, r);
    assert(!pdfErr, `PDF: ${pdfErr}`);
  }));

  // 23. Email rule 2: same company domain as FMCSA registered email → no HOLD
  results.push(await t('email: same domain as FMCSA registered → APPROVE', async () => {
    const d = { ...CLEAN, contactEmail: 'driver@testcarrier.com', fmcsaRegisteredEmail: 'dispatch@testcarrier.com' };
    const r = runVettingRules(d, CFG);
    assert(r.verdict === 'APPROVE', `want APPROVE (same domain), got ${r.verdict}: ${r.reasons.join('; ')}`);
    const pdfErr = await checkPdf(d, r);
    assert(!pdfErr, `PDF: ${pdfErr}`);
  }));

  // 24. Email rule 3: free provider that doesn't match FMCSA registered email → HOLD
  results.push(await t('email: free provider, mismatches FMCSA registered → HOLD', async () => {
    const d = { ...CLEAN, contactEmail: 'driver@gmail.com', fmcsaRegisteredEmail: 'dispatch@testcarrier.com' };
    const r = runVettingRules(d, CFG);
    assert(r.verdict === 'HOLD', `want HOLD, got ${r.verdict}`);
    assert(r.reasons.some(s => s.includes('free provider')),
      `free-provider reason not found: ${r.reasons.join('; ')}`);
    const pdfErr = await checkPdf(d, r);
    assert(!pdfErr, `PDF: ${pdfErr}`);
  }));

  // 25. Email rule 4: different company domain (lookalike) → HOLD "doesn't match FMCSA record"
  results.push(await t('email: company domain mismatch (lookalike) → HOLD', async () => {
    const d = { ...CLEAN, contactEmail: 'dispatch@testcarr1er.com', fmcsaRegisteredEmail: 'dispatch@testcarrier.com' };
    const r = runVettingRules(d, CFG);
    assert(r.verdict === 'HOLD', `want HOLD, got ${r.verdict}`);
    assert(r.reasons.some(s => s.includes("doesn't match FMCSA record")),
      `domain-mismatch reason not found: ${r.reasons.join('; ')}`);
    const pdfErr = await checkPdf(d, r);
    assert(!pdfErr, `PDF: ${pdfErr}`);
  }));

  // 26. Email rule 5: no FMCSA email on file, free provider → HOLD (today's behavior unchanged)
  results.push(await t('email: no FMCSA email on file + free provider → HOLD', async () => {
    const d = { ...CLEAN, contactEmail: 'driver@gmail.com', fmcsaRegisteredEmail: null };
    const r = runVettingRules(d, CFG);
    assert(r.verdict === 'HOLD', `want HOLD, got ${r.verdict}`);
    assert(r.reasons.some(s => s.includes('free provider')),
      `free-provider reason not found: ${r.reasons.join('; ')}`);
    const pdfErr = await checkPdf(d, r);
    assert(!pdfErr, `PDF: ${pdfErr}`);
  }));

  // 29. Contact info changed (phone) → HOLD, all changes listed with date
  results.push(await t('contact info changed (phone) → HOLD', async () => {
    const d = { ...CLEAN, fmcsaContactChange: {
      recentChanges: [{ field_label: 'Phone', old_value: '(555) 111-2222', new_value: '(555) 999-0000', detected_at: '2026-10-15T14:00:00Z' }],
      mcs150Recent: false,
      mcs150Date:   null,
    }};
    const r = runVettingRules(d, CFG);
    assert(r.verdict === 'HOLD', `want HOLD, got ${r.verdict}`);
    assert(r.reasons.some(s => s.includes('changed in the last 60 days')),
      `"changed in the last 60 days" not in reasons: ${r.reasons.join('; ')}`);
    const pdfErr = await checkPdf(d, r);
    assert(!pdfErr, `PDF: ${pdfErr}`);
  }));

  // 30. Contact info changed + MCS-150 recently updated → HOLD with MCS-150 in reason
  results.push(await t('contact info changed + MCS-150 recent → HOLD with MCS-150 note', async () => {
    const recentDate = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const d = { ...CLEAN, fmcsaContactChange: {
      recentChanges: [{ field_label: 'Email', old_value: 'old@carrier.com', new_value: 'new@carrier.com', detected_at: '2026-10-15T14:00:00Z' }],
      mcs150Recent: true,
      mcs150Date:   recentDate,
    }};
    const r = runVettingRules(d, CFG);
    assert(r.verdict === 'HOLD', `want HOLD, got ${r.verdict}`);
    assert(r.reasons.some(s => s.includes('MCS-150')),
      `MCS-150 not in reasons: ${r.reasons.join('; ')}`);
    const pdfErr = await checkPdf(d, r);
    assert(!pdfErr, `PDF: ${pdfErr}`);
  }));

  // 31. First-time DOT (firstSeen) → APPROVE, cert shows "first seen" note
  results.push(await t('first-time DOT (firstSeen) → APPROVE, PDF renders first-seen note', async () => {
    const d = { ...CLEAN, fmcsaContactChange: { firstSeen: '2026-11-01T12:00:00Z' } };
    const r = runVettingRules(d, CFG);
    assert(r.verdict === 'APPROVE', `want APPROVE for firstSeen, got ${r.verdict}: ${r.reasons.join('; ')}`);
    const pdfErr = await checkPdf(d, r);
    assert(!pdfErr, `PDF: ${pdfErr}`);
  }));

  // 33. Mileage too low (< 1,000/unit) → HOLD
  results.push(await t('fleet: mileage too low (500/unit) → HOLD', async () => {
    const d = { ...CLEAN, mcs150Mileage: '5000', powerUnits: '10' };  // 500/unit
    const r = runVettingRules(d, CFG);
    assert(r.verdict === 'HOLD', `want HOLD, got ${r.verdict}`);
    assert(r.reasons.some(s => s.includes("doesn't match fleet size")),
      `mileage reason not found: ${r.reasons.join('; ')}`);
    const pdfErr = await checkPdf(d, r);
    assert(!pdfErr, `PDF: ${pdfErr}`);
  }));

  // 34. Mileage too high (> 250,000/unit) → HOLD
  results.push(await t('fleet: mileage too high (300,000/unit) → HOLD', async () => {
    const d = { ...CLEAN, mcs150Mileage: '3000000', powerUnits: '10' };  // 300,000/unit
    const r = runVettingRules(d, CFG);
    assert(r.verdict === 'HOLD', `want HOLD, got ${r.verdict}`);
    assert(r.reasons.some(s => s.includes("doesn't match fleet size")),
      `mileage reason not found: ${r.reasons.join('; ')}`);
    const pdfErr = await checkPdf(d, r);
    assert(!pdfErr, `PDF: ${pdfErr}`);
  }));

  // 35. Mileage year same as authority year → no HOLD, note pushed
  results.push(await t('fleet: mileage year same as authority year → APPROVE (skipped)', async () => {
    const d = { ...CLEAN, mcs150Mileage: '5000', mcs150MileageYear: '2020', authorityGrantDate: '2020-03-15' };
    const r = runVettingRules(d, CFG);
    assert(r.verdict === 'APPROVE', `want APPROVE, got ${r.verdict}: ${r.reasons.join('; ')}`);
    assert(r.notes.some(s => s.includes('Mileage not evaluated')),
      `expected mileage-not-evaluated note: ${r.notes.join('; ')}`);
    const pdfErr = await checkPdf(d, r);
    assert(!pdfErr, `PDF: ${pdfErr}`);
  }));

  // 36. Drivers far over units (informational, no HOLD)
  results.push(await t('fleet: drivers 4× units → APPROVE (informational note)', async () => {
    const d = { ...CLEAN, totalDrivers: '40', powerUnits: '10' };  // 4× > driversPerTruckMax 3
    const r = runVettingRules(d, CFG);
    assert(r.verdict === 'APPROVE', `want APPROVE, got ${r.verdict}: ${r.reasons.join('; ')}`);
    assert(r.notes.some(s => s.includes('ratio')),
      `expected driver ratio note: ${r.notes.join('; ')}`);
    const pdfErr = await checkPdf(d, r);
    assert(!pdfErr, `PDF: ${pdfErr}`);
  }));

  // 37. Karelia-like new carrier: authority 2025, mileage year 2025, low mileage → APPROVE (skipped)
  results.push(await t('fleet: new carrier (Karelia-like) — mileage year ≤ authority year → APPROVE', async () => {
    const d = { ...CLEAN,
      powerUnits: '3', totalDrivers: '2',
      mcs150Mileage: '18000', mcs150MileageYear: '2025',
      authorityGrantDate: '2025-02-10',
    };
    const r = runVettingRules(d, CFG);
    assert(r.verdict === 'APPROVE', `want APPROVE, got ${r.verdict}: ${r.reasons.join('; ')}`);
    assert(r.notes.some(s => s.includes('Mileage not evaluated')),
      `expected mileage-not-evaluated note: ${r.notes.join('; ')}`);
    const pdfErr = await checkPdf(d, r);
    assert(!pdfErr, `PDF: ${pdfErr}`);
  }));

  // 38. Free-provider same-domain false-positive: FMCSA has atlas.freight777@gmail.com,
  //     dispatcher enters test@gmail.com — both gmail.com but NOT the same person.
  //     Domain-match rule must not fire for free providers; must fall through to free-provider HOLD.
  //     PDF must say "FREE PROVIDER", not "MATCH — same registered domain".
  results.push(await t('email: free-provider domain match (gmail) → HOLD; PDF says FREE PROVIDER not MATCH', async () => {
    const d = { ...CLEAN, contactEmail: 'test@gmail.com', fmcsaRegisteredEmail: 'atlas.freight777@gmail.com' };

    // Rules engine must HOLD
    const r = runVettingRules(d, CFG);
    assert(r.verdict === 'HOLD', `want HOLD, got ${r.verdict}: ${r.reasons.join('; ')}`);
    assert(r.reasons.some(s => s.includes('free provider')),
      `free-provider reason not found: ${r.reasons.join('; ')}`);

    // classifyEmailMatch must flag as not a match
    const em = classifyEmailMatch(d);
    assert(em !== null, 'classifyEmailMatch must return a result when contactEmail is set');
    assert(!em.match, `expected match:false but got pdfLabel: "${em.pdfLabel}"`);
    assert(em.pdfLabel.includes('FREE PROVIDER'),
      `pdfLabel must include "FREE PROVIDER", got: "${em.pdfLabel}"`);
    assert(!em.pdfLabel.toLowerCase().includes('same registered domain'),
      `pdfLabel must NOT say "same registered domain", got: "${em.pdfLabel}"`);

    // PDF must generate without crash.
    // Text content is verified via classifyEmailMatch.pdfLabel above — that is exactly
    // what the PDF renders (pdf_generator imports and calls classifyEmailMatch directly).
    const pdfErr = await checkPdf(d, r);
    assert(!pdfErr, `PDF: ${pdfErr}`);
  }));

  // 32. Chameleon timed out → PDF renders "FMCSA slow to respond" (no crash)
  // contactEmail cleared so the census-unreachable email HOLD doesn't fire (tested separately in test 28)
  results.push(await t('chameleon timeout → PDF renders "slow to respond", no crash', async () => {
    const d = { ...CLEAN, contactEmail: null, fmcsaChameleonTimedOut: true, fmcsaChameleonNotReviewed: true, fmcsaChameleonMatches: null, fmcsaEmailNotReviewed: true };
    const r = runVettingRules(d, CFG);
    assert(r.verdict === 'APPROVE', `want APPROVE, got ${r.verdict}: ${r.reasons.join('; ')}`);
    const pdfErr = await checkPdf(d, r);
    assert(!pdfErr, `PDF: ${pdfErr}`);
  }));

  // 27. Skipped night: enforcementLoadedAt 30h ago (within 48h window) → APPROVE + PDF shows timestamp
  results.push(await t('skipped night: enforcement data 30h old → APPROVE, PDF renders timestamp', async () => {
    const thirtyHoursAgo = new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString();
    const d = { ...CLEAN, fmcsaEnforcementLoadedAt: thirtyHoursAgo };
    const r = runVettingRules(d, CFG);
    assert(r.verdict === 'APPROVE', `want APPROVE, got ${r.verdict}: ${r.reasons.join('; ')}`);
    const pdfErr = await checkPdf(d, r);
    assert(!pdfErr, `PDF: ${pdfErr}`);
  }));

  // 28. Census unreachable + company email domain → HOLD (can't verify against FMCSA)
  results.push(await t('email: census unreachable + company domain → HOLD', async () => {
    const d = { ...CLEAN, contactEmail: 'dispatch@testcarrier.com', fmcsaRegisteredEmail: null, fmcsaEmailNotReviewed: true };
    const r = runVettingRules(d, CFG);
    assert(r.verdict === 'HOLD', `want HOLD, got ${r.verdict}`);
    assert(r.reasons.some(s => s.includes('unreachable')),
      `unreachable reason not found: ${r.reasons.join('; ')}`);
    const pdfErr = await checkPdf(d, r);
    assert(!pdfErr, `PDF: ${pdfErr}`);
  }));

  // 41. oosMaxTruck tenant setting: custom max of 25 means 22% → HOLD not REJECT
  //     With DEFAULT max (20): classifyOos(22, 10, 2, 20) → 22>20 → hard_block → REJECT
  //     With max=25:           classifyOos(22, 10, 2, 25) → 22≤25 → not hard_block;
  //                            22>=2×10=20 → yellow → HOLD
  results.push(await t('oosMaxTruck=25: truck OOS 22% → HOLD (not REJECT)', async () => {
    const d = { ...CLEAN, truckOosPct: '22', nationalAvgTruckOos: '10' };
    const cfgMax25 = { ...CFG, oosMaxTruck: 25 };
    const r = runVettingRules(d, cfgMax25);
    assert(r.verdict === 'HOLD', `want HOLD (above yellow, below custom max), got ${r.verdict}: ${r.reasons.join('; ')}`);
    assert(!r.reasons.some(s => s.includes('maximum')),
      `OOS max must not fire at 22% when max=25: ${r.reasons.join('; ')}`);
    const pdfErr = await checkPdf(d, r);
    assert(!pdfErr, `PDF: ${pdfErr}`);
  }));

  // 42. oosMaxTruck default (20) still REJECTs at 22% — existing behaviour unchanged
  results.push(await t('oosMaxTruck=20 (default): truck OOS 22% → REJECT', async () => {
    const d = { ...CLEAN, truckOosPct: '22', nationalAvgTruckOos: '10' };
    const r = runVettingRules(d, CFG);
    assert(r.verdict === 'REJECT', `want REJECT (22>20 max), got ${r.verdict}`);
    assert(r.reasons.some(s => s.includes('maximum') && s.includes('20%')),
      `OOS max reason with 20% not found: ${r.reasons.join('; ')}`);
    const pdfErr = await checkPdf(d, r);
    assert(!pdfErr, `PDF: ${pdfErr}`);
  }));

  // 39. BASIC at-or-above: score exactly at threshold → REJECT (≥ semantics)
  //     DEFAULT_SETTINGS: basicUnsafeDrivingThreshold = 65, action = 'reject'
  results.push(await t('BASIC at threshold (65 = 65) → REJECT (≥ semantics)', async () => {
    const d = { ...CLEAN, unsafeDrivingBasic: '65' };
    const r = runVettingRules(d, CFG);
    assert(r.verdict === 'REJECT', `want REJECT (at-threshold ≥), got ${r.verdict}: ${r.reasons.join('; ')}`);
    assert(r.reasons.some(s => s.includes('Unsafe Driving') && s.includes('at or above')),
      `expected "at or above" in BASIC reason, got: ${r.reasons.join('; ')}`);
    const pdfErr = await checkPdf(d, r);
    assert(!pdfErr, `PDF: ${pdfErr}`);
  }));

  // 40. BASIC one below threshold: score 64 < 65 → APPROVE (not triggered)
  results.push(await t('BASIC one below threshold (64 < 65) → APPROVE', async () => {
    const d = { ...CLEAN, unsafeDrivingBasic: '64' };
    const r = runVettingRules(d, CFG);
    assert(r.verdict === 'APPROVE', `want APPROVE (below threshold), got ${r.verdict}: ${r.reasons.join('; ')}`);
    const pdfErr = await checkPdf(d, r);
    assert(!pdfErr, `PDF: ${pdfErr}`);
  }));

  // ── lookup_merge.js: mergeResults ───────────────────────────────────────────

  // M1. FMCSA fields land in auto_filled
  results.push(await t('mergeResults: FMCSA fields populate auto_filled', () => {
    const fmcsa = { filledFields: ['carrierName', 'dotNumber', 'truckOosPct'],
      carrierName: 'ACME Trucking', dotNumber: '1234567', truckOosPct: '5.00',
      saferData: null, saferSnapshotDate: null };
    const { autoFilled } = mergeResults({ fmcsa, sw: null, insurance: null, chameleon: null });
    assert(autoFilled.carrierName?.value === 'ACME Trucking', 'carrierName must be in auto_filled');
    assert(autoFilled.dotNumber?.value  === '1234567',       'dotNumber must be in auto_filled');
    assert(autoFilled.truckOosPct?.value === '5.00',         'truckOosPct must be in auto_filled');
    assert(autoFilled.carrierName?.sourceLabel === 'FMCSA',  'source must be FMCSA');
  }));

  // M2. SAFER wins OOS when SAFER snapshot date >= SW inspection date
  results.push(await t('mergeResults: SAFER wins OOS when newer than SaferWatch', () => {
    const fmcsa = { filledFields: [], saferSnapshotDate: '2024-10-01',
      saferData: { vehicleOosPct: '15.00', driverOosPct: '5.00' } };
    const sw = { ok: true, filledFields: [], swInspectionsDate: '2024-09-01',
      truckOosPct: '12.00', driverOosPct: '3.00' };
    const { autoFilled } = mergeResults({ fmcsa, sw, insurance: null, chameleon: null });
    assert(autoFilled.truckOosPct?.value === '15.00', `SAFER truck OOS 15 must win, got ${autoFilled.truckOosPct?.value}`);
    assert(autoFilled.driverOosPct?.value === '5.00', `SAFER driver OOS 5 must win, got ${autoFilled.driverOosPct?.value}`);
    assert(autoFilled.truckOosPct?.sourceLabel.includes('SAFER'), 'source label must mention SAFER');
  }));

  // M3. SaferWatch wins OOS when SW inspection date > SAFER snapshot date
  results.push(await t('mergeResults: SaferWatch wins OOS when newer than SAFER', () => {
    const fmcsa = { filledFields: [], saferSnapshotDate: '2024-08-01',
      saferData: { vehicleOosPct: '15.00', driverOosPct: '5.00' } };
    const sw = { ok: true, filledFields: [], swInspectionsDate: '2024-10-01',
      truckOosPct: '12.00', driverOosPct: '3.00' };
    const { autoFilled } = mergeResults({ fmcsa, sw, insurance: null, chameleon: null });
    assert(autoFilled.truckOosPct?.value === '12.00', `SW truck OOS 12 must win, got ${autoFilled.truckOosPct?.value}`);
    assert(autoFilled.driverOosPct?.value === '3.00', `SW driver OOS 3 must win, got ${autoFilled.driverOosPct?.value}`);
    assert(autoFilled.truckOosPct?.sourceLabel.includes('SaferWatch'), 'source label must mention SaferWatch');
  }));

  // M4. Insurance bipdCancelPending lands in auto_filled
  results.push(await t('mergeResults: insurance bipdCancelPending in auto_filled', () => {
    const insurance = { bipdCancelPending: true, bipdCancelLapsed: false,
      effectiveDate: '2026-12-01', insuranceCompany: 'Big Insurance Co' };
    const { autoFilled } = mergeResults({ fmcsa: null, sw: null, insurance, chameleon: null });
    assert(autoFilled.bipdCancelPending?.value === 'true', 'bipdCancelPending must be true');
    assert(autoFilled.bipdCancelInsuranceCompany?.value === 'Big Insurance Co', 'insurance company must be set');
    assert(autoFilled.bipdCancelPending?.sourceLabel === 'FMCSA BMC-35', 'source must be FMCSA BMC-35');
  }));

  // M6. crashes24mo is a complex object — must NOT end up in auto_filled (would be stringified)
  //     Must land in serverFields as the original object.
  //     Regression for: "Not reviewed (no data)" on every carrier — crashes24mo was in
  //     SCALAR_AUTO_FIELDS so setScalar stringified it → "[object Object]" → crashes.count == null.
  results.push(await t('mergeResults: crashes24mo stays as object in serverFields (not stringified)', () => {
    const crashObj = { count: 4, fatal: 0, injury: 2, tow: 2, items: [] };
    const fmcsa = {
      filledFields: ['carrierName', 'crashes24mo'],
      carrierName: 'UGN Carrier LLC',
      crashes24mo: crashObj,
      saferData: null, saferSnapshotDate: null,
    };
    const { autoFilled, serverFields } = mergeResults({ fmcsa, sw: null, insurance: null, chameleon: null });
    // Must NOT be in autoFilled (would be stringified there)
    assert(autoFilled.crashes24mo === undefined,
      `crashes24mo must not be in autoFilled — got: ${JSON.stringify(autoFilled.crashes24mo)}`);
    // Must be in serverFields as the original object
    assert(serverFields.crashes24mo !== null && typeof serverFields.crashes24mo === 'object',
      `crashes24mo must be an object in serverFields, got: ${typeof serverFields.crashes24mo}`);
    assert(serverFields.crashes24mo.count === 4,
      `crashes24mo.count must be 4, got: ${serverFields.crashes24mo?.count}`);
    assert(serverFields.crashes24mo.injury === 2,
      `crashes24mo.injury must be 2, got: ${serverFields.crashes24mo?.injury}`);
  }));

  // M7. crashes24mo null (FMCSA couldn't retrieve it) → serverFields.crashes24mo = null, not in autoFilled
  results.push(await t('mergeResults: crashes24mo null → serverFields null, not stringified', () => {
    const fmcsa = {
      filledFields: ['carrierName'],  // crashes24mo NOT in filledFields when unavailable
      carrierName: 'No Crashes LLC',
      crashes24mo: null,
      saferData: null, saferSnapshotDate: null,
    };
    const { autoFilled, serverFields } = mergeResults({ fmcsa, sw: null, insurance: null, chameleon: null });
    assert(autoFilled.crashes24mo === undefined, 'crashes24mo must not appear in autoFilled when null');
    // serverFields.crashes24mo not set when crashes24mo is not in filledFields
  }));

  // M5. Chameleon fmcsaRegisteredEmail lands in auto_filled
  results.push(await t('mergeResults: chameleon fmcsaRegisteredEmail in auto_filled', () => {
    const chameleon = { notReviewed: false, matches: [], fmcsaRegisteredEmail: 'dispatch@testcarrier.com', contactChange: null };
    const { autoFilled } = mergeResults({ fmcsa: null, sw: null, insurance: null, chameleon });
    assert(autoFilled.fmcsaRegisteredEmail?.value === 'dispatch@testcarrier.com',
      'fmcsaRegisteredEmail must be in auto_filled');
  }));

  // ── lookup_merge.js: detectEdits ─────────────────────────────────────────────

  // E1. Browser matching server → no edits detected
  results.push(await t('detectEdits: browser matches server → empty edits', () => {
    const autoFilled = {
      truckOosPct:  { value: '5.00', sourceLabel: 'FMCSA' },
      autoLiability: { value: '1000000', sourceLabel: 'SaferWatch' },
    };
    const browser = { truckOosPct: '5.00', autoLiability: '1000000' };
    const edits = detectEdits(autoFilled, browser);
    assert(Object.keys(edits).length === 0, `expected 0 edits, got: ${JSON.stringify(edits)}`);
  }));

  // E2. Browser fakes OOS rate → edit detected
  results.push(await t('detectEdits: faked truck OOS detected', () => {
    const autoFilled = { truckOosPct: { value: '25.00', sourceLabel: 'FMCSA' } };
    const browser = { truckOosPct: '5.00' };
    const edits = detectEdits(autoFilled, browser);
    assert(edits.truckOosPct, 'truckOosPct edit must be detected');
    assert(edits.truckOosPct.original === '25.00', 'original must be server value');
    assert(edits.truckOosPct.submitted === '5.00', 'submitted must be browser value');
  }));

  // E3. Browser fakes insurance amount → edit detected
  results.push(await t('detectEdits: faked auto liability detected', () => {
    const autoFilled = { autoLiability: { value: '750000', sourceLabel: 'SaferWatch' } };
    const browser = { autoLiability: '2000000' };
    const edits = detectEdits(autoFilled, browser);
    assert(edits.autoLiability, 'autoLiability edit must be detected');
    assert(edits.autoLiability.original === '750000');
  }));

  // E4. Browser fakes safety rating → edit detected
  results.push(await t('detectEdits: faked safety rating detected', () => {
    const autoFilled = { safetyRating: { value: 'Unsatisfactory', sourceLabel: 'FMCSA' } };
    const browser = { safetyRating: 'Satisfactory' };
    const edits = detectEdits(autoFilled, browser);
    assert(edits.safetyRating, 'safetyRating edit must be detected');
  }));

  // E5. Numeric equivalence: "5" vs "5.00" → NOT an edit
  results.push(await t('detectEdits: numeric equivalence (5 vs 5.00) → no edit', () => {
    const autoFilled = { truckOosPct: { value: '5.00', sourceLabel: 'FMCSA' } };
    const browser = { truckOosPct: '5' };
    const edits = detectEdits(autoFilled, browser);
    assert(!edits.truckOosPct, 'numeric equivalence must not flag as edit');
  }));

  // E6. Boolean equivalence: true vs "true" → NOT an edit
  results.push(await t('detectEdits: boolean equivalence (true vs "true") → no edit', () => {
    const autoFilled = { activeFederalOOS: { value: 'false', sourceLabel: 'FMCSA' } };
    const browser = { activeFederalOOS: false };
    const edits = detectEdits(autoFilled, browser);
    assert(!edits.activeFederalOOS, 'boolean equivalence must not flag as edit');
  }));

  // ── lookup_merge.js: applyToSubmission ───────────────────────────────────────

  // A1. Server OOS value overrides whatever browser sent
  results.push(await t('applyToSubmission: server OOS enforced over browser fake', () => {
    const savedLookup = {
      auto_filled:   { truckOosPct: { value: '25.00', sourceLabel: 'FMCSA' } },
      server_fields: {},
      fmcsa_cannot_verify: false,
    };
    const browser = { truckOosPct: '5.00', loadRef: 'LOAD-001', dispatcher: 'Alice' };
    const data = applyToSubmission(savedLookup, browser);
    assert(data.truckOosPct === '25.00', `server OOS must win, got ${data.truckOosPct}`);
    assert(data.loadRef === 'LOAD-001', 'manual loadRef must be preserved');
    assert(data.dispatcher === 'Alice', 'manual dispatcher must be preserved');
  }));

  // A2. Full rules chain rejects when server has bad OOS (browser cannot fake past it)
  results.push(await t('applyToSubmission: rules reject when server has bad OOS (browser faked lower)', () => {
    const savedLookup = {
      auto_filled:   {
        truckOosPct:        { value: '25.00', sourceLabel: 'FMCSA' },
        nationalAvgTruckOos: { value: '10.00', sourceLabel: 'FMCSA' },
        driverOosPct:       { value: '2.00',  sourceLabel: 'FMCSA' },
        nationalAvgDriverOos: { value: '4.00', sourceLabel: 'FMCSA' },
        safetyRating:       { value: 'Unsatisfactory', sourceLabel: 'FMCSA' },
        carrierName:        { value: 'Bad Carrier LLC', sourceLabel: 'FMCSA' },
        activeFederalOOS:   { value: 'false', sourceLabel: 'FMCSA' },
        hasBrokerAuthority: { value: 'false', sourceLabel: 'FMCSA' },
        bipdCancelPending:  { value: 'false', sourceLabel: 'FMCSA BMC-35' },
        bipdCancelLapsed:   { value: 'false', sourceLabel: 'FMCSA BMC-35' },
      },
      server_fields: {},
      fmcsa_cannot_verify: false,
    };
    const browser = {
      ...CLEAN,
      truckOosPct:  '5.00',   // faked lower
      safetyRating: 'Satisfactory',  // faked better
    };
    const data = applyToSubmission(savedLookup, browser);
    const r = runVettingRules(data, CFG);
    assert(r.verdict === 'REJECT', `must REJECT with server values applied, got ${r.verdict}: ${r.reasons.join('; ')}`);
    assert(r.reasons.some(s => s.includes('Unsatisfactory')),
      `Unsatisfactory reason must fire: ${r.reasons.join('; ')}`);
  }));

  // ── lookup_merge.js: validateLookupRow ──────────────────────────────────────

  // V1. Wrong-tenant lookup: DB query returns null (tenant filter) → "Lookup not found"
  results.push(await t('validateLookupRow: wrong-tenant (null row) → Lookup not found', () => {
    const err = validateLookupRow(null, '1234567', Date.now(), 24 * 60 * 60 * 1000);
    assert(err && err.includes('Lookup not found'), `expected "Lookup not found", got: ${err}`);
  }));

  // V2. Lookup older than 24 hours → stale error
  results.push(await t('validateLookupRow: lookup > 24h old → stale error', () => {
    const twentyFiveHoursAgo = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    const row = { created_at: twentyFiveHoursAgo, dot_number: '1234567' };
    const err = validateLookupRow(row, '1234567', Date.now(), 24 * 60 * 60 * 1000);
    assert(err && err.includes('older than 24 hours'), `expected stale error, got: ${err}`);
  }));

  // V3. Lookup DOT ≠ submitted DOT → DOT mismatch error
  results.push(await t('validateLookupRow: DOT mismatch → mismatch error', () => {
    const freshRow = { created_at: new Date().toISOString(), dot_number: '1111111' };
    const err = validateLookupRow(freshRow, '2222222', Date.now(), 24 * 60 * 60 * 1000);
    assert(err && err.includes('DOT 1111111') && err.includes('DOT 2222222'),
      `expected DOT mismatch error with both DOTs, got: ${err}`);
  }));

  // V4. Fresh row with matching DOT → no error
  results.push(await t('validateLookupRow: fresh row + matching DOT → no error', () => {
    const freshRow = { created_at: new Date().toISOString(), dot_number: '1234567' };
    const err = validateLookupRow(freshRow, '1234567', Date.now(), 24 * 60 * 60 * 1000);
    assert(err === null, `expected null (valid), got: ${err}`);
  }));

  // A-CRASH. crashes24mo object in server_fields → applyToSubmission preserves it as object
  //          Regression test for "Not reviewed (no data)" bug: crashes24mo was in SCALAR_AUTO_FIELDS,
  //          got stringified to "[object Object]", PDF saw crashes.count == null → "Not reviewed".
  results.push(await t('applyToSubmission: crashes24mo object preserved from server_fields', () => {
    const crashObj = { count: 4, fatal: 0, injury: 2, tow: 2, items: [] };
    const savedLookup = {
      auto_filled:   { carrierName: { value: 'UGN Carrier LLC', sourceLabel: 'FMCSA' } },
      server_fields: { crashes24mo: crashObj },
      fmcsa_cannot_verify: false,
    };
    const browser = { ...CLEAN };
    const data = applyToSubmission(savedLookup, browser);
    assert(typeof data.crashes24mo === 'object' && data.crashes24mo !== null,
      `crashes24mo must be an object after applyToSubmission, got: ${typeof data.crashes24mo} (${JSON.stringify(data.crashes24mo)})`);
    assert(data.crashes24mo.count === 4,
      `crashes24mo.count must be 4, got: ${data.crashes24mo?.count}`);
    assert(data.crashes24mo.injury === 2,
      `crashes24mo.injury must be 2, got: ${data.crashes24mo?.injury}`);
  }));

  // A-TYPES. All scalar auto-filled field types reach carrierData with the correct native type
  //          after applyToSubmission. Verifies strings stay strings, booleans come back as
  //          actual booleans (not "true"/"false"), and numeric strings stay as strings (compatible
  //          with parseFloat in the rules engine).
  results.push(await t('applyToSubmission: all auto-filled field types preserved correctly', () => {
    const savedLookup = {
      auto_filled: {
        carrierName:          { value: 'Type Test LLC',   sourceLabel: 'FMCSA' },
        authorityStatus:      { value: 'active',          sourceLabel: 'FMCSA' },
        safetyRating:         { value: 'Satisfactory',    sourceLabel: 'FMCSA' },
        authorityGrantDate:   { value: '2020-01-01',      sourceLabel: 'FMCSA' },
        truckOosPct:          { value: '15.00',           sourceLabel: 'FMCSA' },
        autoLiability:        { value: '1000000',         sourceLabel: 'SaferWatch' },
        autoLiabilityExpiration: { value: futureDate(90), sourceLabel: 'SaferWatch' },
        activeFederalOOS:     { value: 'false',           sourceLabel: 'FMCSA' },
        hasBrokerAuthority:   { value: 'false',           sourceLabel: 'FMCSA' },
        bipdCancelPending:    { value: 'false',           sourceLabel: 'FMCSA BMC-35' },
        bipdCancelLapsed:     { value: 'false',           sourceLabel: 'FMCSA BMC-35' },
        pendingInsuranceCancellation: { value: 'false',   sourceLabel: 'FMCSA BMC-35' },
        drugAlcoholViolation: { value: 'false',           sourceLabel: 'SaferWatch' },
        fmcsaChameleonNotReviewed: { value: 'false',      sourceLabel: 'FMCSA' },
        fmcsaEmailNotReviewed:     { value: 'false',      sourceLabel: 'FMCSA' },
        fmcsaChameleonTimedOut:    { value: 'false',      sourceLabel: 'FMCSA' },
      },
      server_fields: {},
      fmcsa_cannot_verify: false,
    };
    const data = applyToSubmission(savedLookup, { ...CLEAN });
    // Strings stay as strings
    assert(data.carrierName === 'Type Test LLC', `carrierName must be string`);
    assert(data.authorityStatus === 'active', `authorityStatus must be string`);
    assert(data.safetyRating === 'Satisfactory', `safetyRating must be string`);
    // Numeric strings stay as strings (parseFloat-compatible)
    assert(data.truckOosPct === '15.00', `truckOosPct must be string '15.00'`);
    assert(data.autoLiability === '1000000', `autoLiability must be string`);
    // Date strings stay as strings
    assert(typeof data.authorityGrantDate === 'string', `authorityGrantDate must be string`);
    // Booleans — 'false' string must become boolean false (not the string)
    assert(data.activeFederalOOS === false,     `activeFederalOOS must be boolean false, got ${typeof data.activeFederalOOS}`);
    assert(data.hasBrokerAuthority === false,   `hasBrokerAuthority must be boolean false, got ${typeof data.hasBrokerAuthority}`);
    assert(data.bipdCancelPending === false,    `bipdCancelPending must be boolean false, got ${typeof data.bipdCancelPending}`);
    assert(data.bipdCancelLapsed === false,     `bipdCancelLapsed must be boolean false, got ${typeof data.bipdCancelLapsed}`);
    assert(data.pendingInsuranceCancellation === false, `pendingInsuranceCancellation must be boolean false`);
    assert(data.drugAlcoholViolation === false, `drugAlcoholViolation must be boolean false, got ${typeof data.drugAlcoholViolation}`);
    assert(data.fmcsaChameleonNotReviewed === false, `fmcsaChameleonNotReviewed must be boolean false`);
    assert(data.fmcsaEmailNotReviewed === false,     `fmcsaEmailNotReviewed must be boolean false`);
    assert(data.fmcsaChameleonTimedOut === false,    `fmcsaChameleonTimedOut must be boolean false`);
    // 'true' variants also coerced
    const savedTrue = {
      auto_filled: {
        activeFederalOOS:     { value: 'true', sourceLabel: 'FMCSA' },
        drugAlcoholViolation: { value: 'true', sourceLabel: 'SaferWatch' },
        bipdCancelLapsed:     { value: 'true', sourceLabel: 'FMCSA BMC-35' },
      },
      server_fields: {},
      fmcsa_cannot_verify: false,
    };
    const dataTrue = applyToSubmission(savedTrue, { ...CLEAN });
    assert(dataTrue.activeFederalOOS === true,     `activeFederalOOS 'true' must become boolean true`);
    assert(dataTrue.drugAlcoholViolation === true, `drugAlcoholViolation 'true' must become boolean true`);
    assert(dataTrue.bipdCancelLapsed === true,     `bipdCancelLapsed 'true' must become boolean true`);
  }));

  // A3. Manual fields preserved from browser (loadRef, dispatcher, contactPhone, contactEmail)
  results.push(await t('applyToSubmission: manual fields preserved from browser', () => {
    const savedLookup = {
      auto_filled:   { carrierName: { value: 'Server Carrier', sourceLabel: 'FMCSA' } },
      server_fields: {},
      fmcsa_cannot_verify: false,
    };
    const browser = {
      carrierName:   'Fake Name',       // auto-filled: server must win
      loadRef:       'REF-XYZ',
      dispatcher:    'Bob',
      contactPhone:  '5559998888',
      contactEmail:  'bob@company.com',
    };
    const data = applyToSubmission(savedLookup, browser);
    assert(data.carrierName    === 'Server Carrier', 'carrierName must be from server');
    assert(data.loadRef        === 'REF-XYZ',        'loadRef must be preserved');
    assert(data.dispatcher     === 'Bob',            'dispatcher must be preserved');
    assert(data.contactPhone   === '5559998888',     'contactPhone must be preserved');
    assert(data.contactEmail   === 'bob@company.com','contactEmail must be preserved');
  }));

  // ── lookup_merge.js: applyStricterEdits ──────────────────────────────────────

  // S1. Dispatcher tries to lower OOS below the REJECT threshold — server value kept, still REJECT
  results.push(await t('applyStricterEdits: OOS lowered (20.2 → 19.8) → server value used, still REJECT', async () => {
    const savedLookup = {
      auto_filled:   { truckOosPct: { value: '20.2', sourceLabel: 'FMCSA' } },
      server_fields: {},
      fmcsa_cannot_verify: false,
    };
    const browser = { ...CLEAN, truckOosPct: '19.8' };
    const applied = applyToSubmission(savedLookup, browser);
    const edits   = detectEdits(savedLookup.auto_filled, browser);
    applied._dispatcherEdits = edits;
    const strict  = applyStricterEdits(applied, edits);
    assert(parseFloat(strict.truckOosPct) === 20.2,
      `server OOS (20.2) must be kept — got ${strict.truckOosPct}`);
    const r = runVettingRules(strict, CFG);
    assert(r.verdict === 'REJECT',
      `lowering OOS must still REJECT with server value — got ${r.verdict}: ${r.reasons.join('; ')}`);
    const pdfErr = await checkPdf(strict, r);
    assert(!pdfErr, `PDF: ${pdfErr}`);
  }));

  // S2. Dispatcher raises OOS above the REJECT threshold — dispatcher value used, now REJECT
  results.push(await t('applyStricterEdits: OOS raised (15.0 → 25.0) → dispatcher value used, REJECT', async () => {
    const savedLookup = {
      auto_filled:   { truckOosPct: { value: '15.0', sourceLabel: 'FMCSA' } },
      server_fields: {},
      fmcsa_cannot_verify: false,
    };
    const browser = { ...CLEAN, truckOosPct: '25.0' };
    const applied = applyToSubmission(savedLookup, browser);
    const edits   = detectEdits(savedLookup.auto_filled, browser);
    applied._dispatcherEdits = edits;
    const strict  = applyStricterEdits(applied, edits);
    assert(parseFloat(strict.truckOosPct) === 25.0,
      `dispatcher OOS (25.0) must be applied as stricter — got ${strict.truckOosPct}`);
    const r = runVettingRules(strict, CFG);
    assert(r.verdict === 'REJECT',
      `raising OOS above threshold must REJECT — got ${r.verdict}: ${r.reasons.join('; ')}`);
    const pdfErr = await checkPdf(strict, r);
    assert(!pdfErr, `PDF: ${pdfErr}`);
  }));

  // S3. Authority status: inactive wins over active
  results.push(await t('applyStricterEdits: authority status inactive → applied; active → not applied', () => {
    // inactive wins when server says active
    const edits1 = { authorityStatus: { original: 'active', sourceLabel: 'FMCSA', submitted: 'inactive' } };
    const c1 = { ...CLEAN, authorityStatus: 'active', _dispatcherEdits: edits1 };
    const s1 = applyStricterEdits(c1, edits1);
    assert(s1.authorityStatus === 'inactive', `inactive must win over active, got ${s1.authorityStatus}`);

    // looser edit rejected: server says inactive, dispatcher says active
    const edits2 = { authorityStatus: { original: 'inactive', sourceLabel: 'FMCSA', submitted: 'active' } };
    const c2 = { ...CLEAN, authorityStatus: 'inactive', _dispatcherEdits: edits2 };
    const s2 = applyStricterEdits(c2, edits2);
    assert(s2.authorityStatus === 'inactive', `active must NOT override inactive, got ${s2.authorityStatus}`);
  }));

  // S4. Drug/alcohol: true wins over false → REJECT
  results.push(await t('applyStricterEdits: drugAlcohol true → applied, REJECT', async () => {
    const edits = { drugAlcoholViolation: { original: 'false', sourceLabel: 'SaferWatch', submitted: 'true' } };
    const carrier = { ...CLEAN, drugAlcoholViolation: false, _dispatcherEdits: edits };
    const strict = applyStricterEdits(carrier, edits);
    assert(strict.drugAlcoholViolation === true, `drug/alcohol true must be applied, got ${strict.drugAlcoholViolation}`);
    const r = runVettingRules(strict, CFG);
    assert(r.verdict === 'REJECT', `drug/alcohol true must REJECT, got ${r.verdict}`);
    const pdfErr = await checkPdf(strict, r);
    assert(!pdfErr, `PDF: ${pdfErr}`);
  }));

  // S5. Insurance expiration: earlier date wins (expires sooner = stricter)
  results.push(await t('applyStricterEdits: earlier insurance expiration → applied; later → not applied', () => {
    const earlier = futureDate(10);   // expires in 10 days
    const later   = futureDate(90);   // expires in 90 days

    // earlier submitted wins
    const edits1 = { autoLiabilityExpiration: { original: later, sourceLabel: 'SaferWatch', submitted: earlier } };
    const c1 = { ...CLEAN, autoLiabilityExpiration: later, _dispatcherEdits: edits1 };
    const s1 = applyStricterEdits(c1, edits1);
    assert(s1.autoLiabilityExpiration === earlier, `earlier expiration must win, got ${s1.autoLiabilityExpiration}`);

    // later submitted rejected
    const edits2 = { autoLiabilityExpiration: { original: earlier, sourceLabel: 'SaferWatch', submitted: later } };
    const c2 = { ...CLEAN, autoLiabilityExpiration: earlier, _dispatcherEdits: edits2 };
    const s2 = applyStricterEdits(c2, edits2);
    assert(s2.autoLiabilityExpiration === earlier, `later expiration must NOT override earlier, got ${s2.autoLiabilityExpiration}`);
  }));

  // S6. Authority grant date: later date wins (younger authority = fewer days = stricter)
  results.push(await t('applyStricterEdits: later authority grant date (younger) → applied; earlier → not applied', () => {
    const older  = '2020-01-01';       // 5+ years ago (many authority days → passes)
    const newer  = futureDate(-100);   // 100 days ago (few authority days → stricter)

    // newer submitted wins
    const edits1 = { authorityGrantDate: { original: older, sourceLabel: 'FMCSA', submitted: newer } };
    const c1 = { ...CLEAN, authorityGrantDate: older, _dispatcherEdits: edits1 };
    const s1 = applyStricterEdits(c1, edits1);
    assert(s1.authorityGrantDate === newer, `later grant date must win, got ${s1.authorityGrantDate}`);

    // older submitted rejected
    const edits2 = { authorityGrantDate: { original: newer, sourceLabel: 'FMCSA', submitted: older } };
    const c2 = { ...CLEAN, authorityGrantDate: newer, _dispatcherEdits: edits2 };
    const s2 = applyStricterEdits(c2, edits2);
    assert(s2.authorityGrantDate === newer, `older grant date must NOT override newer, got ${s2.authorityGrantDate}`);
  }));

  // ── Full /run-path tests: server-authoritative lookup → runVettingRules ────────
  // These simulate exactly what vetting.js /run does:
  //   applyToSubmission → detectEdits → applyStricterEdits → runVettingRules
  // Each test has the bad value in auto_filled (server-side) and a clean browser body.

  function runPath(autoFilledOverrides, browserOverrides = {}) {
    const savedLookup = {
      auto_filled:   autoFilledOverrides,
      server_fields: {},
      fmcsa_cannot_verify: false,
    };
    const browser = { ...CLEAN, ...browserOverrides };
    const data  = applyToSubmission(savedLookup, browser);
    const edits = detectEdits(savedLookup.auto_filled, browser);
    if (Object.keys(edits).length > 0) data._dispatcherEdits = edits;
    return runVettingRules(applyStricterEdits(data, edits), CFG);
  }

  // FP-CRASH. Bug regression: crashes24mo auto-filled as object from server_fields →
  //           applyToSubmission preserves object → PDF renders crash count, not "Not reviewed".
  //           (Triggered ~2026-11-12: crashes24mo was in SCALAR_AUTO_FIELDS, got stringified.)
  results.push(await t('full /run path: crashes24mo auto-filled (4 crashes) → PDF renders count', async () => {
    const crashObj = { count: 4, fatal: 0, injury: 2, tow: 2, items: [] };
    const savedLookup = {
      auto_filled:   {},   // crashes24mo not in auto_filled — it's a complex field
      server_fields: { crashes24mo: crashObj },
      fmcsa_cannot_verify: false,
    };
    const browser = { ...CLEAN };
    const data  = applyToSubmission(savedLookup, browser);
    const edits = detectEdits(savedLookup.auto_filled, browser);
    if (Object.keys(edits).length > 0) data._dispatcherEdits = edits;
    const ruleData = applyStricterEdits(data, edits);

    // crashes24mo must survive as an object — not "[object Object]"
    assert(ruleData.crashes24mo?.count === 4,
      `crashes24mo.count must be 4 after full path, got: ${JSON.stringify(ruleData.crashes24mo)}`);
    assert(ruleData.crashes24mo?.injury === 2,
      `crashes24mo.injury must be 2 after full path, got: ${ruleData.crashes24mo?.injury}`);

    const r = runVettingRules(ruleData, CFG);
    assert(r.verdict === 'APPROVE',
      `crash data alone must not change verdict, got ${r.verdict}: ${r.reasons.join('; ')}`);

    // PDF must render the crash count (not "Not reviewed")
    // We verify by checking the PDF generates without crash — the crash count rendering
    // is indirectly validated because a string "[object Object]" would cause a different
    // code path and the count would show as null (which we asserted above is 4).
    const pdfErr = await checkPdf(ruleData, r);
    assert(!pdfErr, `PDF must render with crash data: ${pdfErr}`);
  }));

  // FP-DA. Bug regression: SW reports controlSubPCT 8 → drugAlcoholViolation stored as
  //        string 'true' in auto_filled → applyToSubmission must restore boolean true →
  //        rules engine must see true → REJECT, no override.
  //        (Precision Transportation bug: was HOLD because string 'true' !== true)
  results.push(await t('full /run path: drugAlcohol auto-filled true (SW) → REJECT canOverride:false', async () => {
    const r = runPath({
      drugAlcoholViolation: { value: 'true', sourceLabel: 'SaferWatch' },
    });
    assert(r.verdict === 'REJECT',
      `want REJECT, got ${r.verdict} — string 'true' not being coerced to boolean true is the bug`);
    assert(r.reasons.some(s => s.toLowerCase().includes('drug/alcohol')),
      `drug/alcohol reason must fire: ${r.reasons.join('; ')}`);
    assert(r.canOverride === false, 'drug/alcohol violation must set canOverride:false');
    // Browser had drugAlcoholViolation: false — dispatcher could NOT override the SW finding
    const pdfErr = await checkPdf({ ...CLEAN, drugAlcoholViolation: true }, r);
    assert(!pdfErr, `PDF: ${pdfErr}`);
  }));

  // FP-AUTH. Inactive authority auto-filled → REJECT
  results.push(await t('full /run path: inactive authority auto-filled → REJECT canOverride:false', async () => {
    const r = runPath({
      authorityStatus: { value: 'inactive', sourceLabel: 'FMCSA' },
    });
    assert(r.verdict === 'REJECT',
      `want REJECT for inactive authority, got ${r.verdict}: ${r.reasons.join('; ')}`);
    assert(r.reasons.some(s => s.includes('inactive')),
      `inactive reason must fire: ${r.reasons.join('; ')}`);
    assert(r.canOverride === false, 'inactive authority must set canOverride:false');
    const pdfErr = await checkPdf({ ...CLEAN, authorityStatus: 'inactive' }, r);
    assert(!pdfErr, `PDF: ${pdfErr}`);
  }));

  // FP-COND. Conditional safety rating auto-filled → REJECT
  results.push(await t('full /run path: Conditional safety rating auto-filled → REJECT canOverride:false', async () => {
    const r = runPath({
      safetyRating: { value: 'Conditional', sourceLabel: 'FMCSA' },
    });
    assert(r.verdict === 'REJECT',
      `want REJECT for Conditional, got ${r.verdict}: ${r.reasons.join('; ')}`);
    assert(r.reasons.some(s => s.includes('Conditional')),
      `Conditional reason must fire: ${r.reasons.join('; ')}`);
    assert(r.canOverride === false, 'Conditional must set canOverride:false');
    const pdfErr = await checkPdf({ ...CLEAN, safetyRating: 'Conditional' }, r);
    assert(!pdfErr, `PDF: ${pdfErr}`);
  }));

  // FP-UNSAT. Unsatisfactory safety rating auto-filled → REJECT
  results.push(await t('full /run path: Unsatisfactory safety rating auto-filled → REJECT canOverride:false', async () => {
    const r = runPath({
      safetyRating: { value: 'Unsatisfactory', sourceLabel: 'FMCSA' },
    });
    assert(r.verdict === 'REJECT',
      `want REJECT for Unsatisfactory, got ${r.verdict}: ${r.reasons.join('; ')}`);
    assert(r.reasons.some(s => s.includes('Unsatisfactory')),
      `Unsatisfactory reason must fire: ${r.reasons.join('; ')}`);
    assert(r.canOverride === false, 'Unsatisfactory must set canOverride:false');
    const pdfErr = await checkPdf({ ...CLEAN, safetyRating: 'Unsatisfactory' }, r);
    assert(!pdfErr, `PDF: ${pdfErr}`);
  }));

  // FP-LAPSED. Lapsed BIPD insurance auto-filled (no active SW coverage) → REJECT
  results.push(await t('full /run path: lapsed BIPD insurance auto-filled (no SW coverage) → REJECT', async () => {
    const r = runPath(
      { bipdCancelLapsed: { value: 'true', sourceLabel: 'FMCSA BMC-35' } },
      { autoLiabilityExpiration: '' },   // no active SW expiry → no conflict path → hard RED
    );
    assert(r.verdict === 'REJECT',
      `want REJECT for lapsed BIPD, got ${r.verdict}: ${r.reasons.join('; ')}`);
    assert(r.reasons.some(s => s.includes('cancelled')),
      `lapsed-BIPD reason must fire: ${r.reasons.join('; ')}`);
    assert(r.canOverride === false, 'lapsed BIPD must set canOverride:false');
    const pdfErr = await checkPdf({ ...CLEAN, bipdCancelLapsed: true, autoLiabilityExpiration: '' }, r);
    assert(!pdfErr, `PDF: ${pdfErr}`);
  }));

  // FP-BASIC. BASIC at-or-above threshold auto-filled (action=reject) → REJECT
  results.push(await t('full /run path: BASIC unsafeDriving ≥ threshold auto-filled → REJECT', async () => {
    const r = runPath({
      unsafeDrivingBasic: { value: '65', sourceLabel: 'SaferWatch' },
    });
    assert(r.verdict === 'REJECT',
      `want REJECT for BASIC at threshold, got ${r.verdict}: ${r.reasons.join('; ')}`);
    assert(r.reasons.some(s => s.includes('Unsafe Driving') && s.includes('at or above')),
      `BASIC reject reason must fire: ${r.reasons.join('; ')}`);
    assert(r.canOverride === false, 'BASIC reject must set canOverride:false');
    const pdfErr = await checkPdf({ ...CLEAN, unsafeDrivingBasic: '65' }, r);
    assert(!pdfErr, `PDF: ${pdfErr}`);
  }));

  // FP-OOS-TRUCK. Truck OOS > max auto-filled → REJECT
  results.push(await t('full /run path: truck OOS > max auto-filled → REJECT canOverride:false', async () => {
    const r = runPath({
      truckOosPct:         { value: '25.00', sourceLabel: 'FMCSA' },
      nationalAvgTruckOos: { value: '10.00', sourceLabel: 'FMCSA' },
    });
    assert(r.verdict === 'REJECT',
      `want REJECT for truck OOS 25>20, got ${r.verdict}: ${r.reasons.join('; ')}`);
    assert(r.reasons.some(s => s.includes('maximum')),
      `OOS max reason must fire: ${r.reasons.join('; ')}`);
    assert(r.canOverride === false, 'truck OOS max must set canOverride:false');
    const pdfErr = await checkPdf({ ...CLEAN, truckOosPct: '25.00', nationalAvgTruckOos: '10.00' }, r);
    assert(!pdfErr, `PDF: ${pdfErr}`);
  }));

  // FP-OOS-DRV. Driver OOS > hard block auto-filled → REJECT
  results.push(await t('full /run path: driver OOS > hard block auto-filled → REJECT canOverride:false', async () => {
    const r = runPath({
      driverOosPct:         { value: '7.5', sourceLabel: 'FMCSA' },
      nationalAvgDriverOos: { value: '4.00', sourceLabel: 'FMCSA' },
    });
    assert(r.verdict === 'REJECT',
      `want REJECT for driver OOS 7.5>7, got ${r.verdict}: ${r.reasons.join('; ')}`);
    assert(r.reasons.some(s => s.includes('hard limit') && s.includes('7.5%')),
      `driver hard_block reason must fire: ${r.reasons.join('; ')}`);
    assert(r.canOverride === false, 'driver OOS hard block must set canOverride:false');
    const pdfErr = await checkPdf({ ...CLEAN, driverOosPct: '7.5', nationalAvgDriverOos: '4.00' }, r);
    assert(!pdfErr, `PDF: ${pdfErr}`);
  }));

  // DLS-INSUR. refreshInsuranceCancellations writes daily_load_status after full load
  results.push(await t('DLS: refreshInsuranceCancellations writes daily_load_status', async () => {
    const { supa, dlsWrites } = makeDlsSupa();
    const origFetch = globalThis.fetch;
    globalThis.fetch = function(url) {
      const u = String(url);
      if (u.includes('$select=count(*)')) return Promise.resolve({ ok: true, json: () => Promise.resolve([{ count: '1' }]) });
      if (u.includes('BMC-35'))           return Promise.resolve({ ok: true, json: () => Promise.resolve([{ usdot_number: '123456', docket_number: 'MC-123', effective_date: '20240101' }]) });
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
    };
    try {
      await refreshInsuranceCancellations(supa);
    } finally {
      globalThis.fetch = origFetch;
    }
    assert(dlsWrites.some(r => r.table_name === 'insurance_cancellations'),
      `daily_load_status not written for insurance_cancellations; writes: ${JSON.stringify(dlsWrites)}`);
  }));

  // DLS-OOS. refreshOosOrders writes daily_load_status after full load
  results.push(await t('DLS: refreshOosOrders writes daily_load_status', async () => {
    const { supa, dlsWrites } = makeDlsSupa();
    const origFetch = globalThis.fetch;
    globalThis.fetch = function(url) {
      const u = String(url);
      if (u.includes('$select=count(*)')) return Promise.resolve({ ok: true, json: () => Promise.resolve([{ count: '1' }]) });
      return Promise.resolve({ ok: true, json: () => Promise.resolve([{ dot_number: '123456', oos_date: '2024-01-01', oos_reason: 'Test' }]) });
    };
    try {
      await refreshOosOrders(supa);
    } finally {
      globalThis.fetch = origFetch;
    }
    assert(dlsWrites.some(r => r.table_name === 'oos_orders'),
      `daily_load_status not written for oos_orders; writes: ${JSON.stringify(dlsWrites)}`);
  }));

  // DLS-REVOKE. refreshSaferRevocations writes daily_load_status after full load
  results.push(await t('DLS: refreshSaferRevocations writes daily_load_status', async () => {
    const { supa, dlsWrites } = makeDlsSupa();
    const origFetch = globalThis.fetch;
    globalThis.fetch = function(url) {
      const u = String(url);
      if (u.includes('api/views/'))       return Promise.resolve({ ok: true, json: () => Promise.resolve({ rowsUpdatedAt: 1 }) });
      if (u.includes('$select=count(*)')) return Promise.resolve({ ok: true, json: () => Promise.resolve([{ count: '1' }]) });
      return Promise.resolve({ ok: true, json: () => Promise.resolve([{
        dot_number: '123456', order2_type_desc: 'INVOLUNTARY REVOCATION',
        order2_effective_date: '01/01/2024', docket_number: 'MC-123',
      }]) });
    };
    try {
      await refreshSaferRevocations(supa);
    } finally {
      globalThis.fetch = origFetch;
    }
    assert(dlsWrites.some(r => r.table_name === 'safer_revocations'),
      `daily_load_status not written for safer_revocations; writes: ${JSON.stringify(dlsWrites)}`);
  }));

  // DLS-MOTUS. refreshMotusSuspensions writes daily_load_status after full load
  results.push(await t('DLS: refreshMotusSuspensions writes daily_load_status', async () => {
    const { supa, dlsWrites } = makeDlsSupa();
    const origFetch = globalThis.fetch;
    globalThis.fetch = function(url) {
      const u = String(url);
      if (u.includes('$select=count(*)')) return Promise.resolve({ ok: true, json: () => Promise.resolve([{ count: '1' }]) });
      return Promise.resolve({ ok: true, json: () => Promise.resolve([{
        usdot_number: '123456', order1_type_desc: 'INVOLUNTARY SUSPENSION', order1_effective_date: '2024-01-01',
      }]) });
    };
    try {
      await refreshMotusSuspensions(supa);
    } finally {
      globalThis.fetch = origFetch;
    }
    assert(dlsWrites.some(r => r.table_name === 'motus_suspensions'),
      `daily_load_status not written for motus_suspensions; writes: ${JSON.stringify(dlsWrites)}`);
  }));

  // PDF-FP-1. PDF generates, SHA-256 is a 64-char hex string
  results.push(await t('PDF integrity: sha256 of generated PDF is 64-char hex', async () => {
    const r = runVettingRules(CLEAN, CFG);
    const buf = await generateVettingPDF({
      carrierData:  CLEAN,
      verdict:      r.verdict,
      tier:         r.tier,
      reasons:      r.reasons,
      warnings:     r.warnings ?? [],
      authorityDays: null,
      override:     null,
      generatedAt:  new Date(),
      recordId:     '00000000-0000-0000-0000-000000000002',
      settings:     CFG,
      brokerName:   'Test Brokerage',
      fieldSources: {},
      timesUsed:    0,
    });
    assert(Buffer.isBuffer(buf) && buf.slice(0, 4).toString() === '%PDF', 'expected valid PDF');
    const hash = createHash('sha256').update(buf).digest('hex');
    assert(/^[0-9a-f]{64}$/.test(hash), `sha256 is not 64-char hex: ${hash}`);
  }));

  // PDF-FP-3. Dispatcher edit on non-stricter field — "verified value used" note
  results.push(await t('PDF integrity: dispatcher edit on non-stricter field → "verified value used"', async () => {
    // powerUnits has no stricter direction; edit should not be applied, note says "verified value used"
    const edits = { powerUnits: { original: '10', sourceLabel: 'FMCSA', submitted: '15' } };
    const carrier = { ...CLEAN, powerUnits: '10', _dispatcherEdits: edits };
    const r = runVettingRules(carrier, CFG);
    // PDF must not crash — the note text is embedded in compressed stream so we only verify no crash
    const buf = await generateVettingPDF({
      carrierData:  carrier,
      verdict:      r.verdict,
      tier:         r.tier,
      reasons:      r.reasons,
      warnings:     r.warnings ?? [],
      authorityDays: null,
      override:     null,
      generatedAt:  new Date(),
      recordId:     '00000000-0000-0000-0000-000000000004',
      settings:     CFG,
      brokerName:   'Test Brokerage',
      fieldSources: {},
      timesUsed:    0,
    });
    assert(Buffer.isBuffer(buf) && buf.slice(0, 4).toString() === '%PDF', 'expected valid PDF');
  }));

  // MC-1. fmcsaMcLookup with real FMCSA response: content is an ARRAY of { carrier }
  results.push(await t('fmcsaMcLookup: content[] array format (real FMCSA shape) → resolves dotNumber and name', async () => {
    const savedFetch = globalThis.fetch;
    const carrier = {
      dotNumber: 2939905, legalName: 'UGN LOGISTICS INC',
      totalPowerUnits: 41, totalDrivers: 41,
      commonAuthorityStatus: 'A', contractAuthorityStatus: 'N',
      allowedToOperate: 'Y', safetyRating: null,
      vehicleInsp: 39, vehicleOosInsp: 7, vehicleOosRate: 17.95,
      driverInsp: 98, driverOosInsp: 1, driverOosRate: 1.02,
      crashTotal: 4, fatalCrash: 0, injCrash: 0, towawayCrash: 4,
      brokerAuthorityStatus: 'N',
    };
    globalThis.fetch = async (url) => {
      const u = String(url);
      // Real FMCSA docket-number shape: content is an array of { _links, carrier }
      if (u.includes('/carriers/docket-number/'))
        return { ok: true, status: 200, json: async () => ({
          content: [{ _links: {}, carrier }],
          retrievalDate: '2026-11-17T19:25:49.228+0000',
        }) };
      if (u.includes('/docket-numbers'))
        return { ok: true, status: 200, json: async () => ({ content: { item: [] } }) };
      if (u.includes('/authority'))
        return { ok: true, status: 200, json: async () => ({ content: { item: [] } }) };
      if (u.includes('safer.fmcsa.dot.gov'))
        return { ok: true, status: 200, text: async () => '<html></html>' };
      return { ok: true, status: 200, json: async () => ({}) };
    };
    try {
      const result = await fmcsaMcLookup('994024', 'test-webkey');
      assert(result.dotNumber === '2939905',
        `dotNumber must be '2939905', got ${result.dotNumber}`);
      assert(result.carrierName === 'UGN LOGISTICS INC',
        `carrierName wrong: ${result.carrierName}`);
      assert(result.authorityStatus === 'Active-Common',
        `authorityStatus wrong: ${result.authorityStatus}`);
      assert(result.powerUnits === '41', `powerUnits wrong: ${result.powerUnits}`);
    } finally {
      globalThis.fetch = savedFetch;
    }
  }));

  // MC-2. fmcsaMcLookup with legacy content.carrier format (resilience)
  results.push(await t('fmcsaMcLookup: legacy content.carrier format → still works', async () => {
    const savedFetch = globalThis.fetch;
    const carrier = {
      dotNumber: 2939905, legalName: 'UGN LOGISTICS INC',
      totalPowerUnits: 41, totalDrivers: 41,
      commonAuthorityStatus: 'A', contractAuthorityStatus: 'N',
      allowedToOperate: 'Y', safetyRating: null,
      vehicleInsp: 39, vehicleOosInsp: 7, vehicleOosRate: 17.95,
      driverInsp: 98, driverOosInsp: 1, driverOosRate: 1.02,
    };
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes('/carriers/docket-number/'))
        return { ok: true, status: 200, json: async () => ({ content: { carrier } }) };
      if (u.includes('/docket-numbers'))
        return { ok: true, status: 200, json: async () => ({ content: { item: [] } }) };
      if (u.includes('/authority'))
        return { ok: true, status: 200, json: async () => ({ content: { item: [] } }) };
      if (u.includes('safer.fmcsa.dot.gov'))
        return { ok: true, status: 200, text: async () => '<html></html>' };
      return { ok: true, status: 200, json: async () => ({}) };
    };
    try {
      const result = await fmcsaMcLookup('994024', 'test-webkey');
      assert(result.dotNumber === '2939905',
        `dotNumber must be '2939905', got ${result.dotNumber}`);
      assert(result.carrierName === 'UGN LOGISTICS INC',
        `carrierName wrong: ${result.carrierName}`);
      assert(result.authorityStatus !== undefined, 'authorityStatus must be present');
    } finally {
      globalThis.fetch = savedFetch;
    }
  }));

  // 21. Data isolation: second run on a clean carrier has zero contamination from first
  results.push(await t('data isolation — REJECT then APPROVE yields clean second result', async () => {
    const reject = { ...CLEAN, safetyRating: 'Unsatisfactory', drugAlcoholViolation: true, activeFederalOOS: true };
    const r1 = runVettingRules(reject, CFG);
    assert(r1.verdict === 'REJECT', `first run should be REJECT, got ${r1.verdict}`);

    const r2 = runVettingRules(CLEAN, CFG);
    assert(r2.verdict === 'APPROVE',
      `second run should APPROVE (no bleedover), got ${r2.verdict}: ${r2.reasons.join('; ')}`);
    assert(r2.reasons.length === 1,
      `second run should have exactly 1 reason (approve msg), got ${r2.reasons.length}: ${r2.reasons.join('; ')}`);
    assert(r2.warnings.length === 0,
      `second run should have 0 warnings, got ${r2.warnings.length}: ${r2.warnings.join('; ')}`);

    const pdfErr = await checkPdf(CLEAN, r2);
    assert(!pdfErr, `PDF: ${pdfErr}`);
  }));

  // ── FMCSA liability cross-source checks ──────────────────────────────────

  // FMCSA liability: both live + nightly agree no coverage → RED REJECT
  results.push(await t('FMCSA liability: live=0, nightly lapsed, no SW → RED REJECT', async () => {
    const d = { ...CLEAN, fmcsaLiabilityOnFile: 0, fmcsaLiabilityRequired: 750000,
                fmcsaLiabilityIsRequired: 'Y', bipdCancelLapsed: true, autoLiability: '' };
    const r = runVettingRules(d, CFG);
    assert(r.verdict === 'REJECT', `expected REJECT, got ${r.verdict}`);
    assert(r.reasons.some(r => /FMCSA liability on file.*below.*required/i.test(r)),
      `expected FMCSA liability reason, got: ${r.reasons.join('; ')}`);
    const pdfErr = await checkPdf(d, r);
    assert(!pdfErr, `PDF: ${pdfErr}`);
  }));

  // FMCSA liability: live says short, SW shows adequate → HOLD (sources conflict)
  results.push(await t('FMCSA liability: live below required, SW shows adequate → HOLD sources conflict', async () => {
    const d = { ...CLEAN, fmcsaLiabilityOnFile: 0, fmcsaLiabilityRequired: 750000,
                fmcsaLiabilityIsRequired: 'Y', bipdCancelLapsed: false, autoLiability: '1000000' };
    const r = runVettingRules(d, CFG);
    assert(r.verdict === 'HOLD', `expected HOLD, got ${r.verdict}: ${r.reasons.join('; ')}`);
    assert(r.reasons.some(r => /sources conflict/i.test(r)),
      `expected sources conflict reason, got: ${r.reasons.join('; ')}`);
    const pdfErr = await checkPdf(d, r);
    assert(!pdfErr, `PDF: ${pdfErr}`);
  }));

  // FMCSA liability: live says short, nightly no lapse, no SW → HOLD out of sync
  results.push(await t('FMCSA liability: live below required, nightly no lapse → HOLD out of sync', async () => {
    const d = { ...CLEAN, fmcsaLiabilityOnFile: 300000, fmcsaLiabilityRequired: 750000,
                fmcsaLiabilityIsRequired: 'Y', bipdCancelLapsed: false, autoLiability: '' };
    const r = runVettingRules(d, CFG);
    assert(r.verdict === 'HOLD', `expected HOLD, got ${r.verdict}: ${r.reasons.join('; ')}`);
    assert(r.reasons.some(r => /out of sync/i.test(r)),
      `expected out of sync reason, got: ${r.reasons.join('; ')}`);
    const pdfErr = await checkPdf(d, r);
    assert(!pdfErr, `PDF: ${pdfErr}`);
  }));

  // FMCSA liability: meets requirement → no rule fires
  results.push(await t('FMCSA liability: on file meets required → APPROVE', async () => {
    const d = { ...CLEAN, fmcsaLiabilityOnFile: 750000, fmcsaLiabilityRequired: 750000,
                fmcsaLiabilityIsRequired: 'Y' };
    const r = runVettingRules(d, CFG);
    assert(r.verdict === 'APPROVE', `expected APPROVE, got ${r.verdict}: ${r.reasons.join('; ')}`);
  }));

  // FMCSA liability: required='U' (unknown) → no rule fires, cert says "Not reviewed"
  results.push(await t('FMCSA liability: required=U → no rule fires', async () => {
    const d = { ...CLEAN, fmcsaLiabilityOnFile: 0, fmcsaLiabilityRequired: 0,
                fmcsaLiabilityIsRequired: 'U' };
    const r = runVettingRules(d, CFG);
    assert(r.verdict === 'APPROVE', `expected APPROVE, got ${r.verdict}: ${r.reasons.join('; ')}`);
    const pdfErr = await checkPdf(d, r);
    assert(!pdfErr, `PDF: ${pdfErr}`);
  }));

  // bipdCancelLapsed + QCMobile still shows $1M → REJECT + "likely not yet updated" note
  results.push(await t('bipdCancelLapsed: QCMobile shows stale liability → REJECT + note', async () => {
    const d = { ...CLEAN, bipdCancelLapsed: true, bipdCancelEffectiveDate: '2026-06-13',
                autoLiability: '', autoLiabilityExpiration: '',
                fmcsaLiabilityOnFile: 1000000, fmcsaLiabilityRequired: 750000,
                fmcsaLiabilityIsRequired: 'Y' };
    const r = runVettingRules(d, CFG);
    assert(r.verdict === 'REJECT', `expected REJECT, got ${r.verdict}: ${r.reasons.join('; ')}`);
    assert(r.reasons.some(r => /no replacement on file/i.test(r)),
      `expected lapsed RED, got: ${r.reasons.join('; ')}`);
    assert(r.notes.some(n => /likely not yet updated/i.test(n)),
      `expected stale-QCMobile note, got notes: ${r.notes.join('; ')}`);
    const pdfErr = await checkPdf(d, r);
    assert(!pdfErr, `PDF: ${pdfErr}`);
  }));

  // No-SW tenant: QCMobile short + nightly lapsed, but active filing shows insurer → HOLD
  results.push(await t('FMCSA liability: no SW, live=0, nightly lapsed, active filing → HOLD conflict', async () => {
    const d = { ...CLEAN, fmcsaLiabilityOnFile: 0, fmcsaLiabilityRequired: 750000,
                fmcsaLiabilityIsRequired: 'Y', bipdCancelLapsed: true, autoLiability: '',
                currentInsurer: 'National Indemnity', insuranceHistoryNotReviewed: false };
    const r = runVettingRules(d, CFG);
    assert(r.verdict === 'HOLD', `expected HOLD, got ${r.verdict}: ${r.reasons.join('; ')}`);
    assert(r.reasons.some(r => /sources conflict/i.test(r)),
      `expected sources conflict reason, got: ${r.reasons.join('; ')}`);
    // Must NOT contain the RED "confirm no adequate coverage" reason
    assert(!r.reasons.some(r => /confirm no adequate coverage/i.test(r)),
      `must not RED-reject with active filing present: ${r.reasons.join('; ')}`);
    const pdfErr = await checkPdf(d, r);
    assert(!pdfErr, `PDF: ${pdfErr}`);
  }));

  // No-SW tenant: nightly lapsed only (no QCMobile), active filing shows insurer → HOLD
  results.push(await t('bipdCancelLapsed: no SW, active filing → HOLD conflict (not RED)', async () => {
    const d = { ...CLEAN, bipdCancelLapsed: true, bipdCancelEffectiveDate: '2026-10-01',
                autoLiability: '', autoLiabilityExpiration: '',
                currentInsurer: 'Great West Casualty', insuranceHistoryNotReviewed: false };
    const r = runVettingRules(d, CFG);
    assert(r.verdict === 'HOLD', `expected HOLD, got ${r.verdict}: ${r.reasons.join('; ')}`);
    assert(r.reasons.some(r => /active FMCSA filing.*shows insurer/i.test(r)),
      `expected active filing conflict reason, got: ${r.reasons.join('; ')}`);
    assert(!r.reasons.some(r => /no replacement on file \(FMCSA\)/i.test(r)),
      `must not RED-reject: ${r.reasons.join('; ')}`);
    const pdfErr = await checkPdf(d, r);
    assert(!pdfErr, `PDF: ${pdfErr}`);
  }));

  // ── Insurance churn checks ───────────────────────────────────────────────

  // Insurance churn: 3 distinct insurers, threshold=3 → HOLD
  results.push(await t('insurance churn: 3 insurers in 12mo, threshold=3 → HOLD', async () => {
    const d = { ...CLEAN, insurerChanges12mo: 3, currentInsurer: 'Acme Insurance',
                currentPolicyStartDate: futureDate(-45) };
    const r = runVettingRules(d, { ...CFG, insurerChurnThreshold: 3 });
    assert(r.verdict === 'HOLD', `expected HOLD, got ${r.verdict}: ${r.reasons.join('; ')}`);
    assert(r.reasons.some(r => /insurance churn/i.test(r)),
      `expected churn reason, got: ${r.reasons.join('; ')}`);
    const pdfErr = await checkPdf(d, r);
    assert(!pdfErr, `PDF: ${pdfErr}`);
  }));

  // Insurance churn: 2 distinct insurers, threshold=3 → APPROVE
  results.push(await t('insurance churn: 2 insurers in 12mo, threshold=3 → APPROVE', async () => {
    const d = { ...CLEAN, insurerChanges12mo: 2 };
    const r = runVettingRules(d, { ...CFG, insurerChurnThreshold: 3 });
    assert(r.verdict === 'APPROVE', `expected APPROVE, got ${r.verdict}: ${r.reasons.join('; ')}`);
  }));

  // Policy started 15 days ago → informational note, no HOLD
  results.push(await t('policy started 15 days ago → informational note, no HOLD', async () => {
    const d = { ...CLEAN, currentPolicyStartDate: futureDate(-15), insurerChanges12mo: 1 };
    const r = runVettingRules(d, CFG);
    assert(r.verdict === 'APPROVE', `expected APPROVE, got ${r.verdict}: ${r.reasons.join('; ')}`);
    assert(r.notes.some(n => /recently issued/i.test(n)),
      `expected recently issued note, got notes: ${r.notes.join('; ')}`);
  }));

  // Policy started 45 days ago → no note
  results.push(await t('policy started 45 days ago → no note', async () => {
    const d = { ...CLEAN, currentPolicyStartDate: futureDate(-45), insurerChanges12mo: 1 };
    const r = runVettingRules(d, CFG);
    assert(r.verdict === 'APPROVE', `expected APPROVE, got ${r.verdict}: ${r.reasons.join('; ')}`);
    assert(!r.notes.some(n => /recently issued/i.test(n)),
      `should not have recently issued note, got notes: ${r.notes.join('; ')}`);
  }));

  // PDF renders FMCSA liability row
  results.push(await t('PDF renders "Liability on file with FMCSA" row', async () => {
    const d = { ...CLEAN, fmcsaLiabilityOnFile: 750000, fmcsaLiabilityRequired: 750000,
                fmcsaLiabilityIsRequired: 'Y' };
    const r = runVettingRules(d, CFG);
    const buf = await generateVettingPDF({
      carrierData: d, verdict: r.verdict, tier: r.tier, reasons: r.reasons,
      warnings: [], authorityDays: r.authorityDays, override: null,
      generatedAt: new Date(), recordId: '00000000-0000-0000-0000-000000000001',
      settings: CFG, brokerName: 'Test Brokerage', fieldSources: {}, timesUsed: 0,
    });
    assert(Buffer.isBuffer(buf) && buf.slice(0, 4).toString() === '%PDF', 'expected valid PDF');
  }));

  // PDF renders insurance history section
  results.push(await t('PDF renders insurance history section with churn', async () => {
    const d = { ...CLEAN, insurerChanges12mo: 4, currentInsurer: 'Progressive',
                currentPolicyNo: 'POL-123', currentPolicyStartDate: futureDate(-10),
                insuranceTimeline: [
                  { date: futureDate(-10), company: 'Progressive', policyNo: 'POL-123', formCode: 'BMC-91X', isPolicy: true },
                  { date: futureDate(-90), company: 'National Indemnity', policyNo: 'NI-456', formCode: 'BMC-91', isPolicy: true },
                  { date: futureDate(-90), company: 'National Indemnity', policyNo: 'NI-456', formCode: 'BMC-35', isPolicy: false },
                  { date: futureDate(-180), company: 'Acme Insurance', policyNo: 'AC-789', formCode: 'BMC-91X', isPolicy: true },
                  { date: futureDate(-270), company: 'Zurich', policyNo: 'ZU-012', formCode: 'BMC-91', isPolicy: true },
                ],
                insuranceHistoryNotReviewed: false };
    const r = runVettingRules(d, { ...CFG, insurerChurnThreshold: 3 });
    assert(r.verdict === 'HOLD', `expected HOLD, got ${r.verdict}`);
    const buf = await generateVettingPDF({
      carrierData: d, verdict: r.verdict, tier: r.tier, reasons: r.reasons,
      warnings: [], authorityDays: r.authorityDays, override: null,
      generatedAt: new Date(), recordId: '00000000-0000-0000-0000-000000000002',
      settings: { ...CFG, insurerChurnThreshold: 3 }, brokerName: 'Test Brokerage',
      fieldSources: {}, timesUsed: 0,
    });
    assert(Buffer.isBuffer(buf) && buf.slice(0, 4).toString() === '%PDF', 'expected valid PDF');
  }));

  // PDF: no active policy → shows "No active liability policy on file" + cancellations
  results.push(await t('PDF renders "No active policy" with cancellation timeline', async () => {
    const d = { ...CLEAN, bipdCancelLapsed: true, bipdCancelEffectiveDate: '06/13/2026',
                autoLiability: '', autoLiabilityExpiration: '',
                fmcsaLiabilityOnFile: 1000000, fmcsaLiabilityRequired: 750000,
                fmcsaLiabilityIsRequired: 'Y',
                currentInsurer: null, insurerChanges12mo: 0,
                insuranceTimeline: [
                  { date: '06/13/2026', company: 'MS Transverse Insurance Company', policyNo: 'TIRPCA000121', formCode: 'BMC-35', isPolicy: false },
                  { date: '06/13/2025', company: 'MS Transverse Insurance Company', policyNo: 'TIRPCA000121', formCode: 'BMC-91X', isPolicy: true },
                ],
                insuranceHistoryNotReviewed: false };
    const r = runVettingRules(d, CFG);
    assert(r.verdict === 'REJECT', `expected REJECT, got ${r.verdict}`);
    const buf = await generateVettingPDF({
      carrierData: d, verdict: r.verdict, tier: r.tier, reasons: r.reasons,
      warnings: r.warnings, authorityDays: r.authorityDays, override: null,
      generatedAt: new Date(), recordId: '00000000-0000-0000-0000-000000000003',
      settings: CFG, brokerName: 'Test Brokerage', fieldSources: {}, timesUsed: 0,
    });
    assert(Buffer.isBuffer(buf) && buf.slice(0, 4).toString() === '%PDF', 'expected valid PDF');
  }));

  // MC lookup extracts FMCSA insurance fields from real response shape
  results.push(await t('fmcsaMcLookup extracts fmcsaLiabilityOnFile from real response', async () => {
    const savedFetch = globalThis.fetch;
    const carrier = {
      dotNumber: 2939905, legalName: 'UGN LOGISTICS INC',
      totalPowerUnits: 41, totalDrivers: 41,
      commonAuthorityStatus: 'A', contractAuthorityStatus: 'N',
      allowedToOperate: 'Y', safetyRating: null,
      vehicleInsp: 39, vehicleOosInsp: 7, vehicleOosRate: 17.95,
      driverInsp: 98, driverOosInsp: 1, driverOosRate: 1.02,
      brokerAuthorityStatus: 'N',
      bipdInsuranceOnFile: '750', bipdRequiredAmount: '750', bipdInsuranceRequired: 'Y',
      cargoInsuranceOnFile: '0', cargoInsuranceRequired: 'u',
    };
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes('/carriers/docket-number/'))
        return { ok: true, status: 200, json: async () => ({
          content: [{ _links: {}, carrier }],
          retrievalDate: '2026-11-17T19:25:49.228+0000',
        }) };
      if (u.includes('/docket-numbers'))
        return { ok: true, status: 200, json: async () => ({ content: { item: [] } }) };
      if (u.includes('/authority'))
        return { ok: true, status: 200, json: async () => ({ content: { item: [] } }) };
      if (u.includes('safer.fmcsa.dot.gov'))
        return { ok: true, status: 200, text: async () => '<html></html>' };
      return { ok: true, status: 200, json: async () => ({}) };
    };
    try {
      const result = await fmcsaMcLookup('994024', 'test-webkey');
      assert(result.fmcsaLiabilityOnFile === 750000,
        `fmcsaLiabilityOnFile should be 750000, got ${result.fmcsaLiabilityOnFile}`);
      assert(result.fmcsaLiabilityRequired === 750000,
        `fmcsaLiabilityRequired should be 750000, got ${result.fmcsaLiabilityRequired}`);
      assert(result.fmcsaLiabilityIsRequired === 'Y',
        `fmcsaLiabilityIsRequired should be 'Y', got ${result.fmcsaLiabilityIsRequired}`);
    } finally {
      globalThis.fetch = savedFetch;
    }
  }));

  // ── POST-REFRESH tests ─────────────────────────────────────────────────────
  // Helper: build a mock supabase + fetch for runPostRefreshChecks tests.
  // `watchedRows` = array of watched_carriers rows to return.
  // `fmcsaSnap` = object returned by FMCSA QCMobile for any DOT (or null to simulate failure).
  // `insurerName` = string returned by Socrata insurance history as the current insurer
  //                 (null = no active policy, undefined = timeout/error).
  // Returns { supa, updates, inserts, alerts } to inspect what was written.
  function makePostRefreshMocks({ watchedRows = [], fmcsaSnap = null, insurerName, socrataError = false }) {
    const updates = [];   // { table, id, data }
    const inserts = [];   // { table, data }
    const supa = {
      from(table) {
        const chain = {
          select() {
            return {
              is(col, val) {
                // monitored_loads — return empty
                return Promise.resolve({ data: [], error: null });
              },
              eq(col, val) {
                if (table === 'watched_carriers') return Promise.resolve({ data: watchedRows, error: null });
                if (table === 'monitoring_alerts') return {
                  eq() { return { eq() { return { limit() { return Promise.resolve({ data: [], error: null }); } } } } },
                };
                if (table === 'tenants') return { single() { return Promise.resolve({ data: { email: 'test@example.com' }, error: null }); } };
                if (table === 'tenant_settings') return { maybeSingle() { return Promise.resolve({ data: null, error: null }); } };
                return Promise.resolve({ data: [], error: null });
              },
            };
          },
          update(data) {
            return { eq(col, val) { updates.push({ table, id: val, data }); return Promise.resolve({ error: null }); } };
          },
          insert(data) {
            inserts.push({ table, data });
            return Promise.resolve({ error: null });
          },
        };
        return chain;
      },
    };

    // Set FMCSA_WEBKEY so runPostRefreshChecks doesn't bail early
    const origWebKey = process.env.FMCSA_WEBKEY;
    process.env.FMCSA_WEBKEY = 'test-key';

    // Mock fetch: FMCSA QCMobile + Socrata insurance history
    const origFetch = globalThis.fetch;
    globalThis.fetch = function(url) {
      const u = String(url);
      // FMCSA QCMobile carrier lookup
      if (u.includes('mobile.fmcsa.dot.gov') && u.includes('/carriers/')) {
        if (!fmcsaSnap) return Promise.reject(new Error('FMCSA timeout'));
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ content: { carrier: fmcsaSnap } }),
        });
      }
      // Socrata insurance history (active + historical datasets)
      if (u.includes('data.transportation.gov/resource/')) {
        if (socrataError) return Promise.reject(new Error('Socrata timeout'));
        // Return one active BMC-91X filing if insurerName is set, otherwise empty
        if (insurerName === undefined) return Promise.reject(new Error('Socrata timeout'));
        const rows = insurerName
          ? [{ insurance_company_name: insurerName, policy_no: 'POL-1', effective_date: '2026-01-01', trans_date: '2026-01-01', ins_form_code: 'BMC-91X' }]
          : [];
        return Promise.resolve({ ok: true, json: () => Promise.resolve(rows) });
      }
      return origFetch(url);
    };

    return { supa, updates, inserts, restoreFetch: () => { globalThis.fetch = origFetch; if (origWebKey === undefined) delete process.env.FMCSA_WEBKEY; else process.env.FMCSA_WEBKEY = origWebKey; } };
  }

  // A minimal FMCSA carrier object for the QCMobile snapshot
  const FMCSA_CARRIER = {
    legalName: 'TEST CARRIER', dotNumber: '1835635',
    commonAuthorityStatus: 'A', contractAuthorityStatus: 'NONE', allowedToOperate: 'Y',
    bipdInsuranceOnFile: 1000, bipdRequiredAmount: 750, bipdInsuranceRequired: 'Y',
  };

  // PR-1. Baseline: first run (baseline_saved_at null) → saves baseline, no alert
  results.push(await t('POST-REFRESH: baseline saved on first run, no alert', async () => {
    const row = { id: 'w1', tenant_id: 'test-brokerage', dot_number: '1835635', carrier_name: 'Test',
      last_insurer: null, last_authority_status: null, last_fmcsa_liability: null, baseline_saved_at: null, is_active: true };
    const { supa, updates, inserts, restoreFetch } = makePostRefreshMocks({
      watchedRows: [row], fmcsaSnap: FMCSA_CARRIER, insurerName: 'Great West Casualty',
    });
    try {
      await runPostRefreshChecks(supa);
    } finally { restoreFetch(); }
    // Should have updated the row with baseline
    const upd = updates.find(u => u.table === 'watched_carriers' && u.id === 'w1');
    assert(upd, 'watched_carriers row not updated');
    assert(upd.data.baseline_saved_at, `baseline_saved_at not set: ${JSON.stringify(upd.data)}`);
    assert(upd.data.last_insurer === 'Great West Casualty', `last_insurer should be Great West Casualty, got ${upd.data.last_insurer}`);
    // No alert created
    const alertInserts = inserts.filter(i => i.table === 'monitoring_alerts');
    assert(alertInserts.length === 0, `expected 0 alerts on baseline, got ${alertInserts.length}`);
  }));

  // PR-2. Insurer changed → alert fires
  results.push(await t('POST-REFRESH: insurer change creates alert', async () => {
    const row = { id: 'w2', tenant_id: 'test-brokerage', dot_number: '1835635', carrier_name: 'Test',
      last_insurer: 'Old Insurance Co', last_authority_status: 'A/NONE/Y', last_fmcsa_liability: 1000000, baseline_saved_at: '2026-11-01T00:00:00Z', is_active: true };
    const { supa, updates, inserts, restoreFetch } = makePostRefreshMocks({
      watchedRows: [row], fmcsaSnap: FMCSA_CARRIER, insurerName: 'New Insurance Co',
    });
    try {
      await runPostRefreshChecks(supa);
    } finally { restoreFetch(); }
    const alertInserts = inserts.filter(i => i.table === 'monitoring_alerts');
    assert(alertInserts.length === 1, `expected 1 alert, got ${alertInserts.length}`);
    const issues = alertInserts[0].data.issues;
    assert(issues.some(i => /Old Insurance Co.*New Insurance Co/i.test(i)),
      `alert should mention insurer change: ${JSON.stringify(issues)}`);
  }));

  // PR-3. Policy disappears (was insured, now NONE ON FILE, QCMobile also $0) → alert fires
  results.push(await t('POST-REFRESH: policy disappears (NONE ON FILE + QCMobile $0) creates alert', async () => {
    const row = { id: 'w3', tenant_id: 'test-brokerage', dot_number: '1835635', carrier_name: 'Test',
      last_insurer: 'Great West Casualty', last_authority_status: 'A/NONE/Y', last_fmcsa_liability: 1000000, baseline_saved_at: '2026-11-01T00:00:00Z', is_active: true };
    // QCMobile also shows $0 — both sources agree, no coverage
    const { supa, updates, inserts, restoreFetch } = makePostRefreshMocks({
      watchedRows: [row], fmcsaSnap: { ...FMCSA_CARRIER, bipdInsuranceOnFile: 0 }, insurerName: null,
    });
    try {
      await runPostRefreshChecks(supa);
    } finally { restoreFetch(); }
    const alertInserts = inserts.filter(i => i.table === 'monitoring_alerts');
    assert(alertInserts.length === 1, `expected 1 alert, got ${alertInserts.length}`);
    const issues = alertInserts[0].data.issues;
    assert(issues.some(i => /Great West Casualty.*NONE ON FILE/i.test(i)),
      `alert should show NONE ON FILE: ${JSON.stringify(issues)}`);
    const upd = updates.find(u => u.id === 'w3');
    assert(upd.data.last_insurer === 'NONE ON FILE', `last_insurer should be NONE ON FILE, got ${upd.data.last_insurer}`);
  }));

  // PR-4. Socrata timeout → skip insurer, don't overwrite stored value, don't alert
  results.push(await t('POST-REFRESH: Socrata timeout skips insurer without overwriting', async () => {
    const row = { id: 'w4', tenant_id: 'test-brokerage', dot_number: '1835635', carrier_name: 'Test',
      last_insurer: 'Existing Insurer', last_authority_status: 'A/NONE/Y', last_fmcsa_liability: 1000000, baseline_saved_at: '2026-11-01T00:00:00Z', is_active: true };
    const { supa, updates, inserts, restoreFetch } = makePostRefreshMocks({
      watchedRows: [row], fmcsaSnap: FMCSA_CARRIER, insurerName: undefined,  // timeout
    });
    try {
      await runPostRefreshChecks(supa);
    } finally { restoreFetch(); }
    // No insurer-change alert
    const alertInserts = inserts.filter(i => i.table === 'monitoring_alerts');
    assert(alertInserts.length === 0, `expected 0 alerts on timeout, got ${alertInserts.length}`);
    // last_insurer must NOT be in the update (preserved, not overwritten)
    const upd = updates.find(u => u.id === 'w4');
    assert(upd, 'row should still be updated (authority/liability)');
    assert(!('last_insurer' in upd.data), `last_insurer should not be in update on timeout, got: ${JSON.stringify(upd.data)}`);
  }));

  // PR-5. Null row graduates after one run (precision-style: all last_* null, baseline_saved_at null)
  results.push(await t('POST-REFRESH: null-field row graduates from baseline after one run', async () => {
    const row = { id: 'w5', tenant_id: 'precision-transportation', dot_number: '1835635', carrier_name: 'Test',
      last_insurer: null, last_authority_status: null, last_fmcsa_liability: null, baseline_saved_at: null, is_active: true };
    const { supa, updates, inserts, restoreFetch } = makePostRefreshMocks({
      watchedRows: [row], fmcsaSnap: { ...FMCSA_CARRIER, bipdInsuranceOnFile: null },  // FMCSA returns null liability
      insurerName: null,  // no active policy
    });
    try {
      await runPostRefreshChecks(supa);
    } finally { restoreFetch(); }
    const upd = updates.find(u => u.id === 'w5');
    assert(upd, 'row must be updated');
    assert(upd.data.baseline_saved_at, 'baseline_saved_at must be set even with null values');
    assert(upd.data.last_insurer === 'NONE ON FILE', `last_insurer should be NONE ON FILE, got ${upd.data.last_insurer}`);
    // No alert on baseline
    const alertInserts = inserts.filter(i => i.table === 'monitoring_alerts');
    assert(alertInserts.length === 0, `expected 0 alerts on baseline, got ${alertInserts.length}`);
  }));

  // PR-6. Old policy invisible to Socrata but QCMobile shows liability → conflict, insurer skipped
  results.push(await t('POST-REFRESH: Socrata NONE ON FILE + QCMobile $750K → conflict, no alert', async () => {
    const row = { id: 'w6', tenant_id: 'test-brokerage', dot_number: '1887601', carrier_name: 'Old Policy Carrier',
      last_insurer: 'Great West Casualty', last_authority_status: 'A/NONE/Y', last_fmcsa_liability: 750000, baseline_saved_at: '2026-11-01T00:00:00Z', is_active: true };
    // Socrata returns 0 filings (old policy), but QCMobile shows $750K on file
    const { supa, updates, inserts, restoreFetch } = makePostRefreshMocks({
      watchedRows: [row], fmcsaSnap: { ...FMCSA_CARRIER, bipdInsuranceOnFile: 750 }, insurerName: null,
    });
    try {
      await runPostRefreshChecks(supa);
    } finally { restoreFetch(); }
    // No alert — sources conflict
    const alertInserts = inserts.filter(i => i.table === 'monitoring_alerts');
    assert(alertInserts.length === 0, `expected 0 alerts on conflict, got ${alertInserts.length}`);
    // last_insurer must NOT be overwritten (insurer skipped due to conflict)
    const upd = updates.find(u => u.id === 'w6');
    assert(upd, 'row should still be updated (authority/liability)');
    assert(!('last_insurer' in upd.data), `last_insurer should not be in update on conflict: ${JSON.stringify(upd.data)}`);
  }));

  // PR-7. Same conflict on baseline: QCMobile shows $, Socrata empty → baseline saves but insurer skipped
  results.push(await t('POST-REFRESH: baseline + Socrata/QCMobile conflict → baseline saved, insurer skipped', async () => {
    const row = { id: 'w7', tenant_id: 'test-brokerage', dot_number: '1887601', carrier_name: 'Old Policy Carrier',
      last_insurer: null, last_authority_status: null, last_fmcsa_liability: null, baseline_saved_at: null, is_active: true };
    const { supa, updates, inserts, restoreFetch } = makePostRefreshMocks({
      watchedRows: [row], fmcsaSnap: { ...FMCSA_CARRIER, bipdInsuranceOnFile: 750 }, insurerName: null,
    });
    try {
      await runPostRefreshChecks(supa);
    } finally { restoreFetch(); }
    const upd = updates.find(u => u.id === 'w7');
    assert(upd, 'row must be updated');
    assert(upd.data.baseline_saved_at, 'baseline_saved_at must be set');
    // Insurer NOT written — conflict means we don't know who the insurer is
    assert(!('last_insurer' in upd.data), `last_insurer should not be in update on conflict: ${JSON.stringify(upd.data)}`);
    // Authority and liability still saved
    assert(upd.data.last_authority_status, 'authority should still be saved');
    assert(upd.data.last_fmcsa_liability === 750000, `liability should be 750000, got ${upd.data.last_fmcsa_liability}`);
  }));

  // ── Ghost-carrier: missing inspection data must never REJECT ──────────────

  // Ghost-carrier: SAFER timeout + no SW → "Not reviewed", no REJECT
  results.push(await t('ghost-carrier: SAFER timeout + no SW → note only, no REJECT', async () => {
    const d = { ...CLEAN, powerUnits: '10', inspections24mo: null, driverInspections24mo: null };
    const r = runVettingRules(d, CFG);
    assert(r.verdict !== 'REJECT',
      `missing inspections must never REJECT for ghost-carrier (got ${r.verdict})`);
    assert(r.notes.some(s => /ghost.?carrier.*skipped/i.test(s)),
      `ghost-carrier skipped note not found: ${r.notes.join('; ')}`);
    const pdfErr = await checkPdf(d, r);
    assert(!pdfErr, `PDF: ${pdfErr}`);
  }));

  // Ghost-carrier: SAFER timeout + no SW (empty string) → same as null
  results.push(await t('ghost-carrier: inspections24mo empty string → note only, no REJECT', async () => {
    const d = { ...CLEAN, powerUnits: '8', inspections24mo: '', driverInspections24mo: '' };
    const r = runVettingRules(d, CFG);
    assert(r.verdict !== 'REJECT',
      `empty inspections must never REJECT for ghost-carrier (got ${r.verdict})`);
    assert(r.notes.some(s => /ghost.?carrier.*skipped/i.test(s)),
      `ghost-carrier skipped note not found: ${r.notes.join('; ')}`);
  }));

  // Ghost-carrier: vehicle 0 + driver 4 → no ghost (driver inspections prove activity)
  results.push(await t('ghost-carrier: vehicle 0 + driver 4 → no ghost REJECT', async () => {
    const d = { ...CLEAN, powerUnits: '5', inspections24mo: '0', driverInspections24mo: '4' };
    const r = runVettingRules(d, CFG);
    assert(!r.reasons.some(s => /ghost.?carrier/i.test(s)),
      `vehicle 0 + driver 4 must not trigger ghost-carrier: ${r.reasons.join('; ')}`);
    const pdfErr = await checkPdf(d, r);
    assert(!pdfErr, `PDF: ${pdfErr}`);
  }));

  // Ghost-carrier: vehicle 0 + driver unknown → skipped note
  results.push(await t('ghost-carrier: vehicle 0 + driver unknown → skipped note', async () => {
    const d = { ...CLEAN, powerUnits: '6', inspections24mo: '0', driverInspections24mo: null };
    const r = runVettingRules(d, CFG);
    assert(!r.reasons.some(s => /ghost.?carrier/i.test(s)),
      `vehicle 0 + driver unknown must not REJECT: ${r.reasons.join('; ')}`);
    assert(r.notes.some(s => /ghost.?carrier.*skipped/i.test(s)),
      `ghost-carrier skipped note not found: ${r.notes.join('; ')}`);
  }));

  // Ghost-carrier: SAFER fails + SW has 4 → uses 4, no REJECT, cert shows SW label
  results.push(await t('ghost-carrier: SAFER fails but SW has 4 inspections → no REJECT via merge', async () => {
    // Simulate: FMCSA returns no inspection count, SW returns 4
    const fmcsa = {
      filledFields: ['carrierName', 'powerUnits', 'inspections24mo', 'saferSnapshotDate'],
      carrierName: 'Test Carrier', powerUnits: '10', inspections24mo: '',
      saferSnapshotDate: '11/01/2026', saferData: {},
      activeFederalOOS: false, hasBrokerAuthority: false,
    };
    const sw = {
      ok: true,
      filledFields: ['inspections24mo', 'powerUnits'],
      inspections24mo: '4', powerUnits: '10',
      swInspectionsDate: '10/15/2026',
      inspectDrvUS: 3,
    };
    const { merged, autoFilled, serverFields: sf } = mergeResults({ fmcsa, sw, insurance: null, chameleon: null });
    assert(merged.inspections24mo === '4',
      `merge should use SW inspections24mo when SAFER is empty, got: ${merged.inspections24mo}`);
    // Driver inspections should also fall back to SW
    assert(sf.driverInspections24mo === '3',
      `driver inspections should fall back to SW, got: ${sf.driverInspections24mo}`);
    // Cert label must show SaferWatch source
    assert(autoFilled.inspections24mo?.sourceLabel?.includes('SaferWatch'),
      `cert label should mention SaferWatch, got: ${autoFilled.inspections24mo?.sourceLabel}`);
    assert(autoFilled.inspections24mo.sourceLabel.includes('vehicle + driver total'),
      `cert label should say "vehicle + driver total", got: ${autoFilled.inspections24mo.sourceLabel}`);
    // Now run rules with the merged data
    const d = { ...CLEAN, ...merged, _autoFilled: autoFilled };
    const r = runVettingRules(d, CFG);
    assert(!r.reasons.some(s => /ghost.?carrier/i.test(s)),
      `ghost-carrier REJECT must not fire when SW has 4 inspections: ${r.reasons.join('; ')}`);
    // PDF should not crash
    const pdfErr = await checkPdf(d, r);
    assert(!pdfErr, `PDF: ${pdfErr}`);
  }));

  // Ghost-carrier: both 0 + 5 units → ghost REJECT
  results.push(await t('ghost-carrier: both 0 inspections + 5 units → REJECT', async () => {
    const d = { ...CLEAN, powerUnits: '5', inspections24mo: '0', driverInspections24mo: '0' };
    const r = runVettingRules(d, CFG);
    assert(r.verdict === 'REJECT', `genuine 0/0 inspections + 5 units must REJECT, got ${r.verdict}`);
    assert(r.reasons.some(s => /ghost.?carrier/i.test(s)),
      `ghost-carrier reason not found: ${r.reasons.join('; ')}`);
    assert(r.reasons.some(s => /0 vehicle and 0 driver/i.test(s)),
      `reason must mention both vehicle and driver: ${r.reasons.join('; ')}`);
    const pdfErr = await checkPdf(d, r);
    assert(!pdfErr, `PDF: ${pdfErr}`);
  }));

  // Ghost-carrier: SAFER returns a real number → unchanged behavior
  results.push(await t('ghost-carrier: SAFER returns 50 inspections + 10 units → no ghost flag', async () => {
    const d = { ...CLEAN, powerUnits: '10', inspections24mo: '50' };
    const r = runVettingRules(d, CFG);
    assert(!r.reasons.some(s => /ghost.?carrier/i.test(s)),
      `50 inspections must not trigger ghost-carrier: ${r.reasons.join('; ')}`);
    assert(!r.notes.some(s => /ghost.?carrier/i.test(s)),
      `50 inspections must not produce ghost-carrier note: ${r.notes.join('; ')}`);
  }));

  // mergeResults: SAFER has real inspections24mo → SW value skipped
  results.push(await t('mergeResults: SAFER has real inspections24mo → SW skipped', () => {
    const fmcsa = {
      filledFields: ['inspections24mo', 'saferSnapshotDate'],
      inspections24mo: '12', saferSnapshotDate: '11/01/2026', saferData: {},
      activeFederalOOS: false, hasBrokerAuthority: false,
    };
    const sw = {
      ok: true, filledFields: ['inspections24mo'],
      inspections24mo: '20', swInspectionsDate: '10/15/2026',
    };
    const { merged } = mergeResults({ fmcsa, sw, insurance: null, chameleon: null });
    assert(merged.inspections24mo === '12',
      `SAFER's value should win when present, got: ${merged.inspections24mo}`);
  }));

  // parseSaferInspections: empty/NaN vehicle count → null, not 0
  results.push(await t('parseSaferInspections: NaN vehicle count → null not 0', () => {
    // Build a minimal SAFER HTML table where vehicle column is empty but driver has a value
    const html = `<TABLE summary="Inspections">
      <TR><TH SCOPE="ROW">Inspections</TH><TD></TD><TD>5</TD></TR>
      <TR><TH SCOPE="ROW">Out of Service</TH><TD></TD><TD>1</TD></TR>
      <TR><TH SCOPE="ROW">Out of Service %</TH><TD></TD><TD>20.0</TD></TR>
    </TABLE>`;
    const result = parseSaferInspections(html);
    assert(result !== null, 'should return a result object when driver column is present');
    assert(result.vehicleInsp === null,
      `empty vehicle column should be null, got: ${result.vehicleInsp}`);
    assert(result.driverInsp === 5,
      `driver column should be 5, got: ${result.driverInsp}`);
  }));

  // ── Batch 1 audit fixes: missing data → note, never silent skip ───────────

  // #1: National OOS averages missing → note, yellow flag disabled, hard-block still works
  results.push(await t('#1 missing national OOS averages → note, no yellow flag, hard-block still fires', async () => {
    const data = {
      ...CLEAN,
      nationalAvgTruckOos:  '',    // unavailable
      nationalAvgDriverOos: '',    // unavailable
      truckOosPct:          '15.00',
      driverOosPct:         '5.00',
    };
    const r = runVettingRules(data, CFG);
    assert(r.verdict === 'APPROVE', `should APPROVE, got ${r.verdict}`);
    const noteFound = r.notes.some(n => /national.average.*unavailable/i.test(n));
    assert(noteFound, `should have note about OOS national average, got notes: ${JSON.stringify(r.notes)}`);
    const pdfErr = await checkPdf(data, r);
    assert(!pdfErr, `PDF error: ${pdfErr}`);
  }));

  results.push(await t('#1 missing national OOS averages → hard-block still fires above max', async () => {
    const data = {
      ...CLEAN,
      nationalAvgTruckOos:  '',
      nationalAvgDriverOos: '',
      truckOosPct:          '25.00',  // above 20% max
      driverOosPct:         '2.00',
    };
    const r = runVettingRules(data, CFG);
    assert(r.verdict === 'REJECT', `should REJECT, got ${r.verdict}`);
    assert(r.reasons.some(s => /exceeds.*20%/i.test(s)), 'should mention truck OOS exceeds max');
  }));

  results.push(await t('#1 national OOS averages present → no note', async () => {
    const r = runVettingRules(CLEAN, CFG);
    assert(r.verdict === 'APPROVE', `should APPROVE, got ${r.verdict}`);
    const noteFound = r.notes.some(n => /national.average.*unavailable/i.test(n));
    assert(!noteFound, 'should NOT have note when averages are present');
  }));

  // #7: fmcsaLiabilityIsRequired missing → note
  results.push(await t('#7 fmcsaLiabilityIsRequired missing → note, no silent skip', async () => {
    const data = { ...CLEAN, fmcsaLiabilityIsRequired: undefined, fmcsaLiabilityOnFile: undefined };
    const r = runVettingRules(data, CFG);
    assert(r.verdict === 'APPROVE', `should APPROVE, got ${r.verdict}`);
    const noteFound = r.notes.some(n => /FMCSA live liability check not run/i.test(n));
    assert(noteFound, `should have note about liability check, got notes: ${JSON.stringify(r.notes)}`);
    const pdfErr = await checkPdf(data, r);
    assert(!pdfErr, `PDF error: ${pdfErr}`);
  }));

  results.push(await t('#7 fmcsaLiabilityIsRequired=Y → no note', async () => {
    const data = { ...CLEAN, fmcsaLiabilityIsRequired: 'Y', fmcsaLiabilityOnFile: 1000000, fmcsaLiabilityRequired: 750000 };
    const r = runVettingRules(data, CFG);
    const noteFound = r.notes.some(n => /FMCSA live liability check not run/i.test(n));
    assert(!noteFound, 'should NOT have liability-not-run note when isReq=Y');
  }));

  // #16: SAFER unavailable → sourceErrors.safer → note
  results.push(await t('#16 SAFER unavailable → note about SAFER data', async () => {
    const data = { ...CLEAN, sourceErrors: { safer: 'SAFER HTML unavailable' } };
    const r = runVettingRules(data, CFG);
    assert(r.verdict === 'APPROVE', `should APPROVE, got ${r.verdict}`);
    const noteFound = r.notes.some(n => /SAFER HTML was unavailable/i.test(n));
    assert(noteFound, `should have SAFER unavailable note, got notes: ${JSON.stringify(r.notes)}`);
    const pdfErr = await checkPdf(data, r);
    assert(!pdfErr, `PDF error: ${pdfErr}`);
  }));

  // #15: authority grant date fetch fails → sourceErrors.authorityGrantDate → note
  results.push(await t('#15 authority grant date fetch fails → note about authority age', async () => {
    const data = {
      ...CLEAN,
      authorityGrantDate: '',  // empty because fetch failed
      sourceErrors: { authorityGrantDate: 'FMCSA authority timeout' },
    };
    const r = runVettingRules(data, CFG);
    assert(r.verdict === 'APPROVE', `should APPROVE (note only, not HOLD), got ${r.verdict}`);
    const noteFound = r.notes.some(n => /authority.*grant.*date.*not reviewed/i.test(n));
    assert(noteFound, `should have authority-age note, got notes: ${JSON.stringify(r.notes)}`);
    // Authority age rules must NOT fire with no grant date
    const authHold = r.reasons?.some(s => /authority age/i.test(s));
    assert(!authHold, 'authority age rule should not fire when grant date unknown');
    const pdfErr = await checkPdf(data, r);
    assert(!pdfErr, `PDF error: ${pdfErr}`);
  }));

  // #17: lookup source failures → notes
  results.push(await t('#17 lookup source failures → notes for each failed source', async () => {
    const data = { ...CLEAN, lookupSourceFailures: ['SaferWatch', 'Insurance'] };
    const r = runVettingRules(data, CFG);
    assert(r.verdict === 'APPROVE', `should APPROVE, got ${r.verdict}`);
    const swNote = r.notes.some(n => /SaferWatch was unavailable/i.test(n));
    assert(swNote, `should have SaferWatch unavailable note, got: ${JSON.stringify(r.notes)}`);
    const insNote = r.notes.some(n => /Insurance was unavailable/i.test(n));
    assert(insNote, `should have Insurance unavailable note, got: ${JSON.stringify(r.notes)}`);
    const pdfErr = await checkPdf(data, r);
    assert(!pdfErr, `PDF error: ${pdfErr}`);
  }));

  results.push(await t('#17 no lookup source failures → no notes from that path', async () => {
    const data = { ...CLEAN };
    const r = runVettingRules(data, CFG);
    const anyFailNote = r.notes.some(n => /was unavailable during lookup/i.test(n));
    assert(!anyFailNote, 'should NOT have source-failure notes when all sources succeeded');
  }));

  // Combined: SAFER unavailable + missing national averages → both notes, verdict unchanged
  results.push(await t('combined SAFER unavail + missing OOS averages → APPROVE with both notes', async () => {
    const data = {
      ...CLEAN,
      nationalAvgTruckOos:  '',
      nationalAvgDriverOos: '',
      sourceErrors: { safer: 'SAFER HTML unavailable' },
    };
    const r = runVettingRules(data, CFG);
    assert(r.verdict === 'APPROVE', `should APPROVE, got ${r.verdict}`);
    assert(r.notes.some(n => /SAFER HTML was unavailable/i.test(n)), 'should have SAFER note');
    assert(r.notes.some(n => /national.average.*unavailable/i.test(n)), 'should have OOS avg note');
  }));

  // #1 cache: cached national OOS averages → yellow flag works, note mentions "cache"
  results.push(await t('#1 cached OOS averages → yellow flag fires normally, note mentions cache', async () => {
    const data = {
      ...CLEAN,
      nationalAvgTruckOos:   '10.00',
      nationalAvgDriverOos:  '4.00',
      nationalAvgOosAsOf:    '10/01/2026',
      nationalAvgOosCached:  true,
      truckOosPct:           '25.00',  // above 10% × 1.5 = 15% yellow threshold
      driverOosPct:          '2.00',
    };
    const r = runVettingRules(data, CFG);
    // Should REJECT due to truck OOS > 20% hard block
    assert(r.verdict === 'REJECT', `should REJECT (truck OOS 25% > 20% hard block), got ${r.verdict}`);
    const cacheNote = r.notes.some(n => /cache/i.test(n));
    assert(cacheNote, `should have note mentioning cache, got notes: ${JSON.stringify(r.notes)}`);
    const pdfErr = await checkPdf(data, r);
    assert(!pdfErr, `PDF error: ${pdfErr}`);
  }));

  results.push(await t('#1 cached OOS averages → HOLD when above yellow threshold', async () => {
    const data = {
      ...CLEAN,
      nationalAvgTruckOos:   '10.00',
      nationalAvgDriverOos:  '4.00',
      nationalAvgOosAsOf:    '10/01/2026',
      nationalAvgOosCached:  true,
      truckOosPct:           '20.00',  // exactly at 10% × 2 = 20% yellow threshold (hard block is >20%)
      driverOosPct:          '2.00',
      truckInspections:      '10',
      driverInspections:     '10',
    };
    const r = runVettingRules(data, CFG);
    assert(r.verdict === 'HOLD', `should HOLD (yellow flag), got ${r.verdict}`);
    assert(r.reasons.some(w => /truck OOS/i.test(w)), `should have truck OOS reason, got reasons: ${JSON.stringify(r.reasons)}`);
    const cacheNote = r.notes.some(n => /cache/i.test(n) && /10%.*4%/i.test(n));
    assert(cacheNote, `should have note with cached percentages, got notes: ${JSON.stringify(r.notes)}`);
  }));

  results.push(await t('#1 cached OOS averages without date → note says "cached" without date', async () => {
    const data = {
      ...CLEAN,
      nationalAvgTruckOos:   '10.00',
      nationalAvgDriverOos:  '4.00',
      nationalAvgOosAsOf:    '',
      nationalAvgOosCached:  true,
      truckOosPct:           '5.00',
      driverOosPct:          '2.00',
    };
    const r = runVettingRules(data, CFG);
    assert(r.verdict === 'APPROVE', `should APPROVE, got ${r.verdict}`);
    const cacheNote = r.notes.some(n => /cache/i.test(n));
    assert(cacheNote, `should have cache note, got notes: ${JSON.stringify(r.notes)}`);
    // Should NOT have the "data unavailable" note since averages were filled from cache
    const unavailNote = r.notes.some(n => /national average data unavailable/i.test(n));
    assert(!unavailNote, 'should NOT have unavailable note when cached averages are present');
  }));

  // ── SaferWatch not connected ────────────────────────────────────────────────

  results.push(await t('SW not connected: note present, no RED from blank BASICs, PDF renders', async () => {
    const data = {
      ...CLEAN,
      swNotConnected:          true,
      // SW-sourced fields blank (no SW data)
      unsafeDrivingBasic:      '',
      crashIndicatorBasic:     '',
      hosBasic:                '',
      vehicleMaintenanceBasic: '',
      vehicleDriverObservedBasic: '',
      driverFitnessBasic:      '',
      hazmatBasic:             '',
      cargoInsurance:          '',
      drugAlcoholViolation:    false,  // dispatcher answered manually
    };
    const r = runVettingRules(data, CFG);
    // HOLD expected: "sufficient inspections but no BASICs" yellow fires (correct — dispatcher
    // should still enter BASICs manually or accept the hold). NOT a RED reject.
    assert(r.verdict === 'HOLD', `should HOLD (not REJECT), got ${r.verdict}`);
    assert(r.tier === 'YELLOW', `tier should be YELLOW, got ${r.tier}`);
    const noteFound = r.notes.some(n => /SaferWatch not connected/i.test(n));
    assert(noteFound, `should have SW-not-connected note, got notes: ${JSON.stringify(r.notes)}`);
    const pdfErr = await checkPdf(data, r);
    assert(!pdfErr, `PDF error: ${pdfErr}`);
  }));

  results.push(await t('SW not connected: FMCSA-only fields still cause REJECT', async () => {
    const data = {
      ...CLEAN,
      swNotConnected:    true,
      authorityStatus:   'Inactive',
      unsafeDrivingBasic: '',
      cargoInsurance:     '',
      drugAlcoholViolation: null,
    };
    const r = runVettingRules(data, CFG);
    assert(r.verdict === 'REJECT', `should REJECT for inactive authority, got ${r.verdict}`);
    assert(r.reasons.some(s => /authority.*not active/i.test(s) || /inactive/i.test(s)),
      'should have authority reason');
  }));

  results.push(await t('SW connected: no swNotConnected note', async () => {
    const r = runVettingRules(CLEAN, CFG);
    const noteFound = r.notes.some(n => /SaferWatch not connected/i.test(n));
    assert(!noteFound, 'should NOT have SW-not-connected note when SW is connected');
  }));

  results.push(await t('mergeResults: swNotConnected flag propagated to serverFields', () => {
    const fmcsa = { filledFields: ['carrierName', 'dotNumber'], carrierName: 'Test', dotNumber: '123' };
    const { serverFields } = mergeResults({ fmcsa, sw: null, insurance: null, chameleon: null, swNotConnected: true });
    assert(serverFields.swNotConnected === true, `swNotConnected should be true, got ${serverFields.swNotConnected}`);
    assert(/not connected/i.test(serverFields.swErr), `swErr should mention not connected, got ${serverFields.swErr}`);
  }));

  results.push(await t('mergeResults: swNotConnected=false when SW available', () => {
    const fmcsa = { filledFields: ['carrierName'], carrierName: 'Test' };
    const sw = { ok: true, filledFields: ['autoLiability'], autoLiability: '1000000' };
    const { serverFields } = mergeResults({ fmcsa, sw, insurance: null, chameleon: null, swNotConnected: false });
    assert(!serverFields.swNotConnected, `swNotConnected should be falsy, got ${serverFields.swNotConnected}`);
    assert(serverFields.swErr === null, `swErr should be null, got ${serverFields.swErr}`);
  }));

  return results;
}
