/**
 * Whether this host is reachable from outside the machine, and by what route.
 *
 * The laboratory host binds to loopback by default, which is right for a
 * single-PC deployment and completely wrong the moment somebody expects to open
 * it from another device. When that happens the browser just times out, and
 * nothing anywhere says why — the connection is refused by an interface the
 * server was never listening on.
 *
 * Tailscale is the usual answer for a laboratory without a network engineer: it
 * proxies from the tailnet to loopback on this same machine, so the API can stay
 * private to the host and still be reachable by the people who should reach it,
 * with no firewall rule and no port open to the LAN.
 *
 * This module answers three questions the settings screen asks:
 *
 *   is Tailscale installed and logged in?
 *   what is this machine called on the tailnet?
 *   is the laboratory's port actually being served over it?
 *
 * NOTHING HERE MAY BLOCK. It shells out to a CLI that may be missing, may be
 * mid-restart, or may sit waiting on a daemon that has gone away, and it is
 * called from a screen somebody is looking at. Every call has a deadline and
 * every failure degrades to "not detected" rather than an error.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';

/** Long enough for a cold CLI start, short enough not to hold a page open. */
const CLI_TIMEOUT_MS = 4_000;

/**
 * Where the CLI lives when it is not on PATH.
 *
 * The Windows installer does not add itself to PATH, which is exactly the
 * platform a laboratory runs on, so guessing correctly here is the difference
 * between the screen knowing the answer and shrugging.
 */
const CLI_CANDIDATES: Record<string, string[]> = {
  win32: [
    'C:\\Program Files\\Tailscale\\tailscale.exe',
    'C:\\Program Files (x86)\\Tailscale\\tailscale.exe',
  ],
  darwin: [
    '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
    '/usr/local/bin/tailscale',
    '/opt/homebrew/bin/tailscale',
  ],
  linux: ['/usr/bin/tailscale', '/usr/local/bin/tailscale'],
};

let cachedCli: string | null | undefined;

/** The tailscale binary, or null if this machine has not got one. */
export function findCli(): string | null {
  if (cachedCli !== undefined) return cachedCli;
  for (const candidate of CLI_CANDIDATES[process.platform] ?? []) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      cachedCli = candidate;
      return cachedCli;
    } catch { /* try the next one */ }
  }
  // Fall back to PATH. Whether it is really there is settled by the first call.
  cachedCli = 'tailscale';
  return cachedCli;
}

/** Reset the cached lookup, so the next call searches again. */
export function forgetCli(): void { cachedCli = undefined; }

/**
 * Point at a specific binary. The checks use this to stand a stub in for a CLI
 * that is not installed on a test host — the failures that matter here (missing,
 * stopped, unreadable, hanging) are precisely the ones a real Tailscale will not
 * perform on demand.
 */
export function __setCliForTests(binary: string | null): void { cachedCli = binary; }

type RunResult = { ok: true; stdout: string } | { ok: false; error: string; missing?: boolean };

function run(args: string[]): Promise<RunResult> {
  const cli = findCli();
  if (!cli) return Promise.resolve({ ok: false, error: 'Tailscale is not installed on this computer.', missing: true });
  return new Promise(resolve => {
    execFile(cli, args, { timeout: CLI_TIMEOUT_MS, windowsHide: true }, (err, stdout) => {
      if (!err) return resolve({ ok: true, stdout });
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        return resolve({ ok: false, error: 'Tailscale is not installed on this computer.', missing: true });
      }
      if (code === 'ETIMEDOUT' || (err as { killed?: boolean }).killed) {
        return resolve({ ok: false, error: 'Tailscale did not answer. It may be starting up, or stopped.' });
      }
      // A non-zero exit still carries the useful sentence on stdout/stderr.
      const said = `${stdout ?? ''} ${err.message ?? ''}`.trim();
      resolve({ ok: false, error: said || 'Tailscale could not be asked for its status.' });
    });
  });
}

const parse = (text: string): Record<string, unknown> | null => {
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' ? value as Record<string, unknown> : null;
  } catch { return null; }
};

export type TailscaleStatus = {
  /** The CLI exists and answered. */
  installed: boolean;
  /** The daemon is up and this machine is logged in to a tailnet. */
  running: boolean;
  /** e.g. "lab-host.tail1234.ts.net" — the name to hand somebody. */
  dnsName: string | null;
  /** e.g. "100.93.142.70". */
  ip: string | null;
  /** Set when something is wrong in a way worth showing. */
  error: string | null;
};

