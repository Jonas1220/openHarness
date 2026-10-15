import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const md = readFileSync('README.md', 'utf8');
assert.match(md, /^## Installation/m);
const section = md.split(/^## Installation/m)[1].split(/^## /m)[0];
assert.match(section, /npm install/);
assert.match(section, /npm (run )?start/);
assert.match(md, /^# Todo API/m, 'the original title was removed');
