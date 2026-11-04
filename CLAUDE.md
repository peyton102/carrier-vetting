# Claude Code Rules — carrier-vetting

## Testing

- Never send requests to the production backend or production database for testing.
- Test only through the real app UI on the **Test Brokerage** tenant, or a separate test database explicitly set up for the purpose.
- Never forge JWTs or use secrets from `.env` to call live APIs directly.
- While carrier-vetting has no real customers, testing is still restricted to the Test Brokerage tenant — never a made-up or ad-hoc tenant slug.

## Database

- Never run SQL against production directly. Provide any SQL for the user to review and run themselves (Supabase SQL editor).
- Never write SQL that disables or bypasses triggers (e.g. `ALTER TABLE ... DISABLE TRIGGER`, `SET session_replication_role = replica`).
- Never use the Supabase MCP `execute_sql` tool against the production project for writes, deletes, or schema changes without explicit user confirmation.

## Code changes

- One logical change at a time. Generate a test PDF locally (using the local test script pattern) before pushing when pdf_generator.js is modified.
- Never start the production server locally and fire requests at it for testing.

## freeuptime repo

- Never touch the production database or API for testing, ever — not even reads that could have side effects.