/** Is Tailscale here, and what is this machine called on it? */
export async function status(): Promise<TailscaleStatus> {
  const blank: TailscaleStatus = { installed: false, running: false, dnsName: null, ip: null, error: null };
  const result = await run(['status', '--json']);
  if (result.ok !== true) {
    return { ...blank, installed: !result.missing, error: result.missing ? null : result.error };
  }
  const json = parse(result.stdout);
  if (!json) return { ...blank, installed: true, error: 'Tailscale answered with something unreadable.' };

  const state = String(json.BackendState ?? '');
  const self = (json.Self ?? {}) as { DNSName?: string; TailscaleIPs?: string[] };
  const ips = Array.isArray(self.TailscaleIPs) ? self.TailscaleIPs : [];
  return {
    installed: true,
    running: state === 'Running',
    // The CLI reports it with a trailing dot, which is correct and looks wrong.
    dnsName: self.DNSName ? self.DNSName.replace(/\.$/, '') : null,
    ip: ips.find(a => a.includes('.')) ?? ips[0] ?? null,
    error: state === 'NeedsLogin' ? 'Tailscale is installed but not logged in on this computer.'
      : state && state !== 'Running' ? `Tailscale is ${state.toLowerCase()}.`
      : null,
  };
}

export type ServeStatus = {
  /** Something on the tailnet is being proxied to this host's API port. */
  serving: boolean;
  /** The https:// address to open, when it can be worked out. */
  url: string | null;
};

/**
 * Is `tailscale serve` pointing at our port?
 *
 * The serve configuration is matched by searching the whole document for a
 * proxy target on this port rather than by walking a fixed path through it.
 * The shape of that JSON has changed across Tailscale releases and a laboratory
 * host will not be running the version this was written against; a search finds
 * the answer under any of them, and a wrong answer here only costs a hint on a
 * settings screen.
 */
export async function serveStatus(port: number): Promise<ServeStatus> {
  const result = await run(['serve', 'status', '--json']);
  if (result.ok !== true) return { serving: false, url: null };

  const text = result.stdout ?? '';
  const json = parse(text);
  if (!json) return { serving: false, url: null };

  const target = new RegExp(`(?:127\\.0\\.0\\.1|localhost|\\[::1\\]):${port}\\b`);
  if (!target.test(text)) return { serving: false, url: null };

  // The Web block is keyed by "host:port"; the host part is the address to open.
  const web = (json.Web ?? {}) as Record<string, unknown>;
  const key = Object.keys(web)[0];
  const host = key ? key.replace(/:\d+$/, '') : null;
  return { serving: true, url: host ? `https://${host}/` : null };
}

export type Reachability = {
  /** True when a device that is not this one can open the laboratory. */
  reachable: boolean;
  /** How: over the tailnet, over the LAN, or not at all. */
  route: 'tailscale' | 'lan' | 'none';
  /** Everything a person needs to fix it, in one sentence. */
  advice: string | null;
  /** The address to hand somebody, when there is one. */
  url: string | null;
  tailscale: TailscaleStatus & { serving: boolean };
};

/**
 * The single question the settings screen actually wants answered: can anybody
 * else open this laboratory, and if not, what should they do about it?
 */
export async function reachability(opts: { host: string; port: number; lanExposed: boolean }): Promise<Reachability> {
  const ts = await status();
  const serve = ts.running ? await serveStatus(opts.port) : { serving: false, url: null };
  const tailscale = { ...ts, serving: serve.serving };

  if (serve.serving) {
    return {
      reachable: true, route: 'tailscale', advice: null,
      url: serve.url ?? (ts.dnsName ? `https://${ts.dnsName}/` : null),
      tailscale,
    };
  }
  if (opts.lanExposed) {
    return {
      reachable: true, route: 'lan',
      advice: 'The port is open to this whole network. If only named devices should reach the laboratory, publish it over Tailscale instead and bind back to 127.0.0.1.',
      url: null, tailscale,
    };
  }

  // Not reachable. The advice is the next step and only the next step —
  // whoever is asking has already been told the state by `reachable`, and
  // repeating it back to them is noise where an instruction should be. How far
  // along Tailscale already is decides which step that is, because "install
  // Tailscale" and "run one command" are very different jobs.
  const advice = !ts.installed
    ? 'Install Tailscale on this machine and on the devices that need access, then publish the laboratory over it.'
    : !ts.running
      ? `${ts.error ?? 'Tailscale is installed but not running.'} Sign in to it on this computer, then publish the laboratory.`
      : `Tailscale is running, so publishing it takes one command: run "tailscale serve --bg ${opts.port}" once on this machine.`;
  return { reachable: false, route: 'none', advice, url: null, tailscale };
}
