/**
 * Why a watched folder cannot be read — in the words the person at the bench
 * needs, not the words the filesystem used.
 *
 * "The watched folder does not exist" is true and useless. It is true when the
 * folder was mistyped, when the share has gone, when this host has no rights on
 * it, when the analyser's computer is switched off — and, far more often than
 * any of those, when somebody walked to the analyser, read the path out of its
 * own Explorer window, and typed `C:\ProgramData\...` into SECHLIMS. That path
 * is perfectly real. It is simply on the OTHER computer, and a drive letter
 * never means anything but the disk in the machine reading it.
 *
 * That mistake is invisible from the message, because the folder genuinely does
 * not exist here, and the laboratory then spends an afternoon checking a
 * spelling that was right all along. So each of these is separated and each is
 * told what to do about it.
 */
import fs from 'node:fs';
import path from 'node:path';

export type WatchPathReason =
  | 'ok'
  /** Nothing has been entered yet. */
  | 'unset'
  /** A drive-letter or rooted path that is not on this machine. */
  | 'local_path'
  /** A network path whose computer did not answer. */
  | 'host_unreachable'
  /** A network path whose computer answered and has no such share. */
  | 'share_missing'
  /** Reached, but this host is not allowed in. */
  | 'denied'
  /** Reached, but there is no such folder inside it. */
  | 'missing'
  /** It is there, but it is a file. */
  | 'not_a_folder';

export interface WatchPathVerdict {
  ok: boolean;
  reason: WatchPathReason;
  /** One sentence: what was found. */
  note: string;
  /** What to change, where there is something to change. */
  fix?: string;
  /** The network path to try, when one can be worked out from what was typed. */
  suggestion?: string;
}

/** `\\COMPUTER\Share\...`, in either slash. */
const UNC = /^[\\/]{2}([^\\/]+)[\\/]+([^\\/]+)(.*)$/;
/** `C:\...` or `C:/...` */
const DRIVE = /^([A-Za-z]):[\\/]/;

function errno(error: unknown): string {
  return String((error as NodeJS.ErrnoException)?.code ?? '');
}

/** Can this host read it, and is it a folder? Throws what the filesystem threw. */
function inspect(target: string): WatchPathVerdict {
  const stat = fs.statSync(target);
  if (!stat.isDirectory()) {
    return {
      ok: false, reason: 'not_a_folder',
      note: `${target} is a file, not a folder.`,
      fix: 'Point the link at the folder that holds the analyser\'s exports, not at one file inside it.',
    };
  }
  fs.accessSync(target, fs.constants.R_OK);
  return { ok: true, reason: 'ok', note: `${target} is readable from this host.` };
}

/**
 * The share a network path lives on, so "the computer is off" can be told apart
 * from "there is no such folder on it". Both arrive as ENOENT on Windows.
 */
function shareRootOf(target: string): string | null {
  const match = UNC.exec(target);
  return match ? `\\\\${match[1]}\\${match[2]}` : null;
}

/**
 * What a local path most likely meant.
 *
 * The last folder in the path is what an administrator almost always names the
 * share after, so `C:\ProgramData\Hi\Human\LIS\ASTM\Output Worklist` becomes
 * `\\ANALYSER-PC\Output Worklist` — the shape to copy, with the one word only
 * they can supply left obvious.
 */
function suggestionFor(target: string): string {
  const leaf = target.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean).pop();
  return `\\\\ANALYSER-PC\\${leaf || 'Shared Folder'}`;
}

/**
 * Look at a watched folder and say what is wrong with it.
 *
 * Never throws: a verdict is always returned, because this is called from the
 * screen that is supposed to explain the failure.
 */
