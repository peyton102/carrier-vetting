import dotenv from 'dotenv';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { createHmac } from 'crypto';
const __dirname = fileURLToPath(new URL('.', import.meta.url));
dotenv.config({ path: resolve(__dirname, '../.env') });

import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import vettingRouter    from './routes/vetting.js';
import fmcsaRouter      from './routes/fmcsa.js';
import saferwatchRouter from './routes/saferwatch.js';

const app = express();
app.use(cors());
app.use(cookieParser());
app.use(express.json());

function authToken() {
  if (!process.env.UI_PASSWORD) return null;
  return createHmac('sha256', process.env.UI_PASSWORD).update('precision-vetting').digest('hex');
}

function requireAuth(req, res, next) {
  const expected = authToken() ?? 'open';
  if (req.cookies?.auth === expected) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

app.post('/api/login', (req, res) => {
  const { username, password } = req.body ?? {};
  const validUser = !process.env.UI_USERNAME || username === process.env.UI_USERNAME;
  const validPass = !process.env.UI_PASSWORD || password === process.env.UI_PASSWORD;
  if (validUser && validPass) {
    res.cookie('auth', authToken() || 'open', { httpOnly: true, sameSite: 'strict', maxAge: 30 * 24 * 60 * 60 * 1000 });
    return res.json({ ok: true });
  }
  res.status(401).json({ error: 'Invalid username or password' });
});

app.post('/api/logout', requireAuth, (req, res) => {
  res.clearCookie('auth');
  res.json({ ok: true });
});

app.use('/api', requireAuth);
app.use('/api/vetting',    vettingRouter);
app.use('/api/fmcsa',      fmcsaRouter);
app.use('/api/saferwatch', saferwatchRouter);

app.get('/api/health', (_req, res) => res.json({ ok: true }));

// Serve built React frontend
const DIST = resolve(__dirname, '../frontend/dist');
app.use(express.static(DIST));
app.get('*', (_req, res) => res.sendFile(resolve(DIST, 'index.html')));

app.use((err, _req, res, _next) => {
  console.error('[ERROR]', err.message);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

const PORT = process.env.PORT || 3002;
app.listen(PORT, () => {
  const url     = process.env.SUPABASE_URL              || '(not set)';
  const key     = process.env.SUPABASE_SERVICE_ROLE_KEY || '(not set)';
  const swSvc   = process.env.SAFERWATCH_SERVICE_KEY    || '(not set)';
  const swCust  = process.env.SAFERWATCH_CUSTOMER_KEY   || '(not set)';
  const fmcsa   = process.env.FMCSA_WEBKEY              || '(not set)';
  const mask    = (k) => k === '(not set)' ? k : k.length > 8 ? `${k.slice(0, 4)}…${k.slice(-4)}` : '(too short)';
  console.log(`\n  Carrier Vetting running at http://localhost:${PORT}`);
  console.log(`  SUPABASE_URL              = ${url}`);
  console.log(`  SUPABASE_SERVICE_ROLE_KEY = ${mask(key)}`);
  console.log(`  FMCSA_WEBKEY              = ${mask(fmcsa)}`);
  console.log(`  SAFERWATCH_SERVICE_KEY    = ${mask(swSvc)}`);
  console.log(`  SAFERWATCH_CUSTOMER_KEY   = ${mask(swCust)}\n`);
});
