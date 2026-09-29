import express from 'express';
import { randomUUID } from 'crypto';
import { createClient } from '@supabase/supabase-js';
import { runVettingRules } from '../lib/rules_engine.js';
import { generateVettingPDF } from '../lib/pdf_generator.js';
import { fetchSettings } from '../lib/settings.js';

const router = express.Router();

function getSupabase() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

async function getTenantName(slug) {
  const { data } = await getSupabase()
    .from('tenants')
    .select('name')
    .eq('slug', slug)
    .single();
  return data?.name ?? slug;
}

// ── POST /api/vetting/run — compute verdict; no DB touch ─────────────────────
router.post('/run', async (req, res, next) => {
  try {
    const cfg = await fetchSettings(req.auth.tenant);
    res.json(runVettingRules(req.body, cfg));
  } catch (e) { next(e); }
});

// ── POST /api/vetting/pdf ─────────────────────────────────────────────────────
// Generates the PDF, uploads the exact same buffer to storage, inserts DB rows,
// then sends the PDF. Save failure sets X-Certificate-Save-Error but never
// blocks the download — res.send(pdfBuffer) always executes.
router.post('/pdf', async (req, res, next) => {
  try {
    const { carrierData, override } = req.body;
    const orgId = req.auth.tenant;

    if (!carrierData?.loadRef)    return res.status(400).json({ error: 'loadRef is required' });
    if (!carrierData?.dispatcher) return res.status(400).json({ error: 'dispatcher is required' });

    // Fetch settings and broker name in parallel
    const [cfg, brokerName] = await Promise.all([
      fetchSettings(orgId),
      getTenantName(orgId),
    ]);

    const result = runVettingRules(carrierData, cfg);

    const applyOverride = (
      result.verdict === 'HOLD' &&
      result.canOverride &&
      override?.managerName?.trim() &&
      override?.reason?.trim()
    );
    const finalVerdict = applyOverride ? 'APPROVED WITH OVERRIDE' : result.verdict;

    const generatedAt = new Date();
    const recordId    = randomUUID();

    // Generate once — this buffer is sent to the user AND uploaded to storage.
    const pdfBuffer = await generateVettingPDF({
      carrierData,
      verdict:       finalVerdict,
      tier:          result.tier,
      reasons:       result.reasons,
      authorityDays: result.authorityDays,
      override:      applyOverride ? override : null,
      generatedAt,
      recordId,
      settings:      cfg,
      brokerName,
    });

    const dot      = (carrierData.dotNumber || 'NODOT').replace(/\W/g, '');
    const loadRef  = (carrierData.loadRef   || 'NOREF').replace(/\W/g, '');
    const dateStr  = generatedAt.toISOString().replace(/[-:]/g, '').replace('T', '_').slice(0, 15);
    const filename = `VettingCert_${dot}_${loadRef}_${dateStr}.pdf`;

    // ── Save to storage + DB (best-effort) ───────────────────────────────────
    let saveError = null;
    const storagePath = `${orgId}/${recordId}/${filename}`;

    try {
      const supabase = getSupabase();

      // upsert: false — reject if path already exists (write-once at storage level)
      const { error: uploadErr } = await supabase
        .storage
        .from('vetting-certificates')
        .upload(storagePath, pdfBuffer, { contentType: 'application/pdf', upsert: false });

      if (uploadErr) throw new Error(`Storage: ${uploadErr.message}`);

      const { error: certErr } = await supabase
        .from('certificates')
        .insert({
          id:           recordId,
          org_id:       orgId,
          carrier_name: carrierData.carrierName || null,
          dot_number:   carrierData.dotNumber   || null,
          mc_number:    carrierData.mcNumber    || null,
          verdict:      finalVerdict,
          storage_path: storagePath,
        });

      if (certErr) throw new Error(`Certificate record: ${certErr.message}`);

      const { error: logErr } = await supabase
        .from('vetting_logs')
        .insert({
          id:               recordId,
          tenant_id:        orgId,
          load_ref:         carrierData.loadRef,
          dispatcher:       carrierData.dispatcher,
          carrier_name:     carrierData.carrierName || null,
          dot_number:       carrierData.dotNumber   || null,
          mc_number:        carrierData.mcNumber    || null,
          verdict:          finalVerdict,
          tier:             result.tier,
          reasons:          result.reasons,
          carrier_data:     carrierData,
          override_manager: applyOverride ? override.managerName.trim() : null,
          override_reason:  applyOverride ? override.reason.trim()      : null,
          override_at:      applyOverride ? generatedAt.toISOString()   : null,
          pdf_url:          storagePath,
        });

      if (logErr) throw new Error(`Audit log: ${logErr.message}`);
    } catch (e) {
      saveError = e.message;
      console.error('[PDF SAVE]', e.message);
    }

    // ── Send PDF (always) ─────────────────────────────────────────────────────
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('X-Record-Id',  recordId);
    res.setHeader('X-Verdict',    finalVerdict);
    res.setHeader('X-Tier',       result.tier);
    res.setHeader('X-Filename',   filename);
    res.setHeader('Access-Control-Expose-Headers',
      'X-Record-Id, X-Verdict, X-Tier, X-Filename, X-Certificate-Save-Error');

    if (saveError) {
      // Sanitize: HTTP header values cannot contain newlines
      res.setHeader('X-Certificate-Save-Error', saveError.replace(/[\r\n]/g, ' ').slice(0, 200));
    }

    res.send(pdfBuffer);
  } catch (e) { next(e); }
});

