/**
 * Analyser links — how an instrument reaches SECHLIMS, and what it says.
 *
 * THE RULE THIS FILE IS BUILT AROUND: nothing here may disturb a transmission
 * that already works.
 *
 * This laboratory runs the national LHIMS middleware on one haematology
 * analyser, and that link carries patient results. It must keep working exactly
 * as it does today. So SECHLIMS never sits in the path of it, never binds a
 * port it is using, and never opens a connection to an analyser already
 * speaking to it. A bridge that "improves" a working patient-results link and
 * fails at 2am has done more harm than every feature it came with.
 *
 * What that leaves is a great deal, and it is all pure gain:
 *
 *   The SECOND haematology analyser. It transmits to nothing today, because the
 *   LHIMS middleware carries one analyser at a time. SECHLIMS takes it.
 *
 *   BOTH chemistry analysers. They speak TCP/IP and transmit to nothing today,
 *   because the middleware was written for haematology. SECHLIMS takes them.
 *
 *   The first haematology analyser — as a COPY, and this is the interesting one.
 *   Its single host port is spoken for, so SECHLIMS cannot be a second
 *   destination for it. But the LHIMS client has a setting of its own,
 *   WRITE_TO_FILE, which makes it append every message it receives to
 *   LHIMSDataInput.txt before it does anything else with it. SECHLIMS follows
 *   that file, read-only, the way `tail -f` does. No port, no socket, no
 *   interception: if SECHLIMS stops, the LHIMS transmission does not notice.
 *   That is how all four analysers reach SECHLIMS without one of them being
 *   disturbed.
 *
 * In the other direction, SECHLIMS can carry a result INTO LHIMS by making the
 * same HTTP call the middleware makes — api/update_result.php, with the
 * measure ids from the laboratory's own client configuration. That is how the
 * three analysers LHIMS never carried can start reaching it. It is off by
 * default, and refused outright for an analyser LHIMS already receives.
 */

/* ============================================================================
   What a link is FOR — the safety-critical distinction
   ========================================================================= */
export const LINK_ROLES = ['sechlims_only', 'lhims_owned', 'shared_forward'] as const;
export type LinkRole = (typeof LINK_ROLES)[number];

export const LINK_ROLE_LABELS: Record<LinkRole, string> = {
  sechlims_only: '{PRODUCT} only — this analyser transmits to nothing else',
  lhims_owned: 'LHIMS owns this link — {PRODUCT} must not touch it',
  shared_forward: '{PRODUCT} receives, and passes a copy on to LHIMS',
};

export const LINK_ROLE_HINTS: Record<LinkRole, string> = {
  sechlims_only:
    'The safe case, and the usual one. The analyser is not transmitting anywhere today, so {PRODUCT} takes it '
    + 'and nothing existing is affected. Both chemistry analysers and the second haematology analyser are this.',
  lhims_owned:
    'Recorded so the system knows to stay away from it. {PRODUCT} will refuse to bind this port or dial this '
    + 'analyser. It may still take a COPY of what this analyser sends, by following the LHIMS client\'s own '
    + 'append log — that reads a file rather than touching the connection, so the existing transmission is '
    + 'unaffected either way.',
  shared_forward:
    '{PRODUCT} receives from the analyser and forwards a copy onward to the LHIMS middleware. Only switch this '
    + 'on for an analyser LHIMS is NOT already receiving, once the link has proved itself — it is how LHIMS '
    + 'could eventually carry all four analysers, but it must never be pointed at a link LHIMS already has.',
};

/* ============================================================================
   How the analyser is reached
   ========================================================================= */
export const LINK_MODES = ['server', 'client', 'serial', 'file_drop', 'lhims_tap'] as const;
export type LinkMode = (typeof LINK_MODES)[number];

export const LINK_MODE_LABELS: Record<LinkMode, string> = {
  server: '{PRODUCT} listens; the analyser connects to it',
  client: '{PRODUCT} connects out to the analyser',
  serial: 'A serial cable, straight into this computer',
  file_drop: 'The analyser writes files to a watched folder',
  lhims_tap: 'Follow the LHIMS client\'s own log — a copy, touching nothing',
};

export const LINK_MODE_HINTS: Record<LinkMode, string> = {
  server: 'The usual arrangement, and what the LHIMS client uses. Give the analyser this host\'s address and the port below.',
  client: 'For an analyser that listens instead of dialling out. {PRODUCT} opens the connection and keeps it open.',
  serial:
    'For an analyser wired to this computer by an RS-232 cable rather than the network — a Biotecnica BT1500 is '
    + 'this. Give the port the operating system calls it (COM1 on Windows, /dev/ttyUSB0 on Linux) and the settings '
    + 'from the analyser\'s own service menu; they must match on both ends exactly or the bytes arrive as nonsense. '
    + 'Nothing is bound and nothing is dialled, so no network setting is involved at all.',
  file_drop: 'For an analyser whose only export is a file. Nothing is connected; the folder is watched.',
  lhims_tap:
    'The way to get a copy of an analyser LHIMS already owns. Set WRITE_TO_FILE = Yes in the LHIMS client and it '
    + 'appends every message it receives to LHIMSDataInput.txt; {PRODUCT} follows that file read-only, the way tail does. '
    + 'No port is bound, no connection is opened, nothing is intercepted — if {PRODUCT} stops, the LHIMS transmission '
    + 'does not notice.',
};

/* ----------------------------------------------------------------------------
   What a serial line has to agree about
   ----------------------------------------------------------------------------
   Both ends must say the same thing or the bytes arrive as nonsense — not as
   an error, which is the trouble: a mismatched baud rate produces a steady
   stream of plausible-looking rubbish rather than silence. These are offered
   as a list rather than a free-text box so that the one thing a person can get
   wrong is the value, not the spelling of it.

   The defaults are the BT1500's, from its service manual: 9600, 8 data bits,
   no parity, 1 stop bit, hardware handshake.
   -------------------------------------------------------------------------- */
export const SERIAL_BAUD_RATES = [1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200] as const;
export const SERIAL_DATA_BITS = [7, 8] as const;
export const SERIAL_STOP_BITS = [1, 2] as const;
export const SERIAL_PARITIES = ['none', 'even', 'odd'] as const;
export const SERIAL_FLOW_CONTROL = ['hardware', 'none', 'software'] as const;

export const SERIAL_FLOW_LABELS: Record<string, string> = {
  hardware: 'Hardware (RTS/CTS)',
  none: 'None',
  software: 'Software (XON/XOFF)',
};

export const SERIAL_DEFAULTS = {
  baudRate: 9600,
  dataBits: 8,
  stopBits: 1,
  parity: 'none',
  flowControl: 'hardware',
} as const;

/** Does this mode speak over a serial cable rather than the network? */
export function modeIsSerial(mode?: string | null): boolean {
  return mode === 'serial';
}

/**
 * A mode that only ever reads a file somebody else writes.
 *
 * This is the one arrangement in which a link may point at an analyser LHIMS
 * owns, because it does not touch that analyser or its connection at all — it
 * reads the middleware's own log. Every other mode is refused on an LHIMS-owned
 * link, and that difference is what makes including haematology 1 safe.
 */
export function modeIsPassive(mode?: string | null): boolean {
  return mode === 'lhims_tap';
}

/**
 * May the bridge open this link at all?
 *
 * An LHIMS-owned link is off limits — with exactly one exception, and it is
 * the exception that lets haematology 1 reach {PRODUCT}: following the
 * middleware's own append log reads a file, and reading a file cannot disturb
 * a socket. Anything that binds, dials or intercepts stays refused.
 */
