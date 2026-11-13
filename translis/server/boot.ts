/**
 * Point the shared code at this product's data folder, before it is loaded.
 *
 * The database module reads its location once, when it is first imported, from
 * `SECH_LIMS_DATA_DIR`. So this has to run before anything that imports it —
 * which is why it is a module of its own with no imports of its own, and why
 * it is the first line of every TransLis entry point.
 *
 * A TransLis installed beside SECHLIMS on one machine must not open SECHLIMS's
 * database: two products writing one SQLite file, one of them deleting result
 * values on a retention schedule the other knows nothing about, is a way to
 * lose a laboratory's records. Different folder, always.
 */
import path from 'node:path';
import os from 'node:os';

if (!process.env.SECH_LIMS_DATA_DIR) {
  // Matches where the Electron shell puts it, so running the host from a
  // terminal reaches the same database as the installed application.
  const home = os.homedir();
  const base = process.platform === 'win32'
    ? (process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'))
    : process.platform === 'darwin'
      ? path.join(home, 'Library', 'Application Support')
      : (process.env.XDG_CONFIG_HOME ?? path.join(home, '.config'));
  process.env.SECH_LIMS_DATA_DIR = path.join(base, 'TransLis', 'data');
}

// The name the host puts into the few labels it serves rather than renders.
// The browser gets its own copy as a build-time constant; this is for the API.
process.env.SECH_LIMS_PRODUCT_NAME = 'TransLis';

export const TRANSLIS_DATA_DIR = process.env.SECH_LIMS_DATA_DIR;
