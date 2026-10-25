-- Run this once against your Supabase project to enable forgot-password flow.
create table if not exists password_reset_tokens (
  id         bigserial    primary key,
  email      text         not null,
  token      text         not null unique,
  expires_at timestamptz  not null,
  used_at    timestamptz
);
create index if not exists idx_prt_token on password_reset_tokens(token);
create index if not exists idx_prt_email on password_reset_tokens(email);
