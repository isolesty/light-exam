import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export const ADMIN_USERNAME = 'admin';
export const ADMIN_SUB = 'local:admin';

export function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 8 || password.length > 128 || !/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/[0-9]/.test(password)) {
    throw new Error('密码至少 8 位，且须同时包含大写字母、小写字母和数字');
  }
  return password;
}

export function validateUsername(username) {
  if (typeof username !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{2,31}$/.test(username)) {
    throw new Error('用户名须为 3 至 32 位，以字母开头，可包含字母、数字、下划线和连字符');
  }
  return username;
}

export function passwordHash(password) {
  validatePassword(password);
  const salt = randomBytes(16);
  const digest = scryptSync(password, salt, 64);
  return `scrypt:${salt.toString('hex')}:${digest.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  const parts = String(stored || '').split(':');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1], 'hex');
  const expected = Buffer.from(parts[2], 'hex');
  if (salt.length !== 16 || expected.length !== 64) return false;
  const actual = scryptSync(String(password), salt, expected.length);
  return timingSafeEqual(actual, expected);
}
