// GET /api/insurance/cancellation/:dot
// Reads from the insurance_cancellations cache table.
// "Not reviewed" = table is empty (daily refresh job has never run).
// "No pending" = table has data but no row for this DOT (job has run, carrier clean).
// Never returns false/No when we have no data.

import express from 'express';
import { createClient } from '@supabase/supabase-js';

const router = express.Router();

function getSupabase() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

function daysUntil(dateStr) {
  if (!dateStr) return null;
  const exp = new Date(dateStr + 'T00:00:00Z');
  if (isNaN(exp.getTime())) return null;
  const now = new Date();
  const todayMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.floor((exp.getTime() - todayMs) / 86_400_000);
}

router.get('/cancellation/:dot', async (req, res) => {
  const dot = req.params.dot.replace(/\D/g, '');
  if (!dot) return res.status(400).json({ error: 'Invalid DOT number' });

  try {
    const supabase = getSupabase();

    // Check if the table has ever been populated (daily job has run at least once)
    const { count, error: countErr } = await supabase
      .from('insurance_cancellations')
      .select('*', { count: 'exact', head: true });

    if (countErr) throw countErr;

    if (!count) {
      // Table empty — job has never run; cannot confirm "No"
      return res.json({ notReviewed: true });
    }

    const { data: row, error: rowErr } = await supabase
      .from('insurance_cancellations')
      .select('*')
      .eq('dot_number', dot)
      .maybeSingle();

    if (rowErr) throw rowErr;

    if (!row) {
      return res.json({ bipdCancelPending: false, bipdCancelLapsed: false });
    }

    if (row.status === 'lapsed') {
      return res.json({
        bipdCancelPending:   false,
        bipdCancelLapsed:    true,
        effectiveDate:       row.effective_date,
        insuranceCompany:    row.insurance_company,
      });
    }

    return res.json({
      bipdCancelPending:   true,
      bipdCancelLapsed:    false,
      effectiveDate:       row.effective_date,
      transDate:           row.trans_date,
      insuranceCompany:    row.insurance_company,
      daysUntil:           daysUntil(row.effective_date),
    });
  } catch (e) {
    console.error('[INSURANCE] cancellation lookup error:', e.message);
    // On error return notReviewed — never silently pass
    return res.json({ notReviewed: true });
  }
});

export default router;
