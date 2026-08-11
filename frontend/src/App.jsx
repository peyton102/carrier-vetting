import { useState, useEffect } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import CarrierVetting from './pages/CarrierVetting.jsx';

function LoginScreen({ onLogin }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError(''); setLoading(true);
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      if (res.ok) { onLogin(); }
      else { setError('Invalid username or password'); }
    } catch { setError('Could not connect'); }
    finally { setLoading(false); }
  }

  const inputStyle = { width: '100%', padding: '10px 14px', border: '1.5px solid #d1d5db', borderRadius: 8, fontSize: 15, marginBottom: 14, fontFamily: 'inherit', boxSizing: 'border-box' };

  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', background: '#f0f4f0' }}>
      <div style={{ background: '#fff', borderRadius: 14, border: '1px solid #e5e7eb', boxShadow: '0 2px 12px rgba(0,0,0,.08)', padding: '40px 36px', width: 320 }}>
        <div style={{ fontWeight: 800, fontSize: 18, color: '#16a34a', marginBottom: 6 }}>Carrier Vetting</div>
        <div style={{ color: '#6b7280', fontSize: 13, marginBottom: 28 }}>Sign in to continue</div>
        <form onSubmit={handleSubmit}>
          <input type="text" value={username} onChange={e => setUsername(e.target.value)}
            placeholder="Username" autoFocus autoComplete="username" style={inputStyle} />
          <input type="password" value={password} onChange={e => setPassword(e.target.value)}
            placeholder="Password" autoComplete="current-password" style={inputStyle} />
          {error && <div style={{ color: '#dc2626', fontSize: 13, marginBottom: 12 }}>{error}</div>}
          <button type="submit" disabled={loading || !username || !password}
            style={{ width: '100%', padding: '10px', background: '#16a34a', color: '#fff', border: 'none', borderRadius: 8, fontWeight: 600, fontSize: 14, cursor: 'pointer', opacity: loading || !username || !password ? 0.5 : 1 }}>
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  );
}

export default function App() {
  const [authed, setAuthed] = useState(null);

  useEffect(() => {
    fetch('/api/health').then(r => setAuthed(r.ok)).catch(() => setAuthed(false));
  }, []);

  if (authed === null) return null;
  if (!authed) return <LoginScreen onLogin={() => setAuthed(true)} />;

  return (
    <div className="app">
      <nav>
        <span className="brand">Precision Freight — Carrier Vetting</span>
      </nav>
      <main className="content">
        <Routes>
          <Route path="/" element={<Navigate to="/vetting" replace />} />
          <Route path="/vetting" element={<CarrierVetting />} />
        </Routes>
      </main>
    </div>
  );
}
