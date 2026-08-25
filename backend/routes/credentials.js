// ── Per-tenant credential management ─────────────────────────────────────────
// All routes scoped strictly to req.auth.tenant (from verified JWT).
// Plaintext keys are never returned — only configured status.

import express from 'express';
import { createClient } from '@supabase/supabase-js';
import { encrypt, decrypt } from '../lib/encryption.js';
import { verifySaferwatchCredentials } from '../lib/saferwatch_verify.js';

const router = express.Router();

function getSupabase() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

// ── GET /api/credentials/saferwatch ──────────────────────────────────────────
// Returns configuration status only. Never returns plaintext keys.
router.get('/saferwatch', async (req, res, next) => {
  try {
    const { data } = await getSupabase()
      .from('tenant_credentials')
      .select('sw_service_key, sw_configured_at, updated_at')
      .eq('tenant_slug', req.auth.tenant)
      .single();

    res.json({
      configured:   !!(data?.sw_service_key),
      configuredAt: data?.sw_configured_at ?? null,
      updatedAt:    data?.updated_at ?? null,
    });
  } catch (e) { next(e); }
});

// ── PUT /api/credentials/saferwatch ──────────────────────────────────────────
// Encrypts and upserts the tenant's SaferWatch credentials.
router.put('/saferwatch', async (req, res, next) => {
  try {
    const { serviceKey, customerKey } = req.body ?? {};
    if (!serviceKey?.trim())  return res.status(400).json({ error: 'serviceKey is required' });
    if (!customerKey?.trim()) return res.status(400).json({ error: 'customerKey is required' });

    const now = new Date().toISOString();
    const { error } = await getSupabase()
      .from('tenant_credentials')
      .upsert({
        tenant_slug:      req.auth.tenant,
        sw_service_key:   encrypt(serviceKey.trim()),
        sw_customer_key:  encrypt(customerKey.trim()),
        sw_configured_at: now,
        updated_at:       now,
      }, { onConflict: 'tenant_slug' });

    if (error) throw error;
    res.json({ ok: true, configured: true, configuredAt: now });
  } catch (e) { next(e); }
});

// ── POST /api/credentials/saferwatch/verify ───────────────────────────────────
// Decrypts stored credentials and runs the verification stub.
router.post('/saferwatch/verify', async (req, res, next) => {
  try {
    const { data } = await getSupabase()
      .from('tenant_credentials')
      .select('sw_service_key, sw_customer_key')
      .eq('tenant_slug', req.auth.tenant)
      .single();

    if (!data?.sw_service_key || !data?.sw_customer_key) {
      return res.status(400).json({ error: 'No credentials saved — save credentials first.' });
    }

    const result = await verifySaferwatchCredentials(
      decrypt(data.sw_service_key),
      decrypt(data.sw_customer_key),
    );
    res.json(result);
  } catch (e) { next(e); }
});

export default router;
