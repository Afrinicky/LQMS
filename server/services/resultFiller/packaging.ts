/**
 * Handing the extension to a bench.
 *
 * A laboratory should not have to find a folder on a server to install this.
 * The settings screen offers a download, and what comes back is the extension
 * already pointed at THIS host: the address is written into the package at the
 * moment it is built, so the person at the bench loads it and enters a pairing
 * code, and nothing else needs configuring.
 *
 * The archiver is imported lazily for the reason documented beside every other
 * lazy archiver load in this codebase — a top-level import breaks the packaged
 * Electron app under app.asar.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Response } from 'express';
import { createZipArchive } from '../../utils/zipArchive.js';

/** Where the extension's source sits, however this server was started. */
export function extensionRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, '../../../extension'),        // tsx, from server/services/resultFiller
    path.resolve(here, '../../../../extension'),     // compiled, from dist-server/server/services/resultFiller
    path.resolve(process.cwd(), 'extension'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'manifest.json'))) return candidate;
  }
  throw new Error('The extension source folder could not be found on this host.');
}

/** Files that belong in a package a person installs. */
function collect(dir: string, base = ''): Array<{ absolute: string; name: string }> {
  const out: Array<{ absolute: string; name: string }> = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const absolute = path.join(dir, entry.name);
    const name = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...collect(absolute, name));
    else out.push({ absolute, name });
  }
  return out;
}

export interface PackageOptions {
  /** The API address the extension should talk to, written into its defaults. */
  host: string;
  /**
   * The name of the system handing this out. SECHLIMS by default, and TransLis
   * where the standalone middleware is serving it.
   */
  product?: string;
}

/** Files whose text is rewritten on the way into the package. */
const TEXT = /\.(js|html|json|css|md|txt)$/i;

/**
 * Put the right product name into the extension's own wording.
 *
 * Only the standalone uppercase word, and only in text files. The extension
 * also carries the name in lower case inside storage keys, DOM element ids and
 * a window flag — `sechlims-result-filler-bubble`, `sechlimsShowAnyway` — and
 * renaming those would be a behaviour change: a browser already enrolled would
 * stop recognising its own stored session, and the bubble would mount twice.
 *
 * So the rule is a case-sensitive word match, which reaches all sixty-four
 * places the extension says the name to a person and none of the places it
 * says it to itself. For SECHLIMS the substitution is the word for itself, so
 * what it hands out is unchanged.
 */
function brand(text: string, product: string): string {
  return text.replace(/\bSECHLIMS\b/g, product);
}

export async function packageExtension(res: Response, options: PackageOptions): Promise<void> {
  const root = extensionRoot();
  const files = collect(root);
  const host = String(options.host ?? '').replace(/\/+$/, '');
  const product = String(options.product ?? 'SECHLIMS').trim() || 'SECHLIMS';
  const slug = product.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${slug}-result-filler.zip"`);

  const archive = await createZipArchive({ zlib: { level: 9 } });
  archive.on('error', (error: unknown) => { throw error; });
  archive.pipe(res);

  for (const file of files) {
    // One file carries the host, and it is generated rather than edited in
    // place, so the source folder on the server stays exactly as shipped.
    if (file.name === 'config.js') continue;
    if (TEXT.test(file.name)) {
      archive.append(brand(fs.readFileSync(file.absolute, 'utf8'), product), { name: file.name });
    } else {
      archive.file(file.absolute, { name: file.name });
    }
  }

  archive.append(
    `/* Written by ${product} when this package was downloaded. */\n`
    + `export const DEFAULT_HOST = ${JSON.stringify(host)};\n`
    + `export const PACKAGED_AT = ${JSON.stringify(new Date().toISOString())};\n`,
    { name: 'config.js' },
  );

  await archive.finalize();
}
