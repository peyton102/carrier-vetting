import { verifyToken } from '../lib/auth.js';

export function requireAuth(req, res, next) {
  try {
    const token = req.cookies?.auth;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    const payload = verifyToken(token);
    // payload: { sub: email, tenant: slug, canceled?: true }
    req.auth = { email: payload.sub, tenant: payload.tenant, canceled: !!payload.canceled };
    next();
  } catch {
    res.status(401).json({ error: 'Unauthorized' });
  }
}
