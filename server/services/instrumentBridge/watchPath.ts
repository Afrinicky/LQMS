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
import os from 'node:os';
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
 * What to do about a share that refuses this computer.
 *
 * Said in one place because it is the same answer to two different-looking
 * failures, and because the easy fix and the right fix are not the same thing:
 * switching password protection off is one click and opens the folder to
 * everyone on the hospital network, which is a decision a laboratory should
 * make deliberately rather than discover.
 */
export function credentialAdvice(share: string): string {
  const computer = /^[\\/]{2}([^\\/]+)/.exec(share)?.[1] ?? 'that computer';
  return `With password protection on, ${computer} wants a username and password that exists ON ${computer} `
    + 'before it allows any share access, so "Everyone: Read" is never reached. Either give this computer '
    + `those credentials once — on THIS computer, signed in as the account SECHLIMS runs as, run `
    + `net use ${share} /user:${computer}\\<account> <password> /persistent:yes — or, if the laboratory `
    + `accepts it, switch password-protected sharing off on ${computer} under Network and Sharing Center, `
    + 'Advanced sharing settings, All networks. The first keeps the folder private to one account; '
    + 'the second opens it to everyone on the network.';
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
      /*
       * A UNC path only means anything on Windows. Elsewhere it is just a
       * string with backslashes in it, and reporting "the share could not be
       * reached" sends somebody to check a share that was never going to be
       * reached this way.
       */
      if (os.platform() !== 'win32') {
        return {
          ok: false, reason: 'share_missing',
          note: `${target} is a Windows network path, and SECHLIMS is not running on Windows here.`,
          fix: 'Mount the share on this computer and point the link at the mount point instead — for example '
            + `mount it at /mnt/analyser and enter /mnt/analyser. The share itself is fine; this computer `
            + 'just cannot address it the Windows way.',
        };
      }

      /*
       * Why the SHARE could not be opened, which is a different question from
       * why the folder inside it could not.
       *
       * The answer that costs an afternoon is a refusal that does not look
       * like one. With password-protected sharing on — the Windows default —
       * a computer refuses an unauthenticated connection before it ever
       * consults the share's permissions, so "Everyone: Read" is set, correct,
       * and irrelevant. Windows reports that as a bad network path rather than
       * as access denied, so it reads exactly like a misspelled share name and
       * sends somebody to check a name that was right all along.
       */
      let shareError: unknown = null;
      let shareReachable = false;
      try { fs.accessSync(share, fs.constants.R_OK); shareReachable = true; }
      catch (error) { shareError = error; }

      if (shareReachable) {
        return {
          ok: false, reason: 'missing',
          note: `${share} is readable, but there is no ${path.basename(target)} inside it.`,
          fix: `Open ${share} from this computer and check what the folder is actually called. `
            + 'A share is often made ON the export folder, in which case the path ends at the share name '
            + 'and the folders above it are not repeated.',
        };
      }

      const shareCode = errno(shareError);
      if (shareCode === 'EACCES' || shareCode === 'EPERM') {
        return {
          ok: false, reason: 'denied',
          note: `${share} is there, and refused this computer.`,
          fix: credentialAdvice(share),
        };
      }

      return {
        ok: false, reason: 'share_missing',
        note: `${share} could not be opened from this host.`,
        fix: 'Two things look identical here and only one of them is a spelling mistake. '
          + 'If you can browse to it from the ANALYSER\u2019s own computer but not from this one, the name is '
          + 'right and the connection is being refused: see whether that computer has password-protected '
          + `sharing switched on. ${credentialAdvice(share)} `
          + 'Otherwise check the computer name and the share name, and that the folder is still shared.',
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

/* ============================================================================
   Asking without stopping everything else
   ----------------------------------------------------------------------------
   The probes above are synchronous, and that is fine on a local disk where
   they take microseconds. On a network share that is NOT answering, a single
   one blocks for as long as SMB takes to give up — tens of seconds — and
   because it is synchronous it blocks Node's event loop, which means it blocks
   the whole API. Every other screen in the laboratory stops with it, and the
   browser that asked gives up and says only "Failed to fetch".

   So anything reached from a request asks through here instead: the probe runs
   on the thread pool, the answer is bounded by a timeout, and the verdict is
   remembered briefly so a screen that refreshes every few seconds does not
   start a new probe each time.
   ========================================================================= */

/** How long a verdict is reused before the folder is looked at again. */
const VERDICT_TTL_MS = 15_000;
/** How long to wait for a filesystem that may never answer. */
const PROBE_TIMEOUT_MS = 4_000;

const remembered = new Map<string, { at: number; verdict: WatchPathVerdict }>();
const inFlight = new Map<string, Promise<WatchPathVerdict>>();

/**
 * The same verdict, without blocking the event loop.
 *
 * A probe that does not answer within the timeout is reported as exactly
 * that — a folder that did not answer is a real and useful finding, and far
 * better than a screen that hangs until the browser gives up.
 */
export async function diagnoseWatchPathAsync(given?: string | null): Promise<WatchPathVerdict> {
  const target = String(given ?? '').trim();
  if (!target) return diagnoseWatchPath(target);

  const held = remembered.get(target);
  if (held && Date.now() - held.at < VERDICT_TTL_MS) return held.verdict;

  // One probe at a time per path: ten screens asking at once is still one.
  const running = inFlight.get(target);
  if (running) return running;

  const probe = (async (): Promise<WatchPathVerdict> => {
    let timer: NodeJS.Timeout | undefined;
    try {
      const verdict = await Promise.race([
        probeAsync(target),
        new Promise<WatchPathVerdict>(resolve => {
          timer = setTimeout(() => resolve({
            ok: false, reason: 'host_unreachable',
            note: `${target} did not answer within ${PROBE_TIMEOUT_MS / 1000} seconds.`,
            fix: 'That usually means the computer holding it is off, asleep or off the network. It is also what '
              + 'a share being refused looks like while the connection times out, so try browsing to it in '
              + 'Explorer from this computer.',
          }), PROBE_TIMEOUT_MS);
        }),
      ]);
      remembered.set(target, { at: Date.now(), verdict });
      if (remembered.size > 200) remembered.delete(remembered.keys().next().value as string);
      return verdict;
    } finally {
      if (timer) clearTimeout(timer);
      inFlight.delete(target);
    }
  })();

    inFlight.set(target, probe);
  return probe;
}

/** Forget what was learned about a path, so the next ask looks again. */
export function forgetWatchPath(given?: string | null): void {
  const target = String(given ?? '').trim();
  if (target) remembered.delete(target);
  else remembered.clear();
}

/**
 * The same questions as the synchronous diagnosis, asked with fs.promises.
 *
 * This is the part that matters: fs.promises runs the work on Node's thread
 * pool, so a share that takes half a minute to refuse costs one pooled thread
 * and nothing else. The synchronous version blocks the event loop, which on a
 * dead share stops every other request in the host — which is what "Failed to
 * fetch" on an unrelated screen actually was.
 */
async function probeAsync(target: string): Promise<WatchPathVerdict> {
  try {
    const stat = await fs.promises.stat(target);
    if (!stat.isDirectory()) {
      return {
        ok: false, reason: 'not_a_folder',
        note: `${target} is a file, not a folder.`,
        fix: 'Point the link at the folder that holds the analyser\'s exports, not at one file inside it.',
      };
    }
    await fs.promises.access(target, fs.constants.R_OK);
    return { ok: true, reason: 'ok', note: `${target} is readable from this host.` };
  } catch (error) {
    const code = errno(error);
    if (code === 'EACCES' || code === 'EPERM') {
      const share = shareRootOf(target);
      return {
        ok: false, reason: 'denied',
        note: `${target} exists and refused this computer.`,
        fix: share ? credentialAdvice(share)
          : 'Give this computer read access to the folder — on the share and in its Security tab, which are '
            + 'two separate lists. If SECHLIMS runs as a Windows service it is the service\'s account that '
            + 'needs it, not yours.',
      };
    }

    const share = shareRootOf(target);
    if (share) {
      if (code === 'ETIMEDOUT' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH' || code === 'ENETDOWN') {
        return {
          ok: false, reason: 'host_unreachable',
          note: `The computer in ${target} did not answer.`,
          fix: 'Check that computer is switched on, awake and on the hospital network, and that file sharing '
            + 'is not blocked by its firewall.',
        };
      }
      if (os.platform() !== 'win32') {
        return {
          ok: false, reason: 'share_missing',
          note: `${target} is a Windows network path, and SECHLIMS is not running on Windows here.`,
          fix: 'Mount the share on this computer and point the link at the mount point instead — for example '
            + 'mount it at /mnt/analyser and enter /mnt/analyser. The share itself is fine; this computer '
            + 'just cannot address it the Windows way.',
        };
      }
      let shareError: unknown = null;
      try { await fs.promises.access(share, fs.constants.R_OK); }
      catch (e) { shareError = e; }
      if (!shareError) {
        return {
          ok: false, reason: 'missing',
          note: `${share} is readable, but there is no ${path.basename(target)} inside it.`,
          fix: `Open ${share} from this computer and check what the folder is actually called. `
            + 'A share is often made ON the export folder, in which case the path ends at the share name '
            + 'and the folders above it are not repeated.',
        };
      }
      const shareCode = errno(shareError);
      if (shareCode === 'EACCES' || shareCode === 'EPERM') {
        return { ok: false, reason: 'denied', note: `${share} is there, and refused this computer.`, fix: credentialAdvice(share) };
      }
      return {
        ok: false, reason: 'share_missing',
        note: `${share} could not be opened from this host.`,
        fix: 'Two things look identical here and only one of them is a spelling mistake. '
          + 'If you can browse to it from the ANALYSER\u2019s own computer but not from this one, the name is '
          + 'right and the connection is being refused: see whether that computer has password-protected '
          + `sharing switched on. ${credentialAdvice(share)} `
          + 'Otherwise check the computer name and the share name, and that the folder is still shared.',
      };
    }

    // Not a network path: the synchronous reasoning needs no I/O beyond what
    // has already failed, so it answers the local cases without blocking.
    return diagnoseWatchPath(target);
  }
}
