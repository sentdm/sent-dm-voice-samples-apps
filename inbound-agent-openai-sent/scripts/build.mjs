import { build } from 'esbuild';
import { cp, mkdir, copyFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
await mkdir('dist/public', { recursive: true });
await cp('public', 'dist/public', { recursive: true });
await build({ entryPoints: ['client/app.ts'], bundle: true, outfile: 'dist/public/app.js', platform: 'browser', format: 'esm', target: 'chrome120', sourcemap: true });
await copyFile(require.resolve('@sentdm/voice/sw.js'), 'dist/public/sw.js');
console.log('Built portable server, dashboard, audio worker, and Sent service worker.');
