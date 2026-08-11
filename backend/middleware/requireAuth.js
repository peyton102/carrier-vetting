import { verifyToken } from '../lib/auth.js';

export function requireAuth(req, res, next) {
  try {
    const token = req.cookies?.auth;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    req.auth = verifyToken(token);
    next();
  } catch {
    res.status(401).json({ error: 'Unauthorized' });
  }
}
