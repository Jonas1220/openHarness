// Some npm setups skip dependency install scripts, which leaves Electron without
// its binary ("Electron uninstall"). Run Electron's own installer if that happened.
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const require = createRequire(import.meta.url);
let dir;
try {
  dir = path.dirname(require.resolve('electron/package.json'));
} catch {
  process.exit(0); // desktop workspace not installed
}
if (!existsSync(path.join(dir, 'path.txt'))) {
  console.log('Downloading the Electron binary…');
  const r = spawnSync(process.execPath, [path.join(dir, 'install.js')], { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}
