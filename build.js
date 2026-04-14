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

for (const dir of ['dist/popup', 'dist/icons', 'dist/mdh']) {
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
cpSync('src/mdh/mdh.html', 'dist/mdh/mdh.html');
cpSync('src/mdh/mdh.css', 'dist/mdh/mdh.css');

const options = {
  entryPoints: {
    'scripts/rossum': 'src/rossum/index.js',
    'scripts/netsuite': 'src/netsuite/index.js',
    'scripts/coupa': 'src/coupa/index.js',
    'popup/popup': 'src/popup/popup.js',
    'mdh/mdh': 'src/mdh/index.jsx',
  },
  bundle: true,
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
