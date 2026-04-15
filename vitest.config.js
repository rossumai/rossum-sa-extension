import { defineConfig } from 'vitest/config';

// Match build.js: classic Preact JSX with explicit `h` factory.
// Each .jsx file imports { h } from 'preact' at the top.
// Vite 8 uses oxc for JSX transforms, not esbuild — set the oxc.jsx option.
export default defineConfig({
  oxc: {
    jsx: {
      runtime: 'classic',
      pragma: 'h',
      pragmaFrag: 'Fragment',
    },
  },
  test: {
    include: ['tests/**/*.test.js'],
  },
});
