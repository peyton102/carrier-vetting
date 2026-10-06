import { useState, useEffect } from 'react';

const s = {
  page:    { maxWidth: 900, margin: '0 auto', padding: '24px 20px', fontFamily: 'inherit' },
  h1:      { fontSize: 22, fontWeight: 800, color: '#0f172a', margin: '0 0 4px' },
  sub:     { fontSize: 13, color: '#64748b', marginBottom: 24 },
  card:    { background: '#ffffff', border: '1px solid #e2e8f0', borderRadius: 10, padding: '20px 24px', boxShadow: '0 1px 4px rgba(0,0,0,.05)' },
  table:   { width: '100%', borderCollapse: 'collapse', fontSize: 13 },
  th:      { textAlign: 'left', padding: '9px 12px', background: '#f8fafc', fontWeight: 700, color: '#374151', borderBottom: '1px solid #e2e8f0' },
  td:      { padding: '9px 12px', borderBottom: '1px solid #f1f5f9', color: '#374151', verticalAlign: 'middle' },
  empty:   { fontSize: 13, color: '#64748b', textAlign: 'center', padding: '32px 0' },
};

function tierBadge(tier, verdict) {
  const color = tier === 'GREEN' ? '#16a34a' : tier === 'YELLOW' ? '#d97706' : '#64748b';
  return (
    <span style={{ background: color, color: '#fff', borderRadius: 4, padding: '2px 8px', fontSize: 11, fontWeight: 700 }}>
      {verdict ?? tier ?? '—'}
    </span>
  );
}

function fmt(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('en-US', {
    month: '2-digit', day: '2-digit', year: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
}

export default function UsedCarriers() {
  const [rows,    setRows]    = useState(null);
  const [loading, setLoading] = useState(true);
  const [err,     setErr]     = useState('');

  useEffect(() => {
    fetch('/api/vetting/used-carriers')
      .then(r => r.json())
      .then(data => { setRows(data); setLoading(false); })
      .catch(e  => { setErr(e.message); setLoading(false); });
  }, []);

  async function refresh() {
    setLoading(true); setErr('');
    try {
      const r = await fetch('/api/vetting/used-carriers');
      setRows(await r.json());
    } catch (e) { setErr(e.message); }
    finally { setLoading(false); }
  }

  return (
    <div style={s.page}>
      <h1 style={s.h1}>Used Carriers</h1>
      <p style={s.sub}>
        Every carrier marked as used after a vetting run — sorted newest first.
      </p>

      <div style={s.card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <span style={{ fontSize: 13, color: '#64748b' }}>
            {rows ? `${rows.length} carrier${rows.length !== 1 ? 's' : ''}` : ''}
          </span>
          <button
            onClick={refresh}
            disabled={loading}
            style={{
              padding: '7px 18px', border: 'none', borderRadius: 7, fontWeight: 700,
              fontSize: 13, cursor: loading ? 'not-allowed' : 'pointer', fontFamily: 'inherit',
              background: loading ? '#e2e8f0' : '#f97316', color: loading ? '#94a3b8' : '#fff',
              opacity: loading ? 0.7 : 1,
            }}
          >
            {loading ? 'Loading…' : 'Refresh'}
          </button>
        </div>

        {err && <p style={{ color: '#dc2626', fontSize: 13 }}>{err}</p>}

        {!loading && rows && (
          rows.length === 0
            ? <p style={s.empty}>No carriers marked as used yet.</p>
            : (
              <div style={{ overflowX: 'auto' }}>
                <table style={s.table}>
                  <thead>
                    <tr>
                      {['Date Used', 'Carrier', 'DOT', 'MC', 'Load Ref', 'Dispatcher', 'Verdict'].map(h => (
                        <th key={h} style={s.th}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(row => (
                      <tr key={row.id}>
                        <td style={{ ...s.td, whiteSpace: 'nowrap', fontWeight: 600, color: '#0f172a' }}>
                          {fmt(row.used_at)}
                        </td>
                        <td style={{ ...s.td, fontWeight: 600, color: '#1e3a5f' }}>
                          {row.carrier_name || '—'}
                        </td>
                        <td style={s.td}>{row.dot_number || '—'}</td>
                        <td style={s.td}>{row.mc_number  || '—'}</td>
                        <td style={s.td}>{row.load_ref   || '—'}</td>
                        <td style={s.td}>{row.dispatcher || '—'}</td>
                        <td style={s.td}>{tierBadge(row.tier, row.verdict)}</td>
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
