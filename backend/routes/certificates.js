import express from 'express';
import { createClient } from '@supabase/supabase-js';
import { ZipArchive } from 'archiver';

const router = express.Router();

const BUCKET        = 'vetting-certificates';
const BUCKET_BACKUP = 'vetting-certificates-backup';
const SIGNED_SECS   = 3600; // signed URL valid for 1 hour

function getSupabase() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

// ── GET /api/certificates — list org's certificates ───────────────────────────
// Queries vetting_logs (which has pdf_sha256) instead of the certificates
// denormalization table, filtering to records with an uploaded PDF.
router.get('/', async (req, res, next) => {
  try {
    const { data, error } = await getSupabase()
      .from('vetting_logs')
      .select('id, created_at, carrier_name, dot_number, mc_number, verdict, pdf_url, pdf_sha256')
      .eq('tenant_id', req.auth.tenant)
      .not('pdf_url', 'is', null)
      .order('created_at', { ascending: false })
      .limit(200);
    if (error) throw error;
    // expose pdf_url as storage_path so the download endpoint still works
    res.json(data.map(r => ({ ...r, storage_path: r.pdf_url })));
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

// ── GET /api/certificates/export — download ZIP of all records ────────────────
// ZIP contains: pdfs/<filename>.pdf for each record, records.csv, README.txt.
// Canceled accounts are allowed to export.
router.get('/export', async (req, res, next) => {
  try {
    const supabase = getSupabase();
    const orgId    = req.auth.tenant;

    const [logsResult, overridesResult] = await Promise.all([
      supabase
        .from('vetting_logs')
        .select('id,created_at,load_ref,dispatcher,carrier_name,dot_number,mc_number,verdict,tier,reasons,dispatcher_edits,pdf_url,pdf_sha256,rules_version')
        .eq('tenant_id', orgId)
        .order('created_at', { ascending: false }),
      supabase
        .from('vetting_overrides')
        .select('record_id,manager,reason,override_at')
        .eq('tenant_id', orgId),
    ]);
    if (logsResult.error) throw logsResult.error;

    // Build override map (most recent wins)
    const overrideMap = {};
    for (const ov of (overridesResult.data ?? [])) {
      const ex = overrideMap[ov.record_id];
      if (!ex || ov.override_at > ex.override_at) overrideMap[ov.record_id] = ov;
    }

    const rows   = logsResult.data ?? [];
    const now    = new Date().toISOString();
    const dateStr = now.slice(0, 10);

    // Stream the ZIP directly to the response — no full-buffer accumulation.
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="torevez-export-${dateStr}.zip"`);

    const archive = new ZipArchive({ zlib: { level: 6 } });
    archive.pipe(res);

    // Handle archiver errors so they don't go unhandled
    archive.on('error', e => {
      console.error('[EXPORT ZIP ERROR]', e.message);
      // res may already be partially sent; just destroy
      res.destroy(e);
    });

    // Build CSV
    const csvVal = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const csvHeader = [
      'Date', 'Load Ref', 'Dispatcher', 'Carrier Name', 'DOT', 'MC',
      'Verdict', 'Reasons', 'Override Manager', 'Override Reason', 'Override Time',
      'Dispatcher Edits', 'PDF Fingerprint', 'Rules Version', 'Record ID',
    ].join(',');
    const csvRows = rows.map(row => {
      const ov      = overrideMap[row.id];
      const verdict = ov ? 'APPROVED WITH OVERRIDE' : row.verdict;
      const reasons = (row.reasons ?? []).join('; ');
      const edits   = row.dispatcher_edits
        ? Object.entries(row.dispatcher_edits)
            .map(([k, v]) => `${k}: ${v.submitted} (was ${v.original})`)
            .join('; ')
        : '';
      return [
        csvVal(new Date(row.created_at).toISOString()),
        csvVal(row.load_ref),
        csvVal(row.dispatcher),
        csvVal(row.carrier_name),
        csvVal(row.dot_number),
        csvVal(row.mc_number),
        csvVal(verdict),
        csvVal(reasons),
        csvVal(ov?.manager ?? ''),
        csvVal(ov?.reason ?? ''),
        csvVal(ov?.override_at ?? ''),
        csvVal(edits),
        csvVal(row.pdf_sha256 ?? ''),
        csvVal(row.rules_version ?? ''),
        csvVal(row.id),
      ].join(',');
    });
    archive.append([csvHeader, ...csvRows].join('\n'), { name: 'records.csv' });

    // README
    archive.append([
      'Torevez Carrier Vetting Export',
      '================================',
      `Generated: ${now}`,
      `Tenant:    ${orgId}`,
      '',
      'Contents',
      '--------',
      'records.csv  — All vetting records for this account.',
      'pdfs/        — Original PDF certificates. Each PDF is stored exactly as it',
      '               was generated and uploaded.',
      '',
      'Verifying a PDF',
      '---------------',
      'Each row in records.csv has a "PDF Fingerprint" column containing the',
      'SHA-256 hash of the original PDF file. To verify a PDF has not been',
      'tampered with, compute its SHA-256 and compare to the fingerprint.',
      '',
      'Windows (PowerShell):',
      '  Get-FileHash pdfs\\<filename>.pdf -Algorithm SHA256',
      '',
      'macOS / Linux:',
      '  shasum -a 256 pdfs/<filename>.pdf',
      '',
      'The hash must match exactly (case-insensitive).',
    ].join('\n'), { name: 'README.txt' });

    // Download each PDF and append as it arrives — one buffer in memory at a time.
    for (const row of rows) {
      if (!row.pdf_url) continue;
      const filename = row.pdf_url.split('/').pop();
      let buf = null;
      for (const bucket of [BUCKET, BUCKET_BACKUP]) {
        if (buf) break;
        try {
          const { data: blob, error: dlErr } = await supabase.storage
            .from(bucket).download(row.pdf_url);
          if (!dlErr && blob) buf = Buffer.from(await blob.arrayBuffer());
        } catch (e) {
          console.error('[EXPORT PDF]', row.id, bucket, e.message);
        }
      }
      if (buf) {
        archive.append(buf, { name: `pdfs/${filename}` });
      } else {
        console.warn('[EXPORT PDF MISSING]', row.id, row.pdf_url);
      }
    }

    await archive.finalize();
  } catch (e) { next(e); }
});

export default router;
