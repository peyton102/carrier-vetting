// ── Broker Authority Checker ──────────────────────────────────────────────────
// Uses ONLY FMCSA public API data — zero SaferWatch / Truckstop.
// Checks broker operating authority and BMC-84 surety bond ($75k requirement).

import { useState } from 'react';

const BOND_REQUIRED = 75_000;

const s = {
  card:     { background: '#0f1729', border: '1px solid #1e2d45', borderRadius: 10, padding: '20px 24px', marginBottom: 20 },
  cardHead: { fontSize: 12, fontWeight: 700, letterSpacing: '0.08em', color: '#475569', textTransform: 'uppercase', borderBottom: '1px solid #1e2d45', paddingBottom: 10, marginBottom: 16 },
  label:    { display: 'block', fontSize: 12, fontWeight: 600, color: '#64748b', marginBottom: 4 },
  input:    { width: '100%', padding: '8px 10px', border: '1.5px solid #1e2d45', borderRadius: 6, fontSize: 13, fontFamily: 'inherit', boxSizing: 'border-box', color: '#e2e8f0', background: '#0a1220' },
  btn:      (disabled) => ({
    padding: '10px 22px', border: 'none', borderRadius: 7, fontWeight: 700, fontSize: 14,
    cursor: disabled ? 'not-allowed' : 'pointer', fontFamily: 'inherit',
    background: disabled ? '#243044' : '#f97316', color: disabled ? '#64748b' : '#fff',
    opacity: disabled ? 0.6 : 1,
    boxShadow: disabled ? 'none' : '0 2px 8px rgba(249,115,22,.25)',
  }),
  row2:     { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px 20px' },
  metaKey:  { fontSize: 11, color: '#475569', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' },
  metaVal:  { fontSize: 14, color: '#e2e8f0', marginTop: 2 },
  dataGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '14px 20px', marginBottom: 0 },
};

function MetaCell({ label, value }) {
  return (
    <div>
      <div style={s.metaKey}>{label}</div>
      <div style={s.metaVal}>{value || '—'}</div>
    </div>
  );
}

function VerdictBanner({ verdict, reasons }) {
  const isPass = verdict === 'PASS';
  const bg     = isPass ? '#0a1f0e' : '#1a0808';
  const border = isPass ? '#16a34a' : '#dc2626';
  const badge  = isPass ? '#16a34a' : '#dc2626';

  return (
    <div style={{ background: bg, border: `2px solid ${border}`, borderRadius: 10, padding: '20px 24px', marginBottom: 20 }}>
      <span style={{
        display: 'inline-block', padding: '6px 18px', borderRadius: 20, fontWeight: 800,
        fontSize: 18, letterSpacing: '0.05em', background: badge, color: '#fff', marginBottom: 14,
      }}>
        {isPass ? '✓ PASS' : '✗ FAIL'}
      </span>
      <div style={{ fontSize: 13, color: isPass ? '#4ade80' : '#f87171', fontWeight: 600, marginBottom: isPass ? 0 : 12 }}>
        {isPass
          ? 'Broker has active authority and a compliant BMC-84 surety bond.'
          : 'This broker does not meet all requirements.'}
      </div>
      {!isPass && reasons?.length > 0 && (
        <ul style={{ margin: 0, paddingLeft: 18 }}>
          {reasons.map((r, i) => (
            <li key={i} style={{ fontSize: 13, color: '#f87171', marginBottom: 4 }}>{r}</li>
          ))}
        </ul>
      )}
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

  const bondColor = !bond             ? '#f87171'
                  : bond.meetsRequirement ? '#4ade80'
                  : '#f87171';

  return (
    <div>
      {/* ── Lookup ── */}
      <div style={s.card}>
        <div style={s.cardHead}>Broker MC Lookup</div>
        <p style={{ fontSize: 12, color: '#475569', margin: '0 0 14px' }}>
          Enter the broker's MC number to verify operating authority and BMC-84 surety bond status.
          Data source: <strong style={{ color: '#64748b' }}>FMCSA public API only.</strong>
        </p>
        <form onSubmit={handleLookup} style={{ display: 'flex', gap: 10, alignItems: 'flex-end' }}>
          <div style={{ flex: 1, maxWidth: 300 }}>
            <label style={s.label}>MC Number</label>
            <input
              style={s.input}
              placeholder="e.g. 1234567"
              value={mc}
              onChange={e => { setMc(e.target.value); setErr(''); setResult(null); }}
            />
          </div>
          <button type="submit" style={s.btn(loading)} disabled={loading}>
            {loading ? 'Looking up…' : 'Check Broker'}
          </button>
        </form>
        {err && <p style={{ fontSize: 13, color: '#f87171', marginTop: 10, marginBottom: 0 }}>{err}</p>}
      </div>

      {result && (
        <>
          {/* ── Verdict ── */}
          <VerdictBanner verdict={result.verdict} reasons={result.reasons} />

          {/* ── Entity Info ── */}
          <div style={s.card}>
            <div style={s.cardHead}>Entity Information</div>
            <div style={s.dataGrid}>
              <MetaCell label="Legal Name"   value={broker.legalName} />
              <MetaCell label="DBA"          value={broker.dbaName} />
              <MetaCell label="MC Number"    value={broker.mcNumber ? `MC${broker.mcNumber}` : '—'} />
              <MetaCell label="DOT Number"   value={broker.dotNumber} />
              <MetaCell label="Location"     value={[broker.phyCity, broker.phyState].filter(Boolean).join(', ')} />
              <MetaCell label="Allowed to Operate" value={broker.allowedToOperate === 'Y' ? 'Yes' : broker.allowedToOperate === 'N' ? 'No' : '—'} />
            </div>
          </div>

          {/* ── Authority ── */}
          <div style={s.card}>
            <div style={s.cardHead}>Broker Authority</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6 }}>
              <span style={{
                padding: '4px 14px', borderRadius: 20, fontWeight: 700, fontSize: 13,
                background: broker.brokerAuthorityStatus === 'Active' ? '#16a34a' : '#dc2626',
                color: '#fff',
              }}>
                {broker.brokerAuthorityStatus}
              </span>
              <span style={{ fontSize: 13, color: '#64748b' }}>
                FMCSA broker operating authority
              </span>
            </div>
            <p style={{ fontSize: 12, color: '#475569', margin: 0 }}>
              Brokers must hold active FMCSA broker authority to legally arrange transportation for
              compensation. Carriers found operating as unlicensed brokers are subject to civil
              penalties under 49 U.S.C. § 13901.
            </p>
          </div>

          {/* ── Bond ── */}
          <div style={s.card}>
            <div style={s.cardHead}>BMC-84 Surety Bond</div>
            {bond ? (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
                  <span style={{
                    padding: '4px 14px', borderRadius: 20, fontWeight: 700, fontSize: 13,
                    background: bond.meetsRequirement ? '#16a34a' : '#dc2626', color: '#fff',
                  }}>
                    ${bond.amount.toLocaleString()}
                  </span>
                  <span style={{ fontSize: 13, color: bondColor, fontWeight: 600 }}>
                    {bond.meetsRequirement
                      ? `Meets $${BOND_REQUIRED.toLocaleString()} requirement`
                      : `Below required $${BOND_REQUIRED.toLocaleString()}`}
                  </span>
                </div>
                <div style={s.row2}>
                  <MetaCell label="Bond Type"       value={bond.typeDesc} />
                  <MetaCell label="Surety Company"  value={bond.insurer} />
                  <MetaCell label="Policy Number"   value={bond.policyNumber} />
                  <MetaCell label="Effective Date"  value={bond.effectiveDate} />
                  <MetaCell label="Expiration Date" value={bond.expirationDate} />
                </div>
              </>
            ) : (
              <div style={{ fontSize: 13, color: '#f87171', fontWeight: 600 }}>
                No BMC-84 surety bond found in FMCSA records.
                <p style={{ fontSize: 12, color: '#475569', fontWeight: 400, marginTop: 8, marginBottom: 0 }}>
                  Brokers are required to maintain a $75,000 surety bond (BMC-84) or trust fund
                  (BMC-85) under 49 CFR Part 387. Operating without a valid bond is a federal
                  violation.
                </p>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
