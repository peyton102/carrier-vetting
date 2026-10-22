import dotenv from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, '../.env') });

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function run(name, sql) {
  console.log(`\n▶ ${name}...`);
  const { error } = await sb.rpc('exec_sql', { sql }).catch(() => ({ error: { message: 'rpc not available' } }));
  if (error) {
    // Fall back to direct REST API
    const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/rpc/exec_sql`, {
      method: 'POST',
      headers: {
        'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY,
        'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ sql }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`${name} failed: ${text}`);
    }
  }
  console.log(`  ✓ done`);
}

const migrations = [
  {
    name: '1. tenant_settings table',
    sql: `
create table if not exists tenant_settings (
  tenant_slug  text primary key references tenants(slug) on delete cascade,
  basic_unsafe_driving_threshold       int      not null default 55 check (basic_unsafe_driving_threshold between 1 and 100),
  basic_crash_indicator_threshold      int      not null default 55 check (basic_crash_indicator_threshold between 1 and 100),
  basic_hos_threshold                  int      not null default 55 check (basic_hos_threshold between 1 and 100),
  basic_vehicle_maintenance_threshold  int      not null default 55 check (basic_vehicle_maintenance_threshold between 1 and 100),
  basic_driver_fitness_threshold       int      not null default 55 check (basic_driver_fitness_threshold between 1 and 100),
  basic_controlled_substance_threshold int      not null default 55 check (basic_controlled_substance_threshold between 1 and 100),
  basic_unsafe_driving_action          text     not null default 'reject' check (basic_unsafe_driving_action in ('reject','hold')),
  basic_crash_indicator_action         text     not null default 'reject' check (basic_crash_indicator_action in ('reject','hold')),
  basic_hos_action                     text     not null default 'hold' check (basic_hos_action in ('reject','hold')),
  basic_vehicle_maintenance_action     text     not null default 'hold' check (basic_vehicle_maintenance_action in ('reject','hold')),
  basic_driver_fitness_action          text     not null default 'hold' check (basic_driver_fitness_action in ('reject','hold')),
  basic_controlled_substance_action    text     not null default 'reject' check (basic_controlled_substance_action in ('reject','hold')),
  auto_liability_min                   int      not null default 1000000,
  cargo_min                            int      not null default 100000,
  authority_min_days                   int      not null default 365,
  authority_age_action                 text     not null default 'hold' check (authority_age_action in ('hold','block')),
  block_conditional                    boolean  not null default true,
  block_unsatisfactory                 boolean  not null default true,
  oos_rate_multiplier                  numeric  not null default 2.0,
  updated_at  timestamptz not null default now()
);
alter table tenant_settings enable row level security;
`
  },
  {
    name: '2. tenant_settings v2 (vehicle_driver_observed, hazmat, oos hard blocks)',
    sql: `
alter table tenant_settings
  add column if not exists basic_vehicle_driver_observed_threshold int not null default 65
    check (basic_vehicle_driver_observed_threshold between 1 and 100),
  add column if not exists basic_vehicle_driver_observed_action text not null default 'hold'
    check (basic_vehicle_driver_observed_action in ('reject','hold'));
alter table tenant_settings
  add column if not exists basic_hazmat_threshold int not null default 80
    check (basic_hazmat_threshold between 1 and 100),
  add column if not exists basic_hazmat_action text not null default 'hold'
    check (basic_hazmat_action in ('reject','hold'));
alter table tenant_settings
  add column if not exists oos_hard_block_truck  numeric not null default 35.0,
  add column if not exists oos_hard_block_driver numeric not null default 7.0;
alter table tenant_settings
  add column if not exists inspection_volume_min int not null default 3;
`
  },
  {
    name: '3. tenant_settings v3 (alert_recipients)',
    sql: `
alter table tenant_settings
  add column if not exists alert_recipients text not null default '';
`
  },
  {
    name: '4. watched_carriers_schema (used_carriers, watched_carriers, carrier_blocks)',
    sql: `
create table if not exists used_carriers (
  id                uuid        primary key default gen_random_uuid(),
  tenant_id         text        not null references tenants(slug) on delete cascade,
  used_at           timestamptz not null default now(),
  carrier_name      text,
  dot_number        text,
  mc_number         text,
  load_ref          text,
  dispatcher        text,
  verdict           text,
  tier              text,
  vetting_record_id uuid
);
alter table used_carriers enable row level security;
create policy if not exists "service_role_full_access_used_carriers" on used_carriers
  for all to service_role using (true) with check (true);
create index if not exists idx_used_carriers_tenant
  on used_carriers(tenant_id, used_at desc);

create table if not exists watched_carriers (
  id                    uuid        primary key default gen_random_uuid(),
  tenant_id             text        not null references tenants(slug) on delete cascade,
  dot_number            text        not null,
  carrier_name          text,
  mc_number             text,
  added_at              timestamptz not null default now(),
  added_by              text        not null default 'system',
  is_active             boolean     not null default true,
  last_checked_at       timestamptz,
  last_report_numbers   text[]      not null default '{}',
  last_truck_oos_pct    numeric,
  last_driver_oos_pct   numeric,
  last_inspection_count integer,
  constraint uq_watched_tenant_dot unique (tenant_id, dot_number)
);
alter table watched_carriers enable row level security;
create policy if not exists "service_role_full_access_watched" on watched_carriers
  for all to service_role using (true) with check (true);
create index if not exists idx_watched_tenant_dot_active
  on watched_carriers(tenant_id, dot_number) where is_active = true;

create table if not exists carrier_blocks (
  id                uuid        primary key default gen_random_uuid(),
  tenant_id         text        not null references tenants(slug) on delete cascade,
  dot_number        text        not null,
  carrier_name      text,
  mc_number         text,
  blocked_at        timestamptz not null default now(),
  blocked_by        text        not null default 'system',
  block_reason      text        not null,
  threshold_type    text        not null,
  threshold_value   numeric,
  actual_value      numeric,
  violation_details jsonb,
  is_active         boolean     not null default true,
  lifted_at         timestamptz,
  lifted_by         text,
  lifted_reason     text
);
alter table carrier_blocks enable row level security;
create policy if not exists "service_role_full_access_blocks" on carrier_blocks
  for all to service_role using (true) with check (true);
create index if not exists idx_blocks_tenant_dot
  on carrier_blocks(tenant_id, dot_number);
create index if not exists idx_blocks_tenant_dot_active
  on carrier_blocks(tenant_id, dot_number) where is_active = true;
`
  },
  {
    name: '5. tenant_credentials fmcsa columns',
    sql: `
alter table tenant_credentials
  add column if not exists fmcsa_webkey       text,
  add column if not exists fmcsa_configured_at timestamptz;
`
  },
];

// Use Supabase's pg REST endpoint directly
async function execSQL(sql) {
  const url = `${process.env.SUPABASE_URL}/rest/v1/`;
  // Use the pg endpoint
  const pgUrl = process.env.SUPABASE_URL.replace('https://', 'https://') + '/pg/query';
  const res = await fetch(pgUrl, {
    method: 'POST',
    headers: {
      'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: sql }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text);
  }
  return res.json();
}

for (const m of migrations) {
  console.log(`\n▶ ${m.name}...`);
  try {
    await execSQL(m.sql);
    console.log('  ✓ done');
  } catch (e) {
    console.error(`  ✗ FAILED: ${e.message}`);
    process.exit(1);
  }
}

console.log('\nAll migrations complete.');
