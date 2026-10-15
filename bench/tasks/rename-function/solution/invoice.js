import { calculateTotal } from './utils.js';
export function invoiceLine(items) {
  return `Total: ${calculateTotal(items).toFixed(2)}`;
}
