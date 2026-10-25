import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';

const s = {
  wrap:    { display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', background: '#f1f5f9' },
  card:    { background: '#ffffff', borderRadius: 14, border: '1px solid #e2e8f0', boxShadow: '0 4px 24px rgba(0,0,0,.08)', padding: '40px 36px', width: 380 },
  logo:    { fontWeight: 800, fontSize: 20, color: '#0f172a', marginBottom: 4 },
  sub:     { color: '#64748b', fontSize: 13, marginBottom: 28, lineHeight: 1.5 },
  label:   { display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 },
  input:   { width: '100%', padding: '10px 14px', border: '1.5px solid #cbd5e1', borderRadius: 8, fontSize: 15, marginBottom: 14, fontFamily: 'inherit', boxSizing: 'border-box', background: '#f8fafc', color: '#0f172a' },
  btn:     (disabled) => ({
    width: '100%', padding: '10px', background: disabled ? '#e2e8f0' : '#f97316', color: disabled ? '#94a3b8' : '#fff',
    border: 'none', borderRadius: 8, fontWeight: 700, fontSize: 14, cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.7 : 1, boxShadow: disabled ? 'none' : '0 2px 8px rgba(249,115,22,.3)',
  }),
  err:     { color: '#dc2626', fontSize: 13, marginBottom: 12 },
};

export default function ResetPassword() {
  const navigate = useNavigate();
  const params   = new URLSearchParams(window.location.search);
  const token    = params.get('token') ?? '';
  const email    = params.get('email') ?? '';

  const [status,     setStatus]     = useState('loading'); // loading | valid | invalid | done
  const [statusMsg,  setStatusMsg]  = useState('');
  const [password,   setPassword]   = useState('');
  const [password2,  setPassword2]  = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [err,        setErr]        = useState('');

  useEffect(() => {
    if (!token || !email) { setStatus('invalid'); setStatusMsg('Missing reset token or email.'); return; }

    fetch(`/api/reset/verify?token=${encodeURIComponent(token)}&email=${encodeURIComponent(email)}`)
      .then(r => r.json().then(d => ({ ok: r.ok, ...d })))
      .then(d => {
        if (d.ok) setStatus('valid');
        else      { setStatus('invalid'); setStatusMsg(d.error ?? 'Invalid reset link'); }
      })
      .catch(() => { setStatus('invalid'); setStatusMsg('Could not verify reset link'); });
  }, []);

  async function handleSubmit(e) {
    e.preventDefault();
    if (password !== password2) return setErr('Passwords do not match');
    if (password.length < 8)   return setErr('Password must be at least 8 characters');

    setErr(''); setSubmitting(true);
    try {
      const res  = await fetch('/api/reset/confirm', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ token, email, password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Password reset failed');
      setStatus('done');
    } catch (e) {
      setErr(e.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={s.wrap}>
      <div style={s.card}>
        <div style={s.logo}>Carrier Vetting</div>

        {status === 'loading' && (
          <p style={{ color: '#64748b', fontSize: 13 }}>Verifying reset link…</p>
        )}

        {status === 'invalid' && (
          <>
            <p style={{ color: '#f87171', fontWeight: 600, fontSize: 14, marginBottom: 8 }}>
              Link invalid or expired
            </p>
            <p style={{ color: '#64748b', fontSize: 13, marginBottom: 16 }}>{statusMsg}</p>
            <button
              onClick={() => navigate('/')}
              style={{ ...s.btn(false), marginTop: 4 }}
            >
              Back to sign in
            </button>
          </>
        )}

        {status === 'done' && (
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 36, marginBottom: 12, color: '#22c55e' }}>✓</div>
            <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 8 }}>Password updated!</div>
            <p style={{ fontSize: 13, color: '#6b7280', marginBottom: 24 }}>
              You can now sign in with your new password.
            </p>
            <button onClick={() => navigate('/')} style={s.btn(false)}>
              Go to sign in
            </button>
          </div>
        )}

        {status === 'valid' && (
          <>
            <div style={s.sub}>
              Enter a new password for <strong>{decodeURIComponent(email)}</strong>.
            </div>
            <form onSubmit={handleSubmit}>
              <label style={s.label}>New password</label>
              <input
                type="password" style={s.input} required autoFocus
                value={password} onChange={e => { setPassword(e.target.value); setErr(''); }}
                placeholder="At least 8 characters"
              />

              <label style={s.label}>Confirm password</label>
              <input
                type="password" style={s.input} required
                value={password2} onChange={e => { setPassword2(e.target.value); setErr(''); }}
                placeholder="Repeat password"
              />

              {err && <div style={s.err}>{err}</div>}

              <button
                type="submit"
                style={s.btn(submitting || !password || !password2)}
                disabled={submitting || !password || !password2}
              >
                {submitting ? 'Saving…' : 'Set new password'}
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
