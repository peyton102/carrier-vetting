// Standalone cron entry-point — refreshes all four enforcement tables then exits.
// Deployed as a Render cron job so a crash or OOM here never affects the web service.
// Schedule: 0 4 * * *  (4 AM UTC daily, after Socrata nightly updates)

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import {
  withLoadTimeout,
  refreshInsuranceCancellations,
  refreshOosOrders,
  refreshSaferRevocations,
  refreshMotusSuspensions,
} from '../lib/monitor.js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

console.log('[DAILY] Starting enforcement table refresh…');

await withLoadTimeout('INSUR',  () => refreshInsuranceCancellations(supabase));
await withLoadTimeout('OOS',    () => refreshOosOrders(supabase));
await withLoadTimeout('REVOKE', () => refreshSaferRevocations(supabase));
await withLoadTimeout('MOTUS',  () => refreshMotusSuspensions(supabase));

console.log('[DAILY] All loads complete.');
process.exit(0);
