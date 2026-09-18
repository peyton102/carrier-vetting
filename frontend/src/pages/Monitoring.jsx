import { useState, useEffect, useCallback } from 'react';

const STATUS_LABEL = {
  pending:       { text: 'Pending first check', color: '#64748b',  bg: '#f8fafc' },
  ok:            { text: 'OK',                  color: '#16a34a',  bg: '#f0fdf4' },
  alert:         { text: 'ALERT',               color: '#dc2626',  bg: '#fef2f2' },
  cannot_verify: { text: 'CANNOT VERIFY',       color: '#d97706',  bg: '#fffbeb' },
  delivered:     { text: 'Delivered',            color: '#64748b',  bg: '#f1f5f9' },
};

function StatusBadge({ status }) {
  const s = STATUS_LABEL[status] || STATUS_LABEL.pending;
  return (
    <span style={{
      display: 'inline-block', padding: '2px 10px', borderRadius: 20, fontSize: 11,
      fontWeight: 700, color: s.color, background: s.bg, border: `1px solid ${s.color}33`,
    }}>
      {s.text}
    </span>
  );
}

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-US', {
    month: '2-digit', day: '2-digit', year: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
}

const s = {
  page:  { maxWidth: 960, margin: '0 auto', padding: '24px 20px' },
  h1:    { fontSize: 22, fontWeight: 800, color: '#0f172a', margin: '0 0 4px' },
  sub:   { fontSize: 13, color: '#64748b', marginBottom: 24 },
  card:  { background: '#ffffff', border: '1px solid #e2e8f0', borderRadius: 10, padding: '20px 24px', marginBottom: 20, boxShadow: '0 1px 4px rgba(0,0,0,.05)' },
  head:  { fontSize: 12, fontWeight: 700, letterSpacing: '0.08em', color: '#374151', textTransform: 'uppercase', borderBottom: '1px solid #e2e8f0', paddingBottom: 10, marginBottom: 16 },
  th:    { textAlign: 'left', padding: '8px 10px', background: '#f8fafc', fontWeight: 700, color: '#374151', borderBottom: '1px solid #e2e8f0', fontSize: 12 },
  td:    { padding: '8px 10px', borderBottom: '1px solid #f1f5f9', color: '#374151', fontSize: 12 },
  btn:   (color, disabled) => ({
    padding: '4px 12px', border: 'none', borderRadius: 6,
    fontWeight: 700, fontSize: 11, cursor: disabled ? 'not-allowed' : 'pointer',
    fontFamily: 'inherit',
    background: disabled ? '#e2e8f0'
      : color === 'red'    ? '#dc2626'
      : color === 'green'  ? '#16a34a'
      : color === 'orange' ? '#d97706'
      : '#3b82f6',
    color: disabled ? '#94a3b8' : '#fff',
    opacity: disabled ? 0.7 : 1,
  }),
  alertCard: {
    background: '#fef2f2', border: '2px solid #dc2626', borderRadius: 10,
    padding: '16px 20px', marginBottom: 12,
  },
  cannotCard: {
    background: '#fffbeb', border: '2px solid #d97706', borderRadius: 10,
    padding: '16px 20px', marginBottom: 12,
  },
};

