const esbuild = require('esbuild');
const { cpSync, rmSync, mkdirSync } = require('fs');

const isWatch = process.argv.includes('--watch');

rmSync('dist', { recursive: true, force: true });

for (const dir of ['dist/styles', 'dist/popup', 'dist/icons']) {
  mkdirSync(dir, { recursive: true });
}

cpSync('manifest.json', 'dist/manifest.json');
cpSync('icons', 'dist/icons', { recursive: true });
cpSync('src/rossum/rossum.css', 'dist/styles/rossum.css');
cpSync('src/netsuite/netsuite.css', 'dist/styles/netsuite.css');
cpSync('src/popup/popup.html', 'dist/popup/popup.html');
cpSync('src/popup/popup.css', 'dist/popup/popup.css');

const options = {
  entryPoints: {
    'scripts/rossum': 'src/rossum/index.js',
    'scripts/netsuite': 'src/netsuite/index.js',
    'popup/popup': 'src/popup/popup.js',
  },
  bundle: true,
  outdir: 'dist',
  format: 'iife',
  logLevel: 'info',
};

if (isWatch) {
  esbuild.context(options).then((ctx) => ctx.watch());
} else {
  esbuild.buildSync(options);
}
