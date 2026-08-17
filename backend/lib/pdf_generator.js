import PDFDocument from 'pdfkit';
import { DEFAULT_SETTINGS } from './rules_engine.js';

// Colors
const C = {
  blue:    '#1e3a5f',
  green:   '#16a34a',
  yellow:  '#b45309',
  red:     '#dc2626',
  gray:    '#6b7280',
  light:   '#f3f4f6',
  border:  '#d1d5db',
  black:   '#111827',
  darkgray:'#374151',
};

/**
 * Generate a flattened, non-editable vetting certificate PDF.
 *
 * @param {object} opts
 * @param {object} opts.carrierData    — all form fields
 * @param {string} opts.verdict        — APPROVE | HOLD | REJECT | APPROVED WITH OVERRIDE
 * @param {string} opts.tier           — GREEN | YELLOW | RED
 * @param {string[]} opts.reasons      — verdict reason strings
 * @param {number|null} opts.authorityDays
 * @param {object|null} opts.override  — { managerName, reason } if applicable
 * @param {Date}   opts.generatedAt
 * @param {string} opts.recordId       — UUID from DB insert
 * @param {object} opts.settings       — tenant vetting settings (thresholds shown on certificate)
 * @param {string} opts.brokerName     — broker's display name for the certificate header
 * @returns {Promise<Buffer>}
 */
