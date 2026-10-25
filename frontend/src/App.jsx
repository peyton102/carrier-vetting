import { useState, useEffect } from 'react';
import { Routes, Route, Navigate, NavLink } from 'react-router-dom';
import CarrierVetting from './pages/CarrierVetting.jsx';
import Certificates   from './pages/Certificates.jsx';
import Settings       from './pages/Settings.jsx';
import Admin          from './pages/Admin.jsx';
import Activate       from './pages/Activate.jsx';
import Monitoring     from './pages/Monitoring.jsx';
import UsedCarriers   from './pages/UsedCarriers.jsx';
import AlertBanner    from './components/AlertBanner.jsx';
import ResetPassword  from './pages/ResetPassword.jsx';

function LoginScreen({ onLogin, onForgot }) {
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
    border: '1.5px solid #cbd5e1', borderRadius: 8, fontSize: 15, marginBottom: 14,
    fontFamily: 'inherit', boxSizing: 'border-box',
    background: '#f8fafc', color: '#0f172a',
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', background: '#f1f5f9' }}>
      <div style={{ background: '#ffffff', borderRadius: 14, border: '1px solid #e2e8f0', boxShadow: '0 4px 24px rgba(0,0,0,.08)', padding: '40px 36px', width: 340 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#22c55e', boxShadow: '0 0 8px rgba(34,197,94,.5)', display: 'inline-block' }} />
          <span style={{ fontWeight: 800, fontSize: 20, color: '#0f172a' }}>Carrier Vetting</span>
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
          {error && <div style={{ color: '#dc2626', fontSize: 13, marginBottom: 12 }}>{error}</div>}
          <button
            type="submit" disabled={loading || !email || !password}
            style={{
              width: '100%', padding: '10px',
              background: loading || !email || !password ? '#e2e8f0' : '#f97316',
              color: loading || !email || !password ? '#94a3b8' : '#fff',
              border: 'none', borderRadius: 8, fontWeight: 700, fontSize: 14,
              cursor: loading || !email || !password ? 'not-allowed' : 'pointer',
              opacity: loading || !email || !password ? 0.7 : 1,
              boxShadow: loading || !email || !password ? 'none' : '0 2px 8px rgba(249,115,22,.3)',
            }}
          >
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
        <div style={{ textAlign: 'center', marginTop: 16 }}>
          <button
            onClick={onForgot}
            style={{ background: 'none', border: 'none', color: '#f97316', fontSize: 13, cursor: 'pointer', fontFamily: 'inherit', padding: 0 }}
          >
            Forgot password?
          </button>
        </div>
      </div>
    </div>
  );
}

function ForgotPasswordScreen({ onBack }) {
  const [email,   setEmail]   = useState('');
  const [status,  setStatus]  = useState('idle'); // idle | loading | sent | error
  const [errMsg,  setErrMsg]  = useState('');

  async function handleSubmit(e) {
    e.preventDefault();
    setStatus('loading');
    try {
      const res = await fetch('/api/reset/request', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ email }),
      });
      if (res.ok) setStatus('sent');
      else        { const d = await res.json(); setErrMsg(d.error || 'Request failed'); setStatus('error'); }
    } catch { setErrMsg('Could not connect'); setStatus('error'); }
  }

  const inputStyle = {
    width: '100%', padding: '10px 14px',
    border: '1.5px solid #cbd5e1', borderRadius: 8, fontSize: 15, marginBottom: 14,
    fontFamily: 'inherit', boxSizing: 'border-box', background: '#f8fafc', color: '#0f172a',
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', background: '#f1f5f9' }}>
      <div style={{ background: '#ffffff', borderRadius: 14, border: '1px solid #e2e8f0', boxShadow: '0 4px 24px rgba(0,0,0,.08)', padding: '40px 36px', width: 340 }}>
        <div style={{ fontWeight: 800, fontSize: 20, color: '#0f172a', marginBottom: 4 }}>Carrier Vetting</div>

        {status === 'sent' ? (
          <>
            <div style={{ color: '#166534', fontWeight: 600, fontSize: 14, marginBottom: 8 }}>Check your email</div>
            <p style={{ color: '#64748b', fontSize: 13, marginBottom: 24 }}>
              If an account exists for that address, we've sent a reset link. It expires in 1 hour.
            </p>
            <button onClick={onBack} style={{ background: 'none', border: 'none', color: '#f97316', fontSize: 13, cursor: 'pointer', fontFamily: 'inherit', padding: 0 }}>
              Back to sign in
            </button>
          </>
        ) : (
          <>
            <div style={{ color: '#64748b', fontSize: 13, marginBottom: 28 }}>
              Enter your email and we'll send you a reset link.
            </div>
            <form onSubmit={handleSubmit}>
              <input
                type="email" value={email} onChange={e => setEmail(e.target.value)}
                placeholder="Email address" autoFocus autoComplete="email" style={inputStyle}
              />
              {status === 'error' && <div style={{ color: '#dc2626', fontSize: 13, marginBottom: 12 }}>{errMsg}</div>}
              <button
                type="submit" disabled={status === 'loading' || !email}
                style={{
                  width: '100%', padding: '10px',
                  background: status === 'loading' || !email ? '#e2e8f0' : '#f97316',
                  color: status === 'loading' || !email ? '#94a3b8' : '#fff',
                  border: 'none', borderRadius: 8, fontWeight: 700, fontSize: 14,
                  cursor: status === 'loading' || !email ? 'not-allowed' : 'pointer',
                  opacity: status === 'loading' || !email ? 0.7 : 1,
                  boxShadow: status === 'loading' || !email ? 'none' : '0 2px 8px rgba(249,115,22,.3)',
                  marginBottom: 14,
                }}
              >
                {status === 'loading' ? 'Sending…' : 'Send reset link'}
              </button>
            </form>
            <button onClick={onBack} style={{ background: 'none', border: 'none', color: '#64748b', fontSize: 13, cursor: 'pointer', fontFamily: 'inherit', padding: 0 }}>
              Back to sign in
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function LoginOrForgot({ onLogin }) {
  const [screen, setScreen] = useState('login');
  if (screen === 'forgot') return <ForgotPasswordScreen onBack={() => setScreen('login')} />;
  return <LoginScreen onLogin={onLogin} onForgot={() => setScreen('forgot')} />;
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

  if (!ready) return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', background: '#f1f5f9' }}>
      <div style={{ textAlign: 'center' }}>
        <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#22c55e', boxShadow: '0 0 8px rgba(34,197,94,.5)', display: 'inline-block', marginBottom: 12 }} />
        <div style={{ fontWeight: 700, color: '#0f172a', fontSize: 16, marginBottom: 6 }}>Carrier Vetting</div>
        <div style={{ color: '#94a3b8', fontSize: 13 }}>Loading…</div>
      </div>
    </div>
  );

  // /activate is public — render before the auth gate
  if (!user) {
    return (
      <Routes>
        <Route path="/activate"       element={<Activate onActivate={data => { setUser(data); }} />} />
        <Route path="/reset-password" element={<ResetPassword />} />
        <Route path="*"               element={<LoginOrForgot onLogin={setUser} />} />
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
        <span className="nav-links">
          {navLink('/vetting',      'Vetting')}
          {navLink('/monitoring',   'Monitoring')}
          {navLink('/certificates',   'Certificates')}
          {navLink('/used-carriers', 'Used Carriers')}
          {navLink('/settings',      'Settings')}
          {user.isAdmin && navLink('/admin', 'Admin')}
        </span>
        <span className="nav-user">
          <span style={{ fontSize: 13, color: '#64748b' }}>{user.email}</span>
          <button
            onClick={handleLogout}
            style={{
              padding: '5px 14px', border: '1px solid #e2e8f0', borderRadius: 6,
              background: '#f8fafc', fontSize: 13, cursor: 'pointer', color: '#475569',
              fontFamily: 'inherit', fontWeight: 500,
            }}
          >
            Sign out
          </button>
        </span>
      </nav>
      <AlertBanner />
      <main className="content">
        <Routes>
          <Route path="/" element={<Navigate to="/vetting" replace />} />
          <Route path="/vetting"      element={<CarrierVetting settings={settings} />} />
          <Route path="/monitoring"   element={<Monitoring />} />
          <Route path="/certificates" element={<Certificates />} />
          <Route path="/used-carriers" element={<UsedCarriers />} />
          <Route path="/settings"     element={<Settings settings={settings} onSave={setSettings} />} />
          <Route path="/admin"        element={user.isAdmin ? <Admin /> : <Navigate to="/vetting" replace />} />
          <Route path="*"             element={<Navigate to="/vetting" replace />} />
        </Routes>
      </main>
    </div>
  );
}
