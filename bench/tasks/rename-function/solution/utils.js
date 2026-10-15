export function calculateTotal(items) {
  return items.reduce((sum, i) => sum + i.price * i.qty, 0);
}
