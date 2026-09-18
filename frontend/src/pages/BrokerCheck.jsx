// ── Broker Authority Checker ──────────────────────────────────────────────────
// Uses ONLY FMCSA public API data — zero SaferWatch / Truckstop.

import { useState } from 'react';

const BOND_REQUIRED = 75_000;

const s = {
  card:     { background: '#ffffff', border: '1px solid #e2e8f0', borderRadius: 10, padding: '20px 24px', marginBottom: 20, boxShadow: '0 1px 4px rgba(0,0,0,.05)' },
  cardHead: { fontSize: 12, fontWeight: 700, letterSpacing: '0.08em', color: '#374151', textTransform: 'uppercase', borderBottom: '1px solid #e2e8f0', paddingBottom: 10, marginBottom: 16 },
  label:    { display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 },
  input:    { width: '100%', padding: '8px 10px', border: '1.5px solid #cbd5e1', borderRadius: 6, fontSize: 13, fontFamily: 'inherit', boxSizing: 'border-box', color: '#0f172a', background: '#ffffff' },
  btn:      (disabled) => ({
    padding: '10px 22px', border: 'none', borderRadius: 7, fontWeight: 700, fontSize: 14,
    cursor: disabled ? 'not-allowed' : 'pointer', fontFamily: 'inherit',
    background: disabled ? '#e2e8f0' : '#f97316', color: disabled ? '#94a3b8' : '#fff',
    opacity: disabled ? 0.7 : 1,
    boxShadow: disabled ? 'none' : '0 2px 8px rgba(249,115,22,.25)',
  }),
  grid2:   { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px 24px' },
  grid3:   { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '16px 24px' },
  metaKey: { fontSize: 11, color: '#64748b', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 3 },
  metaVal: { fontSize: 14, color: '#0f172a', fontWeight: 500 },
  divider: { borderTop: '1px solid #e2e8f0', margin: '16px 0' },
};

function MetaCell({ label, value, mono }) {
  if (value === '' || value == null) return null;
  return (
    <div>
      <div style={s.metaKey}>{label}</div>
      <div style={{ ...s.metaVal, fontFamily: mono ? 'monospace' : 'inherit' }}>{value}</div>
    </div>
  );
}

function StatusBadge({ ok, label }) {
  return (
    <span style={{
      display: 'inline-block', padding: '3px 12px', borderRadius: 20, fontWeight: 700,
      fontSize: 12, background: ok ? '#16a34a' : '#dc2626', color: '#fff',
    }}>
      {label}
    </span>
  );
}

function CheckRow({ label, pass, detail }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', gap: 12, padding: '12px 0',
      borderBottom: '1px solid #e2e8f0',
    }}>
      <span style={{ fontSize: 16, lineHeight: 1, marginTop: 1 }}>{pass ? '✓' : '✗'}</span>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: pass ? '#166534' : '#991b1b' }}>{label}</div>
        {detail && <div style={{ fontSize: 12, color: '#64748b', marginTop: 2 }}>{detail}</div>}
      </div>
      <StatusBadge ok={pass} label={pass ? 'PASS' : 'FAIL'} />
    </div>
  );
}