export function linkIsOurs(role?: string | null, mode?: string | null): boolean {
  if (role !== 'lhims_owned') return true;
  return modeIsPassive(mode);
}

/**
 * Does this link carry a copy of its results onward to LHIMS?
 *
 * The role decides it, and nothing else may. "{PRODUCT} only — this analyser
 * transmits to nothing else" is a sentence about where the results go, and a
 * link saved under that role while an older setting still said "carry these to
 * LHIMS" went on carrying them: the screen said one thing, the link did
 * another, and only the badge on the card gave it away. Forwarding now belongs
 * to the one role that describes it.
 */
export function linkForwards(role?: string | null, forwardEnabled?: unknown): boolean {
  return role === 'shared_forward' && Boolean(Number(forwardEnabled ?? 0));
}

/* ============================================================================
   What it says on the wire
   ========================================================================= */
export const LINK_PROTOCOLS = ['astm', 'hl7', 'bt1500', 'delimited', 'auto'] as const;
export type LinkProtocol = (typeof LINK_PROTOCOLS)[number];

export const LINK_PROTOCOL_LABELS: Record<LinkProtocol, string> = {
  astm: 'ASTM E1394 (most haematology and chemistry analysers)',
  hl7: 'HL7 v2 ORU^R01 over MLLP',
  bt1500: 'Biotecnica BT1500 — fixed columns, asked for by the host',
  delimited: 'Plain delimited text, one result per line',
  auto: 'Work it out from what arrives',
};

export const LINK_PROTOCOL_HINTS: Record<LinkProtocol, string> = {
  astm: 'Framed records with ENQ/ACK handshaking and a checksum. Sysmex, Mindray BC-3600, ABX Pentra, BT-3000, Selectra and DIRUI all speak it.',
  hl7: 'Message framed between 0x0B and 0x1C 0x0D. Mindray BC-5800 and newer analysers use it.',
  bt1500:
    'The Biotecnica dialogue. Unlike every other protocol here the analyser never transmits on its own — '
    + '{PRODUCT} has to ask, and keeps asking: STX, then the analyser\'s ACK, then the request, and back comes '
    + 'one report in fixed columns or a NAK meaning none is waiting. Results only become available to ask for '
    + 'once they are validated on the analyser, so set "All results must be sent automatically (without '
    + 'validate)" under Utility, Setup Analyzer, Serial — otherwise nothing arrives until somebody presses '
    + 'Accept on the machine.',
  delimited: 'A fallback for an analyser with a simple text output. The layout is mapped by hand.',
  auto:
    'For an analyser whose protocol nobody has written down. The first message is read for its shape — ASTM records, '
    + 'HL7 segments or delimited lines — and read as whatever it actually is. Choosing the wrong protocol by hand '
    + 'produces a link that receives messages and understands none of them, which looks exactly like a link that '
    + 'receives nothing; this cannot.',
};

/** How long to wait for the rest of a message before giving up on it. */
export const LINK_MESSAGE_TIMEOUT_MS = 30_000;
/** How long between reconnection attempts in client mode. */
export const LINK_RECONNECT_MS = 15_000;
/** A frame larger than this is a runaway, not a result. */
export const LINK_MAX_FRAME_BYTES = 512 * 1024;
/**
 * How often a watched folder is looked at when it cannot be watched.
 *
 * A folder on another computer is reached over SMB, and SMB change
 * notifications are not dependable — some servers never send them. Such a
 * folder is polled instead, on its own, without depending on the scheduled
 * fetch being switched on: a link that silently reads nothing because a
 * checkbox was left clear is the failure this exists to prevent. Fifteen
 * seconds is quick enough for the bench and gentle enough for a share.
 */
export const LINK_FOLDER_POLL_MS = 15_000;
/**
 * How long a stream with no end-of-transmission marker is given to go quiet
 * before what it has sent is taken as a whole message.
 */
export const LINK_IDLE_FLUSH_MS = 2_000;

/**
 * How long an analyser is given to send anything more before a link set to
 * close after each transmission hangs up. Long enough for a machine that sends
 * two or three messages one after another to finish.
 */
export const LINK_CLOSE_AFTER_MS = 3_000;

/* ============================================================================
   What to do with the connection once a transmission is in
   ----------------------------------------------------------------------------
   Two kinds of analyser, and they want opposite things.

   One dials the computer, keeps the connection for the rest of the day and
   sends each result down it. Hanging up on that one costs a reconnection it
   never asked for.

   The other treats a connection as one transaction: dial, send, wait to be
   acknowledged, and wait for the computer to hang up. Left waiting it eventually
   abandons the link — and will not transmit again until somebody walks to the
   machine and presses reconnect, which is precisely the complaint this setting
   exists to answer.

   Nothing in a transmission says which kind an analyser is, so the laboratory
   is asked, and told what the symptom looks like.
   ========================================================================= */
export const AFTER_TRANSMISSION_LABELS = {
  hold: 'Hold the connection open',
  close: 'Close it once the result is acknowledged',
} as const;

export const AFTER_TRANSMISSION_HINTS = {
  hold:
    'The usual arrangement. The analyser keeps one connection and sends each result down it, and {PRODUCT} '
    + 'never hangs up.',
  close:
    'For an analyser that treats one connection as one transmission and waits for the computer to hang up '
    + 'once it has been acknowledged; left waiting, it abandons the link. {PRODUCT} closes politely a few '
    + 'seconds after the last message, and the analyser dials again by itself for the next sample. '
    + 'Not for an analyser whose manual says it holds a persistent connection and reconnects by itself — the '
    + 'HumaCount 5D is one of those, and on those a connection that keeps dropping is a network fault, most '
    + 'often two machines sharing one address, not something this setting can mend.',
} as const;

export const LINK_STATES = ['stopped', 'listening', 'connected', 'connecting', 'following', 'error', 'blocked'] as const;
export type LinkState = (typeof LINK_STATES)[number];

export const LINK_STATE_LABELS: Record<LinkState, string> = {
  stopped: 'Not running',
  listening: 'Listening for the analyser',
  connected: 'Connected',
  connecting: 'Trying to connect',
  following: 'Following the LHIMS client\'s log',
  error: 'Failed',
  blocked: 'Left alone — LHIMS owns this link',
};

/* ============================================================================
   Telling a control apart from a patient
   ----------------------------------------------------------------------------
   This is the whole reason the bridge exists, and getting it wrong in either
   direction is serious: a patient sample mistaken for a control corrupts the
   QC record, and a control mistaken for a patient invents a patient.
   So the test is explicit and conservative — a message is a control only when
   something in it SAYS so, never by elimination.
   ========================================================================= */

/**
 * What analysers put in the sample identifier of a control run. Sysmex uses
 * QC/XbarM, Mindray writes the control level, the chemistry analysers usually
 * carry the control's own lot. A laboratory adds its own on the link.
 */
export const DEFAULT_CONTROL_PATTERNS = [
  'QC', 'QC1', 'QC2', 'QC3', 'CONTROL', 'CTRL', 'XBARM', 'XBAR',
  'LOW', 'NORMAL', 'HIGH', 'L-J', 'LJ',
];

