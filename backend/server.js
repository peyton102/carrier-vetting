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
import { signToken }  from './lib/auth.js';
import { requireAuth } from './middleware/requireAuth.js';
import vettingRouter    from './routes/vetting.js';
import fmcsaRouter      from './routes/fmcsa.js';
import saferwatchRouter from './routes/saferwatch.js';

const app = express();
app.use(cors());
app.use(cookieParser());
app.use(express.json());

function getSupabase() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

// ── Public: login ─────────────────────────────────────────────────────────────
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body ?? {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  try {
    const supabase = getSupabase();
    const { data: user, error } = await supabase
      .from('users')
      .select('id, org_id, email, name, role, password_hash')
      .eq('email', email.toLowerCase().trim())
      .single();

    if (error || !user) {
      console.error('[LOGIN] user lookup failed:', error?.message, '| found:', !!user);
      console.error('[LOGIN] SUPABASE_URL set:', !!process.env.SUPABASE_URL, '| KEY set:', !!process.env.SUPABASE_SERVICE_ROLE_KEY);
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid email or password' });

    // Fetch org name separately
    const { data: org } = await supabase
      .from('organizations')
      .select('name')
      .eq('id', user.org_id)
      .single();

    const token = signToken({ userId: user.id, orgId: user.org_id, role: user.role });
    res.cookie('auth', token, { httpOnly: true, sameSite: 'strict', maxAge: 30 * 24 * 60 * 60 * 1000 });
    res.json({ ok: true, name: user.name, email: user.email, role: user.role, orgName: org?.name });
  } catch (e) {
    console.error('[LOGIN ERROR]', e.message);
    res.status(500).json({ error: 'Login failed' });
  }
});

// ── Public: logout ────────────────────────────────────────────────────────────
app.post('/api/logout', (req, res) => {
  res.clearCookie('auth');
  res.json({ ok: true });
});

// ── All routes below require a valid JWT ──────────────────────────────────────
app.use('/api', requireAuth);

// ── Auth: current user info ───────────────────────────────────────────────────
app.get('/api/me', async (req, res, next) => {
  try {
    const supabase = getSupabase();
    const { data: user, error } = await supabase
      .from('users')
      .select('id, email, name, role')
      .eq('id', req.auth.userId)
      .single();
    if (error || !user) return res.status(401).json({ error: 'User not found' });
    const { data: org } = await supabase
      .from('organizations')
      .select('name')
      .eq('id', req.auth.orgId)
      .single();
    res.json({
      userId:  user.id,
      email:   user.email,
      name:    user.name,
      role:    user.role,
      orgId:   req.auth.orgId,
      orgName: org?.name,
    });
  } catch (e) { next(e); }
});

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.use('/api/vetting',    vettingRouter);
app.use('/api/fmcsa',      fmcsaRouter);
app.use('/api/saferwatch', saferwatchRouter);

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
  const url   = process.env.SUPABASE_URL              || '(not set)';
  const key   = process.env.SUPABASE_SERVICE_ROLE_KEY || '(not set)';
  const jwt   = process.env.JWT_SECRET                || '(not set)';
  const fmcsa = process.env.FMCSA_WEBKEY              || '(not set)';
  const mask  = (k) => k === '(not set)' ? k : k.length > 8 ? `${k.slice(0, 4)}…${k.slice(-4)}` : '(too short)';
  console.log(`\n  Carrier Vetting running at http://localhost:${PORT}`);
  console.log(`  SUPABASE_URL              = ${url}`);
  console.log(`  SUPABASE_SERVICE_ROLE_KEY = ${mask(key)}`);
  console.log(`  JWT_SECRET                = ${mask(jwt)}`);
  console.log(`  FMCSA_WEBKEY              = ${mask(fmcsa)}\n`);
});
