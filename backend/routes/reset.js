import express        from 'express';
import bcrypt         from 'bcryptjs';
import { randomBytes } from 'crypto';
import { createClient } from '@supabase/supabase-js';
import { sendPasswordResetEmail } from '../lib/mailer.js';

const router = express.Router();

function getSupabase() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

// ── POST /api/reset/request ───────────────────────────────────────────────────
router.post('/request', async (req, res, next) => {
  try {
    const { email } = req.body ?? {};
    if (!email) return res.status(400).json({ error: 'Email required' });
    const cleanEmail = email.toLowerCase().trim();

    const supabase = getSupabase();
    const { data: tenant } = await supabase
      .from('tenants')
      .select('slug, is_active')
      .eq('email', cleanEmail)
      .single();

    // Always respond OK — never reveal whether an account exists.
    if (!tenant || !tenant.is_active) return res.json({ ok: true });

    // Delete any existing unused tokens for this email before issuing a new one.
    await supabase
      .from('password_reset_tokens')
      .delete()
      .eq('email', cleanEmail)
      .is('used_at', null);

    const token      = randomBytes(32).toString('hex');
    const expiresAt  = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour

    const { error: insertErr } = await supabase
      .from('password_reset_tokens')
      .insert({ email: cleanEmail, token, expires_at: expiresAt });

    if (insertErr) throw insertErr;

    const appOrigin = new URL(process.env.PORTAL_URL).origin;
    const resetUrl  = `${appOrigin}/reset-password?token=${token}&email=${encodeURIComponent(cleanEmail)}`;
    await sendPasswordResetEmail(cleanEmail, resetUrl);

    res.json({ ok: true });
  } catch (e) {
    console.error('[RESET/REQUEST]', e.message);
    next(e);
  }
});

// ── GET /api/reset/verify?token=TOKEN&email=EMAIL ─────────────────────────────
router.get('/verify', async (req, res, next) => {
  try {
    const { token, email } = req.query;
    if (!token || !email) return res.status(400).json({ error: 'Missing token or email' });

    const { data, error } = await getSupabase()
      .from('password_reset_tokens')
      .select('email, expires_at, used_at')
      .eq('token', token)
      .eq('email', decodeURIComponent(email).toLowerCase())
      .single();

    if (error || !data)                          return res.status(404).json({ error: 'Invalid or expired reset link' });
    if (data.used_at)                            return res.status(410).json({ error: 'This reset link has already been used' });
    if (new Date(data.expires_at) < new Date()) return res.status(410).json({ error: 'This reset link has expired' });

    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ── POST /api/reset/confirm ───────────────────────────────────────────────────
router.post('/confirm', async (req, res, next) => {
  try {
    const { token, email, password } = req.body ?? {};
    if (!token || !email || !password) return res.status(400).json({ error: 'Missing required fields' });
    if (password.length < 8)           return res.status(400).json({ error: 'Password must be at least 8 characters' });

    const supabase   = getSupabase();
    const cleanEmail = decodeURIComponent(email).toLowerCase().trim();

    const { data: row, error } = await supabase
      .from('password_reset_tokens')
      .select('id, expires_at, used_at')
      .eq('token', token)
      .eq('email', cleanEmail)
      .single();

    if (error || !row)                          return res.status(404).json({ error: 'Invalid reset link' });
    if (row.used_at)                            return res.status(410).json({ error: 'This reset link has already been used' });
    if (new Date(row.expires_at) < new Date()) return res.status(410).json({ error: 'Reset link expired' });

    const password_hash = await bcrypt.hash(password, 10);

    const { error: updateErr } = await supabase
      .from('tenants')
      .update({ password_hash })
      .eq('email', cleanEmail);

    if (updateErr) throw updateErr;

    await supabase
      .from('password_reset_tokens')
      .update({ used_at: new Date().toISOString() })
      .eq('id', row.id);

    res.json({ ok: true });
  } catch (e) {
    console.error('[RESET/CONFIRM]', e.message);
    next(e);
  }
});

export default router;