/**
 * One pattern, compiled.
 *
 * A laboratory's own naming is not something this system can anticipate, and
 * the answer to that is not a longer built-in list — it is letting the
 * laboratory say what it means, here, without anybody changing code:
 *
 *   QC, CTRL            a token: matches when the identifier IS it, or carries
 *                       it whole at a separator. The plain case, unchanged.
 *   QC-*, *CONTROL*     a wildcard: `*` is any run of characters, `?` is one.
 *   /^C\d{4}-/i         a regular expression, between slashes, for a naming
 *                       scheme nothing simpler describes.
 *   !QC-TRAINING        a refusal: whatever else matches, this is never a
 *                       control. Refusals are checked first and always win.
 *
 * An unparseable regular expression is treated as the literal text it is,
 * rather than throwing — a typo in a settings box must not stop an analyser
 * transmitting.
 */
function compilePattern(raw: string): { negate: boolean; test: (id: string) => boolean } | null {
  let pattern = String(raw ?? '').trim();
  if (!pattern) return null;
  const negate = pattern.startsWith('!');
  if (negate) pattern = pattern.slice(1).trim();
  if (!pattern) return null;

  const asRegex = pattern.match(/^\/(.*)\/([a-z]*)$/);
  if (asRegex) {
    try {
      const expression = new RegExp(asRegex[1], asRegex[2].includes('i') ? asRegex[2] : `${asRegex[2]}i`);
      return { negate, test: id => expression.test(id) };
    } catch { /* a typo is literal text, not a broken link */ }
  }

  const upper = pattern.toUpperCase();
  if (/[*?]/.test(upper)) {
    const escaped = upper.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
    const expression = new RegExp(`^${escaped}$`);
    return { negate, test: id => expression.test(id) };
  }

  const escaped = upper.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // A boundary is the start, the end, or a separator — so "QC-2" and "2:QC"
  // match on "QC", while "SC2024QCX" does not.
  const boundary = new RegExp(`(^|[^A-Z0-9])${escaped}([^A-Z0-9]|$)`);
  return { negate, test: id => id === upper || boundary.test(id) };
}

/**
 * Does this sample identifier name a control?
 *
 * Deliberately anchored rather than a loose "contains": a patient sample
 * numbered `SC2024-QC-0031` must not be swept into the QC record because three
 * of its characters happen to spell QC.
 *
 * WHAT THIS IS NOT: it is not a filter on what the bridge accepts. Every
 * message an analyser sends is received, recorded and kept whether it matches
 * anything here or not — that is the whole point of writing the raw message
 * down before trying to understand it. All this decides is WHERE a message
 * goes once it has arrived: a control run to the IQC bench, a patient result
 * to the link's own record. A laboratory that recognises none of its controls
 * still has every one of them, under "patient", and can say so afterwards.
 */
export function looksLikeControl(sampleId: string | null | undefined, patterns?: string[] | null): boolean {
  const id = String(sampleId ?? '').trim().toUpperCase();
  if (!id) return false;
  const list = (patterns && patterns.length ? patterns : DEFAULT_CONTROL_PATTERNS)
    .map(compilePattern).filter(Boolean) as Array<{ negate: boolean; test: (id: string) => boolean }>;
  // A refusal wins over every match, so a laboratory can carve one name out of
  // a rule that is otherwise right.
  if (list.some(p => p.negate && p.test(id))) return false;
  return list.some(p => !p.negate && p.test(id));
}

/* ============================================================================
   Deciding what a message is
   ----------------------------------------------------------------------------
   One place, used by the bridge when a message lands and by the "try a
   message" screen when somebody is proving a link — so what the screen says
   would happen is what actually happens.

   The signals are taken in order of how much they are worth. An analyser that
   SAYS the run is quality control, in the protocol's own field for saying so,
   is believed outright and needs no configuration at all. A sample identifier
   that matches a control material this laboratory has actually registered is
   next: that is this laboratory's own record agreeing, not a guess. Only then
   the identifier patterns, which are a convention rather than a fact.

   And nothing is a control by elimination. A message that matches none of
   these is a patient result, because inventing a control record is as bad as
   losing one.
   ========================================================================= */

export interface ControlSignals {
  sampleId?: string | null;
  lotNumber?: string | null;
  /** The analyser said so itself, in the protocol's own field for it. */
  controlHint?: boolean | null;
  /**
   * Lot numbers and codes of the control materials this laboratory has
   * registered, so a control named only by its own lot is recognised without
   * anybody configuring a pattern for it.
   */
  knownControlIds?: Array<string | null | undefined> | null;
}

export interface ControlVerdict {
  control: boolean;
  /** Why, in a few words, for the screen and the audit trail. */
  because: string;
}

function sameIdentifier(a: string, b: string): boolean {
  const normalise = (v: string) => v.trim().toUpperCase().replace(/[\s_-]+/g, '');
  return Boolean(normalise(a)) && normalise(a) === normalise(b);
}

export function classifyMessage(signals: ControlSignals, patterns?: string[] | null): ControlVerdict {
  const sampleId = String(signals.sampleId ?? '').trim();
  const lotNumber = String(signals.lotNumber ?? '').trim();

  // An explicit refusal beats everything, including the analyser's own flag:
  // it is the one way a laboratory can say "not this one" and be obeyed.
  const refused = [sampleId, lotNumber].filter(Boolean).some(id => {
    const upper = id.toUpperCase();
    return (patterns ?? []).map(compilePattern).some(p => p?.negate && p.test(upper));
  });
  if (refused) return { control: false, because: 'a rule on this link says this identifier is never a control' };

  if (signals.controlHint === true) {
    return { control: true, because: 'the analyser marked the run as quality control' };
  }

  const known = (signals.knownControlIds ?? []).map(v => String(v ?? '').trim()).filter(Boolean);
  for (const candidate of [sampleId, lotNumber]) {
    if (!candidate) continue;
    if (known.some(id => sameIdentifier(candidate, id))) {
      return { control: true, because: `"${candidate}" is a control material registered in this laboratory` };
    }
  }

  if (looksLikeControl(sampleId, patterns)) {
    return { control: true, because: `the sample identifier "${sampleId}" matches a control pattern on this link` };
  }
  if (looksLikeControl(lotNumber, patterns)) {
    return { control: true, because: `the lot "${lotNumber}" matches a control pattern on this link` };
  }
  if (signals.controlHint === false) {
    return { control: false, because: 'the analyser marked the run as a patient sample' };
  }
  return { control: false, because: 'nothing in the message says it is a control, so it is kept as a patient result' };
}

/* ============================================================================
   Analyser profiles
   ----------------------------------------------------------------------------
   The analyte maps below are lifted from the laboratory's own LHIMS client
   configuration files, which is the only place the correct instrument mnemonics
   for these exact machines are written down. Reusing them means a link works on
   the first message rather than after a fortnight of mapping columns by hand.

   A profile is a starting point. Every one of these maps is editable on the
   link, because a laboratory renames its analytes and an analyser's firmware
   changes what it emits.
   ========================================================================= */

export interface InstrumentProfile {
  key: string;
  label: string;
  vendor: string;
  discipline: 'haematology' | 'chemistry' | 'molecular' | 'immunology' | 'other';
  protocol: LinkProtocol;
  /** Instrument mnemonic → the analyte name a control in this system uses. */
  analytes: Record<string, string>;
  /** Parameter → the scale this laboratory keeps it in. Absent means do not rescale. */
  units?: Record<string, string>;
  notes?: string;
  /**
   * Kept so an existing link still resolves, but never offered in a picker.
   *
   * The two original "something else that speaks ASTM / HL7" entries are this:
   * links saved under those keys go on working, while anybody choosing today
   * is offered the per-discipline sets instead.
   */
  hidden?: boolean;
  /** Where this model came from. Built in, a discipline default, or made here. */
  origin?: 'builtin' | 'default' | 'custom';
}

