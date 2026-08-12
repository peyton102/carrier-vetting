import express from 'express';
import { createClient } from '@supabase/supabase-js';

const router = express.Router();

const BUCKET      = 'vetting-certificates';
const SIGNED_SECS = 3600; // signed URL valid for 1 hour

function getSupabase() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

// ── GET /api/certificates — list org's certificates ───────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const { data, error } = await getSupabase()
      .from('certificates')
      .select('id, created_at, carrier_name, dot_number, mc_number, verdict, storage_path')
      .eq('org_id', req.auth.tenant)
      .order('created_at', { ascending: false })
      .limit(200);
    if (error) throw error;
    res.json(data);
  } catch (e) { next(e); }
});

// ── GET /api/certificates/:id/download — signed URL redirect ──────────────────
router.get('/:id/download', async (req, res, next) => {
  try {
    // Verify ownership — org_id must match the authenticated tenant
    const { data: cert, error: certErr } = await getSupabase()
      .from('certificates')
      .select('storage_path')
      .eq('id', req.params.id)
      .eq('org_id', req.auth.tenant)
      .single();

    if (certErr || !cert) {
      return res.status(404).json({ error: 'Certificate not found' });
    }

    const { data: signed, error: signErr } = await getSupabase()
      .storage
      .from(BUCKET)
      .createSignedUrl(cert.storage_path, SIGNED_SECS);

    if (signErr) throw signErr;

    res.redirect(signed.signedUrl);
  } catch (e) { next(e); }
});

export default router;