export default function Monitoring() {
  const [loads,    setLoads]    = useState([]);
  const [alerts,   setAlerts]   = useState([]);
  const [loading,  setLoading]  = useState(true);
  const [checking, setChecking] = useState(false);
  const [err,      setErr]      = useState('');

  const load = useCallback(async () => {
    try {
      const [loadsRes, alertsRes] = await Promise.all([
        fetch('/api/monitoring/active'),
        fetch('/api/monitoring/alerts'),
      ]);
      if (!loadsRes.ok || !alertsRes.ok) throw new Error('Failed to load monitoring data');
      setLoads(await loadsRes.json());
      setAlerts(await alertsRes.json());
    } catch (e) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function deliver(id) {
    if (!confirm('Mark this load as delivered? Monitoring will stop.')) return;
    try {
      const res = await fetch(`/api/monitoring/${id}/deliver`, { method: 'POST' });
      if (!res.ok) throw new Error((await res.json()).error);
      load();
    } catch (e) { alert(e.message); }
  }

  async function ack(alertId) {
    try {
      const res = await fetch(`/api/monitoring/alerts/${alertId}/ack`, { method: 'POST' });
      if (!res.ok) throw new Error((await res.json()).error);
      setAlerts(a => a.filter(x => x.id !== alertId));
    } catch (e) { alert(e.message); }
  }

  async function checkNow() {
    setChecking(true);
    try {
      const res = await fetch('/api/monitoring/check-now', { method: 'POST' });
      if (!res.ok) throw new Error((await res.json()).error);
      await load();
    } catch (e) { alert(e.message); }
    finally { setChecking(false); }
  }

  if (loading) return <div style={s.page}><p style={{ color: '#64748b' }}>Loading…</p></div>;

  return (
    <div style={s.page}>
      <h1 style={s.h1}>Carrier Monitoring</h1>
      <p style={s.sub}>
        Active loads are re-checked every {' '}
        <strong style={{ color: '#94a3b8' }}>{process.env.MONITOR_INTERVAL_HOURS || 4} hours</strong>
        {' '}via FMCSA + SaferWatch. Any status change triggers an email alert.
      </p>

      {/* ── Unacknowledged alerts ── */}
      {alerts.length > 0 && (
        <div style={{ marginBottom: 24 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#f87171', marginBottom: 10 }}>
            {alerts.length} unacknowledged alert{alerts.length > 1 ? 's' : ''}
          </div>
          {alerts.map(a => (
            <div key={a.id} style={a.alert_type === 'cannot_verify' ? s.cannotCard : s.alertCard}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
                <div>
                  <div style={{ fontWeight: 700, fontSize: 13, color: a.alert_type === 'cannot_verify' ? '#fbbf24' : '#f87171', marginBottom: 4 }}>
                    {a.alert_type === 'cannot_verify' ? 'CANNOT VERIFY' : 'STATUS ALERT'} — {a.carrier_name || a.dot_number} (Load {a.load_ref})
                  </div>
                  <div style={{ fontSize: 12, color: '#64748b', marginBottom: 4 }}>
                    DOT {a.dot_number} &nbsp;|&nbsp; {fmtDate(a.created_at)}
                  </div>
                  <ul style={{ margin: '6px 0 0 16px', padding: 0, fontSize: 12, color: '#94a3b8' }}>
                    {(a.issues || []).map((issue, i) => <li key={i}>{issue}</li>)}
                  </ul>
                </div>
                <button style={s.btn('green', false)} onClick={() => ack(a.id)}>
                  Acknowledge
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── Active loads table ── */}
      <div style={s.card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
          <div style={s.head}>Active Monitored Loads</div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button style={s.btn('blue', false)} onClick={load}>Refresh</button>
            <button style={s.btn('orange', checking)} disabled={checking} onClick={checkNow}>
              {checking ? 'Checking…' : 'Check All Now'}
            </button>
          </div>
        </div>

        {err && <p style={{ color: '#f87171', fontSize: 13 }}>{err}</p>}

        {loads.length === 0 ? (
          <p style={{ fontSize: 13, color: '#64748b' }}>
            No loads currently being monitored. Use the <strong style={{ color: '#94a3b8' }}>▶ Monitor</strong> button
            in the Vetting Audit Log after booking an approved carrier.
          </p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  {['Load Ref', 'Carrier', 'DOT', 'Status', 'Last Checked', 'Started By', ''].map(h => (
                    <th key={h} style={s.th}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {loads.map(row => (
                  <tr key={row.id}>
                    <td style={s.td}><strong style={{ color: '#e2e8f0' }}>{row.load_ref}</strong></td>
                    <td style={s.td}>{row.carrier_name || '—'}</td>
                    <td style={s.td}>{row.dot_number}</td>
                    <td style={s.td}>
                      <StatusBadge status={row.last_status} />
                      {row.last_issues?.length > 0 && (
                        <div style={{ fontSize: 11, color: '#64748b', marginTop: 4, maxWidth: 220 }}>
                          {row.last_issues[0]}
                        </div>
                      )}
                    </td>
                    <td style={s.td}>{fmtDate(row.last_checked_at)}</td>
                    <td style={s.td}>{row.started_by || '—'}</td>
                    <td style={s.td}>
                      <button style={s.btn('green', false)} onClick={() => deliver(row.id)}>
                        Mark Delivered
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
