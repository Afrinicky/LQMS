/**
 * What this host can actually be reached on, and why it cannot.
 *
 * ----------------------------------------------------------------------------
 * Why this exists
 * ----------------------------------------------------------------------------
 * A laboratory lost its network and the screen could only say that the host
 * was listening on 0.0.0.0 and that every address was "answering". Both were
 * true. The host answered itself perfectly and no other machine in the
 * building could reach it, because the hospital's IT team had worked on the
 * network and Windows had quietly reclassified the wireless connection as
 * Public — on which it refuses every inbound connection.
 *
 * Nothing in the product could see that, say it, or fix it. The settings
 * screen reported the one layer that was working.
 *
 * So this module looks at the layers underneath: what the machine's interfaces
 * actually are, whether the firewall will admit a connection on the port, what
 * Windows thinks each network is, and whether any other device has in fact
 * reached this host recently. Each answer is reported as a verdict a person
 * can act on rather than a value they have to interpret.
 *
 * Everything here is advisory and read-only except `openFirewallPort`, which
 * changes the machine and is only ever called when somebody presses the
 * button that says it will.
 */
import { execFile } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';

/* ============================================================================
   Running a command without letting it hang the request
   ========================================================================= */
function run(command: string, args: string[], timeoutMs = 8000): Promise<{ ok: boolean; out: string; err: string }> {
  return new Promise(resolve => {
    try {
      execFile(command, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 },
        (error, stdout, stderr) => {
          resolve({ ok: !error, out: String(stdout ?? ''), err: String(stderr ?? error?.message ?? '') });
        });
    } catch (error) {
      resolve({ ok: false, out: '', err: String((error as Error).message) });
    }
  });
}

const isWindows = process.platform === 'win32';

/* ============================================================================
   The interfaces this machine has
   ========================================================================= */
export type Interface = {
  /** The operating system's own name for the adapter. */
  name: string;
  address: string;
  family: 'IPv4' | 'IPv6';
  netmask: string;
  /** 'lan' on an ordinary network, 'remote' for Tailscale and the like. */
  kind: 'lan' | 'remote' | 'hotspot' | 'loopback' | 'other';
  /** Why this one may not be the address to give a bench. */
  note: string | null;
};

/**
 * Tell apart the addresses a machine has, because they are not equivalent.
 *
 * 100.64.0.0/10 is the range Tailscale and other overlay networks hand out:
 * real, routable from the overlay, and invisible to a bench in the next room.
 * 192.168.137.0/24 is the subnet Windows gives its own Mobile Hotspot, which
 * is a different network from the one the laboratory is on and is the
 * commonest address to publish by mistake.
 */
export function classify(address: string, name: string): { kind: Interface['kind']; note: string | null } {
  if (/^127\./.test(address) || address === '::1') {
    return { kind: 'loopback', note: 'This machine only. No other device can reach it here.' };
  }
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(address) || /^(tailscale|ts\d|zt|wg|tun|utun|ppp)/i.test(name)) {
    return { kind: 'remote', note: 'A remote-access network. Reachable from devices signed into it, not from the building.' };
  }
  if (/^192\.168\.137\./.test(address)) {
    return { kind: 'hotspot', note: 'Windows Mobile Hotspot. This is not the laboratory network, and a bench pointed here cannot reach the host.' };
  }
  if (/^169\.254\./.test(address)) {
    return { kind: 'other', note: 'No address was obtained from the network. This adapter has given itself one and cannot reach anything.' };
  }
  if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address)) return { kind: 'lan', note: null };
  return { kind: 'other', note: null };
}

export function interfaces(): Interface[] {
  const found: Interface[] = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const entry of list ?? []) {
      const family = String((entry as { family: string | number }).family);
      if (family !== 'IPv4' && family !== '4' && family !== 'IPv6' && family !== '6') continue;
      const isV4 = family === 'IPv4' || family === '4';
      const { kind, note } = classify(entry.address, name);
      found.push({
        name, address: entry.address, family: isV4 ? 'IPv4' : 'IPv6',
        netmask: entry.netmask ?? '', kind, note,
      });
    }
  }
  // The ones a laboratory would actually use, first.
  const rank: Record<Interface['kind'], number> = { lan: 0, other: 1, remote: 2, hotspot: 3, loopback: 4 };
  return found.sort((a, b) => rank[a.kind] - rank[b.kind]
    || Number(b.family === 'IPv4') - Number(a.family === 'IPv4')
    || a.address.localeCompare(b.address));
}

