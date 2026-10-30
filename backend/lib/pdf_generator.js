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

// Fields expected to be reviewed — blank ones go in the DATA GAPS section.
const REVIEWABLE_FIELDS = [
  ['authorityGrantDate',        'Authority Grant Date'],
  ['autoLiability',             'Auto Liability ($)'],
  ['autoLiabilityExpiration',   'Auto Liability Expiration'],
  ['cargoInsurance',            'Cargo Insurance ($)'],
  ['cargoExpiration',           'Cargo Insurance Expiration'],
  ['powerUnits',                'Power Units'],
  ['inspections24mo',           'Inspections (24 months)'],
  ['cleanInspections24mo',      'Clean Inspections (24 months)'],
  ['truckOosPct',               'Truck OOS %'],
  ['driverOosPct',              'Driver OOS %'],
  ['unsafeDrivingBasic',        'Unsafe Driving BASIC'],
  ['crashIndicatorBasic',       'Crash Indicator BASIC'],
  ['hosBasic',                  'Hours of Service BASIC'],
  ['vehicleMaintenanceBasic',   'Vehicle Maintenance BASIC'],
  ['vehicleDriverObservedBasic','Vehicle Driver-Observed BASIC'],
  ['driverFitnessBasic',        'Driver Fitness BASIC'],
  ['hazmatBasic',               'Hazardous Materials BASIC'],
  ['carrierAssureGrade',        'Carrier Assure Grade'],
  ['contactPhone',              'Contact Phone (dispatcher dealing with)'],
  ['contactEmail',              'Contact Email (dispatcher dealing with)'],
];

/**
 * Generate a flattened, non-editable vetting certificate PDF.
 *
 * @param {object} opts
 * @param {object} opts.carrierData    — all form fields (includes drugAlcoholSource)
 * @param {string} opts.verdict        — APPROVE | HOLD | REJECT | APPROVED WITH OVERRIDE
 * @param {string} opts.tier           — GREEN | YELLOW | RED
 * @param {string[]} opts.reasons      — primary verdict reasons
 * @param {string[]} opts.warnings     — HOLD-level findings (populated on REJECT certs)
 * @param {number|null} opts.authorityDays
 * @param {object|null} opts.override  — { managerName, reason } if applicable
 * @param {Date}   opts.generatedAt
 * @param {string} opts.recordId       — UUID from DB insert
 * @param {object} opts.settings       — tenant vetting settings
 * @param {string} opts.brokerName     — broker's display name
 * @param {object} opts.fieldSources   — { fieldName: 'fmcsa' | 'saferwatch' }
 * @param {number} opts.timesUsed      — how many times this DOT has been booked by this tenant
 * @param {boolean} opts.reissued      — true when original file was unavailable
 * @param {Date}   opts.reissuedAt     — timestamp of reissue (only when reissued=true)
 * @returns {Promise<Buffer>}
 */
