import dotenv from 'dotenv';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
const __dirname = fileURLToPath(new URL('.', import.meta.url));
dotenv.config({ path: resolve(__dirname, '../.env') });

import express        from 'express';
import cors           from 'cors';
import cookieParser   from 'cookie-parser';
import bcrypt         from 'bcryptjs';
import { createClient } from '@supabase/supabase-js';
import { signToken }   from './lib/auth.js';
import { requireAuth } from './middleware/requireAuth.js';
import vettingRouter      from './routes/vetting.js';
import fmcsaRouter        from './routes/fmcsa.js';
import saferwatchRouter   from './routes/saferwatch.js';
import certificatesRouter from './routes/certificates.js';
import settingsRouter     from './routes/settings.js';

const app = express();
app.use(cors());
app.use(cookieParser());
app.use(express.json());

function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
  );
}

// ── POST /api/login ───────────────────────────────────────────────────────────
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body ?? {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  try {
    const { data: tenant, error } = await getSupabase()
      .from('tenants')
      .select('slug, email, name, password_hash')
      .eq('email', email.toLowerCase().trim())
      .single();

    if (error || !tenant) {
      console.error('[LOGIN] tenant lookup failed:', error?.message);
      console.error('[LOGIN] SUPABASE_URL =', process.env.SUPABASE_URL ?? 'UNDEFINED');
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const valid = await bcrypt.compare(password, tenant.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid email or password' });

    const token = signToken({ sub: tenant.email, tenant: tenant.slug });
    res.cookie('auth', token, { httpOnly: true, sameSite: 'strict', maxAge: 7 * 24 * 60 * 60 * 1000 });
    res.json({ ok: true, email: tenant.email, name: tenant.name, tenant: tenant.slug });
  } catch (e) {
    console.error('[LOGIN] error:', e.message);
    res.status(500).json({ error: 'Login failed' });
  }
});

// ── POST /api/logout ──────────────────────────────────────────────────────────
app.post('/api/logout', (req, res) => {
  res.clearCookie('auth');
  res.json({ ok: true });
});

// ── All routes below require valid JWT ────────────────────────────────────────
app.use('/api', requireAuth);

// ── GET /api/me ───────────────────────────────────────────────────────────────
app.get('/api/me', async (req, res, next) => {
  try {
    const { data: tenant, error } = await getSupabase()
      .from('tenants')
      .select('slug, email, name')
      .eq('slug', req.auth.tenant)
      .single();
    if (error || !tenant) return res.status(401).json({ error: 'Tenant not found' });
    res.json({ email: tenant.email, name: tenant.name, tenant: tenant.slug });
  } catch (e) { next(e); }
});

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.use('/api/vetting',      vettingRouter);
app.use('/api/fmcsa',        fmcsaRouter);
app.use('/api/saferwatch',   saferwatchRouter);
app.use('/api/certificates', certificatesRouter);
app.use('/api/settings',     settingsRouter);

// ── Serve built React frontend ────────────────────────────────────────────────
const DIST = resolve(__dirname, '../frontend/dist');
app.use(express.static(DIST));
app.get('*', (_req, res) => res.sendFile(resolve(DIST, 'index.html')));

app.use((err, _req, res, _next) => {
  console.error('[ERROR]', err.message);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

const PORT = process.env.PORT || 3002;
app.listen(PORT, () => {
  const url  = process.env.SUPABASE_URL              || '(not set)';
  const key  = process.env.SUPABASE_SERVICE_ROLE_KEY || '(not set)';
  const jwt  = process.env.JWT_SECRET                ? 'set' : 'using dev-secret';
  const mask = (k) => k === '(not set)' ? k : `${k.slice(0, 4)}…${k.slice(-4)}`;
  console.log(`\n  Carrier Vetting running at http://localhost:${PORT}`);
  console.log(`  SUPABASE_URL              = ${url}`);
  console.log(`  SUPABASE_SERVICE_ROLE_KEY = ${mask(key)}`);
  console.log(`  JWT_SECRET                = ${jwt}\n`);
});
