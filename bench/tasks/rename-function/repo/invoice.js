import { calc_total } from './utils.js';
export function invoiceLine(items) {
  return `Total: ${calc_total(items).toFixed(2)}`;
}
