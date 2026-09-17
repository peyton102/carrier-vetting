// ── Per-tenant credential management ─────────────────────────────────────────
// All routes scoped strictly to req.auth.tenant (from verified JWT).
// Plaintext keys are never returned — only configured status.

import express from 'express';
import { createClient } from '@supabase/supabase-js';
import { encrypt, decrypt } from '../lib/encryption.js';
import { verifySaferwatchCredentials } from '../lib/saferwatch_verify.js';

const router = express.Router();
const FMCSA_BASE = 'https://mobile.fmcsa.dot.gov/qc/services';

function getSupabase() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

// ── SaferWatch ────────────────────────────────────────────────────────────────

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

// ── FMCSA Web Key (per-tenant) ────────────────────────────────────────────────
// Each tenant must register their own free FMCSA web key at:
// https://mobile.fmcsa.dot.gov/qc/services/users/register

router.get('/fmcsa', async (req, res, next) => {
  try {
    const { data } = await getSupabase()
      .from('tenant_credentials')
      .select('fmcsa_webkey, fmcsa_configured_at')
      .eq('tenant_slug', req.auth.tenant)
      .single();

    res.json({
      configured:   !!(data?.fmcsa_webkey),
      configuredAt: data?.fmcsa_configured_at ?? null,
    });
  } catch (e) { next(e); }
});

router.put('/fmcsa', async (req, res, next) => {
  try {
    const { webKey } = req.body ?? {};
    if (!webKey?.trim()) return res.status(400).json({ error: 'webKey is required' });

    const now = new Date().toISOString();
    const { error } = await getSupabase()
      .from('tenant_credentials')
      .upsert({
        tenant_slug:        req.auth.tenant,
        fmcsa_webkey:       encrypt(webKey.trim()),
        fmcsa_configured_at: now,
        updated_at:         now,
      }, { onConflict: 'tenant_slug' });

    if (error) throw error;
    res.json({ ok: true, configured: true, configuredAt: now });
  } catch (e) { next(e); }
});

router.post('/fmcsa/verify', async (req, res, next) => {
  try {
    const { data } = await getSupabase()
      .from('tenant_credentials')
      .select('fmcsa_webkey')
      .eq('tenant_slug', req.auth.tenant)
      .single();

    if (!data?.fmcsa_webkey) {
      return res.status(400).json({ error: 'No FMCSA web key saved — save your key first.' });
    }

    const key = decrypt(data.fmcsa_webkey);
    // Test the key against a known carrier (FMCSA's own DOT number: 285375)
    const testUrl = `${FMCSA_BASE}/carriers/285375?webKey=${encodeURIComponent(key)}&type=json`;
    const r = await fetch(testUrl, { signal: AbortSignal.timeout(10_000) });

    if (r.status === 401 || r.status === 403) {
      return res.json({ status: 'invalid', message: 'Web key rejected by FMCSA — check that the key is correct and your registration is active.' });
    }
    if (r.status === 404 || r.ok) {
      return res.json({ status: 'verified', message: 'FMCSA web key is valid and working.' });
    }
    return res.json({ status: 'unknown', message: `FMCSA returned HTTP ${r.status} — key may be valid; try again.` });
  } catch (e) {
    if (e.name === 'TimeoutError') {
      return res.json({ status: 'unknown', message: 'FMCSA did not respond in time — try again.' });
    }
    next(e);
  }
});

export default router;
