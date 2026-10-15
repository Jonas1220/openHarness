import { isValidEmail } from './validate.js';
export function invite(emails) {
  return emails.filter(isValidEmail);
}