const FBC_SYSMEX: Record<string, string> = {
  WBC: 'WBC', RBC: 'RBC', HGB: 'Haemoglobin', HCT: 'Haematocrit',
  MCV: 'MCV', MCH: 'MCH', MCHC: 'MCHC', PLT: 'Platelets',
  'NEUT%': 'Neutrophils %', 'LYMPH%': 'Lymphocytes %', 'MONO%': 'Monocytes %',
  'EO%': 'Eosinophils %', 'BASO%': 'Basophils %',
  'NEUT#': 'Neutrophils', 'LYMPH#': 'Lymphocytes', 'MONO#': 'Monocytes',
  'EO#': 'Eosinophils', 'BASO#': 'Basophils',
  'RDW-SD': 'RDW-SD', 'RDW-CV': 'RDW-CV', PDW: 'PDW', MPV: 'MPV',
  'P-LCR': 'P-LCR', PCT: 'PCT', 'RET%': 'Reticulocytes %', 'RET#': 'Reticulocytes',
};

const FBC_MINDRAY_3PART: Record<string, string> = {
  WBC: 'WBC', RBC: 'RBC', HGB: 'Haemoglobin', HCT: 'Haematocrit',
  MCV: 'MCV', MCH: 'MCH', MCHC: 'MCHC', 'RDW-CV': 'RDW-CV', 'RDW-SD': 'RDW-SD',
  PLT: 'Platelets', MPV: 'MPV', PDW: 'PDW', PCT: 'PCT',
  'LYM#': 'Lymphocytes', 'MID#': 'Mid cells', 'GRAN#': 'Granulocytes',
  'LYM%': 'Lymphocytes %', 'MID%': 'Mid cells %', 'GRAN%': 'Granulocytes %',
};

/**
 * The HumaCount 5D's own mnemonics, as its HL7 messages carry them.
 *
 * Its OBX records name each parameter in the text component of the test
 * identifier — `770-8^NEU%^LN` — so NEU% and NEU# are what arrive, and the
 * two are deliberately kept apart here: one is a proportion and the other a
 * count, and the system that confuses them reports a control as failed.
 */
const FBC_HUMACOUNT: Record<string, string> = {
  WBC: 'WBC', RBC: 'RBC', HGB: 'Haemoglobin', HCT: 'Haematocrit',
  MCV: 'MCV', MCH: 'MCH', MCHC: 'MCHC', PLT: 'Platelets',
  'NEU%': 'Neutrophils %', 'LYM%': 'Lymphocytes %', 'MON%': 'Monocytes %',
  'EOS%': 'Eosinophils %', 'BAS%': 'Basophils %',
  'NEU#': 'Neutrophils', 'LYM#': 'Lymphocytes', 'MON#': 'Monocytes',
  'EOS#': 'Eosinophils', 'BAS#': 'Basophils',
  'ALY%': 'Atypical lymphocytes %', 'ALY#': 'Atypical lymphocytes',
  'LIC%': 'Large immature cells %', 'LIC#': 'Large immature cells',
  'RDW-CV': 'RDW-CV', 'RDW-SD': 'RDW-SD', PDW: 'PDW', MPV: 'MPV',
  PCT: 'PCT', 'P-LCR': 'P-LCR', 'P-LCC': 'P-LCC',
};

const CHEMISTRY_SELECTRA: Record<string, string> = {
  GLU: 'Glucose', FBS: 'Glucose', RBS: 'Glucose',
  TP: 'Total protein', ALB: 'Albumin', GLOB: 'Globulin',
  TBIL: 'Total bilirubin', DBIL: 'Direct bilirubin', IBIL: 'Indirect bilirubin', IBL: 'Indirect bilirubin',
  AST: 'AST', SGOT: 'AST', ALT: 'ALT', SGPT: 'ALT',
  GGT: 'Gamma GT', ALP: 'ALP',
  UREA: 'Urea', BUN: 'Urea', CREA: 'Creatinine', CRE: 'Creatinine',
  UA: 'Uric acid', URIC: 'Uric acid',
  CHOL: 'Total cholesterol', TC: 'Total cholesterol',
  TRIG: 'Triglycerides', TG: 'Triglycerides',
  HDL: 'HDL cholesterol', LDL: 'LDL cholesterol', VLDL: 'VLDL',
  CA: 'Calcium', AMY: 'Amylase', 'CK-MB': 'CK-MB', CKMB: 'CK-MB',
  CK: 'CK', 'CK-NAC': 'CK', LDH: 'LDH',
  NA: 'Sodium', K: 'Potassium', CL: 'Chloride',
};

/**
 * The HumaStar's own method names.
 *
 * HUMAN's interface manual is explicit that the assay name in a work list
 * "must exactly match the name of the same assay in the software", and those
 * method names are configured by the laboratory that installed it. So this is
 * a starting vocabulary rather than a specification: the spellings HUMAN's own
 * documentation uses, and the ones their methods ship under. A laboratory
 * whose machine says something else names it once under Parameter Mappings,
 * where the codes it has actually sent are listed for exactly that purpose.
 */
const CHEMISTRY_HUMASTAR: Record<string, string> = {
  GLU: 'Glucose', GLUC: 'Glucose', GLUCOSE: 'Glucose',
  UREA: 'Urea', BUN: 'Urea', 'UREA-UV': 'Urea',
  CREA: 'Creatinine', CREAA: 'Creatinine', 'CREA-A': 'Creatinine', CREAJ: 'Creatinine',
  // The reagent-position suffixes a laboratory ends up with when the same
  // method is set up more than once. Seen on a 300SR in the field.
  'CREA-1': 'Creatinine', 'CREA-2': 'Creatinine',
  UA: 'Uric acid', URIC: 'Uric acid',
  TP: 'Total protein', ALB: 'Albumin', ALBU: 'Albumin',
  BILT: 'Total bilirubin', BILTA: 'Total bilirubin', TBIL: 'Total bilirubin',
  BILD: 'Direct bilirubin', BILDA: 'Direct bilirubin', DBIL: 'Direct bilirubin',
  GOT: 'AST', AST: 'AST', SGOT: 'AST',
  GPT: 'ALT', ALT: 'ALT', SGPT: 'ALT',
  ALP: 'ALP', ALKP: 'ALP', GGT: 'Gamma GT',
  AMY: 'Amylase', LIP: 'Lipase', LDH: 'LDH',
  CK: 'CK', 'CK-NAC': 'CK', CKMB: 'CK-MB', 'CK-MB': 'CK-MB',
  CHOL: 'Total cholesterol', HDL: 'HDL cholesterol', LDL: 'LDL cholesterol',
  'HDL-C': 'HDL cholesterol', 'LDL-C': 'LDL cholesterol', LDLC: 'LDL cholesterol', HDLC: 'HDL cholesterol',
  VLDL: 'VLDL cholesterol', 'VLDL-C': 'VLDL cholesterol',
  /*
   * `CR` is deliberately absent.
   *
   * On the 300SR this laboratory runs, CR is the cholesterol/HDL ratio — its
   * own file proves it: 7.69 ÷ 1.21 = 6.36, the value transmitted. On plenty of
   * other analysers CR is creatinine, and the assay name is whatever the
   * laboratory typed into the method, so neither reading can be assumed. A
   * ratio filed as a creatinine is a renal result invented out of a lipid
   * panel, which is precisely the kind of silent mis-filing that is worse than
   * a blank. It is left for the link's own map, under Parameter Mappings, where
   * somebody who can see the analyser decides what it means.
   */
  TRIG: 'Triglycerides', TG: 'Triglycerides',
  CA: 'Calcium', MG: 'Magnesium', PHOS: 'Phosphate', IP: 'Phosphate',
  FE: 'Iron', UIBC: 'UIBC', TIBC: 'TIBC', TRF: 'Transferrin', FERR: 'Ferritin',
  NA: 'Sodium', K: 'Potassium', CL: 'Chloride', LI: 'Lithium',
  CRP: 'C-reactive protein', ASO: 'ASO', RF: 'Rheumatoid factor', 'RF-2': 'Rheumatoid factor',
  C3: 'Complement C3', C4: 'Complement C4',
  IGA: 'IgA', IGG: 'IgG', IGM: 'IgM',
  CYSTC: 'Cystatin C', HCY: 'Homocysteine',
  MALB: 'Microalbumin', HBA1C: 'HbA1c', 'HBA1C-2': 'HbA1c',
  APOA1: 'Apolipoprotein A1', APOB: 'Apolipoprotein B',
};

