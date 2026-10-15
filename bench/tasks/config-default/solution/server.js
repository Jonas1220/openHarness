import { readFileSync } from 'node:fs';

export function getPort() {
  try {
    const config = JSON.parse(readFileSync('config.json', 'utf8'));
    return typeof config.port === 'number' ? config.port : 3000;
  } catch {
    return 3000;
  }
}
