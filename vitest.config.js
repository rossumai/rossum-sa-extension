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
      // Suppress __self / __source debug props. Without this, oxc emits them
      // on every JSX literal and preact tries to setAttribute(__source, {…})
      // on the rendered DOM — which jsdom rejects with
      // "Cannot convert object to primitive value". Production esbuild builds
      // don't emit these, so this just keeps tests in sync with prod behavior.
      development: false,
    },
  },
  test: {
    include: ['tests/**/*.test.js'],
    setupFiles: ['./tests/setup.js'],
  },
});
