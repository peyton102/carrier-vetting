-- ── Immutable Certificate Storage ────────────────────────────────────────────
-- Run this in the Supabase SQL editor after vetting_schema.sql.
--
-- BUCKET SETUP (do this in the Supabase dashboard before deploying):
--   Storage → New bucket
--   Name: vetting-certificates
--   Public: OFF (private)
--   No other settings needed — the backend uses the service role key.

create table if not exists certificates (
  id           uuid        primary key,             -- set by backend (recordId from PDF route)
  created_at   timestamptz not null default now(),  -- always server-set; never sent by client
  org_id       text        not null,                -- tenant slug from JWT (req.auth.tenant)
  carrier_name text,
  dot_number   text,
  mc_number    text,
  verdict      text        not null
               check (verdict in ('APPROVE','HOLD','REJECT','APPROVED WITH OVERRIDE')),
  storage_path text        not null                 -- "{org_id}/{id}/{filename}.pdf"
);

create index if not exists certificates_org_created_idx on certificates (org_id, created_at desc);
create index if not exists certificates_dot_idx         on certificates (dot_number);

-- Enable RLS. The backend uses the service role key which bypasses RLS,
-- so triggers (below) are the actual enforcement layer for immutability.
alter table certificates enable row level security;

-- ── Immutability triggers — block UPDATE and DELETE for everyone ──────────────
-- BEFORE triggers abort the operation before it touches any data.
-- They fire regardless of role, including service role.

create or replace function fn_certificates_immutable()
returns trigger language plpgsql security definer as $$
begin
  raise exception 'certificates are immutable — modifications are not allowed';
end;
$$;

create trigger trg_certificates_no_update
  before update on certificates
  for each row execute function fn_certificates_immutable();

create trigger trg_certificates_no_delete
  before delete on certificates
  for each row execute function fn_certificates_immutable();

comment on table certificates is
  'Write-once certificate index for vetting PDFs stored in Supabase Storage. '
  'One row per vetting run. UPDATE and DELETE are blocked at the trigger level '
  'for all roles including the service role. Storage bucket: vetting-certificates.';
