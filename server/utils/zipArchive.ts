/**
 * Version-tolerant `archiver` loader. archiver 8.x dropped the classic
 * `archiver('zip', opts)` factory-function default export in favour of named
 * classes (`new ZipArchive(opts)`), which silently broke every call site still
 * written against the old API (TypeError: archiver is not a function). This
 * helper supports both shapes so the app keeps working whichever major
 * version `npm install` resolves for the "archiver": "latest" dependency.
 *
 * Loaded lazily (dynamic import only, never a top-level import) for the same
 * reason documented next to the other lazy archiver loaders in this codebase:
 * a top-level `import archiver from 'archiver'` breaks the packaged Electron
 * app under app.asar because archiver (and archiver-utils) are ESM-only.
 */
export type ZipArchiveInstance = {
  pipe: (dest: NodeJS.WritableStream) => unknown;
  append: (source: unknown, data: { name: string }) => unknown;
  directory: (dirpath: string, destpath: string | false) => unknown;
  file: (filepath: string, data: { name: string }) => unknown;
  finalize: () => Promise<void> | void;
  on: (event: string, cb: (...args: unknown[]) => void) => unknown;
};

export async function createZipArchive(options?: { zlib?: { level: number } }): Promise<ZipArchiveInstance> {
  const mod: any = await import('archiver');
  if (typeof mod.default === 'function') return mod.default('zip', options); // archiver < 8
  if (typeof mod.ZipArchive === 'function') return new mod.ZipArchive(options); // archiver >= 8
  if (typeof mod === 'function') return mod('zip', options);
  throw new Error('Unsupported archiver module shape — cannot create a zip archive.');
}
