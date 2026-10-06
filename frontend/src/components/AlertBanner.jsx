import { useState, useEffect, useRef } from 'react';

const POLL_MS = 60_000; // 60 seconds

export default function AlertBanner() {
  const [alerts,    setAlerts]    = useState([]);
  const [dismissed, setDismissed] = useState(new Set());
  const intervalRef = useRef(null);

  async function fetchAlerts() {
    try {
      const res = await fetch('/api/monitoring/alerts');
      if (!res.ok) return;
      const data = await res.json();
      setAlerts(data);
    } catch (_) {}
  }

  useEffect(() => {
    fetchAlerts();
    intervalRef.current = setInterval(fetchAlerts, POLL_MS);
    return () => clearInterval(intervalRef.current);
  }, []);

  async function ack(id) {
    try {
      await fetch(`/api/monitoring/alerts/${id}/ack`, { method: 'POST' });
    } catch (_) {}
    setAlerts(a => a.filter(x => x.id !== id));
    setDismissed(d => new Set([...d, id]));
  }

  const visible = alerts.filter(a => !dismissed.has(a.id));
  if (visible.length === 0) return null;

  return (
    <div style={{
      position: 'fixed', top: 0, left: 0, right: 0, zIndex: 1000,
      display: 'flex', flexDirection: 'column', gap: 0,
      pointerEvents: 'none',
    }}>
      {visible.map(a => (
        <div key={a.id} style={{
          background: a.alert_type === 'cannot_verify' ? '#fffbeb' : '#fef2f2',
          borderBottom: `2px solid ${a.alert_type === 'cannot_verify' ? '#d97706' : '#dc2626'}`,
          padding: '10px 20px',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16,
          pointerEvents: 'auto',
          fontSize: 13,
        }}>
          <span style={{ fontWeight: 700, color: a.alert_type === 'cannot_verify' ? '#92400e' : '#991b1b', marginRight: 8 }}>
            {a.alert_type === 'cannot_verify' ? '⚠ CANNOT VERIFY' : '⚠ MONITORING ALERT'}
          </span>
          <span style={{ color: '#374151', flex: 1 }}>
            {a.carrier_name || a.dot_number} — Load {a.load_ref}
            {a.issues?.length > 0 && `: ${a.issues[0]}`}
          </span>
          <span style={{ fontSize: 12, color: '#64748b', whiteSpace: 'nowrap' }}>
            Go to <strong>Monitoring</strong> for details
          </span>
          <button
            onClick={() => ack(a.id)}
            style={{
              padding: '3px 10px', border: 'none', borderRadius: 5, cursor: 'pointer',
              fontFamily: 'inherit', fontWeight: 700, fontSize: 12,
              background: a.alert_type === 'cannot_verify' ? '#d97706' : '#dc2626',
              color: '#fff',
            }}
          >
            Dismiss
          </button>
        </div>
      ))}
    </div>
  );
}
