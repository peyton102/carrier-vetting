-- ── Permanent admin seed ──────────────────────────────────────────────────────
-- Run once after admin_schema.sql. Safe to re-run (idempotent).
-- Ensures this account is always is_admin = true regardless of how it was created.

UPDATE tenants
SET    is_admin = true
WHERE  email    = 'maddenp0706@gmail.com';
