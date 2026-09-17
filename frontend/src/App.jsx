import { useState, useEffect } from 'react';
import { Routes, Route, Navigate, NavLink } from 'react-router-dom';
import CarrierVetting from './pages/CarrierVetting.jsx';
import Certificates   from './pages/Certificates.jsx';
import Settings       from './pages/Settings.jsx';
import Admin          from './pages/Admin.jsx';
import Activate       from './pages/Activate.jsx';
import Monitoring     from './pages/Monitoring.jsx';

function LoginScreen({ onLogin }) {
  const [email,    setEmail]    = useState('');
  const [password, setPassword] = useState('');
  const [error,    setError]    = useState('');
  const [loading,  setLoading]  = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError(''); setLoading(true);
    try {
      const res  = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (res.ok) {
        onLogin({ email: data.email, name: data.name, tenant: data.tenant, isAdmin: data.isAdmin });
      } else {
        setError(data.error || 'Invalid email or password');
      }
    } catch { setError('Could not connect'); }
    finally { setLoading(false); }
  }

  const inputStyle = {
    width: '100%', padding: '10px 14px',
    border: '1.5px solid #1e2d45', borderRadius: 8, fontSize: 15, marginBottom: 14,
    fontFamily: 'inherit', boxSizing: 'border-box',
    background: '#0a1220', color: '#e2e8f0',
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', background: '#080e1a' }}>
      <div style={{ background: '#0f1729', borderRadius: 14, border: '1px solid #1e2d45', boxShadow: '0 8px 32px rgba(0,0,0,.4)', padding: '40px 36px', width: 340 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#22c55e', boxShadow: '0 0 8px #22c55e', display: 'inline-block' }} />
          <span style={{ fontWeight: 800, fontSize: 20, color: '#f1f5f9' }}>Carrier Vetting</span>
        </div>
        <div style={{ color: '#64748b', fontSize: 13, marginBottom: 28 }}>Sign in to your account</div>
        <form onSubmit={handleSubmit}>
          <input
            type="email" value={email} onChange={e => setEmail(e.target.value)}
            placeholder="Email address" autoFocus autoComplete="email" style={inputStyle}
          />
          <input
            type="password" value={password} onChange={e => setPassword(e.target.value)}
            placeholder="Password" autoComplete="current-password" style={inputStyle}
          />
          {error && <div style={{ color: '#f87171', fontSize: 13, marginBottom: 12 }}>{error}</div>}
          <button
            type="submit" disabled={loading || !email || !password}
            style={{
              width: '100%', padding: '10px',
              background: loading || !email || !password ? '#243044' : '#f97316',
              color: '#fff', border: 'none', borderRadius: 8, fontWeight: 700, fontSize: 14,
              cursor: loading || !email || !password ? 'not-allowed' : 'pointer',
              opacity: loading || !email || !password ? 0.6 : 1,
              boxShadow: loading || !email || !password ? 'none' : '0 2px 8px rgba(249,115,22,.3)',
            }}
          >
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  );
}

export default function App() {
  const [user,     setUser]     = useState(null);
  const [ready,    setReady]    = useState(false);
  const [settings, setSettings] = useState(null);

  useEffect(() => {
    fetch('/api/me')
      .then(r => r.ok ? r.json() : null)
      .then(data => { setUser(data || false); setReady(true); })
      .catch(() => { setUser(false); setReady(true); });
  }, []);

  // Load settings whenever a user session is established
  useEffect(() => {
    if (!user) return;
    fetch('/api/settings')
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (data) setSettings(data); })
      .catch(() => {});
  }, [user]);

  async function handleLogout() {
    await fetch('/api/logout', { method: 'POST' });
    setUser(false);
    setSettings(null);
  }

  if (!ready) return null;

  // /activate is public — render before the auth gate
  if (!user) {
    return (
      <Routes>
        <Route path="/activate" element={<Activate onActivate={data => { setUser(data); }} />} />
        <Route path="*" element={<LoginScreen onLogin={setUser} />} />
      </Routes>
    );
  }

  const navLink = (to, label) => (
    <NavLink to={to} style={{ textDecoration: 'none' }}>
      {label}
    </NavLink>
  );

  return (
    <div className="app">
      <nav>
        <span className="brand">{user.name || 'Carrier Vetting'}</span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 20, marginLeft: 24 }}>
          {navLink('/vetting',      'Vetting')}
          {navLink('/monitoring',   'Monitoring')}
          {navLink('/certificates', 'Certificates')}
          {navLink('/settings',     'Settings')}
          {user.isAdmin && navLink('/admin', 'Admin')}
        </span>
        <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 16 }}>
          <span style={{ fontSize: 13, color: '#475569' }}>{user.email}</span>
          <button
            onClick={handleLogout}
            style={{
              padding: '5px 14px', border: '1px solid #1e2d45', borderRadius: 6,
              background: '#0f1729', fontSize: 13, cursor: 'pointer', color: '#64748b',
              fontFamily: 'inherit', fontWeight: 500,
            }}
          >
            Sign out
          </button>
        </span>
      </nav>
      <main className="content">
        <Routes>
          <Route path="/" element={<Navigate to="/vetting" replace />} />
          <Route path="/vetting"      element={<CarrierVetting settings={settings} />} />
          <Route path="/monitoring"   element={<Monitoring />} />
          <Route path="/certificates" element={<Certificates />} />
          <Route path="/settings"     element={<Settings settings={settings} onSave={setSettings} />} />
          <Route path="/admin"        element={user.isAdmin ? <Admin /> : <Navigate to="/vetting" replace />} />
        </Routes>
      </main>
    </div>
  );
}
