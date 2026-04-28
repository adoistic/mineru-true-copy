import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    // Default to node; component test files opt in via the // @vitest-environment jsdom
    // pragma at the top of the file. (vitest 4.x removed environmentMatchGlobs.)
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
