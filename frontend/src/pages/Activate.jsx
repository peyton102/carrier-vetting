import { useState, useEffect } from 'react';

const s = {
  wrap:    { display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', background: '#f0f4f8' },
  card:    { background: '#fff', borderRadius: 14, border: '1px solid #e5e7eb', boxShadow: '0 2px 12px rgba(0,0,0,.08)', padding: '40px 36px', width: 380 },
  logo:    { fontWeight: 800, fontSize: 20, color: '#1e3a5f', marginBottom: 4 },
  sub:     { color: '#6b7280', fontSize: 13, marginBottom: 28, lineHeight: 1.5 },
  label:   { display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 },
  input:   { width: '100%', padding: '10px 14px', border: '1.5px solid #d1d5db', borderRadius: 8, fontSize: 15, marginBottom: 14, fontFamily: 'inherit', boxSizing: 'border-box' },
  btn:     (disabled) => ({
    width: '100%', padding: '10px', background: disabled ? '#d1d5db' : '#1e3a5f', color: '#fff',
    border: 'none', borderRadius: 8, fontWeight: 600, fontSize: 14, cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.7 : 1,
  }),
  err:     { color: '#dc2626', fontSize: 13, marginBottom: 12 },
  success: { textAlign: 'center', color: '#166534' },
};

export default function Activate({ onActivate }) {
  const params = new URLSearchParams(window.location.search);
  const token  = params.get('invite') ?? '';
  const email  = params.get('email')  ?? '';

  const [orgName,    setOrgName]    = useState('');
  const [status,     setStatus]     = useState('loading'); // loading | valid | invalid | done
  const [statusMsg,  setStatusMsg]  = useState('');
  const [password,   setPassword]   = useState('');
  const [password2,  setPassword2]  = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [err,        setErr]        = useState('');

  useEffect(() => {
    if (!token || !email) { setStatus('invalid'); setStatusMsg('Missing invite token or email.'); return; }

    fetch(`/api/invite/verify?token=${encodeURIComponent(token)}&email=${encodeURIComponent(email)}`)
      .then(r => r.json().then(d => ({ ok: r.ok, ...d })))
      .then(d => {
        if (d.ok) { setOrgName(d.orgName); setStatus('valid'); }
        else      { setStatus('invalid'); setStatusMsg(d.error ?? 'Invalid invite link'); }
      })
      .catch(() => { setStatus('invalid'); setStatusMsg('Could not verify invite link'); });
  }, []);

  async function handleSubmit(e) {
    e.preventDefault();
    if (password !== password2) return setErr('Passwords do not match');
    if (password.length < 8)   return setErr('Password must be at least 8 characters');

    setErr(''); setSubmitting(true);
    try {
      const res  = await fetch('/api/invite/activate', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ token, email, password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Activation failed');
      setStatus('done');
      // Let the parent App know so it can set user state and redirect
      if (onActivate) onActivate({ email: data.email, name: data.name, tenant: data.tenant });
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
          <p style={{ color: '#6b7280', fontSize: 13 }}>Verifying your invite link…</p>
        )}

        {status === 'invalid' && (
          <>
            <p style={{ color: '#dc2626', fontWeight: 600, fontSize: 14, marginBottom: 8 }}>
              Link invalid or expired
            </p>
            <p style={{ color: '#6b7280', fontSize: 13 }}>{statusMsg}</p>
            <p style={{ color: '#6b7280', fontSize: 13 }}>
              Contact your administrator for a new invite.
            </p>
          </>
        )}

        {status === 'done' && (
          <div style={s.success}>
            <div style={{ fontSize: 36, marginBottom: 12 }}>✓</div>
            <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 8 }}>Account activated!</div>
            <p style={{ fontSize: 13, color: '#6b7280' }}>
              You're now signed in. Taking you to the app…
            </p>
          </div>
        )}

        {status === 'valid' && (
          <>
            <div style={s.sub}>
              Set a password for your <strong>{orgName}</strong> account.
            </div>
            <form onSubmit={handleSubmit}>
              <label style={s.label}>Email</label>
              <input style={{ ...s.input, background: '#f3f4f6', color: '#6b7280' }} value={decodeURIComponent(email)} readOnly />

              <label style={s.label}>Password</label>
              <input
                type="password" style={s.input} required
                value={password} onChange={e => { setPassword(e.target.value); setErr(''); }}
                placeholder="At least 8 characters"
                autoFocus
              />

              <label style={s.label}>Confirm Password</label>
              <input
                type="password" style={s.input} required
                value={password2} onChange={e => { setPassword2(e.target.value); setErr(''); }}
                placeholder="Repeat password"
              />

              {err && <div style={s.err}>{err}</div>}

              <button type="submit" style={s.btn(submitting || !password || !password2)} disabled={submitting || !password || !password2}>
                {submitting ? 'Activating…' : 'Set Password & Sign In'}
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
