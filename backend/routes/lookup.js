// ── POST /api/lookup ──────────────────────────────────────────────────────────
// Combined FMCSA + SaferWatch + insurance + chameleon lookup.
// Saves all raw results + merged auto-filled values to carrier_lookups (insert-only).
// Returns lookupId + all data the browser needs to populate the vetting form.
//
// /run requires the lookupId from this endpoint and uses the server's saved values
// for all auto-filled fields — the browser cannot spoof them.

import express                    from 'express';
import { randomUUID }             from 'crypto';
import { createClient }           from '@supabase/supabase-js';
import { fmcsaDotLookup, fmcsaMcLookup, getWebKey } from './fmcsa.js';
import { swLookup }               from './saferwatch.js';
import { insuranceLookup }        from './insurance.js';
import { chameleonLookup }        from './chameleon.js';
import { mergeResults }           from '../lib/lookup_merge.js';

const router = express.Router();
const LOOKUP_MAX_AGE_MS  = 24 * 60 * 60 * 1000;
const CHAMELEON_CAP_MS   = 12_000;

function getSupabase() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

// ── POST /api/lookup ─────────────────────────────────────────────────────────
router.post('/', async (req, res, next) => {
  try {
    const { dot: rawDot, mc: rawMc } = req.body;
    const tenantSlug = req.auth.tenant;

    if (!rawDot && !rawMc) {
      return res.status(400).json({ error: 'dot or mc is required' });
    }

    const webKey = getWebKey();
    if (!webKey) {
      return res.status(503).json({ error: 'FMCSA web key not configured — set FMCSA_WEBKEY in .env' });
    }

    // ── 1. FMCSA lookup (DOT or MC) ──────────────────────────────────────────
    let fmcsa = null;
    let fmcsaCannotVerify = false;
    let resolvedDot = rawDot ? rawDot.replace(/\D/g, '') : null;

    try {
      if (rawMc) {
        const mc = String(rawMc).replace(/^(MC|FF)/i, '').replace(/\D/g, '');
        fmcsa = await fmcsaMcLookup(mc, webKey);
        resolvedDot = String(fmcsa.dotNumber ?? '').replace(/\D/g, '') || resolvedDot;
      } else {
        fmcsa = await fmcsaDotLookup(resolvedDot, webKey);
      }
    } catch (e) {
      if (e.name === 'TimeoutError' || e.name === 'AbortError' ||
          e?.code === 'ECONNRESET' || e?.code === 'ENOTFOUND' || e?.code === 'ECONNREFUSED') {
        fmcsaCannotVerify = true;
        fmcsa = { cannotVerify: true, lastAttemptAt: new Date().toISOString(), error: e.message };
      } else if (e.httpStatus === 404) {
        return res.status(404).json({ error: e.message });
      } else {
        throw e;
      }
    }

    if (!resolvedDot) {
      return res.status(400).json({ error: 'Could not resolve a DOT number from the lookup' });
    }

    // ── 2. SaferWatch + insurance + chameleon in parallel ─────────────────────
    // Chameleon is capped at 12s so a runaway Socrata call never blocks /run.
    const chameleonCapped = Promise.race([
      chameleonLookup(resolvedDot, tenantSlug),
      new Promise(resolve =>
        setTimeout(() => resolve({ notReviewed: true, timedOut: true }), CHAMELEON_CAP_MS)
      ),
    ]);
    const [sw, insurance, chameleon] = await Promise.allSettled([
      swLookup(resolvedDot, 'dot', tenantSlug),
      insuranceLookup(resolvedDot, getSupabase()),
      chameleonCapped,
    ]).then(results => results.map(r => r.status === 'fulfilled' ? r.value : null));

    // ── 3. Merge results (server-side applyLookupResults equivalent) ──────────
    const { autoFilled, fieldSources, serverFields } = mergeResults({
      fmcsa:      fmcsaCannotVerify ? null : fmcsa,
      sw,
      insurance,
      chameleon,
    });

    // ── 4. Save to carrier_lookups ────────────────────────────────────────────
    const lookupId = randomUUID();
    const supabase = getSupabase();
    const { error: insertErr } = await supabase
      .from('carrier_lookups')
      .insert({
        id:                  lookupId,
        tenant_id:           tenantSlug,
        dot_number:          resolvedDot,
        raw_fmcsa:           fmcsa,
        raw_saferwatch:      sw,
        raw_insurance:       insurance,
        raw_chameleon:       chameleon,
        auto_filled:         autoFilled,
        field_sources:       fieldSources,
        server_fields:       serverFields,
        fmcsa_cannot_verify: fmcsaCannotVerify,
      });

    if (insertErr) {
      console.error('[LOOKUP] Failed to save carrier_lookups row:', insertErr.message);
      // Non-fatal only if DB isn't configured (dev without supabase) — otherwise rethrow
      if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) throw insertErr;
    }

    // ── 5. Return combined payload ────────────────────────────────────────────
    // The browser receives: lookupId + raw source responses (same shape as individual routes)
    // so the existing applyLookupResults() in the frontend can process them unchanged.
    res.json({
      lookupId,
      fmcsa:              fmcsaCannotVerify ? null : fmcsa,
      fmcsaCannotVerify,
      fmcsaLastAttemptAt: fmcsaCannotVerify ? fmcsa?.lastAttemptAt ?? null : null,
      sw,
      insurance,
      chameleon,
    });

  } catch (e) { next(e); }
});

// ── GET /api/lookup/:id — verify a lookup is still valid ──────────────────────
// Used by /run to validate before accepting a submission. Also available to the
// browser for sanity checks (is my lookupId still fresh?).
router.get('/:id', async (req, res, next) => {
  try {
    const supabase = getSupabase();
    const { data: row, error } = await supabase
      .from('carrier_lookups')
      .select('id, dot_number, created_at, fmcsa_cannot_verify')
      .eq('id', req.params.id)
      .eq('tenant_id', req.auth.tenant)
      .single();

    if (error || !row) return res.status(404).json({ error: 'Lookup not found' });
    const ageMs = Date.now() - new Date(row.created_at).getTime();
    res.json({ id: row.id, dotNumber: row.dot_number, createdAt: row.created_at, fresh: ageMs < LOOKUP_MAX_AGE_MS });
  } catch (e) { next(e); }
});

export { LOOKUP_MAX_AGE_MS };
export default router;
