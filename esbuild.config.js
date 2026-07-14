const esbuild = require('esbuild');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const config = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'out/extension.js',
  external: ['vscode'],
  loader: { '.node': 'file' },
  format: 'cjs',
  platform: 'node',
  target: 'node22',
  sourcemap: !production,
  minify: production,
  keepNames: true,
  treeShaking: true,
  logLevel: 'info',
};

async function main() {
  if (watch) {
    const ctx = await esbuild.context(config);
    await ctx.watch();
    console.log('[esbuild] watching for changes...');
  } else {
    await esbuild.build(config);
    console.log('[esbuild] build complete');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
