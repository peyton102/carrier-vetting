import PDFDocument from 'pdfkit';
import { DEFAULT_SETTINGS, classifyOos, classifyEmailMatch } from './rules_engine.js';

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
  ['contactPhone',              'Contact Phone (dispatcher)'],
  ['contactEmail',              'Contact Email (dispatcher)'],
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
      carrierData: carrierDataRaw,
      verdict, tier, reasons, warnings = [], authorityDays,
      override, generatedAt, recordId,
      settings, brokerName,
      fieldSources,
      timesUsed = 0,
      reissued = false,
      reissuedAt = null,
    } = opts;

    // Sanitize date fields: treat '0000-00-00', 'Invalid Date', or unparseable strings as blank
    let d = { ...carrierDataRaw };
    const DATE_FIELDS = ['authorityGrantDate', 'autoLiabilityExpiration', 'cargoExpiration', 'bipdCancelEffectiveDate', 'bipdCancelTransDate'];
    for (const f of DATE_FIELDS) {
      const v = d[f];
      if (!v) continue;
      const s = String(v);
      if (s === '0000-00-00' || s === 'Invalid Date' || s === 'NaN') { d[f] = ''; continue; }
      const parsed = new Date(s);
      if (isNaN(parsed.getTime())) d[f] = '';
    }

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
           .text(`!!  ${w}`, L + 8, doc.y, { width: W - 8 });
      });
    }

    doc.moveDown(0.6);
    hRule(doc, L, R);

    // ── Authority & Insurance ─────────────────────────────────────────────────
    sectionHeader(doc, L, W, 'AUTHORITY & INSURANCE');
    dataRow(doc, L, W, 'Authority Status',    d.authorityStatus,   src('authorityStatus'));
    autoFilledNote(doc, L, W, d, 'authorityStatus');
    dataRow(doc, L, W, 'Authority Grant Date', d.authorityGrantDate, src('authorityGrantDate'));
    dataRow(doc, L, W, 'Authority Age',
      authorityDays != null && !isNaN(authorityDays) ? `${authorityDays} days` : null);
    dataRow(doc, L, W, 'Holds Broker Authority',
      d.hasBrokerAuthority === true ? 'YES — carrier also holds broker authority' : (d.hasBrokerAuthority === false ? 'No' : null),
      src('hasBrokerAuthority'));

    dataRow(doc, L, W, `Auto Liability (min $${fmtMoney(cfg.autoLiabilityMin)})`,
      d.autoLiability != null && d.autoLiability !== ''
        ? `$${Number(d.autoLiability).toLocaleString('en-US')}` : null,
      src('autoLiability'));
    autoFilledNote(doc, L, W, d, 'autoLiability');
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
    autoFilledNote(doc, L, W, d, 'cargoInsurance');
    if (d.cargoExpiration) {
      const expDays = daysUntilExpiry(d.cargoExpiration);
      const expNote = expDays === null ? '' : expDays < 0 ? `  !! EXPIRED ${Math.abs(expDays)}d ago` : expDays <= 30 ? `  !! expires in ${expDays}d` : '';
      dataRow(doc, L, W, 'Cargo Insurance Expiration', d.cargoExpiration + expNote, src('cargoExpiration'));
    } else {
      dataRow(doc, L, W, 'Cargo Insurance Expiration', null);
    }

    bipdCancellationRow(doc, L, W, d, cfg.bipdCancelDays ?? 30);

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
    chameleonSection(doc, L, W, d);
    doc.moveDown(0.4);

    // ── Safety data ───────────────────────────────────────────────────────────
    sectionHeader(doc, L, W, 'SAFETY DATA');
    dataRow(doc, L, W, 'FMCSA Safety Rating', d.safetyRating || 'None/Unrated', src('safetyRating'));
    autoFilledNote(doc, L, W, d, 'safetyRating');
    flagRow(doc, L, W, 'Active Federal OOS Order', d.activeFederalOOS, src('activeFederalOOS'));
    autoFilledNote(doc, L, W, d, 'activeFederalOOS');

    // Drug/alcohol row — shows source tag (auto-filled vs dispatcher-answered)
    {
      const isNull = d.drugAlcoholViolation === null || d.drugAlcoholViolation === undefined;
      const isYes  = d.drugAlcoholViolation === true || d.drugAlcoholViolation === 'true';
      const drugSrc = isNull
        ? null
        : (d.drugAlcoholSource || `Answered by ${d.dispatcher || 'dispatcher'}`);
      drugAlcoholRow(doc, L, W, d.drugAlcoholViolation, drugSrc);
    }

    const bs = d._basicSufficiency || {};
    basicRow(doc, L, W,
      `Unsafe Driving BASIC (${cfg.basicUnsafeDrivingAction === 'reject' ? 'REJECT' : 'HOLD'} at or above ${cfg.basicUnsafeDrivingThreshold}%)`,
      d.unsafeDrivingBasic, cfg.basicUnsafeDrivingThreshold, src('unsafeDrivingBasic'),
      bs.unsafeDriving === 'ok' && parseFloat(d.unsafeDrivingBasic) === 0 ? '0.00% (no FMCSA percentile assigned)' : null);
    autoFilledNote(doc, L, W, d, 'unsafeDrivingBasic');
    basicRow(doc, L, W,
      `Crash Indicator BASIC (${cfg.basicCrashIndicatorAction === 'reject' ? 'REJECT' : 'HOLD'} at or above ${cfg.basicCrashIndicatorThreshold}%)`,
      d.crashIndicatorBasic, cfg.basicCrashIndicatorThreshold, src('crashIndicatorBasic'));
    basicRow(doc, L, W,
      `Hours of Service BASIC (${cfg.basicHosAction === 'reject' ? 'REJECT' : 'HOLD'} at or above ${cfg.basicHosThreshold}%)`,
      d.hosBasic, cfg.basicHosThreshold, src('hosBasic'),
      bs.hos === 'ok' && parseFloat(d.hosBasic) === 0 ? '0.00% (no FMCSA percentile assigned)' : null);
    autoFilledNote(doc, L, W, d, 'hosBasic');
    basicRow(doc, L, W,
      `Vehicle Maintenance BASIC (${cfg.basicVehicleMaintenanceAction === 'reject' ? 'REJECT' : 'HOLD'} at or above ${cfg.basicVehicleMaintenanceThreshold}%)`,
      d.vehicleMaintenanceBasic, cfg.basicVehicleMaintenanceThreshold, src('vehicleMaintenanceBasic'),
      bs.vehicleMaintenance === 'ok' && parseFloat(d.vehicleMaintenanceBasic) === 0 ? '0.00% (no FMCSA percentile assigned)' : null);
    autoFilledNote(doc, L, W, d, 'vehicleMaintenanceBasic');
    basicRow(doc, L, W,
      `Vehicle Driver-Observed BASIC (${cfg.basicVehicleDriverObservedAction === 'reject' ? 'REJECT' : 'HOLD'} at or above ${cfg.basicVehicleDriverObservedThreshold}%)`,
      d.vehicleDriverObservedBasic, cfg.basicVehicleDriverObservedThreshold, src('vehicleDriverObservedBasic'));
    basicRow(doc, L, W,
      `Driver Fitness BASIC (${cfg.basicDriverFitnessAction === 'reject' ? 'REJECT' : 'HOLD'} at or above ${cfg.basicDriverFitnessThreshold}%)`,
      d.driverFitnessBasic, cfg.basicDriverFitnessThreshold, src('driverFitnessBasic'),
      bs.driverFitness === 'ok' && parseFloat(d.driverFitnessBasic) === 0 ? '0.00% (no FMCSA percentile assigned)' : null);
    autoFilledNote(doc, L, W, d, 'driverFitnessBasic');
    basicRow(doc, L, W,
      `Hazardous Materials BASIC (${cfg.basicHazmatAction === 'reject' ? 'REJECT' : 'HOLD'} at or above ${cfg.basicHazmatThreshold}%)`,
      d.hazmatBasic, cfg.basicHazmatThreshold, src('hazmatBasic'));

    doc.moveDown(0.4);

    // ── Identity check ────────────────────────────────────────────────────────
    sectionHeader(doc, L, W, 'IDENTITY CHECK AGAINST FMCSA RECORDS');
    dataRow(doc, L, W, 'Contact Phone (dispatcher)', d.contactPhone);
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

    dataRow(doc, L, W, 'Contact Email (dispatcher)', d.contactEmail);
    dataRow(doc, L, W, 'Registered Email (FMCSA)',
      d.fmcsaRegisteredEmail ||
      (d.fmcsaEmailNotReviewed
        ? (d.fmcsaChameleonTimedOut ? 'Not reviewed (FMCSA slow to respond)' : 'Not reviewed (couldn\'t reach FMCSA)')
        : (d.contactEmail ? 'No email on FMCSA record' : null)));

    // Email match check + identity summary.
    // Uses classifyEmailMatch() from rules_engine.js — single source of truth so the
    // PDF label and the vetting verdict always agree on whether an email is a match.
    {
      const emailClass = classifyEmailMatch(d);

      if (emailClass) {
        twoColLabelValue(doc, L, W, 'Email Match:', emailClass.pdfLabel, emailClass.match ? C.green : C.yellow, true);
      } else {
        dataRow(doc, L, W, 'Email Match', null);
      }

      // Identity summary
      const contactPhone  = (d.contactPhone || '').replace(/\D/g, '');
      const fmcsaPhone    = (d.fmcsaPhone   || '').replace(/\D/g, '');
      const phoneMismatch = contactPhone && fmcsaPhone && contactPhone !== fmcsaPhone;
      const emailIssue    = emailClass?.summaryIssue ?? null;

      let summaryText, summaryColor;
      if (!phoneMismatch && !emailIssue) {
        summaryText  = contactPhone && fmcsaPhone ? 'Phones match. Email OK.' : 'Insufficient data for full identity check.';
        summaryColor = contactPhone && fmcsaPhone ? C.green : C.gray;
      } else {
        const parts = [];
        if (phoneMismatch) parts.push('Phone: MISMATCH');
        else if (contactPhone && fmcsaPhone) parts.push('Phone: Match');
        if (emailIssue) parts.push(emailIssue);
        summaryText  = parts.join('. ');
        summaryColor = C.yellow;
      }
      twoColLabelValue(doc, L, W, 'Identity Check Summary:', summaryText, summaryColor, true);
    }

    doc.moveDown(0.4);

    // ── Carrier Assure ────────────────────────────────────────────────────────
    sectionHeader(doc, L, W, 'CARRIER ASSURE');
    dataRow(doc, L, W, 'Grade', d.carrierAssureGrade);
    flagRow(doc, L, W, 'Fraud Flag', d.fraudFlag);
    doubleBrokerChameleonRow(doc, L, W, d.doubleBrokerFlag, d.chameleonFlag);

    doc.moveDown(0.4);

    // ── OOS & Operations ──────────────────────────────────────────────────────
    sectionHeader(doc, L, W, 'OOS & OPERATIONS');
    dataRow(doc, L, W, 'Power Units',
      d.powerUnits != null && d.powerUnits !== '' ? String(d.powerUnits) : null,
      src('powerUnits'));
    dataRow(doc, L, W, 'Drivers (reported)',
      d.totalDrivers != null && d.totalDrivers !== '' ? String(d.totalDrivers) : null,
      d.totalDrivers != null && d.totalDrivers !== '' ? 'FMCSA' : null);

    // Annual mileage row + inline fleet notes
    {
      const milRaw  = d.mcs150Mileage    != null && d.mcs150Mileage    !== '' ? parseInt(d.mcs150Mileage, 10)    : NaN;
      const milYear = d.mcs150MileageYear != null && d.mcs150MileageYear !== '' ? parseInt(d.mcs150MileageYear, 10) : NaN;
      const units   = parseInt(d.powerUnits, 10);
      const authYear = d.authorityGrantDate ? parseInt(d.authorityGrantDate.slice(0, 4), 10) : NaN;
      const curYear  = new Date().getFullYear();

      const milDisplay = !isNaN(milRaw)
        ? `${milRaw.toLocaleString()} mi${!isNaN(milYear) ? ` (${milYear})` : ''}`
        : null;
      dataRow(doc, L, W, 'Annual Mileage (MCS-150)', milDisplay,
        milDisplay ? 'FMCSA' : null);

      // Fleet notes shown in gray italic below the mileage row
      const fleetNotes = [];
      if (units > 0) {
        if (isNaN(milRaw)) {
          fleetNotes.push('Mileage not evaluated: not reported on MCS-150');
        } else if (isNaN(milYear)) {
          fleetNotes.push('Mileage not evaluated: mileage year not reported');
        } else if (!isNaN(authYear) && milYear <= authYear) {
          fleetNotes.push(`Mileage not evaluated: mileage year (${milYear}) is same as or before authority grant year (${authYear})`);
        } else if (!isNaN(milRaw) && !isNaN(milYear)) {
          const mpu = milRaw / units;
          if (mpu < (cfg.mileagePerUnitMin || 1000) || mpu > (cfg.mileagePerUnitMax || 250000)) {
            // Already flagged via HOLD reasons — no duplicate note here
          }
        }
      }
      if (!isNaN(milYear) && curYear - milYear > 2) {
        fleetNotes.push(`Fleet data last updated ${milYear} — MCS-150 mileage may be stale`);
      }
      const drivers = d.totalDrivers != null && d.totalDrivers !== '' ? parseInt(d.totalDrivers, 10) : NaN;
      if (units > 0 && !isNaN(drivers) && drivers === 0) {
        fleetNotes.push(`${units} power unit${units === 1 ? '' : 's'}, 0 drivers reported — verify fleet data`);
      } else if (units > 0 && !isNaN(drivers) && drivers > units * (cfg.driversPerTruckMax || 3)) {
        fleetNotes.push(`${drivers} driver${drivers === 1 ? '' : 's'} for ${units} unit${units === 1 ? '' : 's'} (${(drivers / units).toFixed(1)}× ratio) — informational`);
      }
      for (const fn of fleetNotes) {
        _twoColRow(doc, L, W, 'Helvetica-Bold', C.darkgray, 'Fleet note:', 'Helvetica-Oblique', C.gray, fn);
      }
    }

    {
      const inspSrcLabel = d.saferSnapshotDate ? `SAFER (as of ${d.saferSnapshotDate})` : src('inspections24mo');
      const veh = d.inspections24mo       != null && d.inspections24mo       !== '' ? String(d.inspections24mo)       : null;
      const drv = d.driverInspections24mo != null && d.driverInspections24mo !== '' ? String(d.driverInspections24mo) : null;
      const inspDisplay = (veh || drv)
        ? [veh && `Vehicle: ${veh}`, drv && `Driver: ${drv}`].filter(Boolean).join('  |  ')
        : null;
      dataRow(doc, L, W, 'Inspections (24 months)', inspDisplay, inspSrcLabel);
      autoFilledNote(doc, L, W, d, 'inspections24mo');
    }
    dataRow(doc, L, W, 'Clean Inspections (24 months)',
      d.cleanInspections24mo != null && d.cleanInspections24mo !== '' ? String(d.cleanInspections24mo) : null,
      src('cleanInspections24mo'));

    // National OOS averages from SAFER HTML only — null when unavailable (no fallback).
    const natAvgTruckRaw  = parseFloat(d.nationalAvgTruckOos);
    const natAvgDriverRaw = parseFloat(d.nationalAvgDriverOos);
    const natAvgTruck  = isNaN(natAvgTruckRaw)  ? null : natAvgTruckRaw;
    const natAvgDriver = isNaN(natAvgDriverRaw) ? null : natAvgDriverRaw;
    const mult         = parseFloat(cfg.oosRateMultiplier)  || 2;
    const MAX_TRUCK    = parseFloat(cfg.oosMaxTruck)        || DEFAULT_SETTINGS.oosMaxTruck;
    const hardDriver   = parseFloat(cfg.oosHardBlockDriver) || 7;

    const truckParts = [];
    if (natAvgTruck != null) {
      const truckYellowAt = natAvgTruck * mult;
      if (truckYellowAt < MAX_TRUCK) truckParts.push(`HOLD >=${truckYellowAt.toFixed(1)}%`);
    }
    truckParts.push(`REJECT >${MAX_TRUCK}%`);
    const truckLabel = `Truck OOS % (${truckParts.join('; ')})`;

    const driverParts = [];
    if (natAvgDriver != null) {
      const driverYellowAt = natAvgDriver * mult;
      if (driverYellowAt < hardDriver) driverParts.push(`HOLD >=${driverYellowAt.toFixed(1)}%`);
    }
    driverParts.push(`REJECT >${hardDriver}%`);
    const driverLabel = `Driver OOS % (${driverParts.join('; ')})`;

    // Build source label for OOS rows — prefer the stored oosWinLabel from dual-source selection
    const oosWinLabel = d.oosWinLabel || src('truckOosPct') || null;
    const noVehInsp = Number(d.inspections24mo) === 0;
    const noDrvInsp = Number(d.driverInspections24mo) === 0;
    oosRowFull(doc, L, W, truckLabel,  d.truckOosPct,  natAvgTruck,  mult, MAX_TRUCK, oosWinLabel, noVehInsp);
    autoFilledNote(doc, L, W, d, 'truckOosPct');
    if (!noVehInsp && d.truckOosPctAlt && d.truckOosPctAltSrc) {
      doc.fontSize(8).font('Helvetica-Oblique').fillColor(C.gray)
         .text(`  ${d.truckOosPctAltSrc} showed ${parseFloat(d.truckOosPctAlt).toFixed(2)}% (not used — older data)`,
               L + 8, doc.y, { width: W - 8 });
      doc.moveDown(0.15);
    }
    oosRowFull(doc, L, W, driverLabel, d.driverOosPct, natAvgDriver, mult, hardDriver, oosWinLabel, noDrvInsp);
    autoFilledNote(doc, L, W, d, 'driverOosPct');
    if (d.driverOosPctAlt && d.driverOosPctAltSrc) {
      doc.fontSize(8).font('Helvetica-Oblique').fillColor(C.gray)
         .text(`  ${d.driverOosPctAltSrc} showed ${parseFloat(d.driverOosPctAlt).toFixed(2)}% (not used — older data)`,
               L + 8, doc.y, { width: W - 8 });
      doc.moveDown(0.15);
    }

    const oosAsOf = d.nationalAvgOosAsOf ? ` (as of ${d.nationalAvgOosAsOf})` : '';
    dataRow(doc, L, W, `Natl Avg Truck OOS %${oosAsOf}`,  natAvgTruck  != null ? `${natAvgTruck.toFixed(2)}%`  : null);
    dataRow(doc, L, W, `Natl Avg Driver OOS %${oosAsOf}`, natAvgDriver != null ? `${natAvgDriver.toFixed(2)}%` : null);

    doc.moveDown(0.4);

    // ── Crash data (24 months, from FMCSA) ────────────────────────────────────
    sectionHeader(doc, L, W, 'CRASH DATA (24 MONTHS — FMCSA)');
    const crashes = d.crashes24mo;
    if (!crashes || crashes.count == null) {
      dataRow(doc, L, W, 'Crashes (24 months)', null, src('crashes24mo'));
    } else {
      dataRow(doc, L, W, 'Crashes (24 months)', String(crashes.count), src('crashes24mo'));
      if (crashes.count > 0) {
        // Show fatal/injury/tow breakdown when available (from SAFER HTML)
        const hasSummary = crashes.fatal != null || crashes.injury != null || crashes.tow != null;
        if (hasSummary) {
          const parts = [
            `Fatal: ${crashes.fatal ?? 0}`,
            `Injury: ${crashes.injury ?? 0}`,
            `Tow: ${crashes.tow ?? 0}`,
          ].join('  |  ');
          doc.fontSize(9).font('Helvetica').fillColor(C.darkgray)
             .text(`  ${parts}`, L + 8, doc.y, { width: W - 8 });
          doc.moveDown(0.15);
        }
        // Show individual crash records when available (legacy QCMobile items)
        if (Array.isArray(crashes.items) && crashes.items.length > 0) {
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
  // Ensure rowH is at least one full line height — prevents rows from collapsing
  // when heightOfString returns an unexpectedly small value.
  const minH   = doc.currentLineHeight();
  const rowH   = Math.max(labelH, valueH, minH);

  const pageBottom = doc.page.height - doc.page.margins.bottom;
  if (doc.y + rowH > pageBottom) doc.addPage();

  const y = doc.y;
  doc.font(labelFont).fillColor(labelColor).text(labelText, L,       y, { width: 220 });
  doc.font(valueFont).fillColor(valueColor).text(valueText, L + 222, y, { width: W - 222 });
  doc.y = y + rowH;
  doc.moveDown(0.25);
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

// FMCSA identity linkage (chameleon) section.
// cert line format per match:
//   [HOLD] DOT {dot} ({name}), {status} — {matchField}: {matchValue} — {bad reason} ({date})
//   [INFO] DOT {dot} ({name}), {status} — {matchField}: {matchValue} — no enforcement history
//   [INFO] {matchField}: {matchValue} shared by 5+ carriers (shared service/dispatch) — not evaluated individually
function chameleonSection(doc, L, W, d) {
  const matches = d.fmcsaChameleonMatches;
  const notReviewed = d.fmcsaChameleonNotReviewed === true || matches === null || matches === undefined;

  sectionHeader(doc, L, W, 'FMCSA IDENTITY LINKAGE');

  if (d.fmcsaEnforcementLoadedAt) {
    const asOf = new Date(d.fmcsaEnforcementLoadedAt);
    const asOfStr = isNaN(asOf.getTime()) ? d.fmcsaEnforcementLoadedAt
      : asOf.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'America/New_York' }) + ' EST';
    dataRow(doc, L, W, 'Enforcement data as of', asOfStr);
  }

  if (d.fmcsaContactChange?.firstSeen) {
    const since = new Date(d.fmcsaContactChange.firstSeen).toLocaleDateString('en-US',
      { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' });
    dataRow(doc, L, W, 'Contact history (FMCSA)', `First seen ${since} — no prior record to compare`);
  } else if (d.fmcsaContactChange?.recentChanges?.length > 0) {
    const { recentChanges, mcs150Recent, mcs150Date } = d.fmcsaContactChange;
    for (const c of recentChanges) {
      const when = new Date(c.detected_at).toLocaleDateString('en-US',
        { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' });
      const text = `${c.field_label} changed ${when}: "${c.old_value ?? ''}" → "${c.new_value ?? ''}"`;
      _twoColRow(doc, L, W, 'Helvetica-Bold', C.yellow, 'Contact info change (FMCSA):', 'Helvetica', C.yellow, text);
    }
    if (mcs150Recent && mcs150Date) {
      dataRow(doc, L, W, 'MCS-150 updated', mcs150Date);
    }
  }

  if (notReviewed) {
    _twoColRow(doc, L, W,
      'Helvetica-Bold', C.darkgray, 'Carrier identity check (FMCSA):',
      'Helvetica-Oblique', C.gray,
      d.fmcsaChameleonTimedOut ? 'Not reviewed (FMCSA slow to respond)' : 'Not reviewed');
    return;
  }

  const relevant = Array.isArray(matches) ? matches : [];
  if (relevant.length === 0) {
    _twoColRow(doc, L, W,
      'Helvetica-Bold', C.darkgray, 'Carrier identity check (FMCSA):',
      'Helvetica', C.black, 'No linked carriers found');
    return;
  }

  for (const m of relevant) {
    let label, text, textColor;

    if (m.sharedService) {
      label     = 'Carrier identity check (FMCSA):';
      text      = `${m.matchField}: ${m.matchValue} — shared by 5+ carriers (shared service/dispatch) — informational`;
      textColor = C.gray;
    } else {
      const reasons = (m.badReasons ?? []).map(r => {
        let s = r.description;
        if (r.date) { s += ` (${r.date})`; if (r.rescindDate) s += `, rescinded ${r.rescindDate}`; }
        return s;
      });
      const reasonText = reasons.length > 0 ? reasons.join('; ') : 'no enforcement in the last 4 years';
      const statusPart = m.status ? `, ${m.status}` : '';

      label     = m.isHold ? '[HOLD] Linked carrier (FMCSA):' : '[INFO] Linked carrier (FMCSA):';
      text      = `DOT ${m.dot} (${m.name})${statusPart} — ${m.matchField}: ${m.matchValue} — ${reasonText}`;
      textColor = m.isHold ? C.yellow : C.darkgray;
    }

    _twoColRow(doc, L, W, 'Helvetica-Bold', C.darkgray, label, 'Helvetica', textColor, text);
  }
}

// BI&PD cancellation notice row — FMCSA-sourced (new certs) or SW manual (legacy certs).
// New certs set bipdCancelPending (true/false/null); legacy certs only have pendingInsuranceCancellation.
function bipdCancellationRow(doc, L, W, d, cancelDays) {
  const hasNew = d.bipdCancelPending !== undefined;

  if (!hasNew) {
    // Legacy cert: fall back to old SaferWatch / manual field
    flagRow(doc, L, W, 'Pending Cancellation Notice', d.pendingInsuranceCancellation, 'Manual');
    if (d.insuranceCancellationDate) {
      dataRow(doc, L, W, 'Cancellation Effective Date', d.insuranceCancellationDate);
    }
    return;
  }

  const notReviewed = d.bipdCancelNotReviewed === true || d.bipdCancelPending === null;

  if (notReviewed) {
    _twoColRow(doc, L, W,
      'Helvetica-Bold', C.darkgray, 'BI&PD Cancellation Notice (FMCSA):',
      'Helvetica-Oblique', C.gray, 'Not reviewed (no data)');
    return;
  }

  if (d.bipdCancelLapsed) {
    const fmtD      = (iso) => { if (!iso) return null; const [y, m, dy] = iso.split('-'); return `${m}/${dy}/${y}`; };
    const swExpDate = d.autoLiabilityExpiration ? new Date(d.autoLiabilityExpiration) : null;
    const swIsActive = swExpDate && !isNaN(swExpDate.getTime()) && swExpDate >= new Date();
    let text, color;
    if (swIsActive) {
      text  = `FMCSA: cancelled effective ${fmtD(d.bipdCancelEffectiveDate) ?? '?'}, no replacement on file` +
              ` — SaferWatch shows active (exp ${d.autoLiabilityExpiration}) — SOURCES CONFLICT`;
      color = C.yellow;
    } else {
      text  = `CANCELLED effective ${fmtD(d.bipdCancelEffectiveDate) ?? '?'} — no replacement on file`;
      if (d.bipdCancelInsuranceCompany) text += ` — ${d.bipdCancelInsuranceCompany}`;
      color = C.red;
    }
    _twoColRow(doc, L, W,
      'Helvetica-Bold', C.darkgray, 'BI&PD Cancellation Notice (FMCSA):',
      'Helvetica-Bold', color, text);
    return;
  }

  if (!d.bipdCancelPending) {
    _twoColRow(doc, L, W,
      'Helvetica-Bold', C.darkgray, 'BI&PD Cancellation Notice (FMCSA):',
      'Helvetica', C.black, 'No pending cancellation');
    return;
  }

  // Pending = true
  const effDate   = d.bipdCancelEffectiveDate;
  const transDate = d.bipdCancelTransDate;
  const company   = d.bipdCancelInsuranceCompany;
  const daysOut   = d.bipdCancelDaysUntil;
  const withinThreshold = daysOut !== null && daysOut !== undefined && daysOut <= cancelDays;

  const fmtDate = (iso) => {
    if (!iso) return null;
    const [y, m, dy] = iso.split('-');
    return `${m}/${dy}/${y}`;
  };

  let text = `BI\u0026PD cancellation on file, effective ${fmtDate(effDate) ?? '?'}`;
  if (transDate) text += ` (FMCSA, filed ${fmtDate(transDate)})`;
  else text += ' (FMCSA)';
  if (company) text += ` \u2014 ${company}`;
  if (daysOut !== null && daysOut !== undefined) {
    if (daysOut <= 0)              text += '  !! IN EFFECT OR PAST';
    else if (withinThreshold)      text += `  !! ${daysOut} day${daysOut === 1 ? '' : 's'} until cancellation`;
    else                           text += `  (${daysOut} days out \u2014 informational)`;
  }

  _twoColRow(doc, L, W,
    'Helvetica-Bold', C.darkgray, 'BI&PD Cancellation Notice (FMCSA):',
    'Helvetica-Bold',
    withinThreshold ? C.yellow : C.darkgray,
    text);
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

// Double-Broker and Chameleon combined onto one row: "No / No", "YES / No", etc.
function doubleBrokerChameleonRow(doc, L, W, dbVal, chamVal) {
  const fmt = (v) => {
    const on     = v === true || v === 'true';
    const isNull = v === null || v === undefined;
    return { text: isNull ? '?' : (on ? 'YES' : 'No'), on, isNull };
  };
  const db  = fmt(dbVal);
  const ch  = fmt(chamVal);
  const combined = `${db.text} / ${ch.text}`;
  const isNull = db.isNull && ch.isNull;
  const anyOn  = db.on || ch.on;
  const display = isNull ? 'Not reviewed (no data)' : combined;
  _twoColRow(doc, L, W,
    'Helvetica-Bold', C.darkgray, 'Double-Broker / Chameleon Flag:',
    isNull ? 'Helvetica-Oblique' : anyOn ? 'Helvetica-Bold' : 'Helvetica',
    isNull ? C.gray : anyOn ? C.red : C.black,
    display);
}

function basicRow(doc, L, W, label, rawVal, threshold, source, zeroNote = null) {
  const val  = parseFloat(rawVal);
  const isNA = isNaN(val) || rawVal == null || rawVal === '';
  const over = !isNA && val >= threshold;
  const isZeroNote = !isNA && zeroNote != null && val === 0;
  const base = isNA
    ? 'Not reviewed (no data)'
    : isZeroNote
      ? zeroNote
      : `${val.toFixed(2)}%${over ? `  !! ABOVE this broker\u2019s ${threshold}% threshold` : ''}`;
  const display = !isNA && source ? `${base} (${source})` : base;
  _twoColRow(doc, L, W,
    'Helvetica-Bold', C.darkgray, `${label}:`,
    over ? 'Helvetica-Bold' : (isNA || isZeroNote) ? 'Helvetica-Oblique' : 'Helvetica',
    over ? C.red : (isNA || isZeroNote) ? C.gray : C.black,
    display);
}

function oosRowFull(doc, L, W, label, rawVal, nationalAvg, multiplier, rejectThreshold, source, noInspections = false) {
  if (noInspections) {
    _twoColRow(doc, L, W,
      'Helvetica-Bold', C.darkgray, `${label}:`,
      'Helvetica-Oblique', C.gray, 'Not reviewed (no inspections)');
    return;
  }
  const val = parseFloat(rawVal);
  const cls = classifyOos(
    val,
    parseFloat(nationalAvg),
    parseFloat(multiplier),
    parseFloat(rejectThreshold)
  );
  const isNA     = cls === 'unknown';
  const isHard   = cls === 'hard_block';
  const isYellow = cls === 'yellow';
  const flagText = cls === 'hard_block' ? '  !! EXCEEDS MAXIMUM'
                 : cls === 'yellow'     ? '  ^ ABOVE FLAG THRESHOLD'
                 : '';
  const base    = isNA ? 'Not reviewed (no data)' : `${val.toFixed(2)}%${flagText}`;
  const display = !isNA && source ? `${base} (${source})` : base;
  _twoColRow(doc, L, W,
    'Helvetica-Bold', C.darkgray, `${label}:`,
    isNA ? 'Helvetica-Oblique' : isHard || isYellow ? 'Helvetica-Bold' : 'Helvetica',
    isNA ? C.gray : isHard ? C.red : isYellow ? C.yellow : C.black,
    display);
}

// Show a gray note when a BASIC passes the data-sufficiency gate but has value 0.00%
// (meaning FMCSA assigned no percentile because there were no violations in that BASIC).
function basicZeroNote(doc, L, W, sufficiency, rawVal) {
  if (sufficiency !== 'ok') return;
  const v = parseFloat(rawVal);
  if (isNaN(v) || v !== 0 || rawVal === '' || rawVal == null) return;
  doc.fontSize(8).font('Helvetica-Oblique').fillColor(C.gray)
     .text('  0.00% (no FMCSA percentile assigned)',
           L + 8, doc.y, { width: W - 8 });
  doc.moveDown(0.15);
}

// Show an amber edit-audit note when a dispatcher changed an auto-filled value.
// d._autoFilled is stored in carrier_data at /run time; each entry is { value, sourceLabel }.
// Numeric values are normalized before comparison to avoid "20" !== "20.00" false positives.
function autoFilledNote(doc, L, W, d, field) {
  const af = (d._autoFilled || {})[field];
  if (!af) return;
  const current  = String(d[field] ?? '').trim();
  const original = String(af.value).trim();
  if (current === original) return;
  // Numeric comparison: "20" vs "20.00" → equal
  const cn = parseFloat(current), on = parseFloat(original);
  if (!isNaN(cn) && !isNaN(on) && cn === on) return;
  doc.fontSize(8).font('Helvetica-Bold').fillColor(C.yellow)
     .text(`  \u26A0 EDITED by dispatcher \u2014 auto-filled value was: ${original} (${af.sourceLabel})`,
           L + 8, doc.y, { width: W - 8 });
  doc.moveDown(0.15);
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
