# TransLis

The analyser middleware and Result Filler of SECHLIMS, packaged to run on its
own, for facilities that have a laboratory information system already and no
quality management system to put beside it.

It carries a result from an analyser to whichever system the laboratory runs —
LHIMS, SECHLIMS, or anything else that speaks HL7, ASTM, HTTP or files — and
accounts for what happened to every message on the way.

---

## 1. What it is, and what it is not

It is the same engine. The bridge, the middleware engine, the six transports,
the safety rules, the diagnostics, the discovery, the configuration history and
the Result Filler services are **imported** from the SECHLIMS tree, not copied.
A fix to either product is a fix to both, and neither can drift into
disagreeing with the other about a protocol.

Its database is SECHLIMS's schema in a data folder of its own. That is
deliberate: the services were written against those tables, and a hand-copied
subset would be a second schema to keep in step. The unused tables cost an
empty file about a megabyte.

It is **not** a quality management system. There is no document control, no
personnel register, no internal quality control, no audit programme. A control
run that arrives is recorded and can be filled into whatever form the
laboratory keeps its controls in — including SECHLIMS's own, which the filler
recognises by the markers on it.

### What it has

| | |
|---|---|
| **Analyser Transmission & Middleware** | Overview, Discovery, Connection Setup, Diagnostics, Active Connections, Destinations, Routing & Mappings, Parameter Mappings, Live Monitoring, Message Explorer, Queues & Failed Deliveries, Result Filler, Result Reports, Audit & Rollback |
| **Analyser Sync & Interfacing** | The link register: which analyser, how it connects, what a control looks like |
| **Settings** | Accounts, transmission mode, data retention |

The Dennis Assistant is not included. It is the laboratory's own assistant
reading the laboratory's own evidence, and it belongs to the quality management
system rather than to a middleware.

---

## 2. The two ways it receives

Chosen when the installation is set up, and changeable afterwards. It is one
choice per installation rather than per link, because it describes where the
software is standing, and software can only stand in one place.

### Network (LAN)

Analysers transmit to this computer across the laboratory network, exactly as
they transmit to a SECHLIMS host. One installation serves every bench, and the
benches reach it by its address. The host binds every interface.

### Direct — on the analyser PC

This computer **is** the analyser's own PC. Results are taken locally — from a
folder the instrument software writes to, a port on this machine, or a
serial-to-Ethernet converter on it — and go straight out to the LIS from here.
No central installation, one per analyser PC. The host binds loopback and
nothing on the network can reach it.

An installation nobody has set up yet binds loopback whichever way the setting
reads. Changing the mode takes effect when the application is restarted, and
the Settings screen says so rather than leaving a site wondering why its
analysers reach nothing.

---

## 3. Accounts

Two, and no third.

| | |
|---|---|
| **Administrator** | Configures the analysers, the destinations, the routing, the mappings and the accounts. |
| **Staff** | Fills results with the Result Filler, and reads Live Monitoring and the Message Explorer so a bench can see whether an analyser is transmitting before reporting a fault. Changes no configuration. |

The permission model underneath is SECHLIMS's own — the same resolver, the same
tables, the same guards on the same routes. What differs is only how little is
written into it. Every refusal is enforced by the API, not merely hidden.

The last active administrator cannot demote or suspend themselves, because an
installation nobody can configure is an installation nobody can mend.

---

## 4. Data retention

TransLis has to record what an analyser said: a delivery cannot be queued,
retried, traced or accounted for otherwise. It has no reason to hold the values
once the receiving system has them.

An administrator sets how long, default 30 days. Past that age the result
values and the raw message are **emptied**, not deleted — the row stays, so
what remains is the whole account of what happened:

| Removed | Kept |
|---|---|
| The parsed result values | The delivery, its attempts, its acknowledgement and its outcome |
| The raw message as the analyser sent it | The end-to-end trace of every stage |
| The canonical form the transports built from | `payload_hash` — what was transmitted, provably |
| The rendered payload each delivery sent | The sample identifier, as a SHA-256 fingerprint |
| The lot number | When it arrived, and how many results it carried |

A laboratory can still answer "was this sample sent, and when?" by putting the
identifier in. The register is not a list of everybody whose blood went through
the machine.

The sweep runs shortly after the host starts and once a day after that, so a
computer switched off for a week catches up rather than waiting for midnight.
**Purge now** is on the same screen. A purged transmission cannot be replayed.

---

## 5. Running it

```bash
npm run dev:translis
```

```bash
npm run translis:api
```

```bash
npm run build:translis
```

```bash
npm run dist:translis
```

`dist:translis` produces `release-translis/TransLis-<version>-Setup.exe`.

Its data folder is `%APPDATA%/TransLis/data` on Windows, and the equivalent
under `~/.config` or `~/Library/Application Support` elsewhere. It is never the
SECHLIMS folder: two products writing one SQLite file, one of them deleting
result values on a retention schedule the other knows nothing about, is a way
to lose a laboratory's records.

The window closing does not stop the host. An analyser transmits when it
transmits, and somebody shutting the window at the end of a shift must not be
the reason a night's results went nowhere — it lives in the tray, and quitting
asks first.

---

## 6. The extension

The Result Filler is a browser extension, and TransLis hands out its own copy
from **Transmission & Middleware → Result Filler → Install**. It arrives
already pointed at this host and already carrying this product's name.

The branding is applied when the package is built, and only to the standalone
uppercase word. The extension also carries the name in lower case inside
storage keys, DOM element ids and a window flag; renaming those would make an
already-enrolled browser stop recognising its own stored session.

---

## 7. Tests

```bash
SECH_LIMS_DATA_DIR=/tmp/translis-check TRANSLIS_PORT=4331 npx tsx translis/server/index.ts
```

```bash
npm run check:translis
```

42 checks: the setup that runs once, the two accounts and every refusal between
them, the last-administrator guard, the modes and what the host answers on, the
retention bounds and the purge, and the extension it hands out.

The engine, the transports, the routing, the parsing and the filler are **not**
re-tested here. They are the same files, proved by the SECHLIMS suite —
`check:middleware-engine`, `check:middleware`, `check:bridge`, `check:fetch`,
`check:lhims`, `check:transmission`, `check:analyser-feed`, `check:iqc-analyser`
and `check:result-filler`. There is no second copy of any of it to test.

---

## 8. Where the code is

| Path | What it holds |
|---|---|
| `translis/server/boot.ts` | The data folder and the product name, set before anything reads them |
| `translis/server/brand.ts` | What this product is called, and the two modes |
| `translis/server/index.ts` | The host: six routers, five of them SECHLIMS's own |
| `translis/server/network.ts` | What the host binds, which the mode decides |
| `translis/server/seed.ts` | Two access profiles, and the first administrator |
| `translis/server/settings.ts` | The mode, the LIS name, the retention policy and the purge |
| `translis/server/routes.ts` | Setup, accounts, settings, purge |
| `translis/server/services.ts` | The bridge, the engine and the nightly sweep |
| `translis/electron/` | The window, the tray, and the host that outlives the window |
| `translis/src/` | The workspace, composed from SECHLIMS's own components |