/* ============================================================================
   The firewall, and what Windows thinks this network is
   ========================================================================= */
export type FirewallState = {
  supported: boolean;
  /** Is there a rule admitting this port? */
  portAllowed: boolean | null;
  /** The name of the rule, where one was found. */
  ruleName: string | null;
  /** Each connection, and whether Windows is treating it as Public. */
  profiles: Array<{ name: string; category: string; public: boolean }>;
  /** Can this process change any of it, or does it need to be run as admin? */
  elevated: boolean | null;
  note: string | null;
};

export const FIREWALL_RULE_PREFIX = 'SECH_LIMS';

function ruleNameFor(port: number): string { return `${FIREWALL_RULE_PREFIX} ${port}`; }

async function isElevated(): Promise<boolean | null> {
  if (!isWindows) return null;
  const r = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command',
    '([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent())'
    + '.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)']);
  if (!r.ok) return null;
  return /true/i.test(r.out);
}

export async function firewallState(port: number): Promise<FirewallState> {
  if (!isWindows) {
    return {
      supported: false, portAllowed: null, ruleName: null, profiles: [], elevated: null,
      note: 'This host is not running Windows, so its firewall is managed outside this application.',
    };
  }

  const profiles: FirewallState['profiles'] = [];
  const p = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command',
    'Get-NetConnectionProfile | Select-Object InterfaceAlias,NetworkCategory | ConvertTo-Json -Compress']);
  if (p.ok && p.out.trim()) {
    try {
      const parsed = JSON.parse(p.out.trim());
      for (const entry of Array.isArray(parsed) ? parsed : [parsed]) {
        const category = String(entry?.NetworkCategory ?? '');
        profiles.push({
          name: String(entry?.InterfaceAlias ?? ''),
          category,
          public: /public/i.test(category),
        });
      }
    } catch { /* an unreadable answer is reported as no answer */ }
  }

  /*
   * Is the port admitted? Asked of the rules rather than by opening a socket,
   * because a socket opened from this machine to itself never crosses the
   * firewall and so always succeeds — which is precisely the false all-clear
   * the old screen gave.
   */
  let portAllowed: boolean | null = null;
  let ruleName: string | null = null;
  const f = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command',
    `Get-NetFirewallPortFilter | Where-Object { $_.LocalPort -eq '${port}' } | `
    + 'Get-NetFirewallRule | Where-Object { $_.Enabled -eq \'True\' -and $_.Direction -eq \'Inbound\' '
    + '-and $_.Action -eq \'Allow\' } | Select-Object -First 1 -ExpandProperty DisplayName']);
  if (f.ok) {
    const name = f.out.trim();
    portAllowed = Boolean(name);
    ruleName = name || null;
  }

  return {
    supported: true,
    portAllowed,
    ruleName,
    profiles,
    elevated: await isElevated(),
    note: null,
  };
}

/**
 * Admit the port, and stop Windows treating the laboratory network as Public.
 *
 * Both halves matter and the second is the one people miss. A rule scoped to
 * the Private profile does nothing on a connection Windows has decided is
 * Public, and Windows decides that on its own every time a network looks new
 * to it — which is what a renamed access point looks like. So the rule is
 * created for every profile, AND any connection currently marked Public is
 * moved to Private.
 */
