// ── Carrier Monitoring Routes ─────────────────────────────────────────────────
import { Router }       from 'express';
import { createClient } from '@supabase/supabase-js';
import { runMonitoringCheck, runWatchedCarriersCheck } from '../lib/monitor.js';

const router = Router();
const sb = () => createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// GET /api/monitoring/active — active loads for this tenant
router.get('/active', async (req, res, next) => {
  try {
    const { data, error } = await sb()
      .from('monitored_loads')
      .select('*')
      .eq('tenant_id', req.auth.tenant)
      .is('delivered_at', null)
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json(data);
  } catch (e) { next(e); }
});

// GET /api/monitoring/alerts — unacknowledged alerts for this tenant
router.get('/alerts', async (req, res, next) => {
  try {
    const { data, error } = await sb()
      .from('monitoring_alerts')
      .select('*')
      .eq('tenant_id', req.auth.tenant)
      .eq('is_acknowledged', false)
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json(data);
  } catch (e) { next(e); }
});

// POST /api/monitoring/start — start monitoring a booked load
router.post('/start', async (req, res, next) => {
  try {
    const {
      vetting_log_id, load_ref, dot_number,
      carrier_name, mc_number, started_by,
    } = req.body;

    if (!dot_number || !load_ref) {
      return res.status(400).json({ error: 'dot_number and load_ref are required' });
    }

    // Block monitoring for REJECT/HOLD — read effective verdict from DB (never trust client)
    if (vetting_log_id) {
      const supabase = sb();
      const orgId    = req.auth.tenant;
      const [logResult, overrideResult] = await Promise.all([
        supabase
          .from('vetting_logs')
          .select('verdict, override_manager')
          .eq('id', vetting_log_id)
          .eq('tenant_id', orgId)
          .single(),
        supabase
          .from('vetting_overrides')
          .select('resulting_verdict')
          .eq('record_id', vetting_log_id)
          .eq('tenant_id', orgId)
          .order('override_at', { ascending: false })
          .limit(1),
      ]);
      const logRow          = logResult.data;
      const ovRow           = overrideResult.data?.[0] ?? null;
      const effectiveVerdict = ovRow?.resulting_verdict
        ?? (logRow?.override_manager ? 'APPROVED WITH OVERRIDE' : logRow?.verdict);

      if (effectiveVerdict === 'REJECT') {
        return res.status(400).json({ error: 'REJECT verdict — carrier cannot be monitored for active loads' });
      }
      if (effectiveVerdict === 'HOLD') {
        return res.status(400).json({ error: 'HOLD verdict requires manager override before monitoring' });
      }
    }

    const { data, error } = await sb()
      .from('monitored_loads')
      .insert({
        tenant_id:      req.auth.tenant,
        vetting_log_id: vetting_log_id || null,
        load_ref,
        dot_number,
        carrier_name:   carrier_name || null,
        mc_number:      mc_number    || null,
        started_by:     started_by   || null,
      })
      .select()
      .single();
    if (error) throw error;
    res.json({ ok: true, id: data.id });
  } catch (e) { next(e); }
});

// POST /api/monitoring/:id/deliver — mark load as delivered, stop monitoring
router.post('/:id/deliver', async (req, res, next) => {
  try {
    const { error } = await sb()
      .from('monitored_loads')
      .update({ delivered_at: new Date().toISOString(), last_status: 'delivered' })
      .eq('id', req.params.id)
      .eq('tenant_id', req.auth.tenant);
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// POST /api/monitoring/alerts/:id/ack — acknowledge one alert
router.post('/alerts/:id/ack', async (req, res, next) => {
  try {
    const { error } = await sb()
      .from('monitoring_alerts')
      .update({ is_acknowledged: true, acknowledged_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .eq('tenant_id', req.auth.tenant);
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// POST /api/monitoring/check-now — manual trigger (this tenant's loads only)
router.post('/check-now', async (req, res, next) => {
  try {
    await runMonitoringCheck(sb(), req.auth.tenant);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ── Watched Carriers ──────────────────────────────────────────────────────────

// GET /api/monitoring/watched — list all watched carriers for this tenant
router.get('/watched', async (req, res, next) => {
  try {
    const { data, error } = await sb()
      .from('watched_carriers')
      .select('*')
      .eq('tenant_id', req.auth.tenant)
      .eq('is_active', true)
      .order('added_at', { ascending: false });
    if (error) throw error;
    res.json(data);
  } catch (e) { next(e); }
});

// POST /api/monitoring/watched — add a carrier to the watch list
router.post('/watched', async (req, res, next) => {
  try {
    const { dotNumber, carrierName, mcNumber, addedBy } = req.body;
    if (!dotNumber) return res.status(400).json({ error: 'dotNumber is required' });
    const { data, error } = await sb()
      .from('watched_carriers')
      .upsert({
        tenant_id:    req.auth.tenant,
        dot_number:   String(dotNumber),
        carrier_name: carrierName || null,
        mc_number:    mcNumber    || null,
        added_by:     addedBy     || 'manual',
        is_active:    true,
      }, { onConflict: 'tenant_id,dot_number' })
      .select()
      .single();
    if (error) throw error;
    res.json({ ok: true, id: data.id });
  } catch (e) { next(e); }
});

// DELETE /api/monitoring/watched/:dot — deactivate a watched carrier
router.delete('/watched/:dot', async (req, res, next) => {
  try {
    const { error } = await sb()
      .from('watched_carriers')
      .update({ is_active: false })
      .eq('tenant_id', req.auth.tenant)
      .eq('dot_number', req.params.dot);
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// POST /api/monitoring/check-carriers — manual trigger for watched-carrier inspection check
router.post('/check-carriers', async (req, res, next) => {
  try {
    await runWatchedCarriersCheck(sb(), req.auth.tenant);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ── Carrier Blocks ────────────────────────────────────────────────────────────

// GET /api/monitoring/blocks — list all active carrier blocks for this tenant
router.get('/blocks', async (req, res, next) => {
  try {
    const { data, error } = await sb()
      .from('carrier_blocks')
      .select('*')
      .eq('tenant_id', req.auth.tenant)
      .eq('is_active', true)
      .order('blocked_at', { ascending: false });
    if (error) throw error;
    res.json(data);
  } catch (e) { next(e); }
});

// GET /api/monitoring/blocks/:dot — active block for a specific DOT (this tenant)
router.get('/blocks/:dot', async (req, res, next) => {
  try {
    const { data, error } = await sb()
      .from('carrier_blocks')
      .select('*')
      .eq('tenant_id', req.auth.tenant)
      .eq('dot_number', req.params.dot)
      .eq('is_active', true)
      .maybeSingle();
    if (error) throw error;
    res.json(data || null);
  } catch (e) { next(e); }
});

// POST /api/monitoring/blocks/:dot/lift — manually lift a carrier block
router.post('/blocks/:dot/lift', async (req, res, next) => {
  try {
    const { liftedBy, liftedReason } = req.body;
    const { error } = await sb()
      .from('carrier_blocks')
      .update({
        is_active:     false,
        lifted_at:     new Date().toISOString(),
        lifted_by:     liftedBy     || req.auth.tenant,
        lifted_reason: liftedReason || null,
      })
      .eq('tenant_id', req.auth.tenant)
      .eq('dot_number', req.params.dot)
      .eq('is_active', true);
    if (error) throw error;
    res.json({ ok: true });
  } catch (e) { next(e); }
});

export default router;
