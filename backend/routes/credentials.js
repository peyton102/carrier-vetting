// ── Per-tenant credential management ─────────────────────────────────────────
// SaferWatch keys are stored encrypted per-tenant in tenant_credentials.
// Tenants listed in SAFERWATCH_SHARED_TENANTS (comma-separated env var) may
// fall back to the shared operator keys from .env.
// FMCSA uses a single shared key (FMCSA_WEBKEY) — no per-tenant FMCSA config.

import express from 'express';
import { createClient } from '@supabase/supabase-js';
import { encrypt, decrypt } from '../lib/encryption.js';
import { XMLParser } from 'fast-xml-parser';

const router = express.Router();
const SW_BASE = 'https://www.saferwatch.com/webservices/CarrierService32.php';

function getSupabase() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

function isSharedTenant(slug) {
  return (process.env.SAFERWATCH_SHARED_TENANTS || '')
    .split(',').map(s => s.trim()).filter(Boolean).includes(slug);
}

// ── GET /api/credentials/saferwatch ───────────────────────────────────────────
// Returns { configured, configuredAt, shared? }.
// Exempt tenants always return configured:true (they use the shared env keys).
router.get('/saferwatch', async (req, res, next) => {
  try {
    if (isSharedTenant(req.auth.tenant)) {
      return res.json({ configured: true, configuredAt: null, shared: true });
    }

    const { data } = await getSupabase()
      .from('tenant_credentials')
      .select('sw_service_key, sw_configured_at')
      .eq('tenant_slug', req.auth.tenant)
      .maybeSingle();

    res.json({
      configured:   !!(data?.sw_service_key),
      configuredAt: data?.sw_configured_at ?? null,
    });
  } catch (e) { next(e); }
});

// ── PUT /api/credentials/saferwatch ───────────────────────────────────────────
router.put('/saferwatch', async (req, res, next) => {
  try {
    const { serviceKey, customerKey } = req.body ?? {};
    if (!serviceKey?.trim()) return res.status(400).json({ error: 'serviceKey is required' });
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
// Accepts { serviceKey, customerKey } in body to test before saving.
// Falls back to already-saved keys when body is empty.
router.post('/saferwatch/verify', async (req, res, next) => {
  try {
    let serviceKey  = req.body?.serviceKey?.trim();
    let customerKey = req.body?.customerKey?.trim();

    if (!serviceKey || !customerKey) {
      const { data } = await getSupabase()
        .from('tenant_credentials')
        .select('sw_service_key, sw_customer_key')
        .eq('tenant_slug', req.auth.tenant)
        .maybeSingle();
      if (!data?.sw_service_key) {
        return res.status(400).json({ error: 'No SaferWatch key saved — save your keys first.' });
      }
      serviceKey  = decrypt(data.sw_service_key);
      customerKey = decrypt(data.sw_customer_key);
    }

    // Test with FMCSA's own DOT (285375) — always present in FMCSA database
    const p = new URLSearchParams({
      Action:      'CarrierLookup',
      ServiceKey:  serviceKey,
      CustomerKey: customerKey,
      number:      '285375',
    });
    const r = await fetch(`${SW_BASE}?${p}`, { signal: AbortSignal.timeout(10_000) });
    if (!r.ok) {
      return res.json({ status: 'error', message: `SaferWatch returned HTTP ${r.status} — try again.` });
    }

    const xml    = await r.text();
    const parser = new XMLParser({ ignoreAttributes: false });
    const parsed = parser.parse(xml);
    const root   = parsed['CarrierService32.CarrierLookup'];
    const status = String(root?.ResponseDO?.status ?? '').toUpperCase();
    const action = String(root?.ResponseDO?.action  ?? '').toUpperCase();

    if (status === 'APPROVED' && action === 'OK') {
      return res.json({ status: 'verified', message: 'SaferWatch connection confirmed — your keys are working.' });
    }
    if (['DENIED', 'INVALID', 'UNAUTHORIZED'].some(s => status.includes(s) || action.includes(s))) {
      return res.json({ status: 'invalid', message: 'Keys rejected by SaferWatch — check your Service Key and Customer Key are correct.' });
    }
    return res.json({ status: 'unknown', message: `Unexpected SaferWatch response (status=${status} action=${action}) — try again.` });

  } catch (e) {
    if (e.name === 'TimeoutError') {
      return res.json({ status: 'error', message: 'SaferWatch did not respond in time — try again.' });
    }
    next(e);
  }
});

export default router;
