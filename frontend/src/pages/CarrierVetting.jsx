import { useState, useCallback, useEffect } from 'react';
import BrokerCheck from './BrokerCheck.jsx';

// Fallback defaults used only while settings are loading (replaced immediately by server values)
// These match FMCSA's published SMS intervention thresholds for property carriers.
const DEFAULTS = {
  basicUnsafeDrivingThreshold:            65,
  basicUnsafeDrivingAction:               'reject',
  basicCrashIndicatorThreshold:           65,
  basicCrashIndicatorAction:              'reject',
  basicHosThreshold:                      65,
  basicHosAction:                         'hold',
  basicVehicleMaintenanceThreshold:       80,
  basicVehicleMaintenanceAction:          'hold',
  basicDriverFitnessThreshold:            80,
  basicDriverFitnessAction:               'hold',
  basicVehicleDriverObservedThreshold:    65,
  basicVehicleDriverObservedAction:       'hold',
  basicHazmatThreshold:                   80,
  basicHazmatAction:                      'hold',
  autoLiabilityMin:  1_000_000,
  cargoMin:            100_000,
  authorityMinDays:      365,
  oosHardBlockTruck:  35,
  oosHardBlockDriver:  7,
  inspectionVolumeMin: 3,
};

const INITIAL_FORM = {
  // Run metadata
  loadRef:    '',
  dispatcher: '',
  fmcsaLookupCompleted: false,
  // Carrier identity
  dotNumber:   '',
  mcNumber:    '',
  carrierName: '',
  // Authority
  authorityStatus:    'Active-Common',
  authorityGrantDate: '',
  // Safety rating
  safetyRating: 'None/Unrated',
  // Insurance
  autoLiability:                '',
  autoLiabilityExpiration:      '',
  cargoInsurance:               '',
  cargoExpiration:              '',
  pendingInsuranceCancellation: false,
  // Carrier Assure
  carrierAssureGrade: '',
  fraudFlag:         false,
  doubleBrokerFlag:  false,
  chameleonFlag:     false,
  // Federal OOS
  activeFederalOOS: false,
  // BASIC scores
  unsafeDrivingBasic:           '',
  crashIndicatorBasic:          '',
  hosBasic:                     '',
  vehicleMaintenanceBasic:      '',
  vehicleDriverObservedBasic:   '',
  driverFitnessBasic:           '',
  hazmatBasic:                  '',
  // Drug/alcohol — null = not answered (required), true = yes, false = no
  drugAlcoholViolation:         null,
  // Contact verification
  contactPhone:   '',
  contactEmail:   '',
  hasBrokerAuthority: false,
  fmcsaPhone:     '',
  // Crashes (FMCSA, display only)
  crashes24mo:    null,
  // Insurance data timestamp (from SaferWatch)
  insuranceDataAsOf: '',
  // Operations
  powerUnits:           '',
  inspections24mo:      '',
  cleanInspections24mo: '',
  truckOosPct:          '',
  driverOosPct:         '',
  nationalAvgTruckOos:  '',
  nationalAvgDriverOos: '',
  nationalAvgOosAsOf:   '',
};

const AUTHORITY_STATUSES = [
  'Active-Common', 'Active-Contract', 'Inactive', 'Suspended', 'Revoked',
  'Not Authorized', 'Revocation Pending',
];
const SAFETY_RATINGS = [
  'None/Unrated', 'Satisfactory', 'Conditional', 'Unsatisfactory',
];
const CA_GRADES = ['A', 'B', 'C', 'D', 'F'];

