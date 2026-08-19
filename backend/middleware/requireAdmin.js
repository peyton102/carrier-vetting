import { createClient } from '@supabase/supabase-js';

function getSupabase() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

/**
 * Must run after requireAuth. Re-checks is_admin from DB on every request —
 * never cached in the JWT. Any authenticated non-admin gets a hard 403.
 */
export async function requireAdmin(req, res, next) {
  try {
    const { data } = await getSupabase()
      .from('tenants')
      .select('is_admin')
      .eq('slug', req.auth.tenant)
      .single();

    if (!data?.is_admin) return res.status(403).json({ error: 'Forbidden' });
    next();
  } catch {
    res.status(403).json({ error: 'Forbidden' });
  }
}
