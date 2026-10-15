import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const load = (f) => import(pathToFileURL(path.join(process.cwd(), f)).href);

import { readFileSync } from 'node:fs';
const all = ['signup.js', 'invite.js', 'validate.js'].map((f) => readFileSync(f, 'utf8')).join('\n');
assert.equal(all.split('[^\\s@]+@').length - 1, 1, 'the regex should appear exactly once');
const { isValidEmail } = await load('validate.js');
const { signup } = await load('signup.js');
const { invite } = await load('invite.js');
assert.equal(isValidEmail('a@b.co'), true);
assert.equal(isValidEmail('nope'), false);
assert.deepEqual(signup('a@b.co'), { ok: true });
assert.deepEqual(signup('bad'), { ok: false, error: 'invalid email' });
assert.equal(invite(['x@y.io', 'bad']).length, 1);
