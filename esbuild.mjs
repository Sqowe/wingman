import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

const ctx = await esbuild.context({
  entryPoints: ['src/extension.ts'],
  bundle: true,
  format: 'cjs',
  minify: !watch,
  sourcemap: watch ? 'inline' : false,
  sourcesContent: false,
  platform: 'node',
  outfile: 'dist/extension.js',
  // vscode is provided at runtime by the extension host — never bundle it.
  external: ['vscode'],
  logLevel: 'info',
});

if (watch) {
  await ctx.watch();
  console.log('[esbuild] Watching for changes…');
} else {
  await ctx.rebuild();
  await ctx.dispose();
}
