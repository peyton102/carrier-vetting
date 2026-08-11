import jwt from 'jsonwebtoken';

function secret() {
  return process.env.JWT_SECRET || 'dev-secret';
}

// payload: { sub: email, tenant: slug }
export function signToken(payload) {
  return jwt.sign(payload, secret(), { expiresIn: '7d' });
}

export function verifyToken(token) {
  return jwt.verify(token, secret());
}