/**
 * The molecular vocabulary, kept apart so the discipline default can use it.
 */
const MOLECULAR_GENEXPERT: Record<string, string> = {
  MTB: 'MTB', RIF: 'Rifampicin resistance', 'MTB-RIF': 'MTB/RIF',
  'HIV-VL': 'HIV viral load', HCV: 'HCV', HBV: 'HBV', CT: 'Chlamydia trachomatis', NG: 'Neisseria gonorrhoeae',
};

/**
 * The immunology vocabulary.
 *
 * Every one of these is run on a chemistry analyser in this laboratory, so the
 * spellings are the ones the chemistry maps already use. It is a separate set
 * because an immunology bench that gets handed the whole chemistry menu spends
 * its first afternoon deleting eighty parameters it does not measure.
 */
const IMMUNOLOGY_DEFAULT: Record<string, string> = {
  CRP: 'C-reactive protein', ASO: 'ASO', RF: 'Rheumatoid factor',
  C3: 'Complement C3', C4: 'Complement C4',
  IGA: 'IgA', IGG: 'IgG', IGM: 'IgM', IGE: 'IgE',
  FERR: 'Ferritin', TRF: 'Transferrin',
  TSH: 'TSH', FT3: 'Free T3', FT4: 'Free T4', T3: 'T3', T4: 'T4',
  PSA: 'PSA', AFP: 'AFP', CEA: 'CEA', BHCG: 'Beta hCG',
  'VIT-D': 'Vitamin D', B12: 'Vitamin B12', FOL: 'Folate',
  PROC: 'Procalcitonin', TROP: 'Troponin I', 'TROP-I': 'Troponin I',
};

/* ============================================================================
   Defaults for an analyser the system has never heard of
   ----------------------------------------------------------------------------
   A model that is not on the list used to start a link with nothing: no
   parameters, no units, and a Parameter Mappings screen with an empty table.
   Everything the machine sent arrived under its own spelling and stayed that
   way until somebody typed out the whole menu by hand.

   These sets are what a link starts from instead. Each is the union of every
   analyser of that discipline this system already knows, taken from the maps
   above rather than written out again, so a spelling corrected on a model is
   corrected here too. Nothing here is binding: a link may add, rename or drop
   any of it, and the whole set is editable in Settings under Analysers, where
   a laboratory that measures something else entirely says so once.
   ========================================================================= */
export const ANALYSER_DISCIPLINES = ['haematology', 'chemistry', 'molecular', 'immunology', 'other'] as const;
export type AnalyserDiscipline = (typeof ANALYSER_DISCIPLINES)[number];

export const DISCIPLINE_LABELS: Record<AnalyserDiscipline, string> = {
  haematology: 'Haematology',
  chemistry: 'Biochemistry',
  molecular: 'Molecular',
  immunology: 'Immunology',
  other: 'Other',
};

/**
 * Merge analyte maps, first spelling wins.
 *
 * First rather than last because the maps are listed in order of how well this
 * laboratory knows them, and a code that means one thing on the analyser in the
 * room should not be redefined by one that is merely possible elsewhere.
 */
function unionAnalytes(...maps: Array<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const map of maps) {
    for (const [code, parameter] of Object.entries(map)) {
      if (!(code in out)) out[code] = parameter;
    }
  }
  return out;
}

/** What a link starts with when the analyser is not one of the listed models. */
export const DEFAULT_PARAMETER_SETS: Record<AnalyserDiscipline, Record<string, string>> = {
  haematology: unionAnalytes(FBC_SYSMEX, FBC_HUMACOUNT, FBC_MINDRAY_3PART),
  chemistry: unionAnalytes(CHEMISTRY_SELECTRA, CHEMISTRY_HUMASTAR),
  molecular: unionAnalytes(MOLECULAR_GENEXPERT),
  immunology: unionAnalytes(IMMUNOLOGY_DEFAULT),
  other: unionAnalytes(
    FBC_SYSMEX, FBC_HUMACOUNT, FBC_MINDRAY_3PART,
    CHEMISTRY_SELECTRA, CHEMISTRY_HUMASTAR,
    MOLECULAR_GENEXPERT, IMMUNOLOGY_DEFAULT,
  ),
};

/**
 * The scale each default parameter is kept in.
 *
 * SI throughout, because that is what LHIMS files and what this laboratory
 * reports. A parameter absent from here is simply not rescaled — the reading is
 * kept exactly as it arrived, which is the right answer until somebody states
 * otherwise.
 */
const UNITS_HAEMATOLOGY: Record<string, string> = {
  WBC: '10^9/L', RBC: '10^12/L', Haemoglobin: 'g/dL', Haematocrit: '%',
  MCV: 'fL', MCH: 'pg', MCHC: 'g/dL', Platelets: '10^9/L',
  'Neutrophils %': '%', 'Lymphocytes %': '%', 'Monocytes %': '%',
  'Eosinophils %': '%', 'Basophils %': '%',
  Neutrophils: '10^9/L', Lymphocytes: '10^9/L', Monocytes: '10^9/L',
  Eosinophils: '10^9/L', Basophils: '10^9/L',
  'Mid cells': '10^9/L', 'Mid cells %': '%',
  Granulocytes: '10^9/L', 'Granulocytes %': '%',
  'Atypical lymphocytes': '10^9/L', 'Atypical lymphocytes %': '%',
  'Large immature cells': '10^9/L', 'Large immature cells %': '%',
  'RDW-CV': '%', 'RDW-SD': 'fL', PDW: 'fL', MPV: 'fL',
  'P-LCR': '%', 'P-LCC': '10^9/L', PCT: '%',
  Reticulocytes: '10^9/L', 'Reticulocytes %': '%',
};

