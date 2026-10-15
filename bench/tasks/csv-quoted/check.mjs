import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const load = (f) => import(pathToFileURL(path.join(process.cwd(), f)).href);

const { parseCsvLine } = await load('csv.js');
assert.deepEqual(parseCsvLine('a,b,c'), ['a', 'b', 'c']);
assert.deepEqual(parseCsvLine('"Smith, John",42'), ['Smith, John', '42']);
assert.deepEqual(parseCsvLine('"say ""hi""",x'), ['say "hi"', 'x']);
assert.deepEqual(parseCsvLine('a,,c'), ['a', '', 'c']);
