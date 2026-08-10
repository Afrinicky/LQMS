/**
 * Which build is this, exactly?
 *
 * Until the August 2026 validation, every SECH_LIMS installer ever produced
 * reported version 0.1.0 — the number had not moved since the foundation MVP.
 * A laboratory could not say which build it was running, an assessor could not
 * be shown that the running system was the validated one, and change control
 * had nothing to attach itself to (validation finding VF-11).
 *
 * The version now comes from package.json and moves with each release. The
 * commit and build date are stamped in by CI (SECH_LIMS_BUILD_COMMIT and
 * SECH_LIMS_BUILD_DATE); when they are absent — running from source on a
 * developer's machine — this reads them from git rather than inventing them,
 * and says plainly when it cannot.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export interface BuildInfo {
  version: string;
  /** Short commit hash, or 'unknown' when the build carries no stamp. */
  commit: string;
  /** ISO-8601, or null when unknown. */
  builtAt: string | null;
  /** 'release' when stamped by CI, 'source' when derived from the working tree. */
  provenance: 'release' | 'source' | 'unknown';
}

let cached: BuildInfo | null = null;

function readPackageVersion(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const candidate of [
    path.resolve(here, '../../package.json'),      // running from source
    path.resolve(here, '../../../package.json'),   // running from dist-electron
    path.resolve(process.cwd(), 'package.json'),
  ]) {
    try {
      const raw = JSON.parse(fs.readFileSync(candidate, 'utf8')) as { version?: string; name?: string };
      if (raw.version && /sech/i.test(raw.name ?? '')) return raw.version;
    } catch { /* try the next candidate */ }
  }
  return process.env.npm_package_version ?? '0.0.0';
}

function readGitCommit(): string | null {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'),
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    }).trim() || null;
  } catch {
    return null; // packaged installs have no git, which is fine and expected
  }
}

export function buildInfo(): BuildInfo {
  if (cached) return cached;

  const stampedCommit = process.env.SECH_LIMS_BUILD_COMMIT?.trim();
  const stampedDate = process.env.SECH_LIMS_BUILD_DATE?.trim();

  if (stampedCommit) {
    cached = {
      version: readPackageVersion(),
      commit: stampedCommit.slice(0, 12),
      builtAt: stampedDate || null,
      provenance: 'release',
    };
    return cached;
  }

  const gitCommit = readGitCommit();
  cached = {
    version: readPackageVersion(),
    commit: gitCommit ?? 'unknown',
    builtAt: stampedDate || null,
    provenance: gitCommit ? 'source' : 'unknown',
  };
  return cached;
}

/** "1.0.0 (a1b2c3d)" — what belongs on an About screen and in a release record. */
export function releaseLabel(): string {
  const info = buildInfo();
  return info.commit === 'unknown' ? info.version : `${info.version} (${info.commit})`;
}
