import express from 'express';
import { randomUUID } from 'crypto';
import { createClient } from '@supabase/supabase-js';
import { runVettingRules, RULES_VERSION } from '../lib/rules_engine.js';
import { generateVettingPDF } from '../lib/pdf_generator.js';
import { fetchSettings } from '../lib/settings.js';

const router = express.Router();

function getSupabase() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

async function getTenantName(slug) {
  const { data } = await getSupabase()
    .from('tenants').select('name').eq('slug', slug).single();
  return data?.name ?? slug;
}

// ── Required-field validation ─────────────────────────────────────────────────
function validateCarrierData(d) {
  if (!d?.loadRef?.trim())      return 'loadRef is required';
  if (!d?.dispatcher?.trim())   return 'dispatcher is required';
  if (!d?.dotNumber?.trim())    return 'dotNumber is required';
  if (!d?.contactPhone?.trim()) return 'contactPhone is required';
  if (!d?.contactEmail?.trim()) return 'contactEmail is required';
  // fmcsaCannotVerify is an acceptable substitute for a completed lookup
  if (!d?.fmcsaLookupCompleted && !d?.fmcsaCannotVerify)
    return 'FMCSA lookup must be completed before running vetting';
  return null;
}

// ── POST /api/vetting/run ─────────────────────────────────────────────────────
// Validate → run rules → write authoritative DB record → return verdict + recordId.
// /pdf reads from this record; it never trusts client-supplied verdict fields.
router.post('/run', async (req, res, next) => {
  try {
    const err = validateCarrierData(req.body);
    if (err) return res.status(400).json({ error: err });

    const orgId  = req.auth.tenant;
    const cfg    = await fetchSettings(orgId);
    const result = runVettingRules(req.body, cfg);

    const recordId = randomUUID();
    const supabase = getSupabase();

    // Insert authoritative record. pdf_url is null here; /pdf fills it in.
    const { error: logErr } = await supabase
      .from('vetting_logs')
      .insert({
        id:            recordId,
        tenant_id:     orgId,
        load_ref:      req.body.loadRef,
        dispatcher:    req.body.dispatcher,
        carrier_name:  req.body.carrierName  || null,
        dot_number:    req.body.dotNumber    || null,
        mc_number:     req.body.mcNumber     || null,
        verdict:       result.verdict,
        tier:          result.tier,
        reasons:       result.reasons,
        warnings:      result.warnings ?? [],
        carrier_data:  req.body,
        rules_version: RULES_VERSION,
      });
    if (logErr) throw logErr;

    // certificates row (non-fatal — vetting_logs is the authoritative audit record)
    getSupabase()
      .from('certificates')
      .insert({
        id:           recordId,
        org_id:       orgId,
        carrier_name: req.body.carrierName || null,
        dot_number:   req.body.dotNumber   || null,
        mc_number:    req.body.mcNumber    || null,
        verdict:      result.verdict,
      })
      .then(({ error }) => { if (error) console.warn('[CERT INSERT]', error.message); });

    res.json({ ...result, recordId });
  } catch (e) { next(e); }
});

