const esbuild = require('esbuild');
const { execSync } = require('child_process');
const { cpSync, rmSync, mkdirSync, readFileSync, writeFileSync } = require('fs');

const isWatch = process.argv.includes('--watch');

// ── Git-based versioning ───────────────────────────
const gitHash = execSync('git rev-parse --short HEAD').toString().trim();
const commitCount = Number(execSync('git rev-list --count HEAD').toString().trim());
const chromeMajor = Math.floor(commitCount / 65535);
const chromeMinor = commitCount % 65535;
const chromeVersion = `${chromeMajor}.${chromeMinor}`;

rmSync('dist', { recursive: true, force: true });

for (const dir of ['dist/popup', 'dist/icons', 'dist/console', 'dist/devtools', 'dist/sidepanel']) {
  mkdirSync(dir, { recursive: true });
}

// Inject version + version_name into manifest.json
const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));
manifest.version = chromeVersion;
manifest.version_name = gitHash;
writeFileSync('dist/manifest.json', JSON.stringify(manifest, null, 2) + '\n');

cpSync('icons', 'dist/icons', { recursive: true });
cpSync('src/popup/popup.html', 'dist/popup/popup.html');
cpSync('src/popup/popup.css', 'dist/popup/popup.css');
cpSync('src/console/console.html', 'dist/console/console.html');
// The hand-written monolith is the LEGACY base stylesheet, copied as-is. esbuild
// emits dist/console/console.css from imported CSS Modules (self-contained
// design-system component styles), so the monolith is renamed to avoid the clash.
// As components migrate their rules into CSS Modules, console.base.css shrinks and
// is eventually retired. console.html links both (base first, then the modules).
cpSync('src/console/console.css', 'dist/console/console.base.css');
cpSync('src/devtools/devtools.html', 'dist/devtools/devtools.html');
cpSync('src/devtools/panel.html', 'dist/devtools/panel.html');
cpSync('src/devtools/panel.css', 'dist/devtools/panel.css');
// The side panel links ../popup/popup.css FIRST and only overrides the popup's
// shell in sidepanel.css, so the shared MDH card has one source of truth.
cpSync('src/sidepanel/sidepanel.html', 'dist/sidepanel/sidepanel.html');
cpSync('src/sidepanel/sidepanel.css', 'dist/sidepanel/sidepanel.css');

const options = {
  entryPoints: {
    'scripts/rossum': 'src/rossum/index.js',
    'scripts/netsuite': 'src/netsuite/index.js',
    'scripts/coupa': 'src/coupa/index.js',
    'popup/popup': 'src/popup/popup.jsx',
    'console/console': 'src/console/index.jsx',
    // Lazy-loaded by the Fabry chat's MermaidBlock (script-injected on the
    // first mermaid fence): beautiful-mermaid ships one flat ~1.5MB module,
    // so it gets its own bundle instead of weighing down console.js.
    'console/mermaid': 'src/fabry/mermaidEntry.js',
    'background': 'src/background/index.js',
    'devtools/devtools': 'src/devtools/devtools.js',
    'devtools/panel': 'src/devtools/panel.jsx',
    'sidepanel/sidepanel': 'src/sidepanel/index.jsx',
  },
  bundle: true,
  // Full minification, INCLUDING identifier renaming — which also shortens CSS
  // Modules' local class names (e.g. Academy.module.css's `.heroBlobA`) into
  // one/two-character globals emitted to dist/console/console.css. esbuild only
  // guarantees those generated names are unique AMONG THEMSELVES, not against
  // bare hand-written classes in JSX (`<div class="k">`) or the legacy
  // console.css/popup.css. That is not hypothetical: a generated `.k` once
  // collided with the Inspector's `class="k"` cells and painted a 320px blurred
  // hero blob across them.
  //
  // What keeps this safe is NOT the minifier — it is that no bare single-letter
  // class names remain to be collided with, enforced on every run by
  // tests/css-class-collision-boundary.test.js, which asserts against the BUILT
  // stylesheet rather than the source. Adding a bare `class="x"` to any JSX
  // fails that test. Turning identifier minification off is the other half of
  // the fix and costs ~575KB on console.js; either half reaches zero collisions
  // alone, and this is the half that keeps the bundle small.
  minify: true,
  outdir: 'dist',
  format: 'iife',
  logLevel: 'info',
  jsxFactory: 'h',
  jsxFragment: 'Fragment',
};

if (isWatch) {
  esbuild.context(options).then((ctx) => ctx.watch());
} else {
  esbuild.buildSync(options);
}
