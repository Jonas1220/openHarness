/** Sum of all integers from a to b, inclusive. */
export function sumRange(a, b) {
  let total = 0;
  for (let i = a; i < b; i++) total += i;
  return total;
}
