import express from 'express';
import { randomUUID } from 'crypto';
import { createClient } from '@supabase/supabase-js';
import { runVettingRules } from '../lib/rules_engine.js';
import { generateVettingPDF } from '../lib/pdf_generator.js';

const router = express.Router();

// ── POST /api/vetting/run — compute verdict; no DB touch ─────────────────────
router.post('/run', (req, res, next) => {
  try {
    res.json(runVettingRules(req.body));
  } catch (e) { next(e); }
});

// ── POST /api/vetting/pdf ─────────────────────────────────────────────────────
// Generate and deliver the PDF certificate.
// !! NO database operations here — DB failure can never block PDF delivery !!
// Pre-generates a UUID so it appears in the PDF and can be passed to /save.
router.post('/pdf', async (req, res, next) => {
  try {
    const { carrierData, override } = req.body;

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
    const recordId    = randomUUID();  // pre-generate so it appears inside the PDF

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

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    // Surface metadata to the frontend for the subsequent /save call
    res.setHeader('X-Record-Id',    recordId);
    res.setHeader('X-Verdict',      finalVerdict);
    res.setHeader('X-Tier',         result.tier);
    res.setHeader('X-Filename',     filename);
    res.setHeader('Access-Control-Expose-Headers',
      'X-Record-Id, X-Verdict, X-Tier, X-Filename');

    res.send(pdfBuffer);
    // PDF is delivered. Nothing after this line can affect what the user received.
  } catch (e) { next(e); }
});

// ── POST /api/vetting/save ────────────────────────────────────────────────────
// Persist the vetting record to Supabase.
// Called AFTER the PDF has already been delivered. Completely independent.
// Always returns JSON { ok, recordId?, error? } — never throws to the client.
router.post('/save', async (req, res) => {
  const { carrierData, override, recordId, verdict, tier } = req.body;

  try {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error('Supabase credentials not configured');
    }
    if (!carrierData?.loadRef) throw new Error('loadRef required');

    const result = runVettingRules(carrierData);

    const applyOverride = (
      result.verdict === 'HOLD' &&
      result.canOverride &&
      override?.managerName?.trim() &&
      override?.reason?.trim()
    );
    // Prefer the verdict computed at PDF time (passed in from frontend)
    const finalVerdict = verdict || (applyOverride ? 'APPROVED WITH OVERRIDE' : result.verdict);

    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
    );

    const { data: row, error: dbErr } = await supabase
      .from('vetting_logs')
      .insert({
        id:               recordId,           // use the same UUID that's in the PDF
        load_ref:         carrierData.loadRef,
        dispatcher:       carrierData.dispatcher,
        carrier_name:     carrierData.carrierName || null,
        dot_number:       carrierData.dotNumber   || null,
        mc_number:        carrierData.mcNumber    || null,
        verdict:          finalVerdict,
        tier:             tier || result.tier,
        reasons:          result.reasons,
        carrier_data:     carrierData,
        override_manager: applyOverride ? override.managerName.trim() : null,
        override_reason:  applyOverride ? override.reason.trim()      : null,
        override_at:      applyOverride ? new Date().toISOString()    : null,
        pdf_url:          null,
      })
      .select('id')
      .single();

    if (dbErr) throw new Error(dbErr.message);

    res.json({ ok: true, recordId: row.id });
  } catch (e) {
    // Never let this propagate — PDF is already delivered, this is informational only
    res.json({ ok: false, error: e.message });
  }
});

// ── GET /api/vetting/logs — audit trail ──────────────────────────────────────
router.get('/logs', async (req, res, next) => {
  try {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      return res.json([]);
    }
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
    );
    const { data, error } = await supabase
      .from('vetting_logs')
      .select('id,created_at,load_ref,dispatcher,carrier_name,dot_number,mc_number,verdict,tier,reasons,pdf_url')
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
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
    );
    const { data, error } = await supabase
      .from('vetting_logs')
      .select('*')
      .eq('id', req.params.id)
      .single();
    if (error) throw error;
    res.json(data);
  } catch (e) { next(e); }
});

export default router;
