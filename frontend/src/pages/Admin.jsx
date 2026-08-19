import { useState, useEffect } from 'react';

const s = {
  page:     { maxWidth: 900, margin: '0 auto', padding: '24px 20px' },
  h1:       { fontSize: 22, fontWeight: 800, color: '#1e3a5f', margin: '0 0 4px' },
  sub:      { fontSize: 13, color: '#6b7280', marginBottom: 24 },
  card:     { background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: '20px 24px', marginBottom: 20 },
  cardHead: { fontSize: 12, fontWeight: 700, letterSpacing: '0.08em', color: '#1e3a5f', textTransform: 'uppercase', borderBottom: '1px solid #e5e7eb', paddingBottom: 10, marginBottom: 16 },
  label:    { display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 },
  input:    { width: '100%', padding: '8px 10px', border: '1.5px solid #d1d5db', borderRadius: 6, fontSize: 13, fontFamily: 'inherit', boxSizing: 'border-box', color: '#111827', background: '#fff' },
  hint:     { fontSize: 11, color: '#9ca3af', marginTop: 3 },
  grid2:    { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px 20px' },
  btn:      (disabled) => ({
    padding: '10px 22px', border: 'none', borderRadius: 7, fontWeight: 700, fontSize: 14,
    cursor: disabled ? 'not-allowed' : 'pointer', fontFamily: 'inherit',
    background: disabled ? '#d1d5db' : '#1e3a5f', color: '#fff', opacity: disabled ? 0.7 : 1,
  }),
  success: { background: '#f0fdf4', border: '2px solid #16a34a', borderRadius: 10, padding: '20px 24px', marginBottom: 20 },
  th:      { textAlign: 'left', padding: '8px 10px', background: '#f3f4f6', fontWeight: 700, color: '#374151', borderBottom: '1px solid #e5e7eb', fontSize: 12 },
  td:      { padding: '7px 10px', borderBottom: '1px solid #f3f4f6', color: '#374151', fontSize: 12 },
};

function toSlug(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export default function Admin() {
  const [form,        setForm]        = useState({ name: '', email: '', slug: '' });
  const [slugLocked,  setSlugLocked]  = useState(false);
  const [submitting,  setSubmitting]  = useState(false);
  const [result,      setResult]      = useState(null);
  const [err,         setErr]         = useState('');
  const [tenants,     setTenants]     = useState(null);
  const [loadingOrgs, setLoadingOrgs] = useState(false);

  useEffect(() => { loadTenants(); }, []);

  async function loadTenants() {
    setLoadingOrgs(true);
    try {
      const res  = await fetch('/api/admin/tenants');
      const data = await res.json();
      if (res.ok) setTenants(data);
    } catch {}
    finally { setLoadingOrgs(false); }
  }

  function handleNameChange(e) {
    const name = e.target.value;
    setForm(f => ({ ...f, name, slug: slugLocked ? f.slug : toSlug(name) }));
    setResult(null); setErr('');
  }

  function handleSlugChange(e) {
    setSlugLocked(true);
    setForm(f => ({ ...f, slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') }));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setErr(''); setResult(null); setSubmitting(true);
    try {
      const res  = await fetch('/api/admin/invite', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(form),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Failed to create org');
      setResult(data);
      setForm({ name: '', email: '', slug: '' });
      setSlugLocked(false);
      loadTenants();
    } catch (e) {
      setErr(e.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={s.page}>
      <h1 style={s.h1}>Admin — Create Org</h1>
      <p style={s.sub}>
        Invite a new brokerage customer. They'll receive an email with a link to set their own password.
        No password is set until they click the link.
      </p>

      {result && (
        <div style={s.success}>
          <div style={{ fontWeight: 700, color: '#166534', fontSize: 15, marginBottom: 8 }}>
            ✓ Invite sent to {result.email}
          </div>
          <div style={{ fontSize: 13, color: '#166534' }}>
            <strong>Org:</strong> {result.name}<br />
            <strong>Slug:</strong> {result.slug}<br />
            <strong>Email:</strong> {result.email}
          </div>
          <p style={{ fontSize: 12, color: '#166534', marginTop: 10, marginBottom: 0 }}>
            They'll receive an invite email. Their account is inactive until they set a password.
          </p>
        </div>
      )}

      <div style={s.card}>
        <div style={s.cardHead}>New Customer</div>
        <form onSubmit={handleSubmit}>
          <div style={s.grid2}>
            <div>
              <label style={s.label}>Org / Brokerage Name</label>
              <input
                style={s.input} required
                value={form.name} onChange={handleNameChange}
                placeholder="e.g. ABC Freight LLC"
              />
            </div>
            <div>
              <label style={s.label}>Login Email</label>
              <input
                type="email" style={s.input} required
                value={form.email} onChange={e => { setForm(f => ({ ...f, email: e.target.value })); setResult(null); setErr(''); }}
                placeholder="dispatcher@abcfreight.com"
              />
            </div>
            <div>
              <label style={s.label}>Slug (auto-generated, editable)</label>
              <input
                style={s.input} required
                value={form.slug}
                onChange={handleSlugChange}
                placeholder="abc-freight"
              />
              <p style={s.hint}>Lowercase, hyphens only. Used internally — never shown to the customer.</p>
            </div>
          </div>

          {err && <p style={{ color: '#dc2626', fontSize: 13, marginTop: 12 }}>{err}</p>}

          <div style={{ marginTop: 16 }}>
            <button type="submit" style={s.btn(submitting || !form.name || !form.email || !form.slug)} disabled={submitting || !form.name || !form.email || !form.slug}>
              {submitting ? 'Sending invite…' : 'Create Org & Send Invite'}
            </button>
          </div>
        </form>
      </div>

      {/* ── All orgs ── */}
      <div style={s.card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
          <div style={s.cardHead}>All Orgs</div>
          <button
            onClick={loadTenants} disabled={loadingOrgs}
            style={{ padding: '5px 12px', border: '1px solid #d1d5db', borderRadius: 6, background: '#fff', fontSize: 12, cursor: 'pointer' }}
          >
            {loadingOrgs ? 'Loading…' : 'Refresh'}
          </button>
        </div>
        {tenants && (
          tenants.length === 0
            ? <p style={{ fontSize: 13, color: '#6b7280' }}>No orgs yet.</p>
            : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr>
                      {['Name', 'Slug', 'Email', 'Status', 'Admin'].map(h => (
                        <th key={h} style={s.th}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {tenants.map(t => (
                      <tr key={t.slug}>
                        <td style={s.td}>{t.name}</td>
                        <td style={s.td}><code style={{ fontSize: 11 }}>{t.slug}</code></td>
                        <td style={s.td}>{t.email}</td>
                        <td style={s.td}>
                          <span style={{
                            background: t.is_active ? '#dcfce7' : '#fef3c7',
                            color: t.is_active ? '#166534' : '#92400e',
                            borderRadius: 4, padding: '1px 7px', fontSize: 11, fontWeight: 700,
                          }}>
                            {t.is_active ? 'Active' : 'Pending invite'}
                          </span>
                        </td>
                        <td style={s.td}>{t.is_admin ? '✓' : '—'}</td>
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
