import { useState, useCallback } from 'react';

// Fallback defaults used only while settings are loading (replaced immediately by server values)
const DEFAULTS = {
  basicUnsafeDrivingThreshold:       55,
  basicUnsafeDrivingAction:          'reject',
  basicCrashIndicatorThreshold:      55,
  basicCrashIndicatorAction:         'reject',
  basicHosThreshold:                 55,
  basicHosAction:                    'hold',
  basicVehicleMaintenanceThreshold:  55,
  basicVehicleMaintenanceAction:     'hold',
  basicDriverFitnessThreshold:       55,
  basicDriverFitnessAction:          'hold',
  basicControlledSubstanceThreshold: 55,
  basicControlledSubstanceAction:    'reject',
  autoLiabilityMin:  1_000_000,
  cargoMin:            100_000,
  authorityMinDays:      365,
};

const INITIAL_FORM = {
  // Run metadata
  loadRef:    '',
  dispatcher: '',
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
  cargoInsurance:               '',
  pendingInsuranceCancellation: false,
  // Carrier Assure
  carrierAssureGrade: '',
  fraudFlag:         false,
  doubleBrokerFlag:  false,
  chameleonFlag:     false,
  // Federal OOS
  activeFederalOOS: false,
  // BASIC scores
  unsafeDrivingBasic:        '',
  crashIndicatorBasic:       '',
  hosBasic:                  '',
  vehicleMaintenanceBasic:   '',
  driverFitnessBasic:        '',
  controlledSubstancesBasic: '',
  // Operations
  powerUnits:           '',
  inspections24mo:      '',
  cleanInspections24mo: '',
  truckOosPct:          '',
  driverOosPct:         '',
  nationalAvgTruckOos:  '5.5',
  nationalAvgDriverOos: '5.2',
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
  h1:   { fontSize: 22, fontWeight: 800, color: '#1e3a5f', margin: '0 0 4px' },
  sub:  { fontSize: 13, color: '#6b7280', marginBottom: 24 },

  card:     { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: '20px 24px', marginBottom: 20 },
  cardHead: { fontSize: 12, fontWeight: 700, letterSpacing: '0.08em', color: '#1e3a5f', textTransform: 'uppercase', borderBottom: '1px solid #e5e7eb', paddingBottom: 10, marginBottom: 16 },

  grid2: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px 20px' },
  grid3: { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '14px 20px' },

  label: { display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 },
  input: {
    width: '100%', padding: '8px 10px', border: '1.5px solid #d1d5db', borderRadius: 6,
    fontSize: 13, fontFamily: 'inherit', boxSizing: 'border-box', color: '#111827',
    background: '#fff',
  },
  inputFilled: {
    width: '100%', padding: '8px 10px', border: '1.5px solid #16a34a', borderRadius: 6,
    fontSize: 13, fontFamily: 'inherit', boxSizing: 'border-box', color: '#111827',
    background: '#f0fdf4',
  },
  inputFilledSW: {
    width: '100%', padding: '8px 10px', border: '1.5px solid #0284c7', borderRadius: 6,
    fontSize: 13, fontFamily: 'inherit', boxSizing: 'border-box', color: '#111827',
    background: '#f0f9ff',
  },
  select: {
    width: '100%', padding: '8px 10px', border: '1.5px solid #d1d5db', borderRadius: 6,
    fontSize: 13, fontFamily: 'inherit', boxSizing: 'border-box', color: '#111827', background: '#fff',
  },
  selectFilled: {
    width: '100%', padding: '8px 10px', border: '1.5px solid #16a34a', borderRadius: 6,
    fontSize: 13, fontFamily: 'inherit', boxSizing: 'border-box', color: '#111827', background: '#f0fdf4',
  },
  selectFilledSW: {
    width: '100%', padding: '8px 10px', border: '1.5px solid #0284c7', borderRadius: 6,
    fontSize: 13, fontFamily: 'inherit', boxSizing: 'border-box', color: '#111827', background: '#f0f9ff',
  },
  checkRow: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#374151', cursor: 'pointer' },

  btn: (color, disabled) => ({
    padding: '10px 22px', border: 'none', borderRadius: 7, fontWeight: 700, fontSize: 14,
    cursor: disabled ? 'not-allowed' : 'pointer', fontFamily: 'inherit',
    background: disabled ? '#d1d5db' : color === 'blue' ? '#1e3a5f' : color === 'green' ? '#16a34a' : '#b45309',
    color: '#fff', opacity: disabled ? 0.7 : 1, transition: 'opacity .15s',
  }),
  btnRow: { display: 'flex', gap: 12, marginTop: 8, flexWrap: 'wrap' },

  lookupBtn: (disabled) => ({
    padding: '8px 11px', border: 'none', borderRadius: 6, fontWeight: 700, fontSize: 12,
    cursor: disabled ? 'not-allowed' : 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap',
    flexShrink: 0, background: disabled ? '#d1d5db' : '#1e3a5f', color: '#fff',
    opacity: disabled ? 0.6 : 1,
  }),

  fmcsaBanner: {
    background: '#f0fdf4', border: '1.5px solid #16a34a', borderRadius: 8,
    padding: '14px 18px', marginBottom: 12, fontSize: 12,
  },
  swBanner: {
    background: '#f0f9ff', border: '1.5px solid #0284c7', borderRadius: 8,
    padding: '14px 18px', marginBottom: 20, fontSize: 12,
  },
  swWarnBanner: {
    background: '#fffbeb', border: '1.5px solid #d97706', borderRadius: 8,
    padding: '14px 18px', marginBottom: 20, fontSize: 12,
  },

  // Verdict card
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
  overrideSub:  { fontSize: 12, color: '#92400e', marginBottom: 14, lineHeight: 1.5 },

  logTable: { width: '100%', borderCollapse: 'collapse', fontSize: 12 },
  logTh:    { textAlign: 'left', padding: '8px 10px', background: '#f3f4f6', fontWeight: 700, color: '#374151', borderBottom: '1px solid #e5e7eb' },
  logTd:    { padding: '7px 10px', borderBottom: '1px solid #f3f4f6', color: '#374151' },

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
  const [logsLoading, setLogsLoading] = useState(false);
  const [logsErr,     setLogsErr]     = useState('');

  // ── Auto-fill state ──────────────────────────────────────────────────────
  const [fmcsaData,    setFmcsaData]    = useState(null);
  const [swData,       setSwData]       = useState(null);
  // fieldSources: { fieldName: 'fmcsa' | 'saferwatch' }
  const [fieldSources, setFieldSources] = useState({});
  const [lookingUp,    setLookingUp]    = useState(false);
  const [lookupErr,    setLookupErr]    = useState('');
  const [swErr,        setSwErr]        = useState('');

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
    }
  }, []);

  // ── Shared: merge FMCSA + SW responses into form ────────────────────────────
  function applyLookupResults(fmcsaJson, swRes, swJson) {
    const sources = {};
    const updates = {};

    for (const field of (fmcsaJson.filledFields ?? [])) {
      const val = fmcsaJson[field];
      if (val !== '' && val != null) { updates[field] = val; sources[field] = 'fmcsa'; }
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
      if (swJson.extraBasics?.controlledSubstancesPct) {
        updates.controlledSubstancesBasic = swJson.extraBasics.controlledSubstancesPct;
        sources.controlledSubstancesBasic = 'saferwatch';
      }
      if (swJson.extraBasics?.driverFitnessPct) {
        updates.driverFitnessBasic = swJson.extraBasics.driverFitnessPct;
        sources.driverFitnessBasic = 'saferwatch';
      }
    }

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
    setLookingUp(true);
    try {
      const [fmcsaRes, swRes] = await Promise.all([
        fetch(`/api/fmcsa/dot/${dot}`),
        fetch(`/api/saferwatch/${dot}`),
      ]);
      const fmcsaJson = await fmcsaRes.json();
      const swJson    = await swRes.json();
      if (!fmcsaRes.ok) throw new Error(fmcsaJson.error ?? 'FMCSA lookup failed');
      applyLookupResults(fmcsaJson, swRes, swJson);
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
    setLookingUp(true);
    try {
      const [fmcsaRes, swRes] = await Promise.all([
        fetch(`/api/fmcsa/mc/${mc}`),
        fetch(`/api/saferwatch/${mc}?type=mc`),
      ]);
      const fmcsaJson = await fmcsaRes.json();
      const swJson    = await swRes.json();
      if (!fmcsaRes.ok) throw new Error(fmcsaJson.error ?? 'FMCSA MC lookup failed');
      applyLookupResults(fmcsaJson, swRes, swJson);
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
    setRunning(true);
    try {
      const res = await fetch('/api/vetting/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Vetting failed');
      setVerdict(data);
      setOverride({ managerName: '', reason: '' });
      setSavedRecordId(null);
      setFinalErr('');
    } catch (e) { setRunErr(e.message); }
    finally { setRunning(false); }
  }

  // ── Finalize: generate PDF, save to storage, download to user ───────────────
  // The backend generates the PDF once, uploads that exact buffer to storage,
  // then sends the same buffer as the download. X-Certificate-Save-Error is set
  // in the response headers if the save failed — PDF is always delivered.
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
          carrierData: form,
          override:    applyOverride ? override : null,
        }),
      });

      if (!pdfRes.ok) {
        const err = await pdfRes.json().catch(() => ({ error: 'PDF generation failed' }));
        throw new Error(err.error ?? 'PDF generation failed');
      }

      const recordId  = pdfRes.headers.get('X-Record-Id');
      const filename  = pdfRes.headers.get('X-Filename') || 'VettingCert.pdf';
      const saveErr   = pdfRes.headers.get('X-Certificate-Save-Error');

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
      setSaveStatus(saveErr ? { ok: false, error: saveErr } : { ok: true, recordId });
    } catch (e) {
      setFinalErr(`PDF generation failed: ${e.message}`);
    } finally {
      setFinalizing(false);
    }
  }

  // ── Load audit logs ─────────────────────────────────────────────────────────
  async function loadLogs() {
    setLogsLoading(true); setLogsErr('');
    try {
      const res  = await fetch('/api/vetting/logs');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Failed to load logs');
      setLogs(data);
    } catch (e) { setLogsErr(e.message); }
    finally { setLogsLoading(false); }
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
    setSwData(null);
    setFieldSources({});
    setLookupErr('');
    setSwErr('');
  }

  const isHold      = verdict?.verdict === 'HOLD';
  const isReject    = verdict?.verdict === 'REJECT';
  const canFinalize = verdict !== null && !savedRecordId;

  return (
    <div style={s.page}>
      <h1 style={s.h1}>Carrier Vetting</h1>
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
              <p style={{ color: '#dc2626', fontSize: 11, margin: '4px 0 0' }}>{lookupErr}</p>
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

      {/* ── Auto-fill Banners ── */}
      {fmcsaData && (
        <div style={s.fmcsaBanner}>
          <strong style={{ color: '#166534' }}>
            FMCSA: {fmcsaData.filledFields.length} fields auto-filled
          </strong>
          {fmcsaData._fmcsa?.legalName && (
            <span style={{ color: '#166534' }}> — {fmcsaData._fmcsa.legalName}</span>
          )}
          <span style={{ color: '#374151' }}>
            {'. '}Green-bordered fields came from the FMCSA public registry.
          </span>
        </div>
      )}

      {swData && (
        <div style={s.swBanner}>
          <strong style={{ color: '#075985' }}>
            SaferWatch: {swData.filledFields.length} fields auto-filled
          </strong>
          <span style={{ color: '#374151' }}>
            {'. '}Blue-bordered fields came from SaferWatch (BASIC scores, insurance, OOS).
          </span>
          {swData.cargoExpiration && (
            <span style={{ color: '#374151' }}>{' '}Cargo cert expires: <strong>{swData.cargoExpiration}</strong>.</span>
          )}
          {swData.certStatus && swData.certStatus !== 'APPROVED' && (
            <span style={{ color: '#b45309', fontWeight: 600 }}>
              {' '}⚠ Cert status: {swData.certStatus}
            </span>
          )}
          {/* SaferWatch Risk Assessment — display only, does not drive our verdict */}
          {swData.riskAssessment?.overall && (
            <div style={{ marginTop: 8, color: '#374151' }}>
              <strong>SaferWatch Risk (reference only — our rules engine decides):</strong>{' '}
              Overall: <RiskBadge v={swData.riskAssessment.overall} />{' '}
              Authority: <RiskBadge v={swData.riskAssessment.authority} />{' '}
              Insurance: <RiskBadge v={swData.riskAssessment.insurance} />{' '}
              Safety: <RiskBadge v={swData.riskAssessment.safety} />
            </div>
          )}
          <div style={{ marginTop: 8, color: '#374151' }}>
            <strong>Still requires manual entry:</strong>{' '}
            Crash Indicator BASIC, Clean inspections count,
            Pending insurance cancellation, Carrier Assure grade &amp; flags.
          </div>
        </div>
      )}

      {swErr && !swData && fmcsaData && (
        <div style={s.swWarnBanner}>
          <strong style={{ color: '#92400e' }}>SaferWatch unavailable:</strong>{' '}
          <span style={{ color: '#92400e' }}>{swErr}</span>
          <div style={{ marginTop: 6, color: '#92400e' }}>
            BASIC scores, insurance amounts, and OOS rates require manual entry.
          </div>
        </div>
      )}

      {!fmcsaData && !swData && (
        <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 16 }}>
          <strong>Still requires manual entry after Look Up:</strong>{' '}
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
          <Field label={`Cargo Insurance ($) — min $${cfg.cargoMin.toLocaleString()}`}>
            <TextInput
              type="number" name="cargoInsurance" value={form.cargoInsurance}
              onChange={handleChange} placeholder="e.g. 100000" min="0"
              inputStyle={fi('cargoInsurance')}
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
          <Field label={`Driver Fitness BASIC % (${cfg.basicDriverFitnessAction === 'reject' ? 'REJECT' : 'HOLD'} ≥ ${cfg.basicDriverFitnessThreshold})`}>
            <TextInput
              type="number" name="driverFitnessBasic" value={form.driverFitnessBasic}
              onChange={handleChange} placeholder="0–100" min="0" max="100" step="0.01"
              inputStyle={fi('driverFitnessBasic')}
            />
          </Field>
          <Field label={`Controlled Substances/Alcohol BASIC % (${cfg.basicControlledSubstanceAction === 'reject' ? 'REJECT' : 'HOLD'} ≥ ${cfg.basicControlledSubstanceThreshold})`}>
            <TextInput
              type="number" name="controlledSubstancesBasic" value={form.controlledSubstancesBasic}
              onChange={handleChange} placeholder="0–100" min="0" max="100" step="0.01"
              inputStyle={fi('controlledSubstancesBasic')}
            />
          </Field>
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
      {runErr && <p style={{ color: '#dc2626', fontSize: 13, marginTop: 8 }}>{runErr}</p>}

      {/* ── Verdict Display ── */}
      {verdict && (
        <>
          <div style={{ ...s.verdictCard(verdict.tier), marginTop: 24 }}>
            <div style={s.verdictBadge(verdict.tier)}>
              {verdictLabel(verdict.tier)} — {verdict.verdict}
            </div>

            {verdict.authorityDays !== null && (
              <p style={{ fontSize: 12, color: '#6b7280', marginBottom: 10 }}>
                Authority age: <strong>{verdict.authorityDays} days</strong>
                {verdict.authorityDays < cfg.authorityMinDays
                  ? <span style={{ color: '#d97706' }}> (under {cfg.authorityMinDays}-day minimum)</span>
                  : <span style={{ color: '#16a34a' }}> ✓</span>}
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
              <div style={{ marginTop: 14, background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 8, padding: '10px 14px' }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: '#1d4ed8', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 6 }}>
                  Informational
                </div>
                <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>
                  {verdict.notes.map((n, i) => (
                    <li key={i} style={{ fontSize: 13, color: '#1e40af', paddingLeft: 18, position: 'relative', marginBottom: 2 }}>
                      <span style={{ position: 'absolute', left: 0 }}>ℹ</span>
                      {n}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {isReject && (
              <p style={{ fontSize: 12, fontWeight: 700, color: '#991b1b', marginTop: 12, marginBottom: 0 }}>
                REJECT decisions cannot be overridden. Do not book this carrier.
              </p>
            )}
          </div>

          {/* ── Manager Override (HOLD only) ── */}
          {isHold && !savedRecordId && (
            <div style={s.overrideCard}>
              <div style={s.overrideHead}>Manager Override</div>
              <p style={s.overrideSub}>
                This carrier is on <strong>HOLD</strong>. You may proceed by completing the override below,
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
                <p style={{ fontSize: 12, color: '#92400e', marginTop: 10, marginBottom: 0 }}>
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
          {finalErr && <p style={{ color: '#dc2626', fontSize: 13, marginTop: 8 }}>{finalErr}</p>}

          {/* ── Post-generate status ── */}
          {savedRecordId && (
            <div style={{
              background: saveStatus?.ok === false ? '#fffbeb' : '#f0fdf4',
              border: `1.5px solid ${saveStatus?.ok === false ? '#d97706' : '#16a34a'}`,
              borderRadius: 8, padding: '14px 18px', marginTop: 16,
            }}>
              <strong style={{ color: saveStatus?.ok === false ? '#92400e' : '#166534' }}>
                PDF generated and downloaded.
              </strong>
              {' '}
              <span style={{ fontSize: 13, color: saveStatus?.ok === false ? '#92400e' : '#166534' }}>
                Attach it to the load in Dr Dispatch now.
              </span>

              {saveStatus?.ok && (
                <p style={{ fontSize: 12, color: '#166534', marginTop: 8, marginBottom: 0 }}>
                  Certificate saved to secure storage. Record ID:{' '}
                  <code style={{ fontSize: 11, background: '#dcfce7', padding: '1px 4px', borderRadius: 3 }}>
                    {saveStatus.recordId}
                  </code>
                </p>
              )}
              {saveStatus?.ok === false && (
                <p style={{ fontSize: 12, color: '#92400e', marginTop: 8, marginBottom: 0 }}>
                  Certificate could not be saved to storage: {saveStatus.error}
                </p>
              )}

              <div style={{ marginTop: 12 }}>
                <button style={s.btn('blue', false)} onClick={reset}>
                  Vet Another Carrier
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {/* ── Audit Log ── */}
      <div style={{ ...s.card, marginTop: 32 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
          <div style={s.cardHead}>Vetting Audit Log</div>
          <button style={s.btn('blue', logsLoading)} disabled={logsLoading} onClick={loadLogs}>
            {logsLoading ? 'Loading…' : logs ? 'Refresh' : 'Load Log'}
          </button>
        </div>
        {logsErr && <p style={{ color: '#dc2626', fontSize: 13 }}>{logsErr}</p>}
        {logs && (
          logs.length === 0
            ? <p style={{ fontSize: 13, color: '#6b7280' }}>No records yet.</p>
            : (
              <div style={{ overflowX: 'auto' }}>
                <table style={s.logTable}>
                  <thead>
                    <tr>
                      {['Date', 'Load Ref', 'Dispatcher', 'Carrier', 'DOT', 'Verdict', 'PDF'].map(h => (
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
                        <td style={s.logTd}>{tierBadge(row.tier, row.verdict)}</td>
                        <td style={s.logTd}>
                          {row.pdf_url
                            ? <a href={`/api/certificates/${row.id}/download`} target="_blank" rel="noreferrer" style={{ color: '#1e3a5f', fontWeight: 600 }}>Download</a>
                            : <span style={{ color: '#9ca3af' }}>—</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
        )}
      </div>
    </div>
  );
}
