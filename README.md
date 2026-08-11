# Carrier Vetting Tool

Standalone carrier vetting app for Precision Transport.

## Setup

```bash
# 1. Copy env and fill in credentials
cp .env.example .env

# 2. Install backend dependencies
cd backend && npm install

# 3. Install and build frontend
cd ../frontend && npm install && npm run build

# 4. Run the DB schema in Supabase SQL editor
#    (supabase/vetting_schema.sql)

# 5. Start the server
cd ../backend && node server.js
```

Open http://localhost:3002

## Dev mode (hot reload frontend)

```bash
# Terminal 1
cd backend && node --watch server.js

# Terminal 2
cd frontend && npm run dev
# Frontend at http://localhost:5173 (proxies /api to backend)
```

## Required env vars

| Variable | Description |
|---|---|
| `UI_USERNAME` / `UI_PASSWORD` | Login credentials |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key |
| `FMCSA_WEBKEY` | FMCSA QCMobile API key |
| `SAFERWATCH_SERVICE_KEY` | SaferWatch service key |
| `SAFERWATCH_CUSTOMER_KEY` | SaferWatch customer key |
