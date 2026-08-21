import { defineConfig } from 'vitest/config';

// Match build.js: classic Preact JSX with explicit `h` factory.
// Each .tsx file imports { h } from 'preact' at the top.
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
    // 17 test files mount CodeMirror, whose construction is heavy and
    // synchronous. It runs in ~200ms unloaded, but on a contended runner
    // (CI is 2-vCPU) it has been observed to blow past the 5s default and
    // fail as a timeout. This is headroom for slow-but-correct mounts —
    // a genuine hang still fails, just later. It is NOT a substitute for
    // fixing a racy test: waits belong on conditions, never on the clock.
    testTimeout: 20_000,
  },
});
