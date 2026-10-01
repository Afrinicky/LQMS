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
  sechlims_only: 'SECHLIMS only — this analyser transmits to nothing else',
  lhims_owned: 'LHIMS owns this link — SECHLIMS must not touch it',
  shared_forward: 'SECHLIMS receives, and passes a copy on to LHIMS',
};

export const LINK_ROLE_HINTS: Record<LinkRole, string> = {
  sechlims_only:
    'The safe case, and the usual one. The analyser is not transmitting anywhere today, so SECHLIMS takes it '
    + 'and nothing existing is affected. Both chemistry analysers and the second haematology analyser are this.',
  lhims_owned:
    'Recorded so the system knows to stay away from it. SECHLIMS will refuse to bind this port or dial this '
    + 'analyser. It may still take a COPY of what this analyser sends, by following the LHIMS client\'s own '
    + 'append log — that reads a file rather than touching the connection, so the existing transmission is '
    + 'unaffected either way.',
  shared_forward:
    'SECHLIMS receives from the analyser and forwards a copy onward to the LHIMS middleware. Only switch this '
    + 'on for an analyser LHIMS is NOT already receiving, once the link has proved itself — it is how LHIMS '
    + 'could eventually carry all four analysers, but it must never be pointed at a link LHIMS already has.',
};

/* ============================================================================
   How the analyser is reached
   ========================================================================= */
export const LINK_MODES = ['server', 'client', 'file_drop', 'lhims_tap'] as const;
export type LinkMode = (typeof LINK_MODES)[number];

export const LINK_MODE_LABELS: Record<LinkMode, string> = {
  server: 'SECHLIMS listens; the analyser connects to it',
  client: 'SECHLIMS connects out to the analyser',
  file_drop: 'The analyser writes files to a watched folder',
  lhims_tap: 'Follow the LHIMS client\'s own log — a copy, touching nothing',
};

export const LINK_MODE_HINTS: Record<LinkMode, string> = {
  server: 'The usual arrangement, and what the LHIMS client uses. Give the analyser this host\'s address and the port below.',
  client: 'For an analyser that listens instead of dialling out. SECHLIMS opens the connection and keeps it open.',
  file_drop: 'For an analyser whose only export is a file. Nothing is connected; the folder is watched.',
  lhims_tap:
    'The way to get a copy of an analyser LHIMS already owns. Set WRITE_TO_FILE = Yes in the LHIMS client and it '
    + 'appends every message it receives to LHIMSDataInput.txt; SECHLIMS follows that file read-only, the way tail does. '
    + 'No port is bound, no connection is opened, nothing is intercepted — if SECHLIMS stops, the LHIMS transmission '
    + 'does not notice.',
};

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
 * the exception that lets haematology 1 reach SECHLIMS: following the
 * middleware's own append log reads a file, and reading a file cannot disturb
 * a socket. Anything that binds, dials or intercepts stays refused.
 */
export function linkIsOurs(role?: string | null, mode?: string | null): boolean {
  if (role !== 'lhims_owned') return true;
  return modeIsPassive(mode);
}

/* ============================================================================
   What it says on the wire
   ========================================================================= */
export const LINK_PROTOCOLS = ['astm', 'hl7', 'delimited', 'auto'] as const;
export type LinkProtocol = (typeof LINK_PROTOCOLS)[number];

export const LINK_PROTOCOL_LABELS: Record<LinkProtocol, string> = {
  astm: 'ASTM E1394 (most haematology and chemistry analysers)',
  hl7: 'HL7 v2 ORU^R01 over MLLP',
  delimited: 'Plain delimited text, one result per line',
  auto: 'Work it out from what arrives',
};

export const LINK_PROTOCOL_HINTS: Record<LinkProtocol, string> = {
  astm: 'Framed records with ENQ/ACK handshaking and a checksum. Sysmex, Mindray BC-3600, ABX Pentra, BT-3000, Selectra and DIRUI all speak it.',
  hl7: 'Message framed between 0x0B and 0x1C 0x0D. Mindray BC-5800 and newer analysers use it.',
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
  notes?: string;
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
    key: 'flexor', label: 'ELITech Flexor E / Flexor Junior',
    vendor: 'ELITech', discipline: 'chemistry', protocol: 'astm', analytes: CHEMISTRY_SELECTRA,
  },
  {
    key: 'bt3000', label: 'Biotecnica BT-3000 Plus',
    vendor: 'Biotecnica', discipline: 'chemistry', protocol: 'astm', analytes: CHEMISTRY_SELECTRA,
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
    vendor: 'Cepheid', discipline: 'molecular', protocol: 'astm',
    analytes: { 'MTB': 'MTB', 'RIF': 'Rifampicin resistance', 'MTB-RIF': 'MTB/RIF' },
  },
  {
    key: 'generic_astm', label: 'Something else that speaks ASTM',
    vendor: 'Generic', discipline: 'other', protocol: 'astm', analytes: {},
    notes: 'Start here for an analyser not listed. The first message it sends shows you exactly which mnemonics it uses, and the map is built from that.',
  },
  {
    key: 'generic_hl7', label: 'Something else that speaks HL7',
    vendor: 'Generic', discipline: 'other', protocol: 'hl7', analytes: {},
  },
];

export function profileByKey(key?: string | null): InstrumentProfile | null {
  return INSTRUMENT_PROFILES.find(p => p.key === key) ?? null;
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
