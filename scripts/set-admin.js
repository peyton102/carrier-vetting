import dotenv from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, '../.env') });

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const { data, error } = await sb
  .from('tenants')
  .update({ is_admin: true })
  .eq('email', 'maddenp0706@gmail.com')
  .select('slug, email, is_admin');

if (error) { console.error('ERROR:', error.message); process.exit(1); }
if (!data.length) { console.error('No row found for that email — check the email address.'); process.exit(1); }

console.log('Done:', data[0]);