export default function BrokerCheck() {
  const [mc,      setMc]      = useState('');
  const [loading, setLoading] = useState(false);
  const [err,     setErr]     = useState('');
  const [result,  setResult]  = useState(null);

  async function handleLookup(e) {
    e.preventDefault();
    const clean = mc.replace(/^MC/i, '').replace(/\D/g, '');
    if (!clean) { setErr('Enter a valid MC number.'); return; }
    setLoading(true); setErr(''); setResult(null);
    try {
      const r = await fetch(`/api/broker-check/${encodeURIComponent(clean)}`);
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? `HTTP ${r.status}`);
      setResult(d);
    } catch (e) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  }

  const broker = result?.broker;
  const bond   = result?.bond;
  const isPass = result?.verdict === 'PASS';

  const hasActiveBrokerAuth = broker?.brokerAuthorityStatus === 'Active';
  const hasBond             = bond?.meetsRequirement;

  const address = broker
    ? [broker.phyStreet, broker.phyCity, broker.phyState, broker.phyZipcode].filter(Boolean).join(', ')
    : '';

  return (
    <div>
      {/* ── Lookup ── */}
      <div style={s.card}>
        <div style={s.cardHead}>Broker MC Lookup</div>
        <p style={{ fontSize: 12, color: '#64748b', margin: '0 0 16px' }}>
          Verify a broker's operating authority and BMC-84 surety bond status.
          Data source: <strong style={{ color: '#374151' }}>FMCSA public API only.</strong>
        </p>
        <form onSubmit={handleLookup} style={{ display: 'flex', gap: 10, alignItems: 'flex-end' }}>
          <div style={{ flex: 1, maxWidth: 300 }}>
            <label style={s.label}>MC Number</label>
            <input
              style={s.input}
              placeholder="e.g. 1234567 or MC1234567"
              value={mc}
              onChange={e => { setMc(e.target.value); setErr(''); setResult(null); }}
            />
          </div>
          <button type="submit" style={s.btn(loading)} disabled={loading}>
            {loading ? 'Looking up…' : 'Check Broker'}
          </button>
        </form>
        {err && <p style={{ fontSize: 13, color: '#dc2626', marginTop: 10, marginBottom: 0 }}>{err}</p>}
      </div>

      {result && broker && (
        <>
          {/* ── Verdict Banner ── */}
          <div style={{
            background: isPass ? '#f0fdf4' : '#fef2f2',
            border: `2px solid ${isPass ? '#16a34a' : '#dc2626'}`,
            borderRadius: 10, padding: '20px 24px', marginBottom: 20,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
              <span style={{
                padding: '8px 22px', borderRadius: 20, fontWeight: 800, fontSize: 20,
                letterSpacing: '0.05em',
                background: isPass ? '#16a34a' : '#dc2626', color: '#fff',
              }}>
                {isPass ? '✓ PASS' : '✗ FAIL'}
              </span>
              <div>
                <div style={{ fontSize: 15, fontWeight: 700, color: isPass ? '#166534' : '#991b1b' }}>
                  {broker.legalName}
                </div>
                <div style={{ fontSize: 12, color: '#64748b', marginTop: 2 }}>
                  MC{broker.mcNumber} · DOT {broker.dotNumber}
                </div>
              </div>
            </div>
          </div>

          {/* ── Compliance Checklist ── */}
          <div style={s.card}>
            <div style={s.cardHead}>Compliance Checklist</div>
            <CheckRow
              label="Broker Operating Authority"
              pass={hasActiveBrokerAuth}
              detail={hasActiveBrokerAuth
                ? 'Active FMCSA broker authority on file'
                : `Authority status: ${broker.brokerAuthorityStatus} — must be Active`}
            />
            <CheckRow
              label="BMC-84 Surety Bond"
              pass={hasBond}
              detail={hasBond
                ? `$${bond.amount.toLocaleString()} on file — meets $${BOND_REQUIRED.toLocaleString()} federal requirement`
                : bond
                  ? `$${bond.amount.toLocaleString()} on file — below $${BOND_REQUIRED.toLocaleString()} requirement`
                  : 'No bond found in FMCSA records'}
            />
            <CheckRow
              label="Allowed to Operate"
              pass={broker.allowedToOperate === 'Y'}
              detail={broker.allowedToOperate === 'Y'
                ? 'FMCSA confirms entity is permitted to operate'
                : 'FMCSA has flagged this entity as not permitted to operate'}
            />
          </div>

          {/* ── Entity Details ── */}
          <div style={s.card}>
            <div style={s.cardHead}>Entity Details</div>
            <div style={s.grid3}>
              <MetaCell label="Legal Name"   value={broker.legalName} />
              <MetaCell label="DBA Name"     value={broker.dbaName} />
              <MetaCell label="MC Number"    value={`MC${broker.mcNumber}`} />
              <MetaCell label="DOT Number"   value={broker.dotNumber} mono />
              <MetaCell label="FMCSA Status" value={broker.statusCode === 'A' ? 'Active' : broker.statusCode} />
              <MetaCell label="Operation"    value={broker.carrierOperation} />
            </div>
            {address && (
              <>
                <div style={s.divider} />
                <MetaCell label="Physical Address" value={address} />
              </>
            )}
            {(broker.totalPowerUnits !== '' || broker.totalDrivers !== '') && (
              <>
                <div style={s.divider} />
                <div style={s.grid2}>
                  <MetaCell label="Power Units" value={broker.totalPowerUnits !== '' ? String(broker.totalPowerUnits) : null} />
                  <MetaCell label="Drivers"     value={broker.totalDrivers     !== '' ? String(broker.totalDrivers)    : null} />
                </div>
              </>
            )}
            {broker.mcs150Outdated === 'Y' && (
              <>
                <div style={s.divider} />
                <div style={{ fontSize: 12, color: '#f97316', fontWeight: 600 }}>
                  ⚠ MCS-150 filing is outdated
                </div>
              </>
            )}
          </div>

          {/* ── Bond Details ── */}
          <div style={s.card}>
            <div style={s.cardHead}>BMC-84 Surety Bond</div>
            {bond ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
                <span style={{
                  fontSize: 28, fontWeight: 800,
                  color: hasBond ? '#16a34a' : '#dc2626',
                }}>
                  ${bond.amount.toLocaleString()}
                </span>
                <div>
                  <StatusBadge ok={hasBond} label={hasBond ? `Meets $${BOND_REQUIRED.toLocaleString()} requirement` : `Below $${BOND_REQUIRED.toLocaleString()} requirement`} />
                  <div style={{ fontSize: 11, color: '#64748b', marginTop: 6 }}>
                    Bond amount per FMCSA carrier record · Full bond details (insurer, policy, expiry)
                    available on <a href="https://li-public.fmcsa.dot.gov" target="_blank" rel="noreferrer" style={{ color: '#2563eb' }}>FMCSA L&amp;I</a>
                  </div>
                </div>
              </div>
            ) : (
              <div>
                <div style={{ fontSize: 13, color: '#dc2626', fontWeight: 700, marginBottom: 8 }}>
                  No BMC-84 surety bond found in FMCSA records
                </div>
                <div style={{ fontSize: 12, color: '#64748b' }}>
                  Brokers must maintain a $75,000 surety bond (BMC-84) or trust fund (BMC-85)
                  under 49 CFR Part 387. Verify directly on{' '}
                  <a href="https://li-public.fmcsa.dot.gov" target="_blank" rel="noreferrer" style={{ color: '#2563eb' }}>FMCSA L&amp;I</a>.
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