export function generateVettingPDF(opts) {
  return new Promise((resolve, reject) => {
    const {
      carrierData: d,
      verdict, tier, reasons, warnings = [], authorityDays,
      override, generatedAt, recordId,
      settings, brokerName,
      fieldSources,
      timesUsed = 0,
      reissued = false,
      reissuedAt = null,
    } = opts;

    const cfg  = { ...DEFAULT_SETTINGS, ...(settings ?? {}) };
    const name = brokerName || 'Carrier Vetting';

    // Helper: abbreviated data source label for a given field name
    const src = (field) => {
      const s = (fieldSources || {})[field];
      if (s === 'fmcsa')      return 'FMCSA';
      if (s === 'saferwatch') return 'SW';
      return null;
    };

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

    // ── Reissued copy banner (only when original file is unavailable) ─────────
    if (reissued && reissuedAt) {
      const reissuedStr = reissuedAt.toLocaleString('en-US', {
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        timeZone: 'America/New_York', timeZoneName: 'short',
      });
      const originalStr = generatedAt.toLocaleString('en-US', {
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit',
        timeZone: 'America/New_York', timeZoneName: 'short',
      });
      const bannerY = doc.y;
      doc.rect(L, bannerY, W, 28).fill('#fef3c7');
      doc.fontSize(8).font('Helvetica-Bold').fillColor(C.yellow)
         .text(
           `REISSUED COPY — original file unavailable. ` +
           `Generated: ${reissuedStr}  ·  From record created: ${originalStr}`,
           L + 6, bannerY + 8, { width: W - 12, align: 'center' }
         );
      doc.y = bannerY + 34;
    }

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
    dataRow(doc, L, W, 'Legal Name',                   d.carrierName,       src('carrierName'));
    dataRow(doc, L, W, 'DOT Number',                   d.dotNumber);
    dataRow(doc, L, W, 'MC Number (display only)',     d.mcNumber);
    dataRow(doc, L, W, `Times used by ${name}`,        String(timesUsed));

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

    // ── HOLD-level warnings (on REJECT certs when yellow findings also exist) ──
    if (Array.isArray(warnings) && warnings.length > 0) {
      doc.moveDown(0.4);
      const warnBoxY = doc.y;
      doc.rect(L, warnBoxY, W, 18).fill('#fef3c7');
      doc.fontSize(8).font('Helvetica-Bold').fillColor(C.yellow)
         .text('HOLD-LEVEL FINDINGS — would require manager review on a passing carrier',
               L + 6, warnBoxY + 5, { width: W - 12 });
      doc.y = warnBoxY + 22;
      warnings.forEach(w => {
        doc.fontSize(9).font('Helvetica').fillColor(C.yellow)
           .text(`\u26a0  ${w}`, L + 8, doc.y, { width: W - 8 });
      });
    }

    doc.moveDown(0.6);
    hRule(doc, L, R);

    // ── Authority & Insurance ─────────────────────────────────────────────────
    sectionHeader(doc, L, W, 'AUTHORITY & INSURANCE');
    dataRow(doc, L, W, 'Authority Status',    d.authorityStatus,   src('authorityStatus'));
    dataRow(doc, L, W, 'Authority Grant Date', d.authorityGrantDate, src('authorityGrantDate'));
    dataRow(doc, L, W, 'Authority Age',
      authorityDays !== null ? `${authorityDays} days` : null);
    dataRow(doc, L, W, 'Holds Broker Authority',
      d.hasBrokerAuthority === true ? 'YES — carrier also holds broker authority' : (d.hasBrokerAuthority === false ? 'No' : null),
      src('hasBrokerAuthority'));

    dataRow(doc, L, W, `Auto Liability (min $${fmtMoney(cfg.autoLiabilityMin)})`,
      d.autoLiability != null && d.autoLiability !== ''
        ? `$${Number(d.autoLiability).toLocaleString('en-US')}` : null,
      src('autoLiability'));
    if (d.autoLiabilityExpiration) {
      const expDays = daysUntilExpiry(d.autoLiabilityExpiration);
      const expNote = expDays === null ? '' : expDays < 0 ? `  !! EXPIRED ${Math.abs(expDays)}d ago` : expDays <= 30 ? `  !! expires in ${expDays}d` : '';
      dataRow(doc, L, W, 'Auto Liability Expiration', d.autoLiabilityExpiration + expNote, src('autoLiabilityExpiration'));
    } else {
      dataRow(doc, L, W, 'Auto Liability Expiration', null);
    }

    dataRow(doc, L, W, `Cargo Insurance (min $${fmtMoney(cfg.cargoMin)})`,
      d.cargoInsurance != null && d.cargoInsurance !== ''
        ? `$${Number(d.cargoInsurance).toLocaleString('en-US')}` : null,
      src('cargoInsurance'));
    if (d.cargoExpiration) {
      const expDays = daysUntilExpiry(d.cargoExpiration);
      const expNote = expDays === null ? '' : expDays < 0 ? `  !! EXPIRED ${Math.abs(expDays)}d ago` : expDays <= 30 ? `  !! expires in ${expDays}d` : '';
      dataRow(doc, L, W, 'Cargo Insurance Expiration', d.cargoExpiration + expNote, src('cargoExpiration'));
    } else {
      dataRow(doc, L, W, 'Cargo Insurance Expiration', null);
    }

    flagRow(doc, L, W, 'Pending Cancellation Notice', d.pendingInsuranceCancellation, 'Manual');
    if (d.insuranceCancellationDate) {
      dataRow(doc, L, W, 'Cancellation Effective Date', d.insuranceCancellationDate);
    }

    // Insurance data timestamp
    if (d.insuranceDataAsOf) {
      const insTs = new Date(d.insuranceDataAsOf).toLocaleString('en-US', {
        month: '2-digit', day: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit',
        timeZone: 'America/New_York', timeZoneName: 'short',
      });
      doc.fontSize(8).font('Helvetica-Oblique').fillColor(C.gray)
         .text(`Insurance data as of: ${insTs}`, L, doc.y, { width: W });
      doc.moveDown(0.2);
    } else {
      doc.fontSize(8).font('Helvetica-Oblique').fillColor(C.gray)
         .text('Insurance data as of: not available (manual entry only)', L, doc.y, { width: W });
      doc.moveDown(0.2);
    }

    doc.moveDown(0.4);

    // ── Safety data ───────────────────────────────────────────────────────────
    sectionHeader(doc, L, W, 'SAFETY DATA');
    dataRow(doc, L, W, 'FMCSA Safety Rating', d.safetyRating || 'None/Unrated', src('safetyRating'));
    flagRow(doc, L, W, 'Active Federal OOS Order', d.activeFederalOOS, src('activeFederalOOS'));

    // Drug/alcohol row — shows source tag (auto-filled vs dispatcher-answered)
    {
      const isNull = d.drugAlcoholViolation === null || d.drugAlcoholViolation === undefined;
      const isYes  = d.drugAlcoholViolation === true || d.drugAlcoholViolation === 'true';
      const drugSrc = isNull
        ? null
        : (d.drugAlcoholSource || `Answered by ${d.dispatcher || 'dispatcher'}`);
      drugAlcoholRow(doc, L, W, d.drugAlcoholViolation, drugSrc);
    }

    basicRow(doc, L, W,
      `Unsafe Driving BASIC (${cfg.basicUnsafeDrivingAction === 'reject' ? 'REJECT' : 'HOLD'} \u2265 ${cfg.basicUnsafeDrivingThreshold}%)`,
      d.unsafeDrivingBasic, cfg.basicUnsafeDrivingThreshold, src('unsafeDrivingBasic'));
    basicRow(doc, L, W,
      `Crash Indicator BASIC (${cfg.basicCrashIndicatorAction === 'reject' ? 'REJECT' : 'HOLD'} \u2265 ${cfg.basicCrashIndicatorThreshold}%)`,
      d.crashIndicatorBasic, cfg.basicCrashIndicatorThreshold, src('crashIndicatorBasic'));
    basicRow(doc, L, W,
      `Hours of Service BASIC (${cfg.basicHosAction === 'reject' ? 'REJECT' : 'HOLD'} \u2265 ${cfg.basicHosThreshold}%)`,
      d.hosBasic, cfg.basicHosThreshold, src('hosBasic'));
    basicRow(doc, L, W,
      `Vehicle Maintenance BASIC (${cfg.basicVehicleMaintenanceAction === 'reject' ? 'REJECT' : 'HOLD'} \u2265 ${cfg.basicVehicleMaintenanceThreshold}%)`,
      d.vehicleMaintenanceBasic, cfg.basicVehicleMaintenanceThreshold, src('vehicleMaintenanceBasic'));
    basicRow(doc, L, W,
      `Vehicle Driver-Observed BASIC (${cfg.basicVehicleDriverObservedAction === 'reject' ? 'REJECT' : 'HOLD'} \u2265 ${cfg.basicVehicleDriverObservedThreshold}%)`,
      d.vehicleDriverObservedBasic, cfg.basicVehicleDriverObservedThreshold, src('vehicleDriverObservedBasic'));
    basicRow(doc, L, W,
      `Driver Fitness BASIC (${cfg.basicDriverFitnessAction === 'reject' ? 'REJECT' : 'HOLD'} \u2265 ${cfg.basicDriverFitnessThreshold}%)`,
      d.driverFitnessBasic, cfg.basicDriverFitnessThreshold, src('driverFitnessBasic'));
    basicRow(doc, L, W,
      `Hazardous Materials BASIC (${cfg.basicHazmatAction === 'reject' ? 'REJECT' : 'HOLD'} \u2265 ${cfg.basicHazmatThreshold}%)`,
      d.hazmatBasic, cfg.basicHazmatThreshold, src('hazmatBasic'));

    doc.moveDown(0.4);

    // ── Identity check ────────────────────────────────────────────────────────
    sectionHeader(doc, L, W, 'IDENTITY CHECK AGAINST FMCSA RECORDS');
    dataRow(doc, L, W, 'Contact Phone (dispatcher dealing with)', d.contactPhone);
    dataRow(doc, L, W, 'FMCSA Phone on Record', d.fmcsaPhone, src('fmcsaPhone'));

    if (d.contactPhone && d.fmcsaPhone) {
      const dp = String(d.contactPhone).replace(/\D/g, '');
      const fp = String(d.fmcsaPhone).replace(/\D/g, '');
      const match = dp && fp && dp === fp;
      twoColLabelValue(doc, L, W,
        'Phone Match:',
        match ? 'MATCH' : 'MISMATCH — manager review required',
        match ? C.green : C.red,
        true);
    } else {
      dataRow(doc, L, W, 'Phone Match', null);
    }

    dataRow(doc, L, W, 'Contact Email (dispatcher dealing with)', d.contactEmail);
    if (d.contactEmail) {
      const domain = String(d.contactEmail).split('@').pop().toLowerCase().trim();
      const freeProviders = new Set([
        'gmail.com','yahoo.com','hotmail.com','outlook.com','live.com',
        'aol.com','icloud.com','protonmail.com','proton.me','me.com',
        'ymail.com','msn.com','mail.com','inbox.com','gmx.com','gmx.net',
        'zoho.com','fastmail.com',
      ]);
      const isFree = freeProviders.has(domain);
      twoColLabelValue(doc, L, W,
        'Email Domain Check:',
        isFree ? `FREE PROVIDER (${domain}) — identity unverifiable by domain` : `Company domain (${domain})`,
        isFree ? C.yellow : C.green,
        true);
    } else {
      dataRow(doc, L, W, 'Email Domain Check', null);
    }

    // Honest identity summary
    {
      const contactPhone = (d.contactPhone || '').replace(/\D/g, '');
      const fmcsaPhone   = (d.fmcsaPhone   || '').replace(/\D/g, '');
      const emailDomain  = (d.contactEmail || '').toLowerCase().split('@')[1] || '';
      const freeEmail    = !!emailDomain && ['gmail.com','yahoo.com','hotmail.com','outlook.com','live.com',
        'aol.com','icloud.com','protonmail.com','proton.me','me.com',
        'ymail.com','msn.com','mail.com','inbox.com','gmx.com','gmx.net',
        'zoho.com','fastmail.com'].includes(emailDomain);
      const phoneMismatch = contactPhone && fmcsaPhone && contactPhone !== fmcsaPhone;

      let summaryText, summaryColor;
      if (!phoneMismatch && !freeEmail) {
        summaryText  = contactPhone && fmcsaPhone ? 'Phones match. No free email.' : 'Insufficient data for full identity check.';
        summaryColor = contactPhone && fmcsaPhone ? C.green : C.gray;
      } else {
        const parts = [];
        if (phoneMismatch) parts.push('Phone: MISMATCH');
        else if (contactPhone && fmcsaPhone) parts.push('Phone: Match');
        if (freeEmail) parts.push(`Email: Free consumer domain (${emailDomain})`);
        summaryText  = parts.join('. ');
        summaryColor = C.yellow;
      }
      twoColLabelValue(doc, L, W, 'Identity Check Summary:', summaryText, summaryColor, true);
    }

    doc.moveDown(0.4);

    // ── Carrier Assure ────────────────────────────────────────────────────────
    sectionHeader(doc, L, W, 'CARRIER ASSURE');
    dataRow(doc, L, W, 'Grade', d.carrierAssureGrade);
    flagRow(doc, L, W, 'Fraud Flag',         d.fraudFlag);
    flagRow(doc, L, W, 'Double-Broker Flag', d.doubleBrokerFlag);
    flagRow(doc, L, W, 'Chameleon Flag',     d.chameleonFlag);

    doc.moveDown(0.4);

    // ── OOS & Operations ──────────────────────────────────────────────────────
    sectionHeader(doc, L, W, 'OOS & OPERATIONS');
    dataRow(doc, L, W, 'Power Units',
      d.powerUnits != null && d.powerUnits !== '' ? String(d.powerUnits) : null,
      src('powerUnits'));
    dataRow(doc, L, W, 'Inspections (24 months)',
      d.inspections24mo != null && d.inspections24mo !== '' ? String(d.inspections24mo) : null,
      src('inspections24mo'));
    dataRow(doc, L, W, 'Clean Inspections (24 months)',
      d.cleanInspections24mo != null && d.cleanInspections24mo !== '' ? String(d.cleanInspections24mo) : null,
      src('cleanInspections24mo'));

    const natAvgTruck  = parseFloat(d.nationalAvgTruckOos)  || 5.5;
    const natAvgDriver = parseFloat(d.nationalAvgDriverOos) || 5.2;
    const mult         = parseFloat(cfg.oosRateMultiplier)  || 2;
    const hardTruck    = parseFloat(cfg.oosHardBlockTruck)  || 35;
    const hardDriver   = parseFloat(cfg.oosHardBlockDriver) || 7;
    const ABS_FLOOR    = 20;

    const truckYellowAt  = natAvgTruck  * mult;
    const driverYellowAt = natAvgDriver * mult;
    const truckCanHold   = truckYellowAt  < ABS_FLOOR;
    const driverCanHold  = driverYellowAt < hardDriver;

    const truckParts = [];
    if (truckCanHold) truckParts.push(`HOLD \u2265${truckYellowAt.toFixed(1)}%`);
    truckParts.push(`REJECT \u226520% floor`, `REJECT \u2265${hardTruck}% hard`);
    const truckLabel = `Truck OOS % (${truckParts.join('; ')})`;

    const driverParts = [];
    if (driverCanHold) driverParts.push(`HOLD \u2265${driverYellowAt.toFixed(1)}%`);
    driverParts.push(`REJECT \u2265${hardDriver}% hard`);
    const driverLabel = `Driver OOS % (${driverParts.join('; ')})`;

    oosRowFull(doc, L, W, truckLabel,  d.truckOosPct,  natAvgTruck,  mult, hardTruck, ABS_FLOOR, src('truckOosPct'));
    oosRowFull(doc, L, W, driverLabel, d.driverOosPct, natAvgDriver, mult, hardDriver, null,      src('driverOosPct'));

    dataRow(doc, L, W, 'Natl Avg Truck OOS %',  `${natAvgTruck.toFixed(2)}%`);
    dataRow(doc, L, W, 'Natl Avg Driver OOS %', `${natAvgDriver.toFixed(2)}%`);

    doc.moveDown(0.4);

    // ── Crash data (24 months, from FMCSA) ────────────────────────────────────
    sectionHeader(doc, L, W, 'CRASH DATA (24 MONTHS — FMCSA)');
    const crashes = d.crashes24mo;
    if (!crashes || crashes.count == null) {
      dataRow(doc, L, W, 'Crashes (24 months)', null, src('crashes24mo'));
    } else {
      dataRow(doc, L, W, 'Crashes (24 months)', String(crashes.count), src('crashes24mo'));
      if (crashes.count > 0 && Array.isArray(crashes.items)) {
        crashes.items.forEach((cr, i) => {
          const detail = [
            cr.date    ? `Date: ${cr.date}`          : null,
            cr.state   ? `State: ${cr.state}`         : null,
            `Fatalities: ${cr.fatalities ?? 0}`,
            `Injuries: ${cr.injuries ?? 0}`,
            `Tow-away: ${cr.towaway ? 'Yes' : 'No'}`,
            cr.hazmatRel ? 'Hazmat release: Yes' : null,
          ].filter(Boolean).join('  |  ');
          doc.fontSize(9).font('Helvetica').fillColor(C.darkgray)
             .text(`  Crash ${i + 1}: ${detail}`, L + 8, doc.y, { width: W - 8 });
          doc.moveDown(0.15);
        });
      }
    }

    doc.moveDown(0.4);

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

    // ── Data gaps section ─────────────────────────────────────────────────────
    const drugAlcoholBlank = d.drugAlcoholViolation === null || d.drugAlcoholViolation === undefined;
    const gapFields = REVIEWABLE_FIELDS.filter(([key]) => {
      const v = d[key];
      return v == null || v === '';
    });
    if (drugAlcoholBlank) {
      gapFields.unshift(['drugAlcoholViolation', 'Drug/Alcohol Violation (24 months)']);
    }

    if (gapFields.length > 0) {
      hRule(doc, L, R);
      sectionHeader(doc, L, W, 'DATA GAPS — FIELDS NOT SUBMITTED', C.gray);
      doc.fontSize(8.5).font('Helvetica-Oblique').fillColor(C.gray)
         .text(
           'The following fields were blank when this certificate was generated. ' +
           'A blank field was not reviewed and never counts as a pass. ' +
           'Any rule that depends on a blank field was evaluated as "data not available."',
           L, doc.y, { width: W }
         );
      doc.moveDown(0.35);
      gapFields.forEach(([, label]) => {
        doc.fontSize(9).font('Helvetica').fillColor(C.gray)
           .text(`\u2022  ${label}: Not reviewed (no data)`, L + 8, doc.y, { width: W - 8 });
        doc.moveDown(0.1);
      });
      doc.moveDown(0.3);
    }

    // ── Footer ────────────────────────────────────────────────────────────────
    hRule(doc, L, R);
    doc.fontSize(7.5).font('Helvetica').fillColor(C.gray)
       .text(
         `This certificate records the data received, criteria applied, result, and any override at the time shown. ` +
         `It reflects ${name}\u2019s own vetting criteria and is not a legal clearance, safety certification, or guarantee. ` +
         `Data from third-party sources may be incomplete or delayed. ` +
         `${name}\u2019s dispatcher and manager are responsible for all booking decisions. ` +
         `This record is immutable; corrections require a new vetting record. ` +
         `Generated by Torevez software.`,
         L, doc.y, { width: W, align: 'center' }
       );
    doc.moveDown(0.3);
    doc.fontSize(7).fillColor(C.gray)
       .text(buildDataSourceLine(fieldSources), L, doc.y, { width: W, align: 'center' });

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

// Core two-column row: measures both sides, adds page break if needed, renders.
function _twoColRow(doc, L, W, labelFont, labelColor, labelText,
                    valueFont, valueColor, valueText) {
  doc.fontSize(9);
  const labelH = doc.font(labelFont).heightOfString(labelText,  { width: 220 });
  const valueH = doc.font(valueFont).heightOfString(valueText,  { width: W - 222 });
  const rowH   = Math.max(labelH, valueH);

  const pageBottom = doc.page.height - doc.page.margins.bottom;
  if (doc.y + rowH > pageBottom) doc.addPage();

  const y = doc.y;
  doc.font(labelFont).fillColor(labelColor).text(labelText, L,       y, { width: 220 });
  doc.font(valueFont).fillColor(valueColor).text(valueText, L + 222, y, { width: W - 222 });
  doc.y = y + rowH;
  doc.moveDown(0.15);
}

function dataRow(doc, L, W, label, value, source) {
  const isBlank  = value == null || value === '';
  const base     = isBlank ? 'Not reviewed (no data)' : String(value);
  const display  = !isBlank && source ? `${base} (${source})` : base;
  _twoColRow(doc, L, W,
    'Helvetica-Bold', C.darkgray, `${label}:`,
    isBlank ? 'Helvetica-Oblique' : 'Helvetica',
    isBlank ? C.gray : C.black,
    display);
}

function twoColLabelValue(doc, L, W, label, value, valueColor, bold = false) {
  _twoColRow(doc, L, W,
    'Helvetica-Bold', C.darkgray, label,
    bold ? 'Helvetica-Bold' : 'Helvetica', valueColor, value);
}

function flagRow(doc, L, W, label, val, source) {
  const on     = val === true || val === 'true';
  const isNull = val === null || val === undefined;
  const text   = isNull ? 'Not reviewed (no data)' : (on ? 'YES' : 'No');
  const color  = isNull ? C.gray : (on ? C.red : C.black);
  const display = !isNull && source ? `${text} (${source})` : text;
  _twoColRow(doc, L, W,
    'Helvetica-Bold', C.darkgray, `${label}:`,
    isNull ? 'Helvetica-Oblique' : 'Helvetica-Bold',
    color, display);
}

function drugAlcoholRow(doc, L, W, val, source) {
  const isNull = val === null || val === undefined;
  const isYes  = val === true || val === 'true';
  const base   = isNull
    ? 'Not reviewed (no data)'
    : isYes
      ? 'YES — violation reported in last 24 months'
      : 'No';
  const display = !isNull && source ? `${base} (${source})` : base;
  _twoColRow(doc, L, W,
    'Helvetica-Bold', C.darkgray, 'Drug/Alcohol Violation (24 months):',
    isNull ? 'Helvetica-Oblique' : 'Helvetica-Bold',
    isNull ? C.gray : isYes ? C.red : C.black,
    display);
}

function basicRow(doc, L, W, label, rawVal, threshold, source) {
  const val  = parseFloat(rawVal);
  const isNA = isNaN(val) || rawVal == null || rawVal === '';
  const over = !isNA && val >= threshold;
  const base = isNA
    ? 'Not reviewed (no data)'
    : `${val.toFixed(2)}%${over ? `  \u26a0 ABOVE this broker\u2019s ${threshold}% threshold` : ''}`;
  const display = !isNA && source ? `${base} (${source})` : base;
  _twoColRow(doc, L, W,
    'Helvetica-Bold', C.darkgray, `${label}:`,
    over ? 'Helvetica-Bold' : isNA ? 'Helvetica-Oblique' : 'Helvetica',
    over ? C.red : isNA ? C.gray : C.black,
    display);
}

function oosRowFull(doc, L, W, label, rawVal, nationalAvg, multiplier, hardBlock, absFloor, source) {
  const val     = parseFloat(rawVal);
  const isNA    = isNaN(val);
  const isHard  = !isNA && (val >= hardBlock || (absFloor != null && val >= absFloor));
  const isYellow = !isNA && !isHard && val >= parseFloat(nationalAvg) * parseFloat(multiplier);
  const exceedsAbsFloor = absFloor != null && !isNA && val >= absFloor && val < hardBlock;
  const flagText = isHard
    ? (exceedsAbsFloor ? '  !! EXCEEDS ABSOLUTE FLOOR' : '  !! EXCEEDS HARD BLOCK')
    : isYellow ? '  ^ ABOVE FLAG THRESHOLD' : '';
  const base    = isNA ? 'Not reviewed (no data)' : `${val.toFixed(2)}%${flagText}`;
  const display = !isNA && source ? `${base} (${source})` : base;
  _twoColRow(doc, L, W,
    'Helvetica-Bold', C.darkgray, `${label}:`,
    isNA ? 'Helvetica-Oblique' : isHard || isYellow ? 'Helvetica-Bold' : 'Helvetica',
    isNA ? C.gray : isHard ? C.red : isYellow ? C.yellow : C.black,
    display);
}

function fmtMoney(n) {
  return Number(n).toLocaleString('en-US');
}

function daysUntilExpiry(dateStr) {
  if (!dateStr) return null;
  const exp = new Date(dateStr);
  if (isNaN(exp.getTime())) return null;
  const now = new Date();
  const todayMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.floor((exp.getTime() - todayMs) / 86_400_000);
}

const FIELD_LABELS = {
  carrierName:               'carrier name',
  dotNumber:                 'DOT',
  mcNumber:                  'MC number',
  authorityStatus:           'authority status',
  authorityGrantDate:        'authority date',
  safetyRating:              'safety rating',
  powerUnits:                'power units',
  inspections24mo:           'inspection count',
  truckOosPct:               'truck OOS%',
  driverOosPct:              'driver OOS%',
  nationalAvgTruckOos:       'natl avg truck OOS',
  nationalAvgDriverOos:      'natl avg driver OOS',
  unsafeDrivingBasic:        'unsafe driving BASIC',
  crashIndicatorBasic:       'crash indicator BASIC',
  hosBasic:                  'HOS BASIC',
  vehicleMaintenanceBasic:   'vehicle maint BASIC',
  vehicleDriverObservedBasic:'vehicle driver-obs BASIC',
  driverFitnessBasic:        'driver fitness BASIC',
  hazmatBasic:               'hazmat BASIC',
  autoLiability:             'auto liability',
  autoLiabilityExpiration:   'auto liab expiry',
  cargoInsurance:            'cargo insurance',
  cargoExpiration:           'cargo expiry',
  activeFederalOOS:          'federal OOS flag',
  hasBrokerAuthority:        'broker authority',
  fmcsaPhone:                'FMCSA phone',
  crashes24mo:               'crash data',
};

function buildDataSourceLine(fieldSources) {
  const fmcsa = [], sw = [];
  for (const [field, source] of Object.entries(fieldSources ?? {})) {
    const label = FIELD_LABELS[field] ?? field;
    if (source === 'fmcsa')           fmcsa.push(label);
    else if (source === 'saferwatch') sw.push(label);
  }
  const parts = [];
  if (fmcsa.length) parts.push(`FMCSA: ${fmcsa.join(', ')}`);
  if (sw.length)    parts.push(`SaferWatch: ${sw.join(', ')}`);
  parts.push('remaining fields: manual entry by dispatcher');
  return `Data sources — ${parts.join('  |  ')}`;
}
