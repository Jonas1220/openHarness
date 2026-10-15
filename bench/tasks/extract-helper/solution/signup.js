import { isValidEmail } from './validate.js';
export function signup(email) {
  if (!isValidEmail(email)) return { ok: false, error: 'invalid email' };
  return { ok: true };
}
