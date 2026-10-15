import { readFileSync } from 'node:fs';

export function getPort() {
  const config = JSON.parse(readFileSync('config.json', 'utf8'));
  return config.port;
}
