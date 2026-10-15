import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
const run = (...a) => execFileSync('node', ['greet.js', ...a]).toString().trim();
assert.equal(run('Ada'), 'Hello, Ada!');
assert.equal(run('Ada', '--shout'), 'HELLO, ADA!');
assert.equal(run('--shout', 'Bob'), 'HELLO, BOB!');