// ── POST /api/vetting/pdf ─────────────────────────────────────────────────────
// Reads the stored vetting record by ID — never trusts client-supplied verdict.
// Generates and delivers the PDF. Uploads to storage. Updates pdf_url + override in DB.
// The immutability trigger allows this one-time update (NULL → non-null pdf_url).
// PDF delivery is always attempted regardless of storage/DB errors.
router.post('/pdf', async (req, res, next) => {
  try {
    const { recordId, fieldSources, override } = req.body;
    const orgId = req.auth.tenant;

    if (!recordId) return res.status(400).json({ error: 'recordId is required' });

    const supabase = getSupabase();

    // Fetch the authoritative record — verdict and carrier data come from here only
    const { data: row, error: fetchErr } = await supabase
      .from('vetting_logs')
      .select('*')
      .eq('id', recordId)
      .eq('tenant_id', orgId)
      .single();
    if (fetchErr || !row) return res.status(404).json({ error: 'Vetting record not found' });

    if (row.pdf_url) {
      return res.status(409).json({ error: 'PDF already generated for this record — use GET /logs/:id/pdf to re-download' });
    }

    const carrierData = row.carrier_data || {};
    const dot = carrierData.dotNumber ? String(carrierData.dotNumber).replace(/\W/g, '') : null;

    // Override eligibility is enforced server-side — tier must be YELLOW (HOLD).
    // A REJECT record may never be overridden; return an error immediately.
    const overrideRequested = !!(override?.managerName?.trim()) && !!(override?.reason?.trim());
    if (overrideRequested && row.tier !== 'YELLOW') {
      return res.status(400).json({
        error: `Override not permitted: record is ${row.tier} (${row.verdict}). Override is only allowed on HOLD records.`,
      });
    }
    const applyOverride = overrideRequested && row.tier === 'YELLOW';
    const finalVerdict = applyOverride ? 'APPROVED WITH OVERRIDE' : row.verdict;

    const [cfg, brokerName, usedCountResult] = await Promise.all([
      fetchSettings(orgId),
      getTenantName(orgId),
      dot
        ? supabase
            .from('used_carriers')
            .select('id', { count: 'exact', head: true })
            .eq('tenant_id', orgId)
            .eq('dot_number', dot)
        : Promise.resolve({ count: 0 }),
    ]);
    const timesUsed = usedCountResult?.count ?? 0;

    // authorityDays as-of the original run timestamp
    const generatedAt = new Date(row.created_at);
    const authorityDays = carrierData.authorityGrantDate
      ? Math.floor((generatedAt - new Date(carrierData.authorityGrantDate)) / 86_400_000)
      : null;

    const pdfBuffer = await generateVettingPDF({
      carrierData,
      verdict:      finalVerdict,
      tier:         row.tier,
      reasons:      row.reasons  ?? [],
      warnings:     row.warnings ?? [],
      authorityDays,
      override:     applyOverride ? override : null,
      generatedAt,
      recordId:     row.id,
      settings:     cfg,
      brokerName,
      timesUsed,
      fieldSources: fieldSources ?? {},
    });

    const loadRef     = (row.load_ref || 'NOREF').replace(/\W/g, '');
    const dateStr     = generatedAt.toISOString().replace(/[-:]/g, '').replace('T', '_').slice(0, 15);
    const filename    = `VettingCert_${dot || 'NODOT'}_${loadRef}_${dateStr}.pdf`;
    const storagePath = `${orgId}/${recordId}/${filename}`;

    // ── Storage upload ────────────────────────────────────────────────────────
    let certSaved = false;
    let certError = null;
    try {
      const { error: uploadErr } = await supabase.storage
        .from('vetting-certificates')
        .upload(storagePath, pdfBuffer, { contentType: 'application/pdf', upsert: false });
      if (uploadErr) throw new Error(`Storage: ${uploadErr.message}`);
      certSaved = true;
    } catch (e) {
      certError = e.message;
      console.error('[CERT STORAGE ERROR]', e.message);
    }

    // ── DB update: ONLY pdf_url (trigger allows NULL → non-null once) ─────────
    // vetting_logs.verdict never changes after insert.
    if (certSaved) {
      const { error: updErr } = await supabase
        .from('vetting_logs')
        .update({ pdf_url: storagePath })
        .eq('id', recordId)
        .eq('tenant_id', orgId);

      if (updErr) {
        certSaved = false;
        certError = `DB update failed: ${updErr.message}`;
        console.error('[CERT DB UPDATE ERROR]', updErr.message);
      }
    }

    // ── Override insert — FATAL ───────────────────────────────────────────────
    // If writing to vetting_overrides fails the cert is NOT delivered.
    // The storage file stays; the dispatcher must re-submit (pdf_url remains null).
    if (certSaved && applyOverride) {
      const { error: ovErr } = await supabase.from('vetting_overrides').insert({
        record_id:         recordId,
        tenant_id:         orgId,
        manager:           override.managerName.trim(),
        reason:            override.reason.trim(),
        resulting_verdict: 'APPROVED WITH OVERRIDE',
      });
      if (ovErr) {
        console.error('[OVERRIDE INSERT FATAL]', ovErr.message);
        return res.status(500).json({
          error: `Override record could not be saved: ${ovErr.message}. Certificate not issued — re-submit to try again.`,
        });
      }
    }

    // Update certificates table (non-fatal)
    if (certSaved) {
      supabase.from('certificates')
        .update({ storage_path: storagePath, verdict: finalVerdict })
        .eq('id', recordId).eq('org_id', orgId)
        .then(({ error }) => { if (error) console.warn('[CERT PATH UPDATE]', error.message); });
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('X-Record-Id',     recordId);
    res.setHeader('X-Verdict',       finalVerdict);
    res.setHeader('X-Tier',          row.tier);
    res.setHeader('X-Filename',      filename);
    res.setHeader('X-Cert-Saved',    String(certSaved));
    res.setHeader('X-Storage-Path',  certSaved ? storagePath : '');
    res.setHeader('X-Cert-Error',    certError ? certError.replace(/[\r\n]/g, ' ').slice(0, 200) : '');
    res.setHeader('Access-Control-Expose-Headers',
      'X-Record-Id, X-Verdict, X-Tier, X-Filename, X-Cert-Saved, X-Storage-Path, X-Cert-Error');

    res.send(pdfBuffer);
  } catch (e) { next(e); }
});

// ── GET /api/vetting/logs ─────────────────────────────────────────────────────
router.get('/logs', async (req, res, next) => {
  try {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      return res.json([]);
    }
    const supabase = getSupabase();
    const orgId    = req.auth.tenant;

    const [logsResult, overridesResult] = await Promise.all([
      supabase
        .from('vetting_logs')
        .select('id,created_at,load_ref,dispatcher,carrier_name,dot_number,mc_number,verdict,tier,reasons,pdf_url,rules_version,override_manager')
        .eq('tenant_id', orgId)
        .order('created_at', { ascending: false })
        .limit(200),
      supabase
        .from('vetting_overrides')
        .select('record_id,resulting_verdict,manager,reason,override_at')
        .eq('tenant_id', orgId),
    ]);

    if (logsResult.error) throw logsResult.error;

    // Build a map of record_id → override (most recent wins if multiple)
    const overrideMap = {};
    for (const ov of (overridesResult.data ?? [])) {
      const existing = overrideMap[ov.record_id];
      if (!existing || ov.override_at > existing.override_at) {
        overrideMap[ov.record_id] = ov;
      }
    }

    const rows = (logsResult.data ?? []).map(row => {
      const ov = overrideMap[row.id];
      const effective_verdict = ov?.resulting_verdict
        ?? (row.override_manager ? 'APPROVED WITH OVERRIDE' : row.verdict);
      return { ...row, effective_verdict };
    });

    res.json(rows);
  } catch (e) { next(e); }
});

