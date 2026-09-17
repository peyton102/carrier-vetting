# FMCSA API Key Setup Guide

Every account on this platform must use **its own free FMCSA web key**. Using a shared key risks rate-limiting or account suspension for all users — the FMCSA free tier is per-registrant.

SaferWatch credentials are different — those are operator-managed and do not need to be set up per account.

---

## Step 1 — Register for a free FMCSA web key

1. Go to: **https://mobile.fmcsa.dot.gov/qc/services/users/register**
2. Fill in:
   - **First / Last Name** — your name
   - **Email address** — use a real email you check (the key is emailed to you)
   - **Company name** — your brokerage name
   - **Intended use** — select "Other" or "Carrier Search / Verification"
3. Click **Submit**.
4. FMCSA emails your key within a few minutes. Check spam if you don't see it.

The key looks like a long alphanumeric string, e.g. `a1b2c3d4e5f6...`

Your key **never expires** and has no usage fee. FMCSA asks that you do not share it.

---

## Step 2 — Add your key to your account

1. Log in to your Carrier Vetting account.
2. Click **Settings** in the top navigation.
3. Scroll down to the **FMCSA API Key** card.
4. Paste your web key into the input field and click **Save Key**.
5. Click **Verify Key** to confirm it is working.

Once saved, the DOT Lookup and MC Lookup buttons on the vetting form will use your key automatically. The monitoring job also uses your key for background carrier checks.

---

## What happens without a key?

- The **DOT Lookup** and **MC Lookup** auto-fill buttons will show an error: *"FMCSA web key not configured"*
- The **carrier monitoring job** will skip your monitored loads with a warning in the logs
- Vetting still works — you just have to enter all fields manually

---

## Troubleshooting

| Error | Fix |
|---|---|
| "Web key rejected by FMCSA" | Make sure you copied the full key with no extra spaces |
| Key verified but lookup fails | Wait 5–10 minutes after first saving — FMCSA activation can take a moment |
| Never received email | Check spam, then re-register with a different email address |
| Rate limit errors | Your key is shared or being called too frequently — register a dedicated key |
