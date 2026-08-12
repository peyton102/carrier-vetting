/**
 * Bootstrap a new tenant (org + user).
 * Usage: node backend/scripts/create-user.js
 *
 * Reads from .env in the project root.
 */

import { resolve, dirname } from 'path';
import { fileURLToPath }    from 'url';
import { createInterface }  from 'readline';
import dotenv               from 'dotenv';
import bcrypt               from 'bcryptjs';
import { createClient }     from '@supabase/supabase-js';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, '../../.env') });

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise(r => rl.question(q, r));

async function main() {
  console.log('\n── Create tenant ────────────────────────────────\n');

  const name     = await ask('Organization / display name (e.g. Precision Transport): ');
  const slug     = await ask('Tenant slug — lowercase, hyphens only (e.g. precision-transport): ');
  const email    = await ask('Login email: ');
  const password = await ask('Login password: ');
  rl.close();

  const password_hash = await bcrypt.hash(password.trim(), 10);

  const { data: tenant, error } = await supabase
    .from('tenants')
    .insert({
      slug:  slug.trim().toLowerCase(),
      email: email.trim().toLowerCase(),
      name:  name.trim(),
      password_hash,
    })
    .select('slug, email, name')
    .single();

  if (error) {
    console.error('\nFailed to create tenant:', error.message);
    process.exit(1);
  }

  console.log(`\nTenant created:`);
  console.log(`  Name:  ${tenant.name}`);
  console.log(`  Slug:  ${tenant.slug}`);
  console.log(`  Email: ${tenant.email}`);
  console.log('\nDone. You can now sign in at http://localhost:3002\n');
}

main().catch(e => { console.error(e); process.exit(1); });
