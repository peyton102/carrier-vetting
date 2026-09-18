import { useState, useEffect, useCallback } from 'react';

const s = {
  page:     { maxWidth: 900, margin: '0 auto', padding: '24px 20px' },
  h1:       { fontSize: 22, fontWeight: 800, color: '#0f172a', margin: '0 0 4px' },
  sub:      { fontSize: 13, color: '#64748b', marginBottom: 24, lineHeight: 1.6 },
  card:     { background: '#ffffff', border: '1px solid #e2e8f0', borderRadius: 10, padding: '20px 24px', marginBottom: 20, boxShadow: '0 1px 4px rgba(0,0,0,.05)' },
  cardHead: { fontSize: 12, fontWeight: 700, letterSpacing: '0.08em', color: '#374151', textTransform: 'uppercase', borderBottom: '1px solid #e2e8f0', paddingBottom: 10, marginBottom: 16 },
  label:    { display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 },
  input:    { width: '100%', padding: '8px 10px', border: '1.5px solid #cbd5e1', borderRadius: 6, fontSize: 13, fontFamily: 'inherit', boxSizing: 'border-box', color: '#0f172a', background: '#ffffff' },
  select:   { width: '100%', padding: '8px 10px', border: '1.5px solid #cbd5e1', borderRadius: 6, fontSize: 13, fontFamily: 'inherit', boxSizing: 'border-box', color: '#0f172a', background: '#ffffff' },
  checkRow: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#374151', cursor: 'pointer', marginBottom: 10 },
  btnRow:   { display: 'flex', gap: 12, marginTop: 8, alignItems: 'center', flexWrap: 'wrap' },
  btn:      (disabled) => ({
    padding: '10px 22px', border: 'none', borderRadius: 7, fontWeight: 700, fontSize: 14,
    cursor: disabled ? 'not-allowed' : 'pointer', fontFamily: 'inherit',
    background: disabled ? '#e2e8f0' : '#f97316',
    color: disabled ? '#94a3b8' : '#fff',
    opacity: disabled ? 0.7 : 1,
    boxShadow: disabled ? 'none' : '0 2px 8px rgba(249,115,22,.25)',
  }),
  notice: { background: 'rgba(59,130,246,.06)', border: '1px solid rgba(59,130,246,.2)', borderRadius: 8, padding: '12px 16px', fontSize: 12, color: '#1d4ed8', marginBottom: 20 },
};

// All 8 FMCSA CSA BASICs with configurable threshold + action
const BASICS = [
  { key: 'basicUnsafeDriving',            label: 'Unsafe Driving'                },
  { key: 'basicCrashIndicator',           label: 'Crash Indicator'               },
  { key: 'basicHos',                      label: 'Hours of Service'              },
  { key: 'basicVehicleMaintenance',       label: 'Vehicle Maintenance'           },
  { key: 'basicVehicleDriverObserved',    label: 'Vehicle Driver-Observed'       },
  { key: 'basicDriverFitness',            label: 'Driver Fitness'                },
  { key: 'basicHazmat',                   label: 'Hazardous Materials'           },
  { key: 'basicControlledSubstance',      label: 'Controlled Substances/Alcohol' },
];

