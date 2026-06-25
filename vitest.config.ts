import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

// Unit-test config. Tests run in a plain Node environment against the
// pure-logic modules (no Electron runtime, no DB). `electron` is aliased
// to a stub so main-process modules can be imported without bootstrapping
// Electron — see test/mocks/electron.ts.
const root = process.cwd();

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
  },
  resolve: {
    alias: {
      '@shared': resolve(root, 'src/shared'),
      '@renderer': resolve(root, 'src/renderer/src'),
      electron: resolve(root, 'test/mocks/electron.ts'),
    },
  },
});
