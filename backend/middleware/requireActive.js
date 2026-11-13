import { createClient } from '@supabase/supabase-js';

function getSupabase() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

// Checks is_canceled from the database on each request so cancellation takes
// effect immediately without waiting for the JWT to expire.
// Fails open on a transient DB error — better to allow a request through than
// to block all users during a Supabase outage.
export async function requireActive(req, res, next) {
  try {
    const { data } = await getSupabase()
      .from('tenants')
      .select('is_canceled')
      .eq('slug', req.auth.tenant)
      .single();
    if (data?.is_canceled) {
      return res.status(403).json({ error: 'Account canceled — contact support to renew.' });
    }
    next();
  } catch (e) {
    console.error('[requireActive] DB check failed, failing open:', e.message);
    next();
  }
}
