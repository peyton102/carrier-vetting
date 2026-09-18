import { useState } from 'react';

const s = {
  page:     { maxWidth: 900, margin: '0 auto', padding: '24px 20px' },
  h1:       { fontSize: 22, fontWeight: 800, color: '#0f172a', margin: '0 0 4px' },
  sub:      { fontSize: 13, color: '#64748b', marginBottom: 24 },
  card:     { background: '#ffffff', border: '1px solid #e2e8f0', borderRadius: 10, padding: '20px 24px', boxShadow: '0 1px 4px rgba(0,0,0,.05)' },
  cardHead: { fontSize: 12, fontWeight: 700, letterSpacing: '0.08em', color: '#374151', textTransform: 'uppercase', borderBottom: '1px solid #e2e8f0', paddingBottom: 10, marginBottom: 16 },
  btn:      { padding: '8px 18px', border: 'none', borderRadius: 7, fontWeight: 700, fontSize: 13, cursor: 'pointer', fontFamily: 'inherit', background: '#f97316', color: '#fff', boxShadow: '0 2px 8px rgba(249,115,22,.25)' },
  btnSm:    { padding: '4px 12px', border: 'none', borderRadius: 5, fontWeight: 600, fontSize: 12, cursor: 'pointer', fontFamily: 'inherit', background: '#f97316', color: '#fff' },
  table:    { width: '100%', borderCollapse: 'collapse', fontSize: 12 },
  th:       { textAlign: 'left', padding: '8px 10px', background: '#f8fafc', fontWeight: 700, color: '#374151', borderBottom: '1px solid #e2e8f0' },
  td:       { padding: '7px 10px', borderBottom: '1px solid #f1f5f9', color: '#374151' },
};

function verdictColor(v) {
  if (v === 'APPROVE')                return '#16a34a';
  if (v === 'APPROVED WITH OVERRIDE') return '#d97706';
  if (v === 'HOLD')                   return '#d97706';
  return '#dc2626';
}

export default function Certificates() {
  const [certs,   setCerts]   = useState(null);
  const [loading, setLoading] = useState(false);
  const [err,     setErr]     = useState('');

  async function load() {
    setLoading(true); setErr('');
    try {
      const res  = await fetch('/api/certificates');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Failed to load certificates');
      setCerts(data);
    } catch (e) { setErr(e.message); }
    finally { setLoading(false); }
  }

  return (
    <div style={s.page}>
      <h1 style={s.h1}>Certificates</h1>
      <p style={s.sub}>
        Immutable vetting certificates for your organization. Each PDF is stored exactly as
        it was generated — byte-for-byte identical to the version downloaded at vetting time.
      </p>

      <div style={s.card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <div style={s.cardHead}>Stored Certificates</div>
          <button style={s.btn} disabled={loading} onClick={load}>
            {loading ? 'Loading…' : certs ? 'Refresh' : 'Load Certificates'}
          </button>
        </div>

        {err && <p style={{ color: '#dc2626', fontSize: 13 }}>{err}</p>}

        {certs && (
          certs.length === 0
            ? <p style={{ fontSize: 13, color: '#64748b' }}>No certificates yet.</p>
            : (
              <div style={{ overflowX: 'auto' }}>
                <table style={s.table}>
                  <thead>
                    <tr>
                      {['Date', 'Carrier', 'DOT', 'MC', 'Verdict', 'PDF'].map(h => (
                        <th key={h} style={s.th}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {certs.map(c => (
                      <tr key={c.id}>
                        <td style={s.td}>
                          {new Date(c.created_at).toLocaleString('en-US', {
                            month: '2-digit', day: '2-digit', year: '2-digit',
                            hour: '2-digit', minute: '2-digit',
                          })}
                        </td>
                        <td style={s.td}>{c.carrier_name || '—'}</td>
                        <td style={s.td}>{c.dot_number   || '—'}</td>
                        <td style={s.td}>{c.mc_number    || '—'}</td>
                        <td style={s.td}>
                          <span style={{
                            background: verdictColor(c.verdict), color: '#fff',
                            borderRadius: 4, padding: '2px 8px', fontSize: 11, fontWeight: 700,
                          }}>
                            {c.verdict}
                          </span>
                        </td>
                        <td style={s.td}>
                          <a
                            href={`/api/certificates/${c.id}/download`}
                            target="_blank"
                            rel="noreferrer"
                            style={{ color: '#f97316', fontWeight: 600, fontSize: 12 }}
                          >
                            Download
                          </a>
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
