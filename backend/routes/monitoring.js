// ── Carrier Monitoring Routes ─────────────────────────────────────────────────
import { Router }       from 'express';
import { createClient } from '@supabase/supabase-js';
import { runMonitoringCheck } from '../lib/monitor.js';

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

export default router;
