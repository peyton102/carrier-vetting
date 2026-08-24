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

// ── GET /api/admin/tenants — list all tenants with invite status ──────────────
router.get('/tenants', async (req, res, next) => {
  try {
    const supabase = getSupabase();

    const { data: tenants, error } = await supabase
      .from('tenants')
      .select('slug, email, name, is_active, is_admin, created_at')
      .order('created_at', { ascending: false });
    if (error) throw error;

    // Fetch any unused invite_codes to determine "invite pending" status
    const emails = tenants.map(t => t.email);
    const { data: invites } = emails.length
      ? await supabase
          .from('invite_codes')
          .select('email, expires_at')
          .in('email', emails)
          .is('used_at', null)
      : { data: [] };

    const pendingByEmail = new Map((invites ?? []).map(i => [i.email, i]));

    const result = tenants.map(t => ({
      ...t,
      invite_pending: !t.is_active && pendingByEmail.has(t.email),
      invite_expires_at: pendingByEmail.get(t.email)?.expires_at ?? null,
    }));

    res.json(result);
  } catch (e) { next(e); }
});

// ── DELETE /api/admin/tenants/:slug ───────────────────────────────────────────
// Removes the tenant and all related rows so the email + slug can be reused.
// Certificates are intentionally left (immutable by DB trigger).
router.delete('/tenants/:slug', async (req, res, next) => {
  try {
    const { slug } = req.params;
    const supabase  = getSupabase();

    // Fetch the tenant first — we need the email for invite_codes cleanup.
    const { data: tenant, error: fetchErr } = await supabase
      .from('tenants')
      .select('email')
      .eq('slug', slug)
      .single();

    if (fetchErr || !tenant) return res.status(404).json({ error: 'Tenant not found' });

    const { email } = tenant;

    // 1. Delete invite_codes scoped to this tenant's email only.
    const { error: inviteDelErr } = await supabase
      .from('invite_codes')
      .delete()
      .eq('email', email);
    if (inviteDelErr) throw inviteDelErr;

    // 2. Delete vetting_logs scoped to this slug only.
    //    (FK on tenant_id blocks tenant deletion if rows remain.)
    const { error: logsDelErr } = await supabase
      .from('vetting_logs')
      .delete()
      .eq('tenant_id', slug);
    if (logsDelErr) throw logsDelErr;

    // 3. Delete the tenant row scoped to this slug only.
    //    tenant_settings cascades automatically (ON DELETE CASCADE).
    const { error: tenantDelErr } = await supabase
      .from('tenants')
      .delete()
      .eq('slug', slug);
    if (tenantDelErr) throw tenantDelErr;

    res.json({ ok: true, slug, email });
  } catch (e) { next(e); }
});

// ── POST /api/admin/tenants/:slug/resend-invite ───────────────────────────────
// Generates a fresh invite token and re-sends the email. Tenant must still be
// inactive (invite not yet used). Does not delete or recreate the tenant row.
router.post('/tenants/:slug/resend-invite', async (req, res, next) => {
  try {
    const { slug } = req.params;
    const supabase  = getSupabase();

    const { data: tenant, error: fetchErr } = await supabase
      .from('tenants')
      .select('email, name, is_active')
      .eq('slug', slug)
      .single();

    if (fetchErr || !tenant) return res.status(404).json({ error: 'Tenant not found' });
    if (tenant.is_active) return res.status(400).json({ error: 'Account is already active — invite cannot be resent' });

    const { email, name } = tenant;

    // Remove any existing unused tokens for this email only.
    await supabase
      .from('invite_codes')
      .delete()
      .eq('email', email)
      .is('used_at', null);

    // Issue a fresh token with a new 72-hour window.
    const token     = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString();

    const { error: inviteErr } = await supabase
      .from('invite_codes')
      .insert({ email, token, expires_at: expiresAt });
    if (inviteErr) throw inviteErr;

    const inviteUrl = `${process.env.PORTAL_URL}?invite=${token}&email=${encodeURIComponent(email)}`;
    await sendInviteEmail(email, name, inviteUrl);

    res.json({ ok: true, email });
  } catch (e) { next(e); }
});

export default router;
