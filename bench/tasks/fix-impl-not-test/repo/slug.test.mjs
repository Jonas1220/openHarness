import assert from 'node:assert/strict';
import { slugify } from './slug.js';
assert.equal(slugify('Hello World'), 'hello-world');
assert.equal(slugify('  Trim me  '), 'trim-me');
assert.equal(slugify('Already-slugged'), 'already-slugged');
assert.equal(slugify('Ünïcode & Symbols!'), 'unicode-symbols');
console.log('ok');