export function generateVettingPDF(opts) {
  return new Promise((resolve, reject) => {
    const {
      carrierData: d,
      verdict, tier, reasons, authorityDays,
      override, generatedAt, recordId,
      settings, brokerName,
    } = opts;

    const cfg = { ...DEFAULT_SETTINGS, ...(settings ?? {}) };
    const name = brokerName || 'Carrier Vetting';

    const verdictColor = tier === 'GREEN' ? C.green : tier === 'YELLOW' ? C.yellow : C.red;

    const doc = new PDFDocument({
      size: 'LETTER',
      margin: 50,
      info: {
        Title:    `Carrier Vetting Audit Certificate — ${name}`,
        Author:   `${name} Vetting System`,
        Creator:  `${name} Vetting System`,
        Producer: 'pdfkit',
      },
    });

    const chunks = [];
    doc.on('data',  c => chunks.push(c));
    doc.on('end',   () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const L = 50;   // left margin
    const R = 562;  // right edge
    const W = R - L; // usable width

    // ── Page header ──────────────────────────────────────────────────────────
    doc.rect(L, 40, W, 54).fill(C.blue);
    doc.fontSize(15).font('Helvetica-Bold').fillColor('#ffffff')
       .text('CARRIER VETTING AUDIT CERTIFICATE', L, 52, { width: W, align: 'center' });
    doc.fontSize(9).font('Helvetica').fillColor('#a8c4e0')
       .text(`${name}  ·  Internal Use Only`, L, 72, { width: W, align: 'center' });

    doc.y = 106;

    // ── Run metadata ─────────────────────────────────────────────────────────
    const tsStr = generatedAt.toLocaleString('en-US', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      timeZone: 'America/New_York',
      timeZoneName: 'short',
    });
    metaRow(doc, L, W, 'Generated', tsStr, 'Load Ref', d.loadRef || '—');
    metaRow(doc, L, W, 'Dispatcher', d.dispatcher || '—', 'Record ID', recordId || 'Pending');

    hRule(doc, L, R);

    // ── Carrier identity ──────────────────────────────────────────────────────
    sectionHeader(doc, L, W, 'CARRIER INFORMATION');
    dataRow(doc, L, W, 'Legal Name', d.carrierName || '—');
    dataRow(doc, L, W, 'DOT Number', d.dotNumber || '—');
    dataRow(doc, L, W, 'MC Number',  d.mcNumber  || '—');

    doc.moveDown(0.6);

    // ── Verdict block ─────────────────────────────────────────────────────────
    const vBoxY = doc.y;
    doc.rect(L, vBoxY, W, 44).fill(verdictColor);
    doc.fontSize(18).font('Helvetica-Bold').fillColor('#ffffff')
       .text(`VERDICT: ${verdict}`, L, vBoxY + 12, { width: W, align: 'center' });
    doc.y = vBoxY + 52;

    // ── Verdict reasons ───────────────────────────────────────────────────────
    sectionHeader(doc, L, W, 'VERDICT REASONS');
    reasons.forEach(r => {
      doc.fontSize(9.5).font('Helvetica').fillColor(verdictColor)
         .text(`\u2022  ${r}`, L + 8, doc.y, { width: W - 8 });
    });

    doc.moveDown(0.6);
    hRule(doc, L, R);

    // ── Authority & Insurance ─────────────────────────────────────────────────
    sectionHeader(doc, L, W, 'AUTHORITY & INSURANCE');
    dataRow(doc, L, W, 'Authority Status',    d.authorityStatus || '—');
    dataRow(doc, L, W, 'Authority Grant Date', d.authorityGrantDate || '—');
    dataRow(doc, L, W, 'Authority Age',
      authorityDays !== null ? `${authorityDays} days` : '—');
    dataRow(doc, L, W, `Auto Liability (min $${fmtMoney(cfg.autoLiabilityMin)})`,
      d.autoLiability != null && d.autoLiability !== '' ? `$${Number(d.autoLiability).toLocaleString('en-US')}` : '—');
    dataRow(doc, L, W, `Cargo Insurance (min $${fmtMoney(cfg.cargoMin)})`,
      d.cargoInsurance != null && d.cargoInsurance !== '' ? `$${Number(d.cargoInsurance).toLocaleString('en-US')}` : '—');
    flagRow(doc, L, W, 'Pending Cancellation', d.pendingInsuranceCancellation);

    doc.moveDown(0.6);

    // ── Safety data ───────────────────────────────────────────────────────────
    sectionHeader(doc, L, W, 'SAFETY DATA');
    dataRow(doc, L, W, 'FMCSA Safety Rating', d.safetyRating || 'None/Unrated');
    flagRow(doc, L, W, 'Active Federal OOS Order', d.activeFederalOOS);

    // Each basicRow shows the actual threshold configured for this broker.
    // Label also indicates whether exceeding the threshold causes REJECT or HOLD.
    basicRow(doc, L, W,
      `Unsafe Driving BASIC (${cfg.basicUnsafeDrivingAction === 'reject' ? 'REJECT' : 'HOLD'} ≥ ${cfg.basicUnsafeDrivingThreshold}%)`,
      d.unsafeDrivingBasic, cfg.basicUnsafeDrivingThreshold);
    basicRow(doc, L, W,
      `Crash Indicator BASIC (${cfg.basicCrashIndicatorAction === 'reject' ? 'REJECT' : 'HOLD'} ≥ ${cfg.basicCrashIndicatorThreshold}%)`,
      d.crashIndicatorBasic, cfg.basicCrashIndicatorThreshold);
    basicRow(doc, L, W,
      `Hours of Service BASIC (${cfg.basicHosAction === 'reject' ? 'REJECT' : 'HOLD'} ≥ ${cfg.basicHosThreshold}%)`,
      d.hosBasic, cfg.basicHosThreshold);
    basicRow(doc, L, W,
      `Vehicle Maintenance BASIC (${cfg.basicVehicleMaintenanceAction === 'reject' ? 'REJECT' : 'HOLD'} ≥ ${cfg.basicVehicleMaintenanceThreshold}%)`,
      d.vehicleMaintenanceBasic, cfg.basicVehicleMaintenanceThreshold);
    basicRow(doc, L, W,
      `Driver Fitness BASIC (${cfg.basicDriverFitnessAction === 'reject' ? 'REJECT' : 'HOLD'} ≥ ${cfg.basicDriverFitnessThreshold}%)`,
      d.driverFitnessBasic, cfg.basicDriverFitnessThreshold);
    basicRow(doc, L, W,
      `Controlled Substances BASIC (${cfg.basicControlledSubstanceAction === 'reject' ? 'REJECT' : 'HOLD'} ≥ ${cfg.basicControlledSubstanceThreshold}%)`,
      d.controlledSubstancesBasic, cfg.basicControlledSubstanceThreshold);

    doc.moveDown(0.6);

    // ── Carrier Assure ────────────────────────────────────────────────────────
    sectionHeader(doc, L, W, 'CARRIER ASSURE');
    dataRow(doc, L, W, 'Grade', d.carrierAssureGrade || '—');
    flagRow(doc, L, W, 'Fraud Flag',         d.fraudFlag);
    flagRow(doc, L, W, 'Double-Broker Flag', d.doubleBrokerFlag);
    flagRow(doc, L, W, 'Chameleon Flag',     d.chameleonFlag);

    doc.moveDown(0.6);

    // ── OOS & Operations ──────────────────────────────────────────────────────
    sectionHeader(doc, L, W, 'OOS & OPERATIONS');
    dataRow(doc, L, W, 'Power Units',
      d.powerUnits != null && d.powerUnits !== '' ? String(d.powerUnits) : '—');
    dataRow(doc, L, W, 'Inspections (24 months)',
      d.inspections24mo != null && d.inspections24mo !== '' ? String(d.inspections24mo) : '—');
    dataRow(doc, L, W, 'Clean Inspections (24 months)',
      d.cleanInspections24mo != null && d.cleanInspections24mo !== '' ? String(d.cleanInspections24mo) : '—');
    const oosLabel = `OOS flag threshold: ≥ ${cfg.oosRateMultiplier}x national average`;
    oosRow(doc, L, W, `Truck OOS % (${oosLabel})`,  d.truckOosPct,  d.nationalAvgTruckOos  || 5.5, cfg.oosRateMultiplier);
    oosRow(doc, L, W, `Driver OOS % (${oosLabel})`, d.driverOosPct, d.nationalAvgDriverOos || 5.2, cfg.oosRateMultiplier);
    dataRow(doc, L, W, 'Natl Avg Truck OOS %',  `${parseFloat(d.nationalAvgTruckOos  || 5.5).toFixed(2)}%`);
    dataRow(doc, L, W, 'Natl Avg Driver OOS %', `${parseFloat(d.nationalAvgDriverOos || 5.2).toFixed(2)}%`);

    doc.moveDown(0.6);

    // ── Override block (only for APPROVED WITH OVERRIDE) ─────────────────────
    if (override) {
      hRule(doc, L, R);
      sectionHeader(doc, L, W, 'MANAGER OVERRIDE', C.yellow);

      const warnY = doc.y;
      doc.rect(L, warnY, W, 24).fill('#fef3c7');
      doc.fontSize(8.5).font('Helvetica-Bold').fillColor(C.yellow)
         .text(
           'This booking was approved with a manager override. ' +
           'The manager accepts responsibility for this decision.',
           L + 6, warnY + 7, { width: W - 12 }
         );
      doc.y = warnY + 30;

      dataRow(doc, L, W, 'Override Manager',   override.managerName);
      dataRow(doc, L, W, 'Override Reason',    override.reason);
      dataRow(doc, L, W, 'Override Timestamp', tsStr);

      doc.moveDown(0.4);
    }

    // ── Footer ────────────────────────────────────────────────────────────────
    hRule(doc, L, R);
    doc.fontSize(7.5).font('Helvetica').fillColor(C.gray)
       .text(
         `This document was generated by the ${name} Carrier Vetting System and reflects whether ` +
         `this carrier meets ${name}\u2019s internal vetting criteria at the time of generation. ` +
         'This is not a legal clearance. The dispatcher and manager are accountable for all booking decisions. ' +
         'A correction requires a new vetting record; this record is immutable.',
         L, doc.y, { width: W, align: 'center' }
       );
    doc.moveDown(0.3);
    doc.fontSize(7).fillColor(C.gray)
       .text(
         `Data source: manual entry by dispatcher.  Generated: ${generatedAt.toLocaleString('en-US', { timeZone: 'America/New_York', timeZoneName: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })}`,
         { align: 'center' }
       );

    doc.end();
  });
}

