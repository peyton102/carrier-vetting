// Rule engine + PDF offline tests — no network, no DB.
// Every test case also generates a PDF to confirm the generator doesn't crash.

import { runVettingRules, DEFAULT_SETTINGS } from '../lib/rules_engine.js';
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
