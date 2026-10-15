import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const load = (f) => import(pathToFileURL(path.join(process.cwd(), f)).href);

import { writeFileSync, rmSync } from 'node:fs';
const { getPort } = await load('server.js');
rmSync('config.json', { force: true });
assert.equal(getPort(), 3000);
writeFileSync('config.json', '{}');
assert.equal(getPort(), 3000);
writeFileSync('config.json', '{"port": 8080}');
assert.equal(getPort(), 8080);