// ── Styles ────────────────────────────────────────────────────────────────────
const s = {
  page: { maxWidth: 900, margin: '0 auto', padding: '24px 20px' },
  h1:   { fontSize: 22, fontWeight: 800, color: '#0f172a', margin: '0 0 4px' },
  sub:  { fontSize: 13, color: '#64748b', marginBottom: 24 },

  card:     { background: '#ffffff', border: '1px solid #e2e8f0', borderRadius: 10, padding: '20px 24px', marginBottom: 20, boxShadow: '0 1px 4px rgba(0,0,0,.05)' },
  cardHead: { fontSize: 12, fontWeight: 700, letterSpacing: '0.08em', color: '#374151', textTransform: 'uppercase', borderBottom: '1px solid #e2e8f0', paddingBottom: 10, marginBottom: 16 },

  grid2: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px 20px' },
  grid3: { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '14px 20px' },

  label: { display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 },
  input: {
    width: '100%', padding: '8px 10px', border: '1.5px solid #cbd5e1', borderRadius: 6,
    fontSize: 13, fontFamily: 'inherit', boxSizing: 'border-box', color: '#0f172a',
    background: '#ffffff',
  },
  inputFilled: {
    width: '100%', padding: '8px 10px', border: '1.5px solid #16a34a', borderRadius: 6,
    fontSize: 13, fontFamily: 'inherit', boxSizing: 'border-box', color: '#14532d',
    background: '#f0fdf4',
  },
  inputFilledSW: {
    width: '100%', padding: '8px 10px', border: '1.5px solid #0284c7', borderRadius: 6,
    fontSize: 13, fontFamily: 'inherit', boxSizing: 'border-box', color: '#0c4a6e',
    background: '#eff6ff',
  },
  select: {
    width: '100%', padding: '8px 10px', border: '1.5px solid #cbd5e1', borderRadius: 6,
    fontSize: 13, fontFamily: 'inherit', boxSizing: 'border-box', color: '#0f172a', background: '#ffffff',
  },
  selectFilled: {
    width: '100%', padding: '8px 10px', border: '1.5px solid #16a34a', borderRadius: 6,
    fontSize: 13, fontFamily: 'inherit', boxSizing: 'border-box', color: '#14532d', background: '#f0fdf4',
  },
  selectFilledSW: {
    width: '100%', padding: '8px 10px', border: '1.5px solid #0284c7', borderRadius: 6,
    fontSize: 13, fontFamily: 'inherit', boxSizing: 'border-box', color: '#0c4a6e', background: '#eff6ff',
  },
  checkRow: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#374151', cursor: 'pointer' },

  btn: (color, disabled) => ({
    padding: '10px 22px', borderRadius: 7, fontWeight: 700, fontSize: 14,
    cursor: disabled ? 'not-allowed' : 'pointer', fontFamily: 'inherit',
    background: disabled ? '#e2e8f0'
      : color === 'gray' ? '#f1f5f9'
      : '#f97316',
    color: disabled ? '#94a3b8'
      : color === 'gray' ? '#475569'
      : '#fff',
    opacity: disabled ? 0.7 : 1,
    transition: 'opacity .15s',
    border: color === 'gray' && !disabled ? '1px solid #e2e8f0' : 'none',
    boxShadow: disabled || color === 'gray' ? 'none' : '0 2px 8px rgba(249,115,22,.25)',
  }),
  btnRow: { display: 'flex', gap: 12, marginTop: 8, flexWrap: 'wrap' },

  lookupBtn: (disabled) => ({
    padding: '8px 11px', border: 'none', borderRadius: 6, fontWeight: 700, fontSize: 12,
    cursor: disabled ? 'not-allowed' : 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap',
    flexShrink: 0, background: disabled ? '#e2e8f0' : '#f97316',
    color: disabled ? '#94a3b8' : '#fff',
    opacity: disabled ? 0.7 : 1,
  }),

  fmcsaBanner: {
    background: '#f0fdf4', border: '1.5px solid #86efac', borderRadius: 8,
    padding: '14px 18px', marginBottom: 12, fontSize: 12,
  },
  swBanner: {
    background: '#eff6ff', border: '1.5px solid #93c5fd', borderRadius: 8,
    padding: '14px 18px', marginBottom: 20, fontSize: 12,
  },
  swWarnBanner: {
    background: '#fffbeb', border: '1.5px solid #fcd34d', borderRadius: 8,
    padding: '14px 18px', marginBottom: 20, fontSize: 12,
  },

  verdictCard: (tier) => ({
    borderRadius: 10, padding: '20px 24px', marginBottom: 20,
    background: tier === 'GREEN' ? '#f0fdf4' : tier === 'YELLOW' ? '#fffbeb' : '#fef2f2',
    border: `2px solid ${tier === 'GREEN' ? '#16a34a' : tier === 'YELLOW' ? '#d97706' : '#dc2626'}`,
  }),
  verdictBadge: (tier) => ({
    display: 'inline-block', padding: '6px 18px', borderRadius: 20, fontWeight: 800,
    fontSize: 18, letterSpacing: '0.05em',
    background: tier === 'GREEN' ? '#16a34a' : tier === 'YELLOW' ? '#d97706' : '#dc2626',
    color: '#fff', marginBottom: 14,
  }),
  reasonItem: (tier) => ({
    fontSize: 13, color: tier === 'GREEN' ? '#166534' : tier === 'YELLOW' ? '#92400e' : '#991b1b',
    marginBottom: 4, paddingLeft: 14, position: 'relative',
  }),

  overrideCard: {
    background: '#fffbeb', border: '2px solid #d97706', borderRadius: 10,
    padding: '20px 24px', marginBottom: 20,
  },
  overrideHead: { fontSize: 13, fontWeight: 700, color: '#92400e', marginBottom: 6 },
  overrideSub:  { fontSize: 12, color: '#b45309', marginBottom: 14, lineHeight: 1.5 },

  logTable: { width: '100%', borderCollapse: 'collapse', fontSize: 12 },
  logTh:    { textAlign: 'left', padding: '8px 10px', background: '#f8fafc', fontWeight: 700, color: '#374151', borderBottom: '1px solid #e2e8f0' },
  logTd:    { padding: '7px 10px', borderBottom: '1px solid #f1f5f9', color: '#475569' },

  required: { color: '#dc2626', marginLeft: 2 },
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function Field({ label, required, children }) {
  return (
    <div>
      <label style={s.label}>
        {label}{required && <span style={s.required}>*</span>}
      </label>
      {children}
    </div>
  );
}

function TextInput({ name, value, onChange, placeholder, type = 'text', inputStyle, ...rest }) {
  return (
    <input
      type={type}
      name={name}
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      style={inputStyle ?? s.input}
      {...rest}
    />
  );
}

function CheckField({ name, label, checked, onChange }) {
  return (
    <label style={s.checkRow}>
      <input type="checkbox" name={name} checked={checked} onChange={onChange} />
      {label}
    </label>
  );
}

function RiskBadge({ v }) {
  const color = v === 'Acceptable'   ? '#16a34a'
              : v === 'Moderate'     ? '#d97706'
              : v === 'Unacceptable' ? '#dc2626'
              : '#6b7280';
  return (
    <span style={{
      background: color, color: '#fff', borderRadius: 4,
      padding: '1px 7px', fontSize: 11, fontWeight: 700,
    }}>{v || '—'}</span>
  );
}

function verdictLabel(tier) {
  return tier === 'GREEN' ? '✓ APPROVE' : tier === 'YELLOW' ? '⚠ HOLD' : '✗ REJECT';
}

function tierBadge(tier, verdict) {
  const color = tier === 'GREEN' ? '#16a34a' : tier === 'YELLOW' ? '#d97706' : '#dc2626';
  return (
    <span style={{
      background: color, color: '#fff', borderRadius: 4, padding: '2px 8px',
      fontSize: 11, fontWeight: 700,
    }}>
      {verdict ?? tier}
    </span>
  );
}

// ── Main component ────────────────────────────────────────────────────────────
export default function CarrierVetting({ settings }) {
  // Merge incoming settings with fallback defaults so labels are always populated
  const cfg = { ...DEFAULTS, ...(settings ?? {}) };
  const [mode,    setMode]    = useState('carrier');  // 'carrier' | 'broker'
  const [form,    setForm]    = useState(INITIAL_FORM);
  const [verdict, setVerdict] = useState(null);
  const [running, setRunning] = useState(false);
  const [runErr,  setRunErr]  = useState('');

  const [override,      setOverride]      = useState({ managerName: '', reason: '' });
  const [finalizing,    setFinalizing]    = useState(false);
  const [finalErr,      setFinalErr]      = useState('');
  const [savedRecordId, setSavedRecordId] = useState(null);
  const [saveStatus,    setSaveStatus]    = useState(null);

  const [logs,        setLogs]        = useState(null);
  const [logsLoading, setLogsLoading] = useState(true);
  const [logsErr,     setLogsErr]     = useState('');
  const [monitoring,  setMonitoring]  = useState(new Set()); // vetting_log IDs being monitored

  // ── Auto-fill state ──────────────────────────────────────────────────────
  const [fmcsaData,    setFmcsaData]    = useState(null);
  const [swData,       setSwData]       = useState(null);
  // fieldSources: { fieldName: 'fmcsa' | 'saferwatch' }
  const [fieldSources, setFieldSources] = useState({});
  const [lookingUp,    setLookingUp]    = useState(false);
  const [lookupErr,    setLookupErr]    = useState('');
  const [swErr,        setSwErr]        = useState('');
  const [swDrugAlcohol, setSwDrugAlcohol] = useState(null); // { value: bool|null, source: string }

  const [blockInfo,          setBlockInfo]          = useState(null);
  const [fmcsaCannotVerify,  setFmcsaCannotVerify]  = useState(false);
  const [fmcsaLastAttemptAt, setFmcsaLastAttemptAt] = useState(null);
  const [marking,            setMarking]            = useState(false);
  const [marked,             setMarked]             = useState(false);
  const [finalVerdict,       setFinalVerdict]       = useState(null);
  // Input border style by source: blue=SaferWatch, green=FMCSA, plain=manual
  const fi = (name) => {
    const src = fieldSources[name];
    if (src === 'saferwatch') return s.inputFilledSW;
    if (src === 'fmcsa')      return s.inputFilled;
    return s.input;
  };
  const fs = (name) => {
    const src = fieldSources[name];
    if (src === 'saferwatch') return s.selectFilledSW;
    if (src === 'fmcsa')      return s.selectFilled;
    return s.select;
  };

  // ── Form change handlers ────────────────────────────────────────────────────
  const handleChange = useCallback(e => {
    const { name, value, type, checked } = e.target;
    setForm(f => ({ ...f, [name]: type === 'checkbox' ? checked : value }));
    setVerdict(null);
    setSavedRecordId(null);
    setSaveStatus(null);
    setRunErr('');
    setFinalErr('');
    // Clear lookup data when DOT or MC changes — results are stale
    if (name === 'dotNumber' || name === 'mcNumber') {
      setFmcsaData(null);
      setSwData(null);
      setFieldSources({});
      setLookupErr('');
      setSwErr('');
      setSwDrugAlcohol(null);
      setForm(f => ({ ...f, fmcsaLookupCompleted: false, drugAlcoholViolation: null }));
    }
  }, []);

  // ── Shared: merge FMCSA + SW responses into form ────────────────────────────
  function applyLookupResults(fmcsaJson, swRes, swJson) {
    const sources = {};
    const updates = {};

    for (const field of (fmcsaJson.filledFields ?? [])) {
      const val = fmcsaJson[field];
      sources[field] = 'fmcsa';  // always record source — even when value is false/null
      if (val !== '' && val != null && val !== false) { updates[field] = val; }
    }

    const swOk = swRes.ok && swJson.ok !== false;
    if (!swOk) {
      setSwErr(swJson.error ?? 'SaferWatch lookup failed — manual entry required for BASIC scores and insurance');
    } else {
      for (const field of (swJson.filledFields ?? [])) {
        const val = swJson[field];
        if (val !== '' && val != null && val !== false) {
          updates[field] = val;
          sources[field] = 'saferwatch';
        }
      }
      if (swJson.activeFederalOOS === true) {
        updates.activeFederalOOS = true;
        sources.activeFederalOOS = 'saferwatch';
      }
      if (swJson.extraBasics?.driverFitnessPct) {
        updates.driverFitnessBasic = swJson.extraBasics.driverFitnessPct;
        sources.driverFitnessBasic = 'saferwatch';
      }
      if (swJson.insuranceDataAsOf) {
        updates.insuranceDataAsOf = swJson.insuranceDataAsOf;
        sources.insuranceDataAsOf = 'saferwatch';
      }
      if (swJson.drugAlcoholViolation !== undefined) {
        updates.drugAlcoholViolation = swJson.drugAlcoholViolation;
        setSwDrugAlcohol({ value: swJson.drugAlcoholViolation, source: swJson.drugAlcoholSource ?? null });
      }
    }
    updates.fmcsaLookupCompleted = true;

    setForm(f => ({ ...f, ...updates }));
    setFieldSources(sources);
    setFmcsaData(fmcsaJson);
    setSwData(swOk ? swJson : null);
    setVerdict(null);
    setSavedRecordId(null);
    setSaveStatus(null);
  }

  // ── DOT lookup: FMCSA + SaferWatch in parallel ──────────────────────────────
  async function lookupFmcsa() {
    const dot = form.dotNumber.replace(/\D/g, '');
    if (!dot) return setLookupErr('Enter a DOT number first.');
    setLookupErr('');
    setSwErr('');
    setFmcsaCannotVerify(false);
    setFmcsaLastAttemptAt(null);
    setBlockInfo(null);
    setLookingUp(true);
    try {
      const [fmcsaRes, swRes, blockRes] = await Promise.all([
        fetch(`/api/fmcsa/dot/${dot}`),
        fetch(`/api/saferwatch/${dot}`),
        fetch(`/api/monitoring/blocks/${dot}`),
      ]);
      const fmcsaJson = await fmcsaRes.json();
      const swJson    = await swRes.json();

      if (fmcsaRes.status === 503 && fmcsaJson.cannotVerify) {
        setFmcsaCannotVerify(true);
        setFmcsaLastAttemptAt(fmcsaJson.lastAttemptAt ?? null);
      } else if (!fmcsaRes.ok) {
        throw new Error(fmcsaJson.error ?? 'FMCSA lookup failed');
      } else {
        applyLookupResults(fmcsaJson, swRes, swJson);
      }

      if (blockRes.ok) {
        const blockJson = await blockRes.json();
        if (blockJson) setBlockInfo(blockJson);
      }
    } catch (e) {
      setLookupErr(e.message);
    } finally {
      setLookingUp(false);
    }
  }

  // ── MC lookup: resolve MC → carrier via FMCSA, SW in parallel ───────────────
  async function lookupByMc() {
    const mc = form.mcNumber.replace(/^(MC|FF)/i, '').replace(/\D/g, '');
    if (!mc) return setLookupErr('Enter an MC number first.');
    setLookupErr('');
    setSwErr('');
    setFmcsaCannotVerify(false);
    setFmcsaLastAttemptAt(null);
    setBlockInfo(null);
    setLookingUp(true);
    try {
      const [fmcsaRes, swRes] = await Promise.all([
        fetch(`/api/fmcsa/mc/${mc}`),
        fetch(`/api/saferwatch/${mc}?type=mc`),
      ]);
      const fmcsaJson = await fmcsaRes.json();
      const swJson    = await swRes.json();

      if (fmcsaRes.status === 503 && fmcsaJson.cannotVerify) {
        setFmcsaCannotVerify(true);
        setFmcsaLastAttemptAt(fmcsaJson.lastAttemptAt ?? null);
      } else if (!fmcsaRes.ok) {
        throw new Error(fmcsaJson.error ?? 'FMCSA MC lookup failed');
      } else {
        applyLookupResults(fmcsaJson, swRes, swJson);
        // Check for carrier block using DOT resolved from FMCSA
        const dot = fmcsaJson.dotNumber;
        if (dot) {
          fetch(`/api/monitoring/blocks/${dot}`)
            .then(r => r.ok ? r.json() : null)
            .then(b => { if (b) setBlockInfo(b); })
            .catch(() => {});
        }
      }
    } catch (e) {
      setLookupErr(e.message);
    } finally {
      setLookingUp(false);
    }
  }

  // ── Run vetting ─────────────────────────────────────────────────────────────
  async function runVetting() {
    setRunErr('');
    if (!form.loadRef.trim())    return setRunErr('Load Reference is required.');
    if (!form.dispatcher.trim()) return setRunErr('Dispatcher Name is required.');
    if (!fmcsaCannotVerify && !form.fmcsaLookupCompleted)
      return setRunErr('FMCSA lookup must be completed first. Enter a DOT or MC number and click Look Up.');
    if (!form.contactPhone.trim()) return setRunErr('Dispatcher Contact Phone is required.');
    if (!form.contactEmail.trim()) return setRunErr('Dispatcher Contact Email is required.');
    setRunning(true);
    try {
      const res = await fetch('/api/vetting/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...form,
          fmcsaCannotVerify,
          fmcsaLastAttemptAt,
          drugAlcoholSource: swDrugAlcohol?.source ?? null,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Vetting failed');
      // data includes { verdict, tier, reasons, warnings, authorityDays, canOverride, recordId }
      setVerdict(data);
      setOverride({ managerName: '', reason: '' });
      setSavedRecordId(null);
      setFinalErr('');
    } catch (e) { setRunErr(e.message); }
    finally { setRunning(false); }
  }

  // ── Finalize: generate PDF → storage → DB update → download ─────────────────
  // /pdf reads the authoritative record from DB by recordId (set during /run).
  // No verdict data is sent from the client — the server owns the verdict.
  async function finalize() {
    setFinalErr('');
    setSaveStatus(null);

    // Partial override guard — both fields required, or neither (save as plain HOLD)
    if (isHold) {
      const hasName   = override.managerName.trim().length > 0;
      const hasReason = override.reason.trim().length > 0;
      if (hasName !== hasReason) {
        return setFinalErr(
          'Both Manager Name and Override Reason are required to record an override. Fill both fields or leave both blank to save as HOLD.'
        );
      }
    }

    setFinalizing(true);

    const applyOverride = verdict?.canOverride &&
      override.managerName.trim() && override.reason.trim();

    try {
      const pdfRes = await fetch('/api/vetting/pdf', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recordId:    verdict.recordId,
          fieldSources,
          override:    applyOverride ? override : null,
        }),
      });

      if (!pdfRes.ok) {
        const err = await pdfRes.json().catch(() => ({ error: 'PDF generation failed' }));
        throw new Error(err.error ?? 'PDF generation failed');
      }

      const recordId  = pdfRes.headers.get('X-Record-Id');
      const filename  = pdfRes.headers.get('X-Filename') || 'VettingCert.pdf';
      const certSaved = pdfRes.headers.get('X-Cert-Saved');
      const certError = pdfRes.headers.get('X-Cert-Error');
      const xVerdict  = pdfRes.headers.get('X-Verdict');
      const xTier     = pdfRes.headers.get('X-Tier');

      // Trigger browser download
      const blob = await pdfRes.blob();
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href     = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      setSavedRecordId(recordId);
      setSaveStatus(
        certSaved === 'false'
          ? { ok: false, error: certError || 'Storage upload failed — attach PDF to load manually' }
          : { ok: true, recordId }
      );
      setFinalVerdict({ verdict: xVerdict, tier: xTier, recordId });
      setMarked(false);
    } catch (e) {
      setFinalErr(`PDF generation failed: ${e.message}`);
    } finally {
      setFinalizing(false);
    }
  }

  // ── Mark as Used ────────────────────────────────────────────────────────────
  async function markAsUsed() {
    if (!finalVerdict?.recordId || marked || marking) return;
    setMarking(true);
    try {
      await fetch('/api/vetting/mark-used', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          carrierName:     form.carrierName,
          dotNumber:       form.dotNumber,
          mcNumber:        form.mcNumber,
          loadRef:         form.loadRef,
          dispatcher:      form.dispatcher,
          verdict:         finalVerdict.verdict,
          tier:            finalVerdict.tier,
          vettingRecordId: finalVerdict.recordId,
        }),
      });
      setMarked(true);
    } catch (_) {}
    finally { setMarking(false); }
  }

  // ── Re-download a past certificate ──────────────────────────────────────────
  async function redownloadPdf(logId) {
    try {
      const res = await fetch(`/api/vetting/logs/${logId}/pdf`);
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? 'PDF not available');
      }
      const filename = res.headers.get('X-Filename') || `cert-${logId}.pdf`;
      const blob = await res.blob();
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href     = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) {
      alert(`Could not retrieve certificate: ${e.message}`);
    }
  }

  // ── Load audit logs ─────────────────────────────────────────────────────────
  async function loadLogs() {
    setLogsLoading(true); setLogsErr('');
    try {
      const [logsRes, monRes] = await Promise.all([
        fetch('/api/vetting/logs'),
        fetch('/api/monitoring/active'),
      ]);
      const data = await logsRes.json();
      if (!logsRes.ok) throw new Error(data.error ?? 'Failed to load logs');
      setLogs(data);
      if (monRes.ok) {
        const monData = await monRes.json();
        setMonitoring(new Set(monData.map(m => m.vetting_log_id).filter(Boolean)));
      }
    } catch (e) { setLogsErr(e.message); }
    finally { setLogsLoading(false); }
  }

  // ── Start monitoring a booked load ───────────────────────────────────────────
  async function startMonitoring(row) {
    try {
      const res = await fetch('/api/monitoring/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          vetting_log_id: row.id,
          load_ref:       row.load_ref,
          dot_number:     row.dot_number,
          carrier_name:   row.carrier_name,
          mc_number:      row.mc_number,
          started_by:     row.dispatcher,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Failed to start monitoring');
      setMonitoring(prev => new Set([...prev, row.id]));
    } catch (e) { alert(`Could not start monitoring: ${e.message}`); }
  }

  // ── Reset ───────────────────────────────────────────────────────────────────
  function reset() {
    setForm({ ...INITIAL_FORM });
    setVerdict(null);
    setOverride({ managerName: '', reason: '' });
    setSavedRecordId(null);
    setSaveStatus(null);
    setRunErr('');
    setFinalErr('');
    setFmcsaData(null);
    setBlockInfo(null);
    setFmcsaCannotVerify(false);
    setFmcsaLastAttemptAt(null);
    setMarking(false);
    setMarked(false);
    setFinalVerdict(null);
    setSwData(null);
    setFieldSources({});
    setLookupErr('');
    setSwErr('');
    setSwDrugAlcohol(null);
  }

  // Auto-load audit log on first render
  useEffect(() => { loadLogs(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const isHold      = verdict?.verdict === 'HOLD';
  const isReject    = verdict?.verdict === 'REJECT';
  const canFinalize = verdict !== null && !savedRecordId;

  return (
    <div style={s.page}>
      <h1 style={s.h1}>{mode === 'carrier' ? 'Carrier Vetting' : 'Broker Check'}</h1>

      {/* ── Mode Toggle ── */}
      <div style={{ display: 'flex', gap: 0, marginBottom: 20, border: '1px solid #e2e8f0', borderRadius: 8, overflow: 'hidden', width: 'fit-content' }}>
        {['carrier', 'broker'].map(m => (
          <button
            key={m}
            onClick={() => setMode(m)}
            style={{
              padding: '9px 22px', border: 'none', fontWeight: 700, fontSize: 13, cursor: 'pointer',
              fontFamily: 'inherit',
              background: mode === m ? '#f97316' : '#ffffff',
              color: mode === m ? '#fff' : '#64748b',
              transition: 'background .15s, color .15s',
            }}
          >
            {m === 'carrier' ? 'Carrier Vetting' : 'Broker Check'}
          </button>
        ))}
      </div>

      {mode === 'broker' ? (
        <BrokerCheck />
      ) : (
      <>
      <p style={s.sub}>
        Enter a DOT number and click <strong>Look Up</strong> to auto-fill from FMCSA.
        Complete remaining fields manually, click <strong>Run Vetting</strong>, then
        <strong> Generate PDF &amp; Save</strong> for an immutable audit record.
      </p>

      {/* ── Section 1: Run Metadata ── */}
      <div style={s.card}>
        <div style={s.cardHead}>Run Information</div>
        <div style={s.grid2}>
          <Field label="Load Reference Number" required>
            <TextInput name="loadRef" value={form.loadRef} onChange={handleChange} placeholder="e.g. 610-12345" />
          </Field>
          <Field label="Dispatcher Name" required>
            <TextInput name="dispatcher" value={form.dispatcher} onChange={handleChange} placeholder="Your name" />
          </Field>
        </div>
      </div>

      {/* ── Section 2: Carrier Identity ── */}
      <div style={s.card}>
        <div style={s.cardHead}>Carrier Identity</div>
        <div style={s.grid3}>
          <Field label="Carrier Legal Name">
            <TextInput
              name="carrierName" value={form.carrierName} onChange={handleChange}
              placeholder="Legal name on authority" inputStyle={fi('carrierName')}
            />
          </Field>

          <Field label="DOT Number">
            <div style={{ display: 'flex', gap: 6 }}>
              <TextInput
                name="dotNumber" value={form.dotNumber} onChange={handleChange}
                placeholder="e.g. 4172640" inputStyle={fi('dotNumber')}
              />
              <button
                style={s.lookupBtn(lookingUp)}
                disabled={lookingUp}
                onClick={lookupFmcsa}
                type="button"
              >
                {lookingUp ? '…' : 'Look Up'}
              </button>
            </div>
            {lookupErr && (
              <p style={{ color: '#f87171', fontSize: 11, margin: '4px 0 0' }}>{lookupErr}</p>
            )}
          </Field>

          <Field label="MC Number">
            <div style={{ display: 'flex', gap: 6 }}>
              <TextInput
                name="mcNumber" value={form.mcNumber} onChange={handleChange}
                placeholder="e.g. 1234567" inputStyle={fi('mcNumber')}
              />
              <button
                style={s.lookupBtn(lookingUp)}
                disabled={lookingUp}
                onClick={lookupByMc}
                type="button"
              >
                {lookingUp ? '…' : 'Look Up'}
              </button>
            </div>
          </Field>
        </div>
      </div>

      {/* ── Carrier Block Banner ── */}
      {blockInfo && (
        <div style={{
          background: '#fef2f2', border: '2px solid #dc2626', borderRadius: 8,
          padding: '14px 18px', marginBottom: 16,
        }}>
          <div style={{ fontWeight: 800, fontSize: 14, color: '#991b1b', marginBottom: 4 }}>
            CARRIER BLOCKED — DO NOT USE
          </div>
          <div style={{ fontSize: 13, color: '#374151', marginBottom: 4 }}>
            {blockInfo.block_reason}
          </div>
          <div style={{ fontSize: 12, color: '#6b7280' }}>
            Blocked {new Date(blockInfo.blocked_at).toLocaleDateString('en-US')}
            {blockInfo.threshold_type && ` · ${blockInfo.threshold_type.replace(/_/g, ' ')}: ${blockInfo.actual_value ?? ''}%`}
            {' '}&mdash; Go to Monitoring to lift this block.
          </div>
        </div>
      )}

      {/* ── FMCSA Cannot Verify Banner ── */}
      {fmcsaCannotVerify && (
        <div style={{
          background: '#fffbeb', border: '2px solid #d97706', borderRadius: 8,
          padding: '14px 18px', marginBottom: 16,
        }}>
          <div style={{ fontWeight: 800, fontSize: 14, color: '#92400e', marginBottom: 4 }}>
            ⚠ FMCSA UNREACHABLE — CANNOT VERIFY
          </div>
          <div style={{ fontSize: 13, color: '#374151', marginBottom: 4 }}>
            FMCSA was unavailable during lookup. Carrier status could not be verified from live data.
            Enter carrier information manually below. This run will be flagged as{' '}
            <strong>HOLD — manager authorization required</strong>.
          </div>
          {fmcsaLastAttemptAt && (
            <div style={{ fontSize: 12, color: '#6b7280' }}>
              Last attempt: {new Date(fmcsaLastAttemptAt).toLocaleString('en-US', { timeZoneName: 'short' })}
            </div>
          )}
        </div>
      )}

      {/* ── Auto-fill Banners ── */}
      {fmcsaData && (
        <div style={s.fmcsaBanner}>
          <strong style={{ color: '#4ade80' }}>
            FMCSA: {fmcsaData.filledFields.length} fields auto-filled
          </strong>
          {fmcsaData._fmcsa?.legalName && (
            <span style={{ color: '#4ade80' }}> — {fmcsaData._fmcsa.legalName}</span>
          )}
          <span style={{ color: '#94a3b8' }}>
            {'. '}Green-bordered fields came from the FMCSA public registry.
          </span>
        </div>
      )}

      {swData && (
        <div style={s.swBanner}>
          <strong style={{ color: '#38bdf8' }}>
            SaferWatch: {swData.filledFields.length} fields auto-filled
          </strong>
          <span style={{ color: '#94a3b8' }}>
            {'. '}Blue-bordered fields came from SaferWatch (BASIC scores, insurance, OOS).
          </span>
          {swData.cargoExpiration && (
            <span style={{ color: '#94a3b8' }}>{' '}Cargo cert expires: <strong>{swData.cargoExpiration}</strong>.</span>
          )}
          {swData.certStatus && !['APPROVED', 'OK'].includes(swData.certStatus) && (
            <span style={{ color: '#fbbf24', fontWeight: 600 }}>
              {' '}⚠ Cert status: {swData.certStatus}
            </span>
          )}
          {/* SaferWatch Risk Assessment — display only, does not drive our verdict */}
          {swData.riskAssessment?.overall && (
            <div style={{ marginTop: 8, color: '#94a3b8' }}>
              <strong>SaferWatch Risk (reference only — our rules engine decides):</strong>{' '}
              Overall: <RiskBadge v={swData.riskAssessment.overall} />{' '}
              Authority: <RiskBadge v={swData.riskAssessment.authority} />{' '}
              Insurance: <RiskBadge v={swData.riskAssessment.insurance} />{' '}
              Safety: <RiskBadge v={swData.riskAssessment.safety} />
            </div>
          )}
          <div style={{ marginTop: 8, color: '#94a3b8' }}>
            <strong>Still requires manual entry:</strong>{' '}
            Drug/alcohol violation (required), Crash Indicator BASIC, Vehicle Driver-Observed BASIC,
            Hazardous Materials BASIC, Clean inspections count, Carrier Assure grade &amp; flags,
            dispatcher contact phone/email.
          </div>
        </div>
      )}

      {swErr && !swData && fmcsaData && (
        <div style={s.swWarnBanner}>
          <strong style={{ color: '#fbbf24' }}>SaferWatch unavailable:</strong>{' '}
          <span style={{ color: '#fbbf24' }}>{swErr}</span>
          <div style={{ marginTop: 6, color: '#fbbf24' }}>
            BASIC scores, insurance amounts, and OOS rates require manual entry.
          </div>
        </div>
      )}

      {!fmcsaData && !swData && (
        <div style={{ fontSize: 12, color: '#475569', marginBottom: 16 }}>
          <strong>Always requires manual entry:</strong>{' '}
          Drug/alcohol violation (required), dispatcher contact phone/email,
          Crash Indicator BASIC, Clean inspections count,
          Pending insurance cancellation, Carrier Assure grade &amp; flags.
        </div>
      )}

      {/* ── Section 3: Authority & Insurance ── */}
      <div style={s.card}>
        <div style={s.cardHead}>Authority &amp; Insurance</div>
        <div style={s.grid3}>
          <Field label="Operating Authority Status">
            <select
              name="authorityStatus" value={form.authorityStatus}
              onChange={handleChange} style={fs('authorityStatus')}
            >
              {AUTHORITY_STATUSES.map(st => <option key={st}>{st}</option>)}
            </select>
          </Field>
          <Field label="Authority Grant Date">
            <TextInput
              type="date" name="authorityGrantDate" value={form.authorityGrantDate}
              onChange={handleChange} inputStyle={fi('authorityGrantDate')}
            />
          </Field>
          <div />

          <Field label={`Auto Liability ($) — min $${cfg.autoLiabilityMin.toLocaleString()}`}>
            <TextInput
              type="number" name="autoLiability" value={form.autoLiability}
              onChange={handleChange} placeholder="e.g. 1000000" min="0"
              inputStyle={fi('autoLiability')}
            />
          </Field>
          <Field label="Auto Liability Expiration">
            <TextInput
              type="date" name="autoLiabilityExpiration" value={form.autoLiabilityExpiration}
              onChange={handleChange}
              inputStyle={fi('autoLiabilityExpiration')}
            />
          </Field>
          <Field label={`Cargo Insurance ($) — min $${cfg.cargoMin.toLocaleString()}`}>
            <TextInput
              type="number" name="cargoInsurance" value={form.cargoInsurance}
              onChange={handleChange} placeholder="e.g. 100000" min="0"
              inputStyle={fi('cargoInsurance')}
            />
          </Field>
          <Field label="Cargo Insurance Expiration">
            <TextInput
              type="date" name="cargoExpiration" value={form.cargoExpiration}
              onChange={handleChange}
              inputStyle={fi('cargoExpiration')}
            />
          </Field>
          <div style={{ display: 'flex', alignItems: 'flex-end', paddingBottom: 4 }}>
            <CheckField
              name="pendingInsuranceCancellation"
              label="Pending insurance cancellation notice on file"
              checked={form.pendingInsuranceCancellation}
              onChange={handleChange}
            />
          </div>
        </div>
      </div>

      {/* ── Section 4: Safety Rating & BASICs ── */}
      <div style={s.card}>
        <div style={s.cardHead}>Safety Rating &amp; BASIC Scores</div>
        <div style={s.grid3}>
          <Field label="FMCSA Safety Rating">
            <select
              name="safetyRating" value={form.safetyRating}
              onChange={handleChange} style={fs('safetyRating')}
            >
              {SAFETY_RATINGS.map(r => <option key={r}>{r}</option>)}
            </select>
          </Field>
          <div style={{ display: 'flex', alignItems: 'flex-end', paddingBottom: 4 }}>
            <CheckField
              name="activeFederalOOS"
              label="Active federal Out-of-Service order"
              checked={form.activeFederalOOS}
              onChange={handleChange}
            />
          </div>
          <div />

          <Field label={`Unsafe Driving BASIC % (${cfg.basicUnsafeDrivingAction === 'reject' ? 'REJECT' : 'HOLD'} ≥ ${cfg.basicUnsafeDrivingThreshold})`}>
            <TextInput
              type="number" name="unsafeDrivingBasic" value={form.unsafeDrivingBasic}
              onChange={handleChange} placeholder="0–100" min="0" max="100" step="0.01"
              inputStyle={fi('unsafeDrivingBasic')}
            />
          </Field>
          <Field label={`Crash Indicator BASIC % (${cfg.basicCrashIndicatorAction === 'reject' ? 'REJECT' : 'HOLD'} ≥ ${cfg.basicCrashIndicatorThreshold}) — manual entry`}>
            <TextInput
              type="number" name="crashIndicatorBasic" value={form.crashIndicatorBasic}
              onChange={handleChange} placeholder="0–100" min="0" max="100" step="0.01"
            />
          </Field>
          <Field label={`Hours of Service BASIC % (${cfg.basicHosAction === 'reject' ? 'REJECT' : 'HOLD'} ≥ ${cfg.basicHosThreshold})`}>
            <TextInput
              type="number" name="hosBasic" value={form.hosBasic}
              onChange={handleChange} placeholder="0–100" min="0" max="100" step="0.01"
              inputStyle={fi('hosBasic')}
            />
          </Field>
          <Field label={`Vehicle Maintenance BASIC % (${cfg.basicVehicleMaintenanceAction === 'reject' ? 'REJECT' : 'HOLD'} ≥ ${cfg.basicVehicleMaintenanceThreshold})`}>
            <TextInput
              type="number" name="vehicleMaintenanceBasic" value={form.vehicleMaintenanceBasic}
              onChange={handleChange} placeholder="0–100" min="0" max="100" step="0.01"
              inputStyle={fi('vehicleMaintenanceBasic')}
            />
          </Field>
          <Field label={`Vehicle Driver-Observed BASIC % (${cfg.basicVehicleDriverObservedAction === 'reject' ? 'REJECT' : 'HOLD'} ≥ ${cfg.basicVehicleDriverObservedThreshold})`}>
            <TextInput
              type="number" name="vehicleDriverObservedBasic" value={form.vehicleDriverObservedBasic}
              onChange={handleChange} placeholder="0–100" min="0" max="100" step="0.01"
              inputStyle={fi('vehicleDriverObservedBasic')}
            />
          </Field>
          <Field label={`Driver Fitness BASIC % (${cfg.basicDriverFitnessAction === 'reject' ? 'REJECT' : 'HOLD'} ≥ ${cfg.basicDriverFitnessThreshold})`}>
            <TextInput
              type="number" name="driverFitnessBasic" value={form.driverFitnessBasic}
              onChange={handleChange} placeholder="0–100" min="0" max="100" step="0.01"
              inputStyle={fi('driverFitnessBasic')}
            />
          </Field>
          <Field label={`Hazardous Materials BASIC % (${cfg.basicHazmatAction === 'reject' ? 'REJECT' : 'HOLD'} ≥ ${cfg.basicHazmatThreshold})`}>
            <TextInput
              type="number" name="hazmatBasic" value={form.hazmatBasic}
              onChange={handleChange} placeholder="0–100" min="0" max="100" step="0.01"
              inputStyle={fi('hazmatBasic')}
            />
          </Field>

          <div style={{ gridColumn: '1 / -1' }}>
            <label style={{ ...s.label, marginBottom: 8 }}>
              Any drug or alcohol violation in the last 24 months?
              <span style={s.required}>*</span>
              <span style={{ fontWeight: 400, color: '#dc2626', marginLeft: 6 }}>
                YES = REJECT, no override
              </span>
            </label>

            {swDrugAlcohol?.source && swDrugAlcohol.value === true && (
              <div style={{ background: '#fef2f2', border: '1.5px solid #dc2626', borderRadius: 6, padding: '8px 12px', marginBottom: 10, fontSize: 12 }}>
                <strong style={{ color: '#991b1b' }}>Auto-filled from SaferWatch — violation detected.</strong>{' '}
                <span style={{ color: '#7f1d1d' }}>{swDrugAlcohol.source}</span>
              </div>
            )}
            {swDrugAlcohol?.source && swDrugAlcohol.value === false && (
              <div style={{ background: '#f0fdf4', border: '1.5px solid #86efac', borderRadius: 6, padding: '8px 12px', marginBottom: 10, fontSize: 12 }}>
                <strong style={{ color: '#166534' }}>Auto-filled — no violations found.</strong>{' '}
                <span style={{ color: '#166534' }}>{swDrugAlcohol.source}</span>
                <span style={{ color: '#6b7280' }}> You may change to Yes if you have additional information.</span>
              </div>
            )}
            {swDrugAlcohol?.source && swDrugAlcohol.value === null && (
              <div style={{ background: '#fffbeb', border: '1.5px solid #fcd34d', borderRadius: 6, padding: '8px 12px', marginBottom: 10, fontSize: 12 }}>
                <strong style={{ color: '#92400e' }}>{swDrugAlcohol.source}</strong>
                <span style={{ color: '#6b7280' }}> — answer required below.</span>
              </div>
            )}

            <div style={{ display: 'flex', gap: 20 }}>
              <label style={{ ...s.checkRow, cursor: swDrugAlcohol?.value === true ? 'not-allowed' : 'pointer' }}>
                <input
                  type="radio" name="drugAlcoholViolation" value="yes"
                  checked={form.drugAlcoholViolation === true}
                  disabled={swDrugAlcohol?.value === true}
                  onChange={() => {
                    setForm(f => ({ ...f, drugAlcoholViolation: true }));
                    setVerdict(null); setSavedRecordId(null); setSaveStatus(null);
                    setRunErr(''); setFinalErr('');
                  }}
                />
                <span style={{ color: '#dc2626', fontWeight: 700 }}>Yes — violation reported</span>
              </label>
              <label style={{ ...s.checkRow, cursor: swDrugAlcohol?.value === true ? 'not-allowed' : 'pointer' }}>
                <input
                  type="radio" name="drugAlcoholViolation" value="no"
                  checked={form.drugAlcoholViolation === false}
                  disabled={swDrugAlcohol?.value === true}
                  onChange={() => {
                    setForm(f => ({ ...f, drugAlcoholViolation: false }));
                    setVerdict(null); setSavedRecordId(null); setSaveStatus(null);
                    setRunErr(''); setFinalErr('');
                  }}
                />
                <span style={{ color: '#166534' }}>No</span>
              </label>
              {form.drugAlcoholViolation === null && !swDrugAlcohol?.source && (
                <span style={{ fontSize: 12, color: '#dc2626', alignSelf: 'center' }}>
                  Required — check the FMCSA Drug &amp; Alcohol Clearinghouse or CSA SMS
                </span>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* ── Contact Verification ── */}
      <div style={s.card}>
        <div style={s.cardHead}>Contact Verification</div>
        <div style={{ fontSize: 12, color: '#64748b', marginBottom: 14 }}>
          Phone mismatch with FMCSA or free email domain = HOLD. Enter the contact info from the dispatch packet.
        </div>
        <div style={s.grid3}>
          <Field label="Dispatcher Contact Phone">
            <TextInput
              name="contactPhone" value={form.contactPhone} onChange={handleChange}
              placeholder="e.g. 555-867-5309"
            />
          </Field>
          <Field label="Dispatcher Contact Email">
            <TextInput
              type="email" name="contactEmail" value={form.contactEmail} onChange={handleChange}
              placeholder="e.g. dispatch@carrier.com"
            />
          </Field>
          <Field label="FMCSA Company Phone (auto-filled)">
            <TextInput
              name="fmcsaPhone" value={form.fmcsaPhone} onChange={handleChange}
              placeholder="From FMCSA registry" inputStyle={fi('fmcsaPhone')}
            />
          </Field>
          <div style={{ display: 'flex', alignItems: 'flex-end', paddingBottom: 4 }}>
            <CheckField
              name="hasBrokerAuthority"
              label="Carrier also holds broker authority"
              checked={form.hasBrokerAuthority}
              onChange={handleChange}
            />
          </div>
        </div>
      </div>

      {/* ── Section 5: Carrier Assure ── */}
      <div style={s.card}>
        <div style={s.cardHead}>Carrier Assure — manual entry</div>
        <div style={s.grid3}>
          <Field label="Carrier Assure Grade">
            <select
              name="carrierAssureGrade" value={form.carrierAssureGrade}
              onChange={handleChange} style={s.select}
            >
              <option value="">— Select grade —</option>
              {CA_GRADES.map(g => <option key={g}>{g}</option>)}
            </select>
          </Field>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, justifyContent: 'flex-end', paddingBottom: 4 }}>
            <CheckField name="fraudFlag"        label="Fraud flag"         checked={form.fraudFlag}        onChange={handleChange} />
            <CheckField name="doubleBrokerFlag" label="Double-broker flag" checked={form.doubleBrokerFlag} onChange={handleChange} />
            <CheckField name="chameleonFlag"    label="Chameleon flag"     checked={form.chameleonFlag}    onChange={handleChange} />
          </div>
        </div>
      </div>

      {/* ── Section 6: OOS & Operations ── */}
      <div style={s.card}>
        <div style={s.cardHead}>OOS &amp; Operations</div>
        <div style={s.grid3}>
          <Field label="Power Units">
            <TextInput
              type="number" name="powerUnits" value={form.powerUnits}
              onChange={handleChange} placeholder="Number of trucks" min="0"
              inputStyle={fi('powerUnits')}
            />
          </Field>
          <Field label="Inspections — vehicle, last 24 months">
            <TextInput
              type="number" name="inspections24mo" value={form.inspections24mo}
              onChange={handleChange} placeholder="Total vehicle inspections" min="0"
              inputStyle={fi('inspections24mo')}
            />
          </Field>
          <Field label="Clean Inspections — last 24 months (manual entry)">
            <TextInput
              type="number" name="cleanInspections24mo" value={form.cleanInspections24mo}
              onChange={handleChange} placeholder="Inspections with no violations" min="0"
            />
          </Field>
          <Field label="Truck OOS %">
            <TextInput
              type="number" name="truckOosPct" value={form.truckOosPct}
              onChange={handleChange} placeholder="e.g. 12.5" min="0" max="100" step="0.1"
              inputStyle={fi('truckOosPct')}
            />
          </Field>
          <Field label="Driver OOS %">
            <TextInput
              type="number" name="driverOosPct" value={form.driverOosPct}
              onChange={handleChange} placeholder="e.g. 5.2" min="0" max="100" step="0.1"
              inputStyle={fi('driverOosPct')}
            />
          </Field>
          <div />
          <Field label="National Avg Truck OOS %">
            <TextInput
              type="number" name="nationalAvgTruckOos" value={form.nationalAvgTruckOos}
              onChange={handleChange} step="0.1"
              inputStyle={fi('nationalAvgTruckOos')}
            />
          </Field>
          <Field label="National Avg Driver OOS %">
            <TextInput
              type="number" name="nationalAvgDriverOos" value={form.nationalAvgDriverOos}
              onChange={handleChange} step="0.1"
              inputStyle={fi('nationalAvgDriverOos')}
            />
          </Field>
        </div>
      </div>

      {/* ── Action Buttons ── */}
      <div style={s.btnRow}>
        <button style={s.btn('blue', running)} disabled={running} onClick={runVetting}>
          {running ? 'Running…' : 'Run Vetting'}
        </button>
        <button style={s.btn('gray', false)} onClick={reset}>
          Clear Form
        </button>
      </div>
      {runErr && <p style={{ color: '#f87171', fontSize: 13, marginTop: 8 }}>{runErr}</p>}

      {/* ── Verdict Display ── */}
      {verdict && (
        <>
          <div style={{ ...s.verdictCard(verdict.tier), marginTop: 24 }}>
            <div style={s.verdictBadge(verdict.tier)}>
              {verdict.verdict === 'APPROVED WITH OVERRIDE' ? '✓ APPROVED WITH OVERRIDE' : verdictLabel(verdict.tier)}
            </div>

            {verdict.authorityDays !== null && (
              <p style={{ fontSize: 12, color: '#64748b', marginBottom: 10 }}>
                Authority age: <strong>{verdict.authorityDays} days</strong>
                {verdict.authorityDays < cfg.authorityMinDays
                  ? <span style={{ color: '#fbbf24' }}> (under {cfg.authorityMinDays}-day minimum)</span>
                  : <span style={{ color: '#4ade80' }}> ✓</span>}
              </p>
            )}

            <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>
              {verdict.reasons.map((r, i) => (
                <li key={i} style={s.reasonItem(verdict.tier)}>
                  <span style={{ position: 'absolute', left: 0 }}>
                    {verdict.tier === 'GREEN' ? '✓' : verdict.tier === 'YELLOW' ? '⚠' : '✗'}
                  </span>
                  {r}
                </li>
              ))}
            </ul>

            {verdict.notes?.length > 0 && (
              <div style={{ marginTop: 14, background: 'rgba(59,130,246,.08)', border: '1px solid rgba(59,130,246,.2)', borderRadius: 8, padding: '10px 14px' }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: '#60a5fa', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 6 }}>
                  Informational
                </div>
                <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>
                  {verdict.notes.map((n, i) => (
                    <li key={i} style={{ fontSize: 13, color: '#93c5fd', paddingLeft: 18, position: 'relative', marginBottom: 2 }}>
                      <span style={{ position: 'absolute', left: 0 }}>ℹ</span>
                      {n}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {verdict.warnings?.length > 0 && (
              <div style={{ marginTop: 14, background: '#fffbeb', border: '1.5px solid #d97706', borderRadius: 8, padding: '10px 14px' }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: '#d97706', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 6 }}>
                  Additional HOLD-level findings
                </div>
                <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>
                  {verdict.warnings.map((w, i) => (
                    <li key={i} style={{ fontSize: 13, color: '#92400e', paddingLeft: 18, position: 'relative', marginBottom: 2 }}>
                      <span style={{ position: 'absolute', left: 0 }}>⚠</span>
                      {w}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {isReject && (
              <p style={{ fontSize: 12, fontWeight: 700, color: '#f87171', marginTop: 12, marginBottom: 0 }}>
                REJECT decisions cannot be overridden. Do not book this carrier.
              </p>
            )}

            <p style={{ fontSize: 11, color: '#94a3b8', marginTop: 14, marginBottom: 0, lineHeight: 1.5 }}>
              Results are based on third-party data and your settings as of this check.
              You make the booking decision. Torevez does not guarantee any carrier is safe or qualified.
            </p>
          </div>

          {/* ── Manager Override (HOLD only) ── */}
          {isHold && !savedRecordId && (
            <div style={s.overrideCard}>
              <div style={s.overrideHead}>Manager Override</div>
              <p style={s.overrideSub}>
                This carrier is on <strong style={{ color: '#fbbf24' }}>HOLD</strong>. You may proceed by completing the override below,
                or save the record as HOLD without overriding.
                RED results cannot be overridden — only HOLD.
              </p>
              <div style={s.grid2}>
                <Field label="Manager Name">
                  <TextInput
                    name="managerName"
                    value={override.managerName}
                    onChange={e => setOverride(o => ({ ...o, managerName: e.target.value }))}
                    placeholder="Authorizing manager's full name"
                  />
                </Field>
                <Field label="Override Reason">
                  <TextInput
                    name="reason"
                    value={override.reason}
                    onChange={e => setOverride(o => ({ ...o, reason: e.target.value }))}
                    placeholder="Documented reason for override"
                  />
                </Field>
              </div>
              {override.managerName.trim() && override.reason.trim() && (
                <p style={{ fontSize: 12, color: '#fbbf24', marginTop: 10, marginBottom: 0 }}>
                  Verdict will be recorded as <strong>APPROVED WITH OVERRIDE</strong>.
                  Manager name, reason, and timestamp will appear in the PDF.
                </p>
              )}
            </div>
          )}

          {/* ── Finalize Button ── */}
          {!savedRecordId && (
            <div style={s.btnRow}>
              <button
                style={s.btn('green', finalizing)}
                disabled={finalizing}
                onClick={finalize}
              >
                {finalizing ? 'Generating…' : 'Generate PDF & Save'}
              </button>
            </div>
          )}
          {finalErr && <p style={{ color: '#f87171', fontSize: 13, marginTop: 8 }}>{finalErr}</p>}

          {/* ── Post-generate status ── */}
          {savedRecordId && (
            <>
              {saveStatus?.ok === false ? (
                <div style={{
                  background: '#fef2f2', border: '2.5px solid #dc2626', borderRadius: 8,
                  padding: '16px 20px', marginTop: 16,
                }}>
                  <div style={{ fontWeight: 800, fontSize: 15, color: '#991b1b', marginBottom: 6 }}>
                    ⚠ Certificate NOT archived to storage
                  </div>
                  <div style={{ fontSize: 13, color: '#7f1d1d', marginBottom: 10 }}>
                    The PDF was generated and downloaded to your computer, but could not be saved to the secure archive.
                    You must manually attach it to the load record and keep a copy.
                  </div>
                  <div style={{ fontSize: 12, color: '#991b1b', fontFamily: 'monospace', background: '#fee2e2', padding: '6px 10px', borderRadius: 4, marginBottom: 14 }}>
                    {saveStatus.error}
                  </div>
                  <button style={s.btn('blue', false)} onClick={reset}>Vet Another Carrier</button>
                </div>
              ) : (
                <div style={{
                  background: '#f0fdf4', border: '1.5px solid #16a34a',
                  borderRadius: 8, padding: '14px 18px', marginTop: 16,
                }}>
                  <strong style={{ color: '#166534' }}>PDF generated and downloaded.</strong>
                  {' '}
                  <span style={{ fontSize: 13, color: '#166534' }}>Attach it to the load in your TMS.</span>
                  <p style={{ fontSize: 12, color: '#166534', marginTop: 8, marginBottom: 0 }}>
                    Certificate saved to secure storage. Record ID:{' '}
                    <code style={{ fontSize: 11, background: 'rgba(22,163,74,.12)', padding: '1px 4px', borderRadius: 3, color: '#166534' }}>
                      {saveStatus.recordId}
                    </code>
                  </p>
                  <div style={{ display: 'flex', gap: 10, marginTop: 12, flexWrap: 'wrap', alignItems: 'center' }}>
                    <button style={s.btn('blue', false)} onClick={reset}>Vet Another Carrier</button>
                    {!marked && finalVerdict?.verdict === 'REJECT' && (
                      <span style={{ fontSize: 13, color: '#dc2626', fontWeight: 700 }}>
                        ✗ REJECT — carrier cannot be booked
                      </span>
                    )}
                    {!marked && finalVerdict?.verdict === 'HOLD' && (
                      <span style={{ fontSize: 13, color: '#d97706', fontWeight: 700 }}>
                        ⚠ HOLD — manager override required before booking
                      </span>
                    )}
                    {!marked && finalVerdict?.verdict !== 'REJECT' && finalVerdict?.verdict !== 'HOLD' && (
                      <button
                        style={s.btn('green', marking)}
                        disabled={marking}
                        onClick={markAsUsed}
                      >
                        {marking ? 'Saving…' : 'Mark as Used'}
                      </button>
                    )}
                    {marked && (
                      <span style={{ fontSize: 13, color: '#166534', fontWeight: 600 }}>
                        ✓ Carrier marked as used
                      </span>
                    )}
                  </div>
                </div>
              )}
            </>
          )}
        </>
      )}

      {/* ── Audit Log ── */}
      <div style={{ ...s.card, marginTop: 32 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
          <div style={s.cardHead}>Vetting Audit Log</div>
          <button style={s.btn('blue', logsLoading)} disabled={logsLoading} onClick={loadLogs}>
            {logsLoading ? 'Loading…' : 'Refresh'}
          </button>
        </div>
        {logsErr && <p style={{ color: '#f87171', fontSize: 13 }}>{logsErr}</p>}
        {logsLoading && !logs && !logsErr && (
          <p style={{ fontSize: 13, color: '#64748b' }}>Loading…</p>
        )}
        {logs && (
          logs.length === 0
            ? <p style={{ fontSize: 13, color: '#6b7280' }}>No records yet.</p>
            : (
              <div style={{ overflowX: 'auto' }}>
                <table style={s.logTable}>
                  <thead>
                    <tr>
                      {['Date', 'Load Ref', 'Dispatcher', 'Carrier', 'DOT', 'Verdict', 'PDF', 'Monitor'].map(h => (
                        <th key={h} style={s.logTh}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {logs.map(row => (
                      <tr key={row.id}>
                        <td style={s.logTd}>{new Date(row.created_at).toLocaleString('en-US', { month: '2-digit', day: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' })}</td>
                        <td style={s.logTd}>{row.load_ref}</td>
                        <td style={s.logTd}>{row.dispatcher}</td>
                        <td style={s.logTd}>{row.carrier_name || '—'}</td>
                        <td style={s.logTd}>{row.dot_number || '—'}</td>
                        <td style={s.logTd}>{tierBadge(row.tier, row.effective_verdict ?? row.verdict)}</td>
                        <td style={s.logTd}>
                          {row.pdf_url
                            ? <button
                                style={{ background: 'none', border: 'none', color: '#f97316', fontWeight: 600, cursor: 'pointer', fontSize: 12, padding: 0 }}
                                onClick={() => redownloadPdf(row.id)}
                              >
                                Download
                              </button>
                            : <span style={{ color: '#475569' }}>—</span>}
                        </td>
                        <td style={s.logTd}>
                          {(row.tier === 'GREEN' || (row.effective_verdict ?? row.verdict) === 'APPROVED WITH OVERRIDE') && row.dot_number
                            ? monitoring.has(row.id)
                              ? <span style={{ fontSize: 11, color: '#4ade80', fontWeight: 700 }}>● Monitoring</span>
                              : <button
                                  style={{ ...s.btn('blue', false), fontSize: 11 }}
                                  onClick={() => startMonitoring(row)}
                                >
                                  ▶ Monitor
                                </button>
                            : <span style={{ color: '#475569' }}>—</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
        )}
      </div>
      </>
      )}
    </div>
  );
}