// ── FMCSA Credentials Card ────────────────────────────────────────────────────
function FmcsaCredentialsCard() {
  const [status,    setStatus]    = useState(null);
  const [webKey,    setWebKey]    = useState('');
  const [saving,    setSaving]    = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [msg,       setMsg]       = useState(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/credentials/fmcsa');
      if (r.ok) setStatus(await r.json());
    } catch (_) {}
  }, []);

  useEffect(() => { load(); }, [load]);

  async function handleSave(e) {
    e.preventDefault();
    if (!webKey.trim()) {
      setMsg({ type: 'err', text: 'Web key is required.' });
      return;
    }
    setSaving(true); setMsg(null);
    try {
      const r = await fetch('/api/credentials/fmcsa', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ webKey }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? 'Save failed');
      setMsg({ type: 'ok', text: 'FMCSA web key saved.' });
      setWebKey('');
      await load();
    } catch (e) { setMsg({ type: 'err', text: e.message }); }
    finally { setSaving(false); }
  }

  async function handleVerify() {
    setVerifying(true); setMsg(null);
    try {
      const r = await fetch('/api/credentials/fmcsa/verify', { method: 'POST' });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? 'Verify failed');
      const type = d.status === 'verified' ? 'ok' : d.status === 'invalid' ? 'err' : 'info';
      setMsg({ type, text: d.message });
    } catch (e) { setMsg({ type: 'err', text: e.message }); }
    finally { setVerifying(false); }
  }

  const msgColors = { ok: '#4ade80', err: '#f87171', info: '#93c5fd' };

  return (
    <div style={s.card}>
      <div style={s.cardHead}>FMCSA API Key (required for DOT/MC lookup)</div>
      <p style={{ fontSize: 12, color: '#475569', marginTop: 0, marginBottom: 8 }}>
        Each account must use its own free FMCSA web key — shared keys may get rate-limited or revoked.
      </p>
      <div style={{ background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 8, padding: '10px 14px', fontSize: 12, color: '#1e40af', marginBottom: 14 }}>
        <strong>How to get your free key:</strong> Click{' '}
        <a
          href="https://mobile.fmcsa.dot.gov/qc/services/users/register"
          target="_blank"
          rel="noreferrer"
          style={{ color: '#1d4ed8', fontWeight: 700 }}
        >
          here to open the FMCSA registration page
        </a>
        {' '}— fill in your name, email, and company. FMCSA emails your key within minutes. It never expires and has no cost.
      </div>

      {status && (
        <p style={{ fontSize: 12, color: status.configured ? '#4ade80' : '#f87171', marginBottom: 14 }}>
          {status.configured
            ? `✓ FMCSA key configured${status.configuredAt ? ` on ${new Date(status.configuredAt).toLocaleDateString()}` : ''}`
            : '✗ No FMCSA key — DOT/MC lookup will not work until a key is saved'}
        </p>
      )}

      <form onSubmit={handleSave}>
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', marginBottom: 14 }}>
          <div style={{ flex: 1 }}>
            <label style={s.label}>FMCSA Web Key</label>
            <input
              type="password" autoComplete="off"
              placeholder="Paste your FMCSA web key…"
              value={webKey}
              onChange={e => setWebKey(e.target.value)}
              style={s.input}
            />
          </div>
        </div>

        <div style={s.btnRow}>
          <button type="submit" style={s.btn(saving)} disabled={saving}>
            {saving ? 'Saving…' : 'Save Key'}
          </button>
          {status?.configured && (
            <button
              type="button"
              onClick={handleVerify}
              disabled={verifying}
              style={{ ...s.btn(verifying), background: verifying ? '#e2e8f0' : '#f1f5f9', color: '#475569', border: '1px solid #e2e8f0', boxShadow: 'none' }}
            >
              {verifying ? 'Verifying…' : 'Verify Key'}
            </button>
          )}
          {msg && (
            <span style={{ fontSize: 13, fontWeight: 600, color: msgColors[msg.type] }}>
              {msg.text}
            </span>
          )}
        </div>
      </form>
    </div>
  );
}

