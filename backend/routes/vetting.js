import express from 'express';
import { randomUUID } from 'crypto';
import { createClient } from '@supabase/supabase-js';
import { runVettingRules } from '../lib/rules_engine.js';
import { generateVettingPDF } from '../lib/pdf_generator.js';

const router = express.Router();

function getSupabase() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

// ── POST /api/vetting/run — compute verdict; no DB touch ─────────────────────
router.post('/run', (req, res, next) => {
  try {
    res.json(runVettingRules(req.body));
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

    const result = runVettingRules(carrierData);

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
          // created_at is set by DB default — never sent from here
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

export default router;
