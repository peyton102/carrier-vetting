import { useState, useEffect } from 'react';

const s = {
  page:     { maxWidth: 900, margin: '0 auto', padding: '24px 20px' },
  h1:       { fontSize: 22, fontWeight: 800, color: '#1e3a5f', margin: '0 0 4px' },
  sub:      { fontSize: 13, color: '#6b7280', marginBottom: 24, lineHeight: 1.6 },
  card:     { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: '20px 24px', marginBottom: 20 },
  cardHead: { fontSize: 12, fontWeight: 700, letterSpacing: '0.08em', color: '#1e3a5f', textTransform: 'uppercase', borderBottom: '1px solid #e5e7eb', paddingBottom: 10, marginBottom: 16 },
  label:    { display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 },
  input:    { width: '100%', padding: '8px 10px', border: '1.5px solid #d1d5db', borderRadius: 6, fontSize: 13, fontFamily: 'inherit', boxSizing: 'border-box', color: '#111827', background: '#fff' },
  select:   { width: '100%', padding: '8px 10px', border: '1.5px solid #d1d5db', borderRadius: 6, fontSize: 13, fontFamily: 'inherit', boxSizing: 'border-box', color: '#111827', background: '#fff' },
  checkRow: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#374151', cursor: 'pointer', marginBottom: 10 },
  btnRow:   { display: 'flex', gap: 12, marginTop: 8, alignItems: 'center', flexWrap: 'wrap' },
  btn:      (disabled) => ({
    padding: '10px 22px', border: 'none', borderRadius: 7, fontWeight: 700, fontSize: 14,
    cursor: disabled ? 'not-allowed' : 'pointer', fontFamily: 'inherit',
    background: disabled ? '#d1d5db' : '#1e3a5f', color: '#fff',
    opacity: disabled ? 0.7 : 1,
  }),
  notice: { background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 8, padding: '12px 16px', fontSize: 12, color: '#1e40af', marginBottom: 20 },
};

// Definition of the 6 BASICs with their field keys and display names
const BASICS = [
  { key: 'basicUnsafeDriving',       label: 'Unsafe Driving'               },
  { key: 'basicCrashIndicator',      label: 'Crash Indicator'              },
  { key: 'basicHos',                 label: 'Hours of Service'             },
  { key: 'basicVehicleMaintenance',  label: 'Vehicle Maintenance'          },
  { key: 'basicDriverFitness',       label: 'Driver Fitness'               },
  { key: 'basicControlledSubstance', label: 'Controlled Substances/Alcohol'},
];

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
          <p style={{ fontSize: 12, color: '#6b7280', marginBottom: 16, marginTop: 0 }}>
            For each BASIC, set the percentile threshold that triggers a flag, and choose whether
            exceeding it causes a hard <strong>Reject</strong> (no override) or a <strong>Hold</strong> (manager override allowed).
          </p>

          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr>
                  <th style={{ textAlign: 'left', padding: '6px 10px', background: '#f3f4f6', fontWeight: 700, color: '#374151', borderBottom: '1px solid #e5e7eb', width: '40%' }}>BASIC</th>
                  <th style={{ textAlign: 'left', padding: '6px 10px', background: '#f3f4f6', fontWeight: 700, color: '#374151', borderBottom: '1px solid #e5e7eb', width: '30%' }}>Alert threshold (%)</th>
                  <th style={{ textAlign: 'left', padding: '6px 10px', background: '#f3f4f6', fontWeight: 700, color: '#374151', borderBottom: '1px solid #e5e7eb', width: '30%' }}>Action when exceeded</th>
                </tr>
              </thead>
              <tbody>
                {BASICS.map(({ key, label }) => (
                  <tr key={key}>
                    <td style={{ padding: '8px 10px', borderBottom: '1px solid #f3f4f6', fontWeight: 600, color: '#374151' }}>{label}</td>
                    <td style={{ padding: '8px 10px', borderBottom: '1px solid #f3f4f6' }}>
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
                    <td style={{ padding: '8px 10px', borderBottom: '1px solid #f3f4f6' }}>
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
              <p style={{ fontSize: 11, color: '#6b7280', margin: '4px 0 0' }}>
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
              <p style={{ fontSize: 11, color: '#6b7280', margin: '4px 0 0' }}>
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
          <p style={{ fontSize: 12, color: '#6b7280', marginTop: 0, marginBottom: 14 }}>
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
          <div style={s.cardHead}>Out-of-Service Rate</div>
          <div style={{ maxWidth: 320 }}>
            <label style={s.label}>Flag when carrier OOS rate exceeds national average by</label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input
                type="number" min={1} step={0.5}
                value={form.oosRateMultiplier ?? ''}
                onChange={e => set('oosRateMultiplier', parseFloat(e.target.value))}
                style={{ ...s.input, width: 80 }}
              />
              <span style={{ fontSize: 13, color: '#374151' }}>× the national average</span>
            </div>
            <p style={{ fontSize: 11, color: '#6b7280', margin: '6px 0 0' }}>
              e.g., 2 = flag if carrier OOS% ≥ 2× national average. Applied to both Truck OOS and Driver OOS.
            </p>
          </div>
        </div>

        {/* ── Save ── */}
        <div style={s.btnRow}>
          <button type="submit" style={s.btn(saving)} disabled={saving}>
            {saving ? 'Saving…' : 'Save Settings'}
          </button>
          {saved && (
            <span style={{ fontSize: 13, color: '#16a34a', fontWeight: 600 }}>
              ✓ Settings saved — active on next vetting run
            </span>
          )}
          {err && (
            <span style={{ fontSize: 13, color: '#dc2626' }}>{err}</span>
          )}
        </div>

      </form>
    </div>
  );
}
