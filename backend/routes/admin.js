import express from 'express';
import { randomBytes } from 'crypto';
import { createClient } from '@supabase/supabase-js';
import { requireAdmin } from '../middleware/requireAdmin.js';
import { sendInviteEmail } from '../lib/mailer.js';

const router = express.Router();

// Every admin route is gated by requireAdmin (which runs after requireAuth)
router.use(requireAdmin);

function getSupabase() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

function toSlug(name) {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// ── POST /api/admin/invite ────────────────────────────────────────────────────
// Creates an inactive tenant and sends them an invite email.
router.post('/invite', async (req, res, next) => {
  try {
    const { name, email, slug: slugOverride } = req.body;
    if (!name?.trim())  return res.status(400).json({ error: 'Org name is required' });
    if (!email?.trim()) return res.status(400).json({ error: 'Email is required' });

    const slug       = slugOverride?.trim() ? slugOverride.trim().toLowerCase().replace(/[^a-z0-9-]/g, '') : toSlug(name);
    const cleanEmail = email.trim().toLowerCase();
    const supabase   = getSupabase();

    // Insert the tenant as inactive — no password until they activate
    const { error: tenantErr } = await supabase
      .from('tenants')
      .insert({
        slug,
        email:         cleanEmail,
        name:          name.trim(),
        password_hash: '',
        is_active:     false,
        is_admin:      false,
      });

    if (tenantErr) {
      if (tenantErr.code === '23505') {
        return res.status(409).json({ error: `Slug "${slug}" or email already exists. Try a different slug.` });
      }
      throw tenantErr;
    }

    // Generate single-use invite token
    const token     = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString();

    const { error: inviteErr } = await supabase
      .from('invite_codes')
      .insert({ email: cleanEmail, token, expires_at: expiresAt });

    if (inviteErr) throw inviteErr;

    // Build invite link and send email
    const inviteUrl = `${process.env.PORTAL_URL}?invite=${token}&email=${encodeURIComponent(cleanEmail)}`;
    await sendInviteEmail(cleanEmail, name.trim(), inviteUrl);

    res.json({ ok: true, slug, email: cleanEmail, name: name.trim(), inviteUrl });
  } catch (e) { next(e); }
});

// ── GET /api/admin/tenants — list all tenants (for admin dashboard) ───────────
router.get('/tenants', async (req, res, next) => {
  try {
    const { data, error } = await getSupabase()
      .from('tenants')
      .select('slug, email, name, is_active, is_admin, created_at')
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json(data);
  } catch (e) { next(e); }
});

export default router;