export default function Settings({ settings, onSave }) {
  const [form,    setForm]    = useState(null);
  const [saving,  setSaving]  = useState(false);
  const [saved,   setSaved]   = useState(false);
  const [err,     setErr]     = useState('');

  // Populate form whenever settings prop arrives (first load or after external save)
  useEffect(() => {
    if (settings) setForm({ ...settings });
  }, [settings]);

  function set(key, value) {
    setForm(f => ({ ...f, [key]: value }));
    setSaved(false);
    setErr('');
  }

  async function handleSave(e) {
    e.preventDefault();
    setSaving(true); setErr(''); setSaved(false);
    try {
      const res  = await fetch('/api/settings', {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(form),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Save failed');
      onSave(data);
      setSaved(true);
    } catch (e) {
      setErr(e.message);
    } finally {
      setSaving(false);
    }
  }

  if (!form) {
    return (
      <div style={s.page}>
        <h1 style={s.h1}>Settings</h1>
        <p style={{ color: '#6b7280', fontSize: 13 }}>Loading settings…</p>
      </div>
    );
  }

  return (
    <div style={s.page}>
      <h1 style={s.h1}>Vetting Settings</h1>
      <p style={s.sub}>
        Configure your brokerage's vetting policy. These thresholds are applied to every carrier
        vetting run and printed on every certificate — giving you a documented, defensible policy
        record per your legal obligations. Adjust any time; changes take effect immediately on the
        next vetting run.
      </p>

      <div style={s.notice}>
        <strong>Legal note:</strong> Each brokerage must maintain its own written vetting policy
        under <em>Montgomery v. Caribe Transport</em> and related precedent. These settings are
        your policy. Save them whenever you update your standards, and retain old certificates as
        evidence of the thresholds that were active at each vetting date.
      </div>

      <form onSubmit={handleSave}>

        {/* ── BASIC Score Thresholds ── */}
        <div style={s.card}>
          <div style={s.cardHead}>BASIC Score Thresholds</div>
          <p style={{ fontSize: 12, color: '#475569', marginBottom: 16, marginTop: 0 }}>
            For each BASIC, set the percentile threshold that triggers a flag, and choose whether
            exceeding it causes a hard <strong>Reject</strong> (no override) or a <strong>Hold</strong> (manager override allowed).
          </p>

          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr>
                  <th style={{ textAlign: 'left', padding: '6px 10px', background: '#f8fafc', fontWeight: 700, color: '#374151', borderBottom: '1px solid #e2e8f0', width: '40%' }}>BASIC</th>
                  <th style={{ textAlign: 'left', padding: '6px 10px', background: '#f8fafc', fontWeight: 700, color: '#374151', borderBottom: '1px solid #e2e8f0', width: '30%' }}>Alert threshold (%)</th>
                  <th style={{ textAlign: 'left', padding: '6px 10px', background: '#f8fafc', fontWeight: 700, color: '#374151', borderBottom: '1px solid #e2e8f0', width: '30%' }}>Action when exceeded</th>
                </tr>
              </thead>
              <tbody>
                {BASICS.map(({ key, label }) => (
                  <tr key={key}>
                    <td style={{ padding: '8px 10px', borderBottom: '1px solid #f1f5f9', fontWeight: 600, color: '#374151' }}>{label}</td>
                    <td style={{ padding: '8px 10px', borderBottom: '1px solid #f1f5f9' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <input
                          type="number"
                          min={1} max={100}
                          value={form[`${key}Threshold`] ?? ''}
                          onChange={e => set(`${key}Threshold`, parseInt(e.target.value, 10))}
                          style={{ ...s.input, width: 70 }}
                        />
                        <span style={{ color: '#6b7280', fontSize: 12 }}>%</span>
                      </div>
                    </td>
                    <td style={{ padding: '8px 10px', borderBottom: '1px solid #f1f5f9' }}>
                      <select
                        value={form[`${key}Action`] ?? 'hold'}
                        onChange={e => set(`${key}Action`, e.target.value)}
                        style={s.select}
                      >
                        <option value="reject">Reject (hard block)</option>
                        <option value="hold">Hold (manager override)</option>
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* ── Insurance Requirements ── */}
        <div style={s.card}>
          <div style={s.cardHead}>Insurance Requirements</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px 20px' }}>
            <div>
              <label style={s.label}>Auto Liability Minimum ($)</label>
              <input
                type="number" min={0}
                value={form.autoLiabilityMin ?? ''}
                onChange={e => set('autoLiabilityMin', parseInt(e.target.value, 10))}
                style={s.input}
              />
              <p style={{ fontSize: 11, color: '#6b7280', margin: '4px 0 0', color: '#475569' }}>
                Carriers below this amount are hard-rejected. Federal minimum is $750,000.
              </p>
            </div>
            <div>
              <label style={s.label}>Cargo Insurance Minimum ($)</label>
              <input
                type="number" min={0}
                value={form.cargoMin ?? ''}
                onChange={e => set('cargoMin', parseInt(e.target.value, 10))}
                style={s.input}
              />
              <p style={{ fontSize: 11, color: '#475569', margin: '4px 0 0' }}>
                Carriers below this amount are hard-rejected.
              </p>
            </div>
          </div>
        </div>

        {/* ── Authority Age ── */}
        <div style={s.card}>
          <div style={s.cardHead}>Authority Age</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px 20px' }}>
            <div>
              <label style={s.label}>Minimum Authority Age (days)</label>
              <input
                type="number" min={0}
                value={form.authorityMinDays ?? ''}
                onChange={e => set('authorityMinDays', parseInt(e.target.value, 10))}
                style={s.input}
              />
            </div>
            <div>
              <label style={s.label}>Action when under minimum</label>
              <select
                value={form.authorityAgeAction ?? 'hold'}
                onChange={e => set('authorityAgeAction', e.target.value)}
                style={s.select}
              >
                <option value="hold">Hold (manager override allowed)</option>
                <option value="block">Block (hard reject — no override)</option>
              </select>
            </div>
          </div>
        </div>

        {/* ── Safety Ratings ── */}
        <div style={s.card}>
          <div style={s.cardHead}>Safety Rating Blocks</div>
          <p style={{ fontSize: 12, color: '#475569', marginTop: 0, marginBottom: 14 }}>
            Carriers with these FMCSA safety ratings will be hard-rejected. Unrated carriers are
            never blocked solely for being unrated.
          </p>
          <label style={s.checkRow}>
            <input
              type="checkbox"
              checked={!!form.blockConditional}
              onChange={e => set('blockConditional', e.target.checked)}
            />
            Block carriers rated <strong style={{ marginLeft: 4 }}>Conditional</strong>
          </label>
          <label style={s.checkRow}>
            <input
              type="checkbox"
              checked={!!form.blockUnsatisfactory}
              onChange={e => set('blockUnsatisfactory', e.target.checked)}
            />
            Block carriers rated <strong style={{ marginLeft: 4 }}>Unsatisfactory</strong>
          </label>
        </div>

        {/* ── OOS Rate ── */}
        <div style={s.card}>
          <div style={s.cardHead}>Out-of-Service Rates</div>

          <p style={{ fontSize: 12, color: '#475569', marginTop: 0, marginBottom: 16 }}>
            Two independent OOS checks. The hard block triggers an immediate <strong>Reject</strong> with no override path.
            The multiplier check triggers a <strong>Hold</strong> for manager review.
          </p>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '14px 20px', marginBottom: 16 }}>
            <div>
              <label style={s.label}>Vehicle OOS Hard Block (%)</label>
              <input
                type="number" min={1} max={100}
                value={form.oosHardBlockTruck ?? ''}
                onChange={e => set('oosHardBlockTruck', parseFloat(e.target.value))}
                style={s.input}
              />
              <p style={{ fontSize: 11, color: '#475569', margin: '4px 0 0' }}>
                Carrier above this → auto-REJECT, no override. Default: 35%.
              </p>
            </div>
            <div>
              <label style={s.label}>Driver OOS Hard Block (%)</label>
              <input
                type="number" min={1} max={100}
                value={form.oosHardBlockDriver ?? ''}
                onChange={e => set('oosHardBlockDriver', parseFloat(e.target.value))}
                style={s.input}
              />
              <p style={{ fontSize: 11, color: '#475569', margin: '4px 0 0' }}>
                Carrier above this → auto-REJECT, no override. Default: 7%.
              </p>
            </div>
            <div>
              <label style={s.label}>Yellow-flag multiplier (× national avg)</label>
              <input
                type="number" min={1} step={0.5}
                value={form.oosRateMultiplier ?? ''}
                onChange={e => set('oosRateMultiplier', parseFloat(e.target.value))}
                style={s.input}
              />
              <p style={{ fontSize: 11, color: '#475569', margin: '4px 0 0' }}>
                e.g., 2 = Hold if OOS% ≥ 2× national average.
              </p>
            </div>
          </div>
        </div>

        {/* ── Inspection Volume ── */}
        <div style={s.card}>
          <div style={s.cardHead}>Inspection Volume Minimum</div>
          <div style={{ maxWidth: 320 }}>
            <label style={s.label}>Minimum inspections (24 months) for reliable BASIC data</label>
            <input
              type="number" min={0}
              value={form.inspectionVolumeMin ?? ''}
              onChange={e => set('inspectionVolumeMin', parseInt(e.target.value, 10))}
              style={{ ...s.input, width: 100 }}
            />
            <p style={{ fontSize: 11, color: '#475569', margin: '6px 0 0' }}>
              Carriers with fewer inspections than this are routed to supervisor review —
              FMCSA percentile scores are not statistically reliable at low inspection volumes.
              Default: 3.
            </p>
          </div>
        </div>

        {/* ── Save ── */}
        <div style={s.btnRow}>
          <button type="submit" style={s.btn(saving)} disabled={saving}>
            {saving ? 'Saving…' : 'Save Settings'}
          </button>
          {saved && (
            <span style={{ fontSize: 13, color: '#4ade80', fontWeight: 600 }}>
              ✓ Settings saved — active on next vetting run
            </span>
          )}
          {err && (
            <span style={{ fontSize: 13, color: '#dc2626' }}>{err}</span>
          )}
        </div>

      </form>

      {/* ── FMCSA Credentials (separate form — cannot nest) ── */}
      <FmcsaCredentialsCard />

    </div>
  );
}
