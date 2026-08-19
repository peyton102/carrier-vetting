import express from 'express';
import bcrypt from 'bcryptjs';
import { createClient } from '@supabase/supabase-js';
import { signToken } from '../lib/auth.js';

const router = express.Router();

function getSupabase() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

// ── GET /api/invite/verify?token=TOKEN&email=EMAIL ────────────────────────────
// Called by the activate page on load to confirm the link is still valid.
router.get('/verify', async (req, res, next) => {
  try {
    const { token, email } = req.query;
    if (!token || !email) return res.status(400).json({ error: 'Missing token or email' });

    const { data, error } = await getSupabase()
      .from('invite_codes')
      .select('email, expires_at, used_at')
      .eq('token', token)
      .eq('email', decodeURIComponent(email).toLowerCase())
      .single();

    if (error || !data)             return res.status(404).json({ error: 'Invalid or expired invite link' });
    if (data.used_at)               return res.status(410).json({ error: 'This invite has already been used' });
    if (new Date(data.expires_at) < new Date()) return res.status(410).json({ error: 'This invite link has expired' });

    // Return org name so the activate page can greet them
    const { data: tenant } = await getSupabase()
      .from('tenants')
      .select('name')
      .eq('email', data.email)
      .single();

    res.json({ ok: true, email: data.email, orgName: tenant?.name ?? '' });
  } catch (e) { next(e); }
});

// ── POST /api/invite/activate ─────────────────────────────────────────────────
// Sets the password, activates the account, marks invite used, logs them in.
router.post('/activate', async (req, res, next) => {
  try {
    const { token, email, password } = req.body;
    if (!token || !email || !password) return res.status(400).json({ error: 'Missing required fields' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

    const supabase   = getSupabase();
    const cleanEmail = decodeURIComponent(email).toLowerCase();

    // Re-validate token (never trust the frontend's earlier check)
    const { data: invite, error } = await supabase
      .from('invite_codes')
      .select('id, email, expires_at, used_at')
      .eq('token', token)
      .eq('email', cleanEmail)
      .single();

    if (error || !invite)              return res.status(404).json({ error: 'Invalid invite' });
    if (invite.used_at)                return res.status(410).json({ error: 'This invite has already been used' });
    if (new Date(invite.expires_at) < new Date()) return res.status(410).json({ error: 'Invite expired' });

    // Hash password and activate the tenant
    const password_hash = await bcrypt.hash(password, 10);

    const { error: updateErr } = await supabase
      .from('tenants')
      .update({ password_hash, is_active: true })
      .eq('email', cleanEmail)
      .eq('is_active', false);

    if (updateErr) throw updateErr;

    // Mark invite as used — can never be reused
    await supabase
      .from('invite_codes')
      .update({ used_at: new Date().toISOString() })
      .eq('id', invite.id);

    // Fetch slug and log them in automatically
    const { data: tenant } = await supabase
      .from('tenants')
      .select('slug, email, name')
      .eq('email', cleanEmail)
      .single();

    const authToken = signToken({ sub: tenant.email, tenant: tenant.slug });
    res.cookie('auth', authToken, { httpOnly: true, sameSite: 'strict', maxAge: 7 * 24 * 60 * 60 * 1000 });
    res.json({ ok: true, email: tenant.email, name: tenant.name, tenant: tenant.slug });
  } catch (e) { next(e); }
});

export default router;