// ── Layout helpers ────────────────────────────────────────────────────────────

function hRule(doc, L, R) {
  doc.moveTo(L, doc.y).lineTo(R, doc.y).strokeColor(C.border).lineWidth(0.5).stroke();
  doc.moveDown(0.4);
}

function sectionHeader(doc, L, W, title, color = C.blue) {
  doc.fontSize(9).font('Helvetica-Bold').fillColor(color)
     .text(title.toUpperCase(), L, doc.y, { width: W });
  doc.moveTo(L, doc.y).lineTo(L + W, doc.y).strokeColor(color).lineWidth(0.5).stroke();
  doc.moveDown(0.3);
}

function metaRow(doc, L, W, label1, val1, label2, val2) {
  doc.fontSize(8.5).font('Helvetica-Bold').fillColor(C.darkgray)
     .text(`${label1}: `, L, doc.y, { continued: true })
     .font('Helvetica').fillColor(C.black)
     .text(String(val1), { continued: true })
     .text('          ', { continued: true })
     .font('Helvetica-Bold').fillColor(C.darkgray)
     .text(`${label2}: `, { continued: true })
     .font('Helvetica').fillColor(C.black)
     .text(String(val2));
  doc.moveDown(0.25);
}

function dataRow(doc, L, W, label, value) {
  const y = doc.y;
  doc.fontSize(9).font('Helvetica-Bold').fillColor(C.darkgray)
     .text(`${label}:`, L, y, { width: 220 });
  doc.font('Helvetica').fillColor(C.black)
     .text(String(value ?? '—'), L + 222, y, { width: W - 222 });
  doc.moveDown(0.15);
}

