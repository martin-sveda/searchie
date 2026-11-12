// Bundles: extension host, index worker, preview, search and statistics webviews, plus dev-only bench and smoke-test runners.
import * as esbuild from 'esbuild';
import fs from 'node:fs';

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

/** @type {esbuild.BuildOptions} */
const nodeCommon = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  sourcemap: !production,
  minify: production,
  // node:sqlite is a Node built-in (VS Code's Electron runtime); never bundle it.
  external: ['vscode', 'node:sqlite'],
  logLevel: 'info',
};

/** @type {esbuild.BuildOptions[]} */
const builds = [
  // The banner timestamps bundle evaluation so the logged activation time includes module loading (N1).
  { ...nodeCommon, entryPoints: ['src/extension.ts'], outfile: 'dist/extension.js', banner: { js: 'globalThis.__searchieLoadStart = performance.now();' } },
  { ...nodeCommon, entryPoints: ['src/worker/worker.ts'], outfile: 'dist/worker.js' },
  {
    bundle: true,
    platform: 'browser',
    target: 'es2022',
    format: 'iife',
    sourcemap: !production,
    minify: production,
    entryPoints: ['src/webview/preview/main.ts'],
    outfile: 'dist/webview/preview.js',
    logLevel: 'info',
  },
  {
    bundle: true,
    platform: 'browser',
    target: 'es2022',
    format: 'iife',
    sourcemap: !production,
    minify: production,
    entryPoints: ['src/webview/search/main.ts'],
    outfile: 'dist/webview/search.js',
    logLevel: 'info',
  },
  {
    bundle: true,
    platform: 'browser',
    target: 'es2022',
    format: 'iife',
    sourcemap: !production,
    minify: production,
    entryPoints: ['src/webview/stats/main.ts'],
    outfile: 'dist/webview/stats.js',
    logLevel: 'info',
  },
];
if (!production) {
  builds.push(
    { ...nodeCommon, entryPoints: ['src/bench/bench.ts'], outfile: 'dist/bench.js' },
    {
      ...nodeCommon,
      entryPoints: ['src/test/smoke/run.ts', 'src/test/smoke/suite.ts'],
      outdir: 'dist/test/smoke',
      external: ['vscode', 'node:sqlite', '@vscode/test-electron'],
    },
  );
}

fs.rmSync('dist', { recursive: true, force: true });
fs.mkdirSync('dist/webview', { recursive: true });
fs.copyFileSync('src/webview/preview/preview.css', 'dist/webview/preview.css');
// Panel styles = shared base + panel rules (one stylesheet per webview, served from dist/webview only).
const base = fs.readFileSync('src/webview/shared/base.css', 'utf8');
for (const name of ['search', 'stats']) fs.writeFileSync(`dist/webview/${name}.css`, `${base}\n${fs.readFileSync(`src/webview/${name}/${name}.css`, 'utf8')}`);

if (watch) {
  const contexts = await Promise.all(builds.map((b) => esbuild.context(b)));
  await Promise.all(contexts.map((c) => c.watch()));
} else {
  await Promise.all(builds.map((b) => esbuild.build(b)));
}
