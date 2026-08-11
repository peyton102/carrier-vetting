import { createClient } from '@supabase/supabase-js';
import { WebSocket } from 'ws';

let _client = null;

function getClient() {
  if (!_client) {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env');
    }
    _client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
      realtime: { transport: WebSocket },
    });
  }
  return _client;
}

// Proxy so callers can write: supabase.from(...)
export default new Proxy({}, {
  get(_target, prop) {
    return (...args) => getClient()[prop](...args);
  },
});