function flagRow(doc, L, W, label, val) {
  const on = val === true || val === 'true';
  const y = doc.y;
  doc.fontSize(9).font('Helvetica-Bold').fillColor(C.darkgray)
     .text(`${label}:`, L, y, { width: 220 });
  doc.font('Helvetica-Bold').fillColor(on ? C.red : C.black)
     .text(on ? 'YES' : 'No', L + 222, y, { width: W - 222 });
  doc.moveDown(0.15);
}

/**
 * @param {string} label     — already includes the threshold in the label
 * @param {*}      rawVal    — the carrier's actual score
 * @param {number} threshold — the configured threshold for this tenant
 */
function basicRow(doc, L, W, label, rawVal, threshold) {
  const val  = parseFloat(rawVal);
  const isNA = isNaN(val);
  const over = !isNA && val >= threshold;
  const display = isNA
    ? 'N/A'
    : `${val.toFixed(2)}%${over ? `  \u26a0 ABOVE this broker\u2019s ${threshold}% threshold` : ''}`;
  const y = doc.y;
  doc.fontSize(9).font('Helvetica-Bold').fillColor(C.darkgray)
     .text(`${label}:`, L, y, { width: 220 });
  doc.font(over ? 'Helvetica-Bold' : 'Helvetica').fillColor(over ? C.red : C.black)
     .text(display, L + 222, y, { width: W - 222 });
  doc.moveDown(0.15);
}

function oosRow(doc, L, W, label, rawVal, nationalAvg, multiplier) {
  const val  = parseFloat(rawVal);
  const isNA = isNaN(val);
  const over = !isNA && val >= parseFloat(nationalAvg) * parseFloat(multiplier);
  const display = isNA ? 'N/A' : `${val.toFixed(2)}%${over ? '  \u26a0 ABOVE THRESHOLD' : ''}`;
  const y = doc.y;
  doc.fontSize(9).font('Helvetica-Bold').fillColor(C.darkgray)
     .text(`${label}:`, L, y, { width: 220 });
  doc.font(over ? 'Helvetica-Bold' : 'Helvetica').fillColor(over ? C.yellow : C.black)
     .text(display, L + 222, y, { width: W - 222 });
  doc.moveDown(0.15);
}

function fmtMoney(n) {
  return Number(n).toLocaleString('en-US');
}