export function diagnoseWatchPath(given?: string | null): WatchPathVerdict {
  const target = String(given ?? '').trim();
  if (!target) {
    return {
      ok: false, reason: 'unset',
      note: 'No folder is set.',
      fix: 'Point the link at the folder the analyser exports into.',
    };
  }

  try {
    return inspect(target);
  } catch (error) {
    const code = errno(error);

    /* Reached, and refused. Nothing about the path is wrong. */
    if (code === 'EACCES' || code === 'EPERM') {
      return {
        ok: false, reason: 'denied',
        note: `${target} exists but this host is not allowed to read it.`,
        fix: 'On the computer that holds the folder, give this computer read access to the share — '
          + 'both on the share itself and in the folder\'s Security tab, which are two separate lists. '
          + 'If SECHLIMS runs as a Windows service, it is the service\'s account that needs the access, not yours.',
      };
    }

    /* A network path. Separate a computer that did not answer from a share
       that is not there, because they are different jobs. */
    const share = shareRootOf(target);
    if (share) {
      if (code === 'ETIMEDOUT' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH' || code === 'ENETDOWN') {
        return {
          ok: false, reason: 'host_unreachable',
          note: `The computer in ${target} did not answer.`,
          fix: 'Check that computer is switched on, awake and on the hospital network, and that file sharing is '
            + 'not blocked by its firewall.',
        };
      }
      let shareReachable = false;
      try { fs.accessSync(share, fs.constants.R_OK); shareReachable = true; } catch { /* answered below */ }
      if (shareReachable) {
        return {
          ok: false, reason: 'missing',
          note: `${share} is readable, but there is no ${path.basename(target)} inside it.`,
          fix: `Open ${share} from this computer and check what the folder is actually called. `
            + 'A share is often made ON the export folder, in which case the path ends at the share name '
            + 'and the folders above it are not repeated.',
        };
      }
      return {
        ok: false, reason: 'share_missing',
        note: `${share} could not be reached from this host.`,
        fix: 'Check the computer name and the share name are spelt right, that the folder is still shared, '
          + 'and that this computer can reach that one. Browsing to it in Explorer from this computer '
          + 'settles all three at once.',
      };
    }

    /* A drive letter, or a rooted path with no computer in it. This is the one
       that costs an afternoon, so it is named outright. */
    const drive = DRIVE.exec(target);
    if (drive || target.startsWith('/')) {
      const letter = drive ? `${drive[1].toUpperCase()}:` : null;
      let driveExists = false;
      if (letter) { try { fs.accessSync(`${letter}\\`, fs.constants.R_OK); driveExists = true; } catch { /* answered below */ } }
      const suggestion = suggestionFor(target);
      return {
        ok: false, reason: 'local_path',
        note: letter && !driveExists
          ? `There is no ${letter} drive on the computer SECHLIMS is running on.`
          : `${target} is a path on the computer SECHLIMS is running on, and there is no such folder here.`,
        fix: 'If the analyser\'s software is on a different computer, this is that computer\'s own disk and '
          + 'SECHLIMS cannot read it — a drive letter always means the machine doing the reading. '
          + `Share the folder on the analyser's computer, then enter it here as a network path: ${suggestion} `
          + '— the computer\'s name, then the share name.',
        suggestion,
      };
    }

    return {
      ok: false, reason: 'missing',
      note: `${target} cannot be reached from this host.`,
      fix: 'Check the share, the spelling and this machine\'s permissions on it.',
    };
  }
}

/**
 * The same judgement, for a path being typed into the form.
 *
 * The form cannot stat a folder on the host from the browser, so this is the
 * half that needs no filesystem: a drive letter on a link whose analyser is
 * somewhere else is wrong on sight, and saying so while they are still typing
 * is worth more than saying it after the link has failed.
 */
export function watchPathShape(given?: string | null): 'empty' | 'unc' | 'drive' | 'posix' | 'relative' {
  const target = String(given ?? '').trim();
  if (!target) return 'empty';
  if (UNC.test(target)) return 'unc';
  if (DRIVE.test(target)) return 'drive';
  if (target.startsWith('/')) return 'posix';
  return 'relative';
}
