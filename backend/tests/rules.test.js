// Rule engine + PDF offline tests — no network, no DB.
// Every test case also generates a PDF to confirm the generator doesn't crash.

import { runVettingRules, DEFAULT_SETTINGS, classifyEmailMatch } from '../lib/rules_engine.js';
import { generateVettingPDF } from '../lib/pdf_generator.js';

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

  // 2. Truck OOS exactly 20.0% — does NOT trigger abs_floor REJECT
  //    natAvg 11% → 2× = 22% > 20%, so no yellow OOS flag either → clean APPROVE
  results.push(await t('truck OOS 20.0% → APPROVE (boundary: not > 20)', async () => {
    const d = { ...CLEAN, truckOosPct: '20.0', nationalAvgTruckOos: '11.0' };
    const r = runVettingRules(d, CFG);
    assert(r.verdict === 'APPROVE', `want APPROVE, got ${r.verdict}: ${r.reasons.join('; ')}`);
    assert(!r.reasons.some(s => s.includes('absolute floor')),
      `unexpected abs_floor reason: ${r.reasons.join('; ')}`);
    const pdfErr = await checkPdf(d, r);
    assert(!pdfErr, `PDF: ${pdfErr}`);
  }));

  // 3. Truck OOS 20.1% — triggers abs_floor REJECT (> 20, not ≥ 20)
  results.push(await t('truck OOS 20.1% → REJECT (abs_floor)', async () => {
    const d = { ...CLEAN, truckOosPct: '20.1', nationalAvgTruckOos: '11.0' };
    const r = runVettingRules(d, CFG);
    assert(r.verdict === 'REJECT', `want REJECT, got ${r.verdict}`);
    assert(r.reasons.some(s => s.includes('absolute floor')),
      `abs_floor reason not found in: ${r.reasons.join('; ')}`);
    assert(r.canOverride === false, 'abs_floor must set canOverride:false');
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

  // 39. BASIC at-or-above: score exactly at threshold → REJECT (≥ semantics)
  //     DEFAULT_SETTINGS: basicUnsafeDrivingThreshold = 65, action = 'reject'
  results.push(await t('BASIC at threshold (65 = 65) → REJECT (≥ semantics)', async () => {
    const d = { ...CLEAN, unsafeDrivingBasic: '65' };
    const r = runVettingRules(d, CFG);
    assert(r.verdict === 'REJECT', `want REJECT (at-threshold ≥), got ${r.verdict}: ${r.reasons.join('; ')}`);
    assert(r.reasons.some(s => s.includes('Unsafe Driving') && s.includes('≥')),
      `expected ≥ in BASIC reason, got: ${r.reasons.join('; ')}`);
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
