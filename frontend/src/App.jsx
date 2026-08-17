import { useState, useEffect } from 'react';
import { Routes, Route, Navigate, NavLink } from 'react-router-dom';
import CarrierVetting from './pages/CarrierVetting.jsx';
import Certificates   from './pages/Certificates.jsx';
import Settings       from './pages/Settings.jsx';

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
        onLogin({ email: data.email, name: data.name, tenant: data.tenant });
      } else {
        setError(data.error || 'Invalid email or password');
      }
    } catch { setError('Could not connect'); }
    finally { setLoading(false); }
  }

  const inputStyle = {
    width: '100%', padding: '10px 14px', border: '1.5px solid #d1d5db',
    borderRadius: 8, fontSize: 15, marginBottom: 14, fontFamily: 'inherit', boxSizing: 'border-box',
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', background: '#f0f4f8' }}>
      <div style={{ background: '#fff', borderRadius: 14, border: '1px solid #e5e7eb', boxShadow: '0 2px 12px rgba(0,0,0,.08)', padding: '40px 36px', width: 340 }}>
        <div style={{ fontWeight: 800, fontSize: 20, color: '#1e3a5f', marginBottom: 4 }}>Carrier Vetting</div>
        <div style={{ color: '#6b7280', fontSize: 13, marginBottom: 28 }}>Sign in to your account</div>
        <form onSubmit={handleSubmit}>
          <input
            type="email" value={email} onChange={e => setEmail(e.target.value)}
            placeholder="Email address" autoFocus autoComplete="email" style={inputStyle}
          />
          <input
            type="password" value={password} onChange={e => setPassword(e.target.value)}
            placeholder="Password" autoComplete="current-password" style={inputStyle}
          />
          {error && <div style={{ color: '#dc2626', fontSize: 13, marginBottom: 12 }}>{error}</div>}
          <button
            type="submit" disabled={loading || !email || !password}
            style={{
              width: '100%', padding: '10px', background: '#1e3a5f', color: '#fff',
              border: 'none', borderRadius: 8, fontWeight: 600, fontSize: 14, cursor: 'pointer',
              opacity: loading || !email || !password ? 0.5 : 1,
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
  if (!user)  return <LoginScreen onLogin={setUser} />;

  const navLink = (to, label) => (
    <NavLink
      to={to}
      style={({ isActive }) => ({
        fontSize: 13, fontWeight: 600, textDecoration: 'none',
        color: isActive ? '#1e3a5f' : '#6b7280',
      })}
    >
      {label}
    </NavLink>
  );

  return (
    <div className="app">
      <nav>
        <span className="brand">{user.name || 'Carrier Vetting'}</span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 20, marginLeft: 24 }}>
          {navLink('/vetting',      'Vetting')}
          {navLink('/certificates', 'Certificates')}
          {navLink('/settings',     'Settings')}
        </span>
        <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 16 }}>
          <span style={{ fontSize: 13, color: '#6b7280' }}>{user.email}</span>
          <button
            onClick={handleLogout}
            style={{
              padding: '5px 14px', border: '1px solid #d1d5db', borderRadius: 6,
              background: '#fff', fontSize: 13, cursor: 'pointer', color: '#374151',
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
          <Route path="/certificates" element={<Certificates />} />
          <Route path="/settings"     element={<Settings settings={settings} onSave={setSettings} />} />
        </Routes>
      </main>
    </div>
  );
}
