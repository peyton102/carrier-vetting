import jwt from 'jsonwebtoken';

function secret() {
  if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET not set in .env');
  return process.env.JWT_SECRET;
}

export function signToken(payload) {
  return jwt.sign(payload, secret(), { expiresIn: '30d' });
}

export function verifyToken(token) {
  return jwt.verify(token, secret());
}