export async function openFirewallPort(port: number, ports: number[] = []): Promise<{
  ok: boolean; changed: string[]; error: string | null; command: string;
}> {
  const all = [...new Set([port, ...ports])];
  const manual = all.map(p =>
    `New-NetFirewallRule -DisplayName "${ruleNameFor(p)}" -Direction Inbound -Protocol TCP `
    + `-LocalPort ${p} -Action Allow -Profile Any`).join('; ');

  if (!isWindows) {
    return { ok: false, changed: [], command: manual,
      error: 'This host is not running Windows, so its firewall is managed outside this application.' };
  }
  if ((await isElevated()) === false) {
    return { ok: false, changed: [], command: manual,
      error: 'Changing the firewall needs administrator rights, and this application is not running with them. '
        + 'Close it, start it again with "Run as administrator", and press this once more — or give the command below to whoever administers this machine.' };
  }

  const changed: string[] = [];
  for (const p of all) {
    const name = ruleNameFor(p);
    await run('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      `Remove-NetFirewallRule -DisplayName "${name}" -ErrorAction SilentlyContinue`], 15000);
    const add = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      `New-NetFirewallRule -DisplayName "${name}" -Direction Inbound -Protocol TCP -LocalPort ${p} `
      + '-Action Allow -Profile Any | Out-Null'], 20000);
    if (!add.ok) {
      return { ok: false, changed, command: manual,
        error: `The firewall rule for port ${p} could not be created. ${add.err.trim()}` };
    }
    changed.push(`Port ${p} admitted by the firewall`);
  }

  // Any connection Windows has classified Public refuses inbound traffic
  // whatever the rules say.
  const state = await firewallState(port);
  for (const profile of state.profiles) {
    if (!profile.public || !profile.name) continue;
    const set = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      `Set-NetConnectionProfile -InterfaceAlias "${profile.name}" -NetworkCategory Private`], 15000);
    if (set.ok) changed.push(`"${profile.name}" changed from Public to Private`);
  }

  return { ok: true, changed, error: null, command: manual };
}

/* ============================================================================
   Has anything else actually reached this host?
   ----------------------------------------------------------------------------
   The only question that matters, and the only one the host cannot answer by
   itself. A bench opens the address it was given; the host records that
   something arrived from somewhere, and the settings screen can then say so
   with a time against it.
   ========================================================================= */
export type Visitor = { address: string; at: string; agent: string | null };

const visitors = new Map<string, Visitor>();
const VISITOR_LIMIT = 50;

/** Remember that a device reached this host. Called by the reachability route. */
export function noteVisitor(address: string | null | undefined, agent?: string | null): void {
  const clean = String(address ?? '').replace(/^::ffff:/, '').trim();
  if (!clean) return;
  visitors.set(clean, { address: clean, at: new Date().toISOString(), agent: agent ? String(agent).slice(0, 120) : null });
  // Oldest first, so the map never grows without bound on a busy network.
  while (visitors.size > VISITOR_LIMIT) {
    const oldest = [...visitors.entries()].sort((a, b) => a[1].at.localeCompare(b[1].at))[0];
    if (!oldest) break;
    visitors.delete(oldest[0]);
  }
}

/** Devices that have reached this host, most recent first. */
export function recentVisitors(): Visitor[] {
  const mine = new Set(interfaces().map(i => i.address));
  return [...visitors.values()]
    // A request from the host to itself proves nothing about the network.
    .filter(v => !mine.has(v.address) && !/^127\./.test(v.address) && v.address !== '::1')
    .sort((a, b) => b.at.localeCompare(a.at));
}

/* ============================================================================
   The diagnosis
   ========================================================================= */
export type Finding = {
  key: string;
  label: string;
  status: 'ok' | 'warn' | 'fail' | 'info';
  detail: string;
  fix: string | null;
};

/** Is something listening on this port of this machine? */
function listening(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise(resolve => {
    const socket = net.connect({ port, host });
    const done = (answer: boolean) => { socket.destroy(); resolve(answer); };
    socket.setTimeout(2000);
    socket.on('connect', () => done(true));
    socket.on('timeout', () => done(false));
    socket.on('error', () => done(false));
  });
}

/**
 * Work down the layers, and say which one is broken.
 *
 * In the order a connection actually has to survive: something is listening,
 * it is listening somewhere other devices could reach, the machine has an
 * address on the laboratory network, the firewall will admit the port, and
 * something has in fact arrived. The first one that fails is the answer, and
 * the ones after it are reported anyway because an administrator fixing a
 * network wants the whole picture rather than one line at a time.
 */
