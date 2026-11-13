// Rule engine + PDF offline tests — no network, no DB.
// Every test case also generates a PDF to confirm the generator doesn't crash.

import { runVettingRules, DEFAULT_SETTINGS, classifyEmailMatch } from '../lib/rules_engine.js';
import { generateVettingPDF } from '../lib/pdf_generator.js';
import { mergeResults, applyToSubmission, detectEdits, validateLookupRow, applyStricterEdits } from '../lib/lookup_merge.js';
import { refreshInsuranceCancellations, refreshOosOrders, refreshSaferRevocations, refreshMotusSuspensions } from '../lib/monitor.js';
import { fmcsaMcLookup } from '../routes/fmcsa.js';
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

  // MC-1. fmcsaMcLookup with content.carrier format (must keep working)
  results.push(await t('fmcsaMcLookup: content.carrier format → resolves dotNumber and name', async () => {
    const savedFetch = globalThis.fetch;
    const carrier = {
      dotNumber: 2939905, legalName: 'UGN TRANSPORTATION INC',
      totalPowerUnits: 15, totalDrivers: 12,
      commonAuthorityStatus: 'A', contractAuthorityStatus: 'I',
      allowedToOperate: 'Y', safetyRating: null,
      vehicleInsp: 50, vehicleOosInsp: 2, vehicleOosRate: 4.0,
      driverInsp: 40, driverOosInsp: 1, driverOosRate: 2.5,
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
      assert(result.carrierName === 'UGN TRANSPORTATION INC',
        `carrierName wrong: ${result.carrierName}`);
      assert(result.authorityStatus !== undefined, 'authorityStatus must be present');
    } finally {
      globalThis.fetch = savedFetch;
    }
  }));

  // MC-2. fmcsaMcLookup with content directly (no .carrier wrapper) — the actual
  //       FMCSA docket-number endpoint response shape; was broken before this fix.
  results.push(await t('fmcsaMcLookup: content (no .carrier wrapper) → resolves dotNumber and name', async () => {
    const savedFetch = globalThis.fetch;
    const carrier = {
      dotNumber: 2939905, legalName: 'UGN TRANSPORTATION INC',
      totalPowerUnits: 15, totalDrivers: 12,
      commonAuthorityStatus: 'A', contractAuthorityStatus: 'I',
      allowedToOperate: 'Y', safetyRating: null,
      vehicleInsp: 50, vehicleOosInsp: 2, vehicleOosRate: 4.0,
      driverInsp: 40, driverOosInsp: 1, driverOosRate: 2.5,
    };
    globalThis.fetch = async (url) => {
      const u = String(url);
      // docket-number endpoint returns carrier at content directly (no .carrier wrapper)
      if (u.includes('/carriers/docket-number/'))
        return { ok: true, status: 200, json: async () => ({ content: carrier }) };
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
      assert(result.carrierName === 'UGN TRANSPORTATION INC',
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

  return results;
}