// ── GET /api/vetting/logs ─────────────────────────────────────────────────────
router.get('/logs', async (req, res, next) => {
  try {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      return res.json([]);
    }
    const { data, error } = await getSupabase()
      .from('vetting_logs')
      .select('id,created_at,load_ref,dispatcher,carrier_name,dot_number,mc_number,verdict,tier,reasons,pdf_url')
      .eq('tenant_id', req.auth.tenant)
      .order('created_at', { ascending: false })
      .limit(200);
    if (error) throw error;
    res.json(data);
  } catch (e) { next(e); }
});

// ── GET /api/vetting/logs/:id ─────────────────────────────────────────────────
router.get('/logs/:id', async (req, res, next) => {
  try {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      return res.status(503).json({ error: 'Database not configured' });
    }
    const { data, error } = await getSupabase()
      .from('vetting_logs')
      .select('*')
      .eq('id', req.params.id)
      .eq('tenant_id', req.auth.tenant)
      .single();
    if (error) throw error;
    res.json(data);
  } catch (e) { next(e); }
});

// ── POST /api/vetting/mark-used ───────────────────────────────────────────────
// Records a carrier as booked. Auto-adds to watched_carriers for ongoing
// inspection monitoring. Called after PDF is generated and saved.
router.post('/mark-used', async (req, res) => {
  const { carrierName, dotNumber, mcNumber, loadRef, dispatcher, verdict, tier, vettingRecordId } = req.body;
  const orgId = req.auth.tenant;
  try {
    const supabase = getSupabase();

    const { data, error } = await supabase
      .from('used_carriers')
      .insert({
        tenant_id:         orgId,
        carrier_name:      carrierName     || null,
        dot_number:        dotNumber       || null,
        mc_number:         mcNumber        || null,
        load_ref:          loadRef         || null,
        dispatcher:        dispatcher      || null,
        verdict:           verdict         || null,
        tier:              tier            || null,
        vetting_record_id: vettingRecordId || null,
      })
      .select('id, used_at')
      .single();
    if (error) throw new Error(error.message);

    // Auto-add to watched_carriers for ongoing inspection monitoring (non-fatal)
    if (dotNumber) {
      try {
        await supabase
          .from('watched_carriers')
          .upsert({
            tenant_id:    orgId,
            dot_number:   String(dotNumber),
            carrier_name: carrierName || null,
            mc_number:    mcNumber    || null,
            added_by:     dispatcher  || 'system',
            is_active:    true,
          }, { onConflict: 'tenant_id,dot_number' });
      } catch (watchErr) {
        console.warn('[WATCH] Could not auto-watch carrier DOT', dotNumber, watchErr.message);
      }
    }

    res.json({ ok: true, id: data.id, used_at: data.used_at });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── GET /api/vetting/used-carriers ────────────────────────────────────────────
router.get('/used-carriers', async (req, res, next) => {
  try {
    const { data, error } = await getSupabase()
      .from('used_carriers')
      .select('*')
      .eq('tenant_id', req.auth.tenant)
      .order('used_at', { ascending: false })
      .limit(500);
    if (error) throw error;
    res.json(data);
  } catch (e) { next(e); }
});

export default router;