export async function diagnose(options: {
  boundHost: string; port: number; extraPorts?: number[];
}): Promise<{ findings: Finding[]; verdict: string }> {
  const findings: Finding[] = [];
  const add = (key: string, label: string, status: Finding['status'], detail: string, fix?: string) =>
    findings.push({ key, label, status, detail, fix: fix ?? null });

  const up = await listening(options.port);
  add('listening', 'The host is listening', up ? 'ok' : 'fail',
    up ? `Something answers on port ${options.port} of this machine.`
      : `Nothing answers on port ${options.port} of this machine.`,
    up ? undefined : 'The host is not running, or it failed to take the port. Restart it and read the message it gives.');

  const loopbackOnly = !options.boundHost || /^127\.|^::1$/.test(options.boundHost);
  add('bound', 'It is listening where others can reach it', loopbackOnly ? 'fail' : 'ok',
    loopbackOnly
      ? 'It is bound to this machine only, so no other device can reach it however the network is set up.'
      : `It is bound to ${options.boundHost}.`,
    loopbackOnly ? 'Set "Who may reach it" to every device on this network.' : undefined);

  const lan = interfaces().filter(i => i.kind === 'lan' && i.family === 'IPv4');
  add('address', 'This machine is on the laboratory network', lan.length ? 'ok' : 'fail',
    lan.length
      ? `${lan.map(i => `${i.address} (${i.name})`).join(', ')}.`
      : 'This machine has no ordinary network address. Every address it has is loopback, a hotspot, or a remote-access network.',
    lan.length ? undefined : 'Check the cable or the wireless connection, and that the network gave this machine an address.');

  const fw = await firewallState(options.port);
  if (!fw.supported) {
    add('firewall', 'The firewall admits the port', 'info', fw.note ?? '');
  } else {
    const publicProfiles = fw.profiles.filter(p => p.public);
    if (publicProfiles.length) {
      add('firewall_profile', 'Windows is treating this network as private', 'fail',
        `${publicProfiles.map(p => `"${p.name}"`).join(', ')} ${publicProfiles.length === 1 ? 'is' : 'are'} `
        + 'classified Public, and Windows refuses inbound connections on a Public network whatever the firewall rules say. '
        + 'Windows reclassifies a network on its own whenever it looks new to it, which is what a renamed or '
        + 'reconfigured access point looks like.',
        'Press "Allow devices to reach this host", which moves it to Private and admits the port.');
    } else if (fw.profiles.length) {
      add('firewall_profile', 'Windows is treating this network as private', 'ok',
        fw.profiles.map(p => `"${p.name}" is ${p.category}`).join(', ') + '.');
    }
    add('firewall', 'The firewall admits the port',
      fw.portAllowed === null ? 'info' : fw.portAllowed ? 'ok' : 'fail',
      fw.portAllowed === null ? 'The firewall rules could not be read on this machine.'
        : fw.portAllowed ? `Admitted by the rule "${fw.ruleName}".`
        : `No enabled inbound rule admits port ${options.port}, so Windows is dropping connections from other devices.`,
      fw.portAllowed === false ? 'Press "Allow devices to reach this host".' : undefined);
  }

  const seen = recentVisitors();
  add('reached', 'Another device has reached this host', seen.length ? 'ok' : 'warn',
    seen.length
      ? `${seen.length} device(s); most recently ${seen[0].address} at ${seen[0].at.slice(11, 19)} UTC.`
      : 'No other device has reached this host since it started.',
    seen.length ? undefined
      : 'Open the address below in a browser on a bench, then look here again. If it does not arrive, the fault is between the two machines rather than on this one.');

  const firstBad = findings.find(f => f.status === 'fail');
  const verdict = firstBad
    ? firstBad.detail
    : seen.length
      ? 'Other devices are reaching this host.'
      : 'Nothing on this machine is blocking a connection. If a bench still cannot reach it, the fault is in the network between them — on a hospital network that is usually client isolation on the wireless, or the two machines being on different VLANs.';
  return { findings, verdict };
}
