import { defineConfig } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The TransLis renderer.
 *
 * Its root is the repository rather than `translis/`, because the pages import
 * SECHLIMS's own components — the middleware sections, the Analyser Sync page,
 * the shared hooks and the stylesheet — and that is the point: TransLis is the
 * same code standing on its own, not a copy of it.
 *
 * Absolute base, for the same reason as the SECHLIMS renderer: the packaged
 * window loads over http:// from the embedded host, so assets must resolve to
 * the origin root or a reload on a nested route fetches them from the wrong
 * place and the application never boots.
 */
const dir = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(dir, '..');

const BUILD_STAMP = new Date().toISOString().slice(0, 16).replace('T', ' ');

export default defineConfig({
  // The root is `translis/`, so the built entry lands at the top of the output
  // folder where the host serves it from. The imports reaching up into `src/`
  // and `shared/` are ordinary relative imports and resolve against the file
  // that makes them, not against the root — `fs.allow` is only what lets the
  // dev server read them.
  root: dir,
  define: {
    __BUILD_STAMP__: JSON.stringify(BUILD_STAMP),
    __PRODUCT_NAME__: JSON.stringify('TransLis'),
  },
  base: '/',
  server: {
    host: '127.0.0.1',
    port: 5183,
    fs: { allow: [repo] },
  },
  build: {
    outDir: path.resolve(repo, 'dist-translis'),
    emptyOutDir: true,
  },
});