const UNITS_CHEMISTRY: Record<string, string> = {
  Glucose: 'mmol/L', Urea: 'mmol/L', Creatinine: 'umol/L', 'Uric acid': 'umol/L',
  'Total protein': 'g/L', Albumin: 'g/L', Globulin: 'g/L',
  'Total bilirubin': 'umol/L', 'Direct bilirubin': 'umol/L', 'Indirect bilirubin': 'umol/L',
  AST: 'U/L', ALT: 'U/L', ALP: 'U/L', 'Gamma GT': 'U/L',
  Amylase: 'U/L', Lipase: 'U/L', LDH: 'U/L', CK: 'U/L', 'CK-MB': 'U/L',
  'Total cholesterol': 'mmol/L', Triglycerides: 'mmol/L',
  'HDL cholesterol': 'mmol/L', 'LDL cholesterol': 'mmol/L',
  VLDL: 'mmol/L', 'VLDL cholesterol': 'mmol/L',
  Sodium: 'mmol/L', Potassium: 'mmol/L', Chloride: 'mmol/L', Lithium: 'mmol/L',
  Calcium: 'mmol/L', Magnesium: 'mmol/L', Phosphate: 'mmol/L',
  Iron: 'umol/L', UIBC: 'umol/L', TIBC: 'umol/L',
  Transferrin: 'g/L', Ferritin: 'ug/L',
  'C-reactive protein': 'mg/L', ASO: 'U/L', 'Rheumatoid factor': 'U/L',
  'Complement C3': 'g/L', 'Complement C4': 'g/L',
  IgA: 'g/L', IgG: 'g/L', IgM: 'g/L',
  'Cystatin C': 'mg/L', Homocysteine: 'umol/L',
  Microalbumin: 'mg/L', HbA1c: '%',
  'Apolipoprotein A1': 'g/L', 'Apolipoprotein B': 'g/L',
};

const UNITS_IMMUNOLOGY: Record<string, string> = {
  'C-reactive protein': 'mg/L', ASO: 'U/L', 'Rheumatoid factor': 'U/L',
  'Complement C3': 'g/L', 'Complement C4': 'g/L',
  IgA: 'g/L', IgG: 'g/L', IgM: 'g/L', IgE: 'U/L',
  Ferritin: 'ug/L', Transferrin: 'g/L',
  TSH: 'U/L', 'Free T3': 'nmol/L', 'Free T4': 'nmol/L', T3: 'nmol/L', T4: 'nmol/L',
  PSA: 'ug/L', AFP: 'ug/L', CEA: 'ug/L', 'Beta hCG': 'U/L',
  'Vitamin D': 'nmol/L', 'Vitamin B12': 'nmol/L', Folate: 'nmol/L',
  Procalcitonin: 'ug/L', 'Troponin I': 'ug/L',
};

export const DEFAULT_UNIT_SETS: Record<AnalyserDiscipline, Record<string, string>> = {
  haematology: { ...UNITS_HAEMATOLOGY },
  chemistry: { ...UNITS_CHEMISTRY },
  molecular: {},
  immunology: { ...UNITS_IMMUNOLOGY },
  other: { ...UNITS_HAEMATOLOGY, ...UNITS_CHEMISTRY, ...UNITS_IMMUNOLOGY },
};

/** The model key a laboratory gets when it says the analyser is not listed. */
export function genericKey(discipline: AnalyserDiscipline, protocol: LinkProtocol): string {
  return `generic_${discipline}_${protocol}`;
}


/**
 * The BT1500's method codes.
 *
 * Four characters, space padded, and chosen by whoever set the analyser up:
 * the service manual names only GLU, BUN and CHO, in its worked example, and
 * leaves the rest to the methods a laboratory configures. So this is a
 * starting vocabulary of the spellings Biotecnica's own methods ship under,
 * and the chemistry set underneath it catches the rest. Where this machine
 * says something else, Parameter Mappings lists the codes it has actually sent
 * and the name is given once.
 *
 * CHO is cholesterol here, not choline and not creatinine — the manual's
 * example transmits CHO at 100.0, which is a cholesterol in mg/dL and nothing
 * else. BUN is urea, reported as urea nitrogen.
 */
const CHEMISTRY_BT1500: Record<string, string> = {
  GLU: 'Glucose', GLUC: 'Glucose',
  BUN: 'Urea', UREA: 'Urea', URE: 'Urea',
  CREA: 'Creatinine', CRE: 'Creatinine', CREJ: 'Creatinine',
  UA: 'Uric acid', URIC: 'Uric acid',
  TP: 'Total protein', PROT: 'Total protein', ALB: 'Albumin',
  TBIL: 'Total bilirubin', BILT: 'Total bilirubin', BILI: 'Total bilirubin',
  DBIL: 'Direct bilirubin', BILD: 'Direct bilirubin',
  AST: 'AST', GOT: 'AST', ALT: 'ALT', GPT: 'ALT',
  ALP: 'ALP', ALKP: 'ALP', GGT: 'Gamma GT',
  AMY: 'Amylase', AMYL: 'Amylase', LIP: 'Lipase', LDH: 'LDH',
  CK: 'CK', CPK: 'CK', CKMB: 'CK-MB',
  CHO: 'Total cholesterol', CHOL: 'Total cholesterol',
  TRI: 'Triglycerides', TRIG: 'Triglycerides', TG: 'Triglycerides',
  HDL: 'HDL cholesterol', LDL: 'LDL cholesterol', VLDL: 'VLDL cholesterol',
  CA: 'Calcium', MG: 'Magnesium', PHO: 'Phosphate', PHOS: 'Phosphate',
  FE: 'Iron', IRON: 'Iron', UIBC: 'UIBC', TIBC: 'TIBC',
  NA: 'Sodium', K: 'Potassium', CL: 'Chloride',
  CRP: 'C-reactive protein', ASO: 'ASO', RF: 'Rheumatoid factor',
  C3: 'Complement C3', C4: 'Complement C4',
  IGA: 'IgA', IGG: 'IgG', IGM: 'IgM',
  MALB: 'Microalbumin', FRUC: 'Fructosamine', LAC: 'Lactate',
};

