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
  console.log('\n── Create tenant + user ─────────────────────────\n');

  const orgName  = await ask('Organization name (e.g. Precision Freight): ');
  const orgSlug  = await ask('Organization slug (e.g. precision-freight): ');
  const userName = await ask('User full name: ');
  const email    = await ask('User email: ');
  const password = await ask('User password: ');
  const role     = (await ask('Role [admin/dispatcher] (default: admin): ')).trim() || 'admin';
  rl.close();

  // Create org
  const { data: org, error: orgErr } = await supabase
    .from('organizations')
    .insert({ name: orgName.trim(), slug: orgSlug.trim() })
    .select('id, name')
    .single();

  if (orgErr) {
    console.error('\nFailed to create org:', orgErr.message);
    process.exit(1);
  }
  console.log(`\nOrg created: ${org.name} (${org.id})`);

  // Hash password
  const password_hash = await bcrypt.hash(password, 10);

  // Create user
  const { data: user, error: userErr } = await supabase
    .from('users')
    .insert({ org_id: org.id, email: email.trim().toLowerCase(), password_hash, name: userName.trim(), role })
    .select('id, email, name, role')
    .single();

  if (userErr) {
    console.error('\nFailed to create user:', userErr.message);
    process.exit(1);
  }

  console.log(`User created: ${user.name} <${user.email}> role=${user.role}`);
  console.log('\nDone. You can now sign in at http://localhost:3002\n');
}

main().catch(e => { console.error(e); process.exit(1); });
