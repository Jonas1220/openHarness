import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const load = (f) => import(pathToFileURL(path.join(process.cwd(), f)).href);

const { sumRange } = await load('sum.js');
assert.equal(sumRange(1, 3), 6);
assert.equal(sumRange(5, 5), 5);
assert.equal(sumRange(-2, 2), 0);
