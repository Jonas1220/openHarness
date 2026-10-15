import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const load = (f) => import(pathToFileURL(path.join(process.cwd(), f)).href);

import { readFileSync, readdirSync } from 'node:fs';
for (const f of readdirSync('.').filter((f) => f.endsWith('.js'))) {
  assert.ok(!readFileSync(f, 'utf8').includes('calc_total'), `${f} still mentions calc_total`);
}
const { calculateTotal } = await load('utils.js');
const { cartTotal } = await load('cart.js');
const { invoiceLine } = await load('invoice.js');
assert.equal(calculateTotal([{ price: 2, qty: 3 }]), 6);
assert.equal(cartTotal([{ price: 1.5, qty: 2 }]), 3);
assert.equal(invoiceLine([{ price: 10, qty: 1 }]), 'Total: 10.00');
