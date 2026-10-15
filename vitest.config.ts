import os from 'node:os';
import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    testTimeout: 20_000,
    // Never read or write the real ~/.openharness from tests.
    env: { OPENHARNESS_HOME: path.join(os.tmpdir(), `oh-test-home-${process.pid}`) },
  },
});