// ── GET /api/vetting/logs/:id/pdf ─────────────────────────────────────────────
// Serves the original stored file. If unavailable, regenerates from stored record.
// Stored verdict is always used — current rules are NEVER re-run.
router.get('/logs/:id/pdf', async (req, res, next) => {
  try {
    const orgId    = req.auth.tenant;
    const supabase = getSupabase();

    const { data: row, error } = await supabase
      .from('vetting_logs')
      .select('*')
      .eq('id', req.params.id)
      .eq('tenant_id', orgId)
      .single();
    if (error || !row) return res.status(404).json({ error: 'Vetting record not found' });

    const carrierData  = row.carrier_data || {};
    const originalDate = new Date(row.created_at);
    const dot     = (carrierData.dotNumber || 'NODOT').replace(/\W/g, '');
    const loadRef = (row.load_ref          || 'NOREF').replace(/\W/g, '');
    const dateStr = originalDate.toISOString().replace(/[-:]/g, '').replace('T', '_').slice(0, 15);
    const filename = `VettingCert_${dot}_${loadRef}_${dateStr}.pdf`;

    // Try original stored file first
    if (row.pdf_url) {
      const { data: fileBlob, error: dlErr } = await supabase.storage
        .from('vetting-certificates')
        .download(row.pdf_url);
      if (!dlErr && fileBlob) {
        const buf = Buffer.from(await fileBlob.arrayBuffer());
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.setHeader('X-Filename',      filename);
        res.setHeader('X-Cert-Source',   'original');
        res.setHeader('X-Rules-Version', row.rules_version || 'pre-v4');
        res.setHeader('Access-Control-Expose-Headers', 'X-Filename, X-Cert-Source, X-Rules-Version');
        return res.send(buf);
      }
      console.warn(`[CERT] Storage download failed for ${row.pdf_url}: ${dlErr?.message}`);
    }

    // Regenerate from stored record using the stored verdict (no rules re-run)
    const authorityDays = carrierData.authorityGrantDate
      ? Math.floor((originalDate - new Date(carrierData.authorityGrantDate)) / 86_400_000)
      : null;

    // Read override from vetting_overrides (new arch); fall back to legacy columns
    const { data: ovRows } = await supabase
      .from('vetting_overrides')
      .select('manager,reason,resulting_verdict,override_at')
      .eq('record_id', row.id)
      .eq('tenant_id', orgId)
      .order('override_at', { ascending: false })
      .limit(1);
    const ovRow = ovRows?.[0] ?? null;

    const effectiveVerdict = ovRow?.resulting_verdict
      ?? (row.override_manager ? 'APPROVED WITH OVERRIDE' : row.verdict);

    const override = ovRow
      ? { managerName: ovRow.manager, reason: ovRow.reason }
      : (row.override_manager && row.override_reason)
        ? { managerName: row.override_manager, reason: row.override_reason }
        : null;

    const [cfg, brokerName, usedCountResult] = await Promise.all([
      fetchSettings(orgId),
      getTenantName(orgId),
      carrierData.dotNumber
        ? supabase
            .from('used_carriers')
            .select('id', { count: 'exact', head: true })
            .eq('tenant_id', orgId)
            .eq('dot_number', String(carrierData.dotNumber).replace(/\W/g, ''))
        : Promise.resolve({ count: 0 }),
    ]);
    const timesUsed = usedCountResult?.count ?? 0;

    const pdfBuffer = await generateVettingPDF({
      carrierData,
      verdict:      effectiveVerdict,
      tier:         row.tier,
      reasons:      row.reasons  ?? [],
      warnings:     row.warnings ?? [],
      authorityDays,
      override,
      generatedAt:  originalDate,
      recordId:     row.id,
      settings:     cfg,
      brokerName,
      timesUsed,
      fieldSources: {},
      reissued:     true,
      reissuedAt:   new Date(),
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('X-Filename',      filename);
    res.setHeader('X-Cert-Source',   'reissued');
    res.setHeader('X-Rules-Version', row.rules_version || 'pre-v4');
    res.setHeader('Access-Control-Expose-Headers', 'X-Filename, X-Cert-Source, X-Rules-Version');
    res.send(pdfBuffer);
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
// Effective verdict is read from DB — client-supplied verdict field is ignored.
// REJECT and HOLD (without approved override) are blocked server-side.
// Auto-adds DOT to watched_carriers.
router.post('/mark-used', async (req, res) => {
  const { carrierName, dotNumber, mcNumber, loadRef, dispatcher, vettingRecordId } = req.body;
  const orgId    = req.auth.tenant;
  const supabase = getSupabase();

  try {
    if (!vettingRecordId) {
      return res.status(400).json({ ok: false, error: 'vettingRecordId is required' });
    }

    // Read effective verdict from DB — never trust client-supplied verdict
    const [logResult, overrideResult] = await Promise.all([
      supabase
        .from('vetting_logs')
        .select('verdict, tier, override_manager')
        .eq('id', vettingRecordId)
        .eq('tenant_id', orgId)
        .single(),
      supabase
        .from('vetting_overrides')
        .select('resulting_verdict')
        .eq('record_id', vettingRecordId)
        .eq('tenant_id', orgId)
        .order('override_at', { ascending: false })
        .limit(1),
    ]);

    if (logResult.error || !logResult.data) {
      return res.status(404).json({ ok: false, error: 'Vetting record not found' });
    }

    const logRow          = logResult.data;
    const ovRow           = overrideResult.data?.[0] ?? null;
    const effectiveVerdict = ovRow?.resulting_verdict
      ?? (logRow.override_manager ? 'APPROVED WITH OVERRIDE' : logRow.verdict);

    if (effectiveVerdict === 'REJECT') {
      return res.status(400).json({ ok: false, error: 'REJECT verdict — carrier cannot be booked' });
    }
    if (effectiveVerdict === 'HOLD') {
      return res.status(400).json({ ok: false, error: 'HOLD verdict requires manager override before booking' });
    }

    const { data, error } = await supabase
      .from('used_carriers')
      .insert({
        tenant_id:         orgId,
        carrier_name:      carrierName     || null,
        dot_number:        dotNumber       || null,
        mc_number:         mcNumber        || null,
        load_ref:          loadRef           || null,
        dispatcher:        dispatcher        || null,
        verdict:           effectiveVerdict  || null,
        tier:              logRow.tier       || null,
        vetting_record_id: vettingRecordId   || null,
      })
      .select('id, used_at')
      .single();
    if (error) throw new Error(error.message);

    // Auto-add to watched_carriers (non-fatal)
    if (dotNumber) {
      supabase
        .from('watched_carriers')
        .upsert({
          tenant_id:    orgId,
          dot_number:   String(dotNumber),
          carrier_name: carrierName || null,
          mc_number:    mcNumber    || null,
          added_by:     dispatcher  || 'system',
          is_active:    true,
        }, { onConflict: 'tenant_id,dot_number' })
        .then(({ error: watchErr }) => {
          if (watchErr) console.warn('[WATCH] Could not auto-watch DOT', dotNumber, watchErr.message);
        });
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
