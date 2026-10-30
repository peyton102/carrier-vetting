-- ── Enable RLS on tables that were created without it ─────────────────────────
-- monitored_loads, monitoring_alerts, password_reset_tokens
-- Safe to run twice (ENABLE ROW LEVEL SECURITY is idempotent).
-- The backend uses the service-role key which bypasses RLS on all tables,
-- so no policies are needed — RLS simply closes off anon/authenticated access.

ALTER TABLE public.monitored_loads   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.monitoring_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.password_reset_tokens ENABLE ROW LEVEL SECURITY;
