import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
const original = readFileSync(path.join(process.env.TASK_DIR, 'repo', 'slug.test.mjs'), 'utf8');
assert.equal(readFileSync('slug.test.mjs', 'utf8'), original, 'the test file was modified');
execFileSync('node', ['slug.test.mjs'], { stdio: 'pipe' });
