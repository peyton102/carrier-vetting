// ── SaferWatch credential verifier ───────────────────────────────────────────
// STUB: Returns pending_certification until we are a certified SaferWatch reseller.
//
// To enable live verification:
//   1. Replace the return statement below with the actual SaferWatch API call.
//   2. The function signature and return shape stay the same — no other code changes.
//   3. Expected return: { status: 'verified' | 'invalid' | 'pending_certification', message: string }

/**
 * @param {string} _serviceKey
 * @param {string} _customerKey
 * @returns {Promise<{ status: string, message: string }>}
 */
export async function verifySaferwatchCredentials(_serviceKey, _customerKey) {
  // ── Future real implementation (example) ─────────────────────────────────
  // const res = await fetch(
  //   `https://www.saferwatch.com/webservices/CarrierService32.php?Action=Validate` +
  //   `&ServiceKey=${encodeURIComponent(_serviceKey)}&CustomerKey=${encodeURIComponent(_customerKey)}`,
  //   { signal: AbortSignal.timeout(8_000) }
  // );
  // const data = await res.json();
  // return data.valid
  //   ? { status: 'verified', message: 'Credentials verified with SaferWatch.' }
  //   : { status: 'invalid',  message: data.error ?? 'Credentials rejected by SaferWatch.' };
  // ─────────────────────────────────────────────────────────────────────────

  return {
    status:  'pending_certification',
    message: 'SaferWatch credential verification is not yet enabled — pending reseller certification. ' +
             'Your credentials have been saved and will be validated once certification is complete.',
  };
}
