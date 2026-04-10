const esbuild = require('esbuild');
const { cpSync, rmSync, mkdirSync } = require('fs');

const isWatch = process.argv.includes('--watch');

rmSync('dist', { recursive: true, force: true });

for (const dir of ['dist/popup', 'dist/icons', 'dist/mdh']) {
  mkdirSync(dir, { recursive: true });
}

cpSync('manifest.json', 'dist/manifest.json');
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
    'mdh/mdh': 'src/mdh/index.js',
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