export const INSTRUMENT_PROFILES: InstrumentProfile[] = [
  {
    key: 'sysmex_xn', label: 'Sysmex XN series (XN-330 / XN-550 / XN-1000)',
    vendor: 'Sysmex', discipline: 'haematology', protocol: 'astm', analytes: FBC_SYSMEX,
    notes: 'Set the analyser\'s host communication to the address of this machine and the port on the link. Sysmex marks a control run with QC or XbarM in the sample identifier.',
  },
  {
    key: 'sysmex_xs', label: 'Sysmex XS series (XS-500i / XS-1000i)',
    vendor: 'Sysmex', discipline: 'haematology', protocol: 'astm', analytes: FBC_SYSMEX,
  },
  {
    key: 'sysmex_xt', label: 'Sysmex XT series (XT-1800i / XT-2000i)',
    vendor: 'Sysmex', discipline: 'haematology', protocol: 'astm', analytes: FBC_SYSMEX,
  },
  {
    key: 'sysmex_kx21', label: 'Sysmex KX-21N',
    vendor: 'Sysmex', discipline: 'haematology', protocol: 'astm',
    analytes: {
      WBC: 'WBC', RBC: 'RBC', HGB: 'Haemoglobin', HCT: 'Haematocrit', MCV: 'MCV',
      MCH: 'MCH', MCHC: 'MCHC', PLT: 'Platelets', 'RDW-CV': 'RDW-CV', 'RDW-SD': 'RDW-SD',
      MPV: 'MPV', PDW: 'PDW', PCT: 'PCT',
      'LYM%': 'Lymphocytes %', 'MXD%': 'Mixed cells %', 'NEUT%': 'Neutrophils %',
      'LYM#': 'Lymphocytes', 'MXD#': 'Mixed cells', 'NEUT#': 'Neutrophils',
    },
  },
  {
    key: 'mindray_bc3600', label: 'Mindray BC-3600 / BC-3000',
    vendor: 'Mindray', discipline: 'haematology', protocol: 'astm', analytes: FBC_MINDRAY_3PART,
  },
  {
    key: 'mindray_bc5300', label: 'Mindray BC-5300 / BC-5150',
    vendor: 'Mindray', discipline: 'haematology', protocol: 'astm', analytes: FBC_SYSMEX,
  },
  {
    key: 'mindray_bc5800', label: 'Mindray BC-5800 (HL7)',
    vendor: 'Mindray', discipline: 'haematology', protocol: 'hl7', analytes: FBC_SYSMEX,
    notes: 'Speaks HL7 v2 ORU^R01 framed in MLLP rather than ASTM.',
  },
  {
    key: 'dirui_bf6800', label: 'DIRUI BF-6800 / BCC-3000B',
    vendor: 'DIRUI', discipline: 'haematology', protocol: 'astm', analytes: FBC_SYSMEX,
  },
  {
    key: 'abx_pentra', label: 'HORIBA ABX Pentra 60/80/400 · Micros 60',
    vendor: 'HORIBA', discipline: 'haematology', protocol: 'astm', analytes: FBC_SYSMEX,
  },
  {
    key: 'celldyn_3700', label: 'Abbott Cell-Dyn 3700',
    vendor: 'Abbott', discipline: 'haematology', protocol: 'astm', analytes: FBC_SYSMEX,
  },
  {
    key: 'urit_3000', label: 'URIT-3000 Plus',
    vendor: 'URIT', discipline: 'haematology', protocol: 'astm', analytes: FBC_MINDRAY_3PART,
  },
  {
    key: 'selectra_pro', label: 'ELITech Selectra Pro S / Selectra Junior',
    vendor: 'ELITech', discipline: 'chemistry', protocol: 'astm', analytes: CHEMISTRY_SELECTRA,
  },
  {
    key: 'humacount_5d', label: 'HUMAN HumaCount 5D / 5L',
    vendor: 'HUMAN', discipline: 'haematology', protocol: 'hl7', analytes: FBC_HUMACOUNT,
    notes: 'Speaks HL7 v2.3.1 over MLLP and dials the computer it transmits to, holding that connection '
      + 'and re-dialling by itself if it drops. On the analyser: Setup \u2192 Communication \u2192 LIS '
      + 'Communication, with Auto-communication and Communication Acknowledgement both on.',
  },
  {
    key: 'humastar_300sr', label: 'HUMAN HumaStar 300SR',
    vendor: 'HUMAN', discipline: 'chemistry', protocol: 'astm', analytes: CHEMISTRY_HUMASTAR,
    notes: 'Two ways in, and the analyser\u2019s own manual validates both. A watched folder reads the '
      + 'ASTM file the HI software writes to its Output Worklist when a worksheet is approved \u2014 that '
      + 'works on every software version and needs no port opened. From version 1.5 the HI software can '
      + 'instead listen for ASTM over TCP on its own port (6557 unless it was changed), which {PRODUCT} '
      + 'dials. A control request names itself Control in the patient record\u2019s sample-type field.',
  },
  {
    key: 'humastar_200', label: 'HUMAN HumaStar 200',
    vendor: 'HUMAN', discipline: 'chemistry', protocol: 'astm', analytes: CHEMISTRY_HUMASTAR,
    notes: 'As the HumaStar 300SR. The QC request records are 300SR-only; a control run on this one is '
      + 'recognised by its sample identifier, as on any other analyser.',
  },
  {
    key: 'humastar_100', label: 'HUMAN HumaStar 100',
    vendor: 'HUMAN', discipline: 'chemistry', protocol: 'astm', analytes: CHEMISTRY_HUMASTAR,
    notes: 'As the HumaStar 300SR. The QC request records are 300SR-only; a control run on this one is '
      + 'recognised by its sample identifier, as on any other analyser.',
  },
  {
    key: 'flexor', label: 'ELITech Flexor E / Flexor Junior',
    vendor: 'ELITech', discipline: 'chemistry', protocol: 'astm', analytes: CHEMISTRY_SELECTRA,
  },
  {
    key: 'bt3000', label: 'Biotecnica BT-3000 Plus',
    vendor: 'Biotecnica', discipline: 'chemistry', protocol: 'astm', analytes: CHEMISTRY_SELECTRA,
  },
  {
    key: 'bt1500', label: 'Biotecnica BT1500',
    vendor: 'Biotecnica', discipline: 'chemistry', protocol: 'bt1500',
    analytes: { ...CHEMISTRY_SELECTRA, ...CHEMISTRY_HUMASTAR, ...CHEMISTRY_BT1500 },
    units: DEFAULT_UNIT_SETS.chemistry,
    notes:
      'The analyser is asked rather than listened to: it never transmits on its own, so {PRODUCT} polls it and '
      + 'collects one report per exchange until the machine says there are none left. Reach it over the LAN '
      + '(TCP/IP) where its PC offers that, or over RS-232 through a serial-to-network device set to 9600 baud, '
      + '8 data bits, no parity, 1 stop bit, hardware handshake. Two settings on the analyser matter: under '
      + 'Utility, RS232 a result is only offered once accepted, and under Utility, Setup Analyzer, Serial the '
      + 'option "All results must be sent automatically (without validate)" removes that step. A control run is '
      + 'recognised by its sample identifier, as the standard report carries no control field.',
  },
  {
    key: 'mindray_bs380', label: 'Mindray BS-380 / BS-240',
    vendor: 'Mindray', discipline: 'chemistry', protocol: 'astm', analytes: CHEMISTRY_SELECTRA,
  },
  {
    key: 'vitros_350', label: 'Ortho VITROS 350',
    vendor: 'Ortho Clinical', discipline: 'chemistry', protocol: 'astm', analytes: CHEMISTRY_SELECTRA,
  },
  {
    key: 'genexpert', label: 'Cepheid GeneXpert',
    vendor: 'Cepheid', discipline: 'molecular', protocol: 'astm', analytes: MOLECULAR_GENEXPERT,
  },
  /* --------------------------------------------------------------------------
     The analyser that is not on the list
     --------------------------------------------------------------------------
     One entry per discipline per protocol, each starting from that discipline's
     default parameter set rather than from nothing. Choosing one is a single
     pick in the Model list — there is no second field to find — and what it
     loads is editable afterwards, both on the link and, for every future link,
     in Settings under Analysers.
     ----------------------------------------------------------------------- */
  {
    key: 'generic_haematology_astm', label: 'Haematology analyser, not listed — speaks ASTM',
    vendor: 'Not listed', discipline: 'haematology', protocol: 'astm',
    analytes: DEFAULT_PARAMETER_SETS.haematology, units: DEFAULT_UNIT_SETS.haematology, origin: 'default',
    notes: 'Start here for an analyser that is not listed. The link begins with every parameter this system knows for haematology work, in SI, and the first message the machine sends shows which of them it actually uses. Add, rename or remove any of it on this link without affecting anything else.',
  },
  {
    key: 'generic_haematology_hl7', label: 'Haematology analyser, not listed — speaks HL7',
    vendor: 'Not listed', discipline: 'haematology', protocol: 'hl7',
    analytes: DEFAULT_PARAMETER_SETS.haematology, units: DEFAULT_UNIT_SETS.haematology, origin: 'default',
    notes: 'Start here for an analyser that is not listed. The link begins with every parameter this system knows for haematology work, in SI, and the first message the machine sends shows which of them it actually uses. Add, rename or remove any of it on this link without affecting anything else.',
  },
  {
    key: 'generic_chemistry_astm', label: 'Biochemistry analyser, not listed — speaks ASTM',
    vendor: 'Not listed', discipline: 'chemistry', protocol: 'astm',
    analytes: DEFAULT_PARAMETER_SETS.chemistry, units: DEFAULT_UNIT_SETS.chemistry, origin: 'default',
    notes: 'Start here for an analyser that is not listed. The link begins with every parameter this system knows for biochemistry work, in SI, and the first message the machine sends shows which of them it actually uses. Add, rename or remove any of it on this link without affecting anything else.',
  },
  {
    key: 'generic_chemistry_hl7', label: 'Biochemistry analyser, not listed — speaks HL7',
    vendor: 'Not listed', discipline: 'chemistry', protocol: 'hl7',
    analytes: DEFAULT_PARAMETER_SETS.chemistry, units: DEFAULT_UNIT_SETS.chemistry, origin: 'default',
    notes: 'Start here for an analyser that is not listed. The link begins with every parameter this system knows for biochemistry work, in SI, and the first message the machine sends shows which of them it actually uses. Add, rename or remove any of it on this link without affecting anything else.',
  },
  {
    key: 'generic_immunology_astm', label: 'Immunology analyser, not listed — speaks ASTM',
    vendor: 'Not listed', discipline: 'immunology', protocol: 'astm',
    analytes: DEFAULT_PARAMETER_SETS.immunology, units: DEFAULT_UNIT_SETS.immunology, origin: 'default',
    notes: 'Start here for an analyser that is not listed. The link begins with every parameter this system knows for immunology work, in SI, and the first message the machine sends shows which of them it actually uses. Add, rename or remove any of it on this link without affecting anything else.',
  },
  {
    key: 'generic_immunology_hl7', label: 'Immunology analyser, not listed — speaks HL7',
    vendor: 'Not listed', discipline: 'immunology', protocol: 'hl7',
    analytes: DEFAULT_PARAMETER_SETS.immunology, units: DEFAULT_UNIT_SETS.immunology, origin: 'default',
    notes: 'Start here for an analyser that is not listed. The link begins with every parameter this system knows for immunology work, in SI, and the first message the machine sends shows which of them it actually uses. Add, rename or remove any of it on this link without affecting anything else.',
  },
  {
    key: 'generic_molecular_astm', label: 'Molecular analyser, not listed — speaks ASTM',
    vendor: 'Not listed', discipline: 'molecular', protocol: 'astm',
    analytes: DEFAULT_PARAMETER_SETS.molecular, units: DEFAULT_UNIT_SETS.molecular, origin: 'default',
    notes: 'Start here for an analyser that is not listed. The link begins with every parameter this system knows for molecular work, in SI, and the first message the machine sends shows which of them it actually uses. Add, rename or remove any of it on this link without affecting anything else.',
  },
  {
    key: 'generic_molecular_hl7', label: 'Molecular analyser, not listed — speaks HL7',
    vendor: 'Not listed', discipline: 'molecular', protocol: 'hl7',
    analytes: DEFAULT_PARAMETER_SETS.molecular, units: DEFAULT_UNIT_SETS.molecular, origin: 'default',
    notes: 'Start here for an analyser that is not listed. The link begins with every parameter this system knows for molecular work, in SI, and the first message the machine sends shows which of them it actually uses. Add, rename or remove any of it on this link without affecting anything else.',
  },
  {
    key: 'generic_other_astm', label: 'Other analyser, not listed — speaks ASTM',
    vendor: 'Not listed', discipline: 'other', protocol: 'astm',
    analytes: DEFAULT_PARAMETER_SETS.other, units: DEFAULT_UNIT_SETS.other, origin: 'default',
    notes: 'Start here for an analyser that is not listed. The link begins with every parameter this system knows for general work, in SI, and the first message the machine sends shows which of them it actually uses. Add, rename or remove any of it on this link without affecting anything else.',
  },
  {
    key: 'generic_other_hl7', label: 'Other analyser, not listed — speaks HL7',
    vendor: 'Not listed', discipline: 'other', protocol: 'hl7',
    analytes: DEFAULT_PARAMETER_SETS.other, units: DEFAULT_UNIT_SETS.other, origin: 'default',
    notes: 'Start here for an analyser that is not listed. The link begins with every parameter this system knows for general work, in SI, and the first message the machine sends shows which of them it actually uses. Add, rename or remove any of it on this link without affecting anything else.',
  },

  /* The two keys these replaced. Hidden from every picker, still resolvable, so
     a link saved before the split keeps the model it was saved with. */
  {
    key: 'generic_astm', label: 'Something else that speaks ASTM',
    vendor: 'Not listed', discipline: 'other', protocol: 'astm',
    analytes: DEFAULT_PARAMETER_SETS.other, units: DEFAULT_UNIT_SETS.other,
    origin: 'default', hidden: true,
  },
  {
    key: 'generic_hl7', label: 'Something else that speaks HL7',
    vendor: 'Not listed', discipline: 'other', protocol: 'hl7',
    analytes: DEFAULT_PARAMETER_SETS.other, units: DEFAULT_UNIT_SETS.other,
    origin: 'default', hidden: true,
  },
];

/**
 * Where a model may come from, beyond the ones compiled in.
 *
 * A laboratory can edit a discipline default and build a model of its own, and
 * both are rows in a database rather than entries in this file. The server
 * installs a resolver at boot that reads them; the browser never has one and
 * works from what the API hands it. Nothing else in this module knows the
 * difference, so a stored model behaves exactly like a built-in one —
 * including inside the bridge, which is the point.
 */
type ProfileResolver = (key: string) => InstrumentProfile | null;
let storedProfiles: ProfileResolver | null = null;

/** Install the resolver. Called once, by the server, at boot. */
export function setProfileResolver(resolver: ProfileResolver | null): void {
  storedProfiles = resolver;
}

export function profileByKey(key?: string | null): InstrumentProfile | null {
  const wanted = String(key ?? '').trim();
  if (!wanted) return null;
  if (storedProfiles) {
    const stored = storedProfiles(wanted);
    if (stored) return stored;
  }
  return INSTRUMENT_PROFILES.find(p => p.key === wanted) ?? null;
}

/** The models a picker should offer: everything not deliberately retired. */
export function listedProfiles(): InstrumentProfile[] {
  return INSTRUMENT_PROFILES.filter(p => !p.hidden);
}

/** The analyte a mnemonic means on this link: the link's own map first, then the profile's. */
export function mapAnalyte(mnemonic: string, linkMap: Record<string, string> | null, profileKey?: string | null): string {
  const raw = String(mnemonic ?? '').trim();
  if (!raw) return raw;
  const upper = raw.toUpperCase();
  if (linkMap) {
    for (const [from, to] of Object.entries(linkMap)) {
      if (String(from).toUpperCase() === upper) return to;
    }
  }
  const profile = profileByKey(profileKey);
  if (profile) {
    for (const [from, to] of Object.entries(profile.analytes)) {
      if (from.toUpperCase() === upper) return to;
    }
  }
  // Unmapped is returned as it came. The bench sees the analyser's own word for
  // it and maps it once, which is better than the system inventing a name.
  return raw;
}
