/**
 * Carrying results onward, to whatever system is downstream.
 *
 * SECHLIMS receives from the analysers. Some laboratories then need those
 * results to reach a second system — the hospital's LIS, a national register, a
 * billing system — and the one in this hospital happens to be LHIMS. It is not
 * the only one, and nothing here assumes it is: LHIMS is a PROFILE, one of
 * several shapes an onward delivery can take, and a laboratory running
 * something else entirely configures a delivery rather than waiting for code.
 *
 * The three shapes cover what receiving systems actually accept:
 *
 *   lhims_api      the LHIMS middleware's own call — api/update_result.php with
 *                  a specimen id, a measure id and a value. Kept exactly as the
 *                  middleware makes it, so a result posted from here lands in
 *                  the field the middleware would have put it in.
 *
 *   http_template  any HTTP endpoint, described by the laboratory as a URL with
 *                  placeholders in it. This is the general case, and the reason
 *                  a laboratory with a different LIS needs nothing from us.
 *
 *   tcp            the raw transmission handed to a program that wants to parse
 *                  it itself, byte for byte as the analyser sent it.
 *
 * WHAT EVERY ONE OF THEM NEEDS is a way to say what the receiving system calls
 * each parameter. An analyser sends WBC; the receiver knows it as 23, or as
 * "wbc_count", or as nothing at all. That correspondence is the laboratory's,
 * not ours — we ship the maps we have been given and let the laboratory write
 * the rest, because the alternative is a haemoglobin filed under whatever
 * identifier happened to be nearby.
 */

export const FORWARD_TARGETS = ['lhims_api', 'http_template', 'tcp'] as const;
export type ForwardTarget = (typeof FORWARD_TARGETS)[number];

export const FORWARD_TARGET_LABELS: Record<ForwardTarget, string> = {
  lhims_api: 'LHIMS — post each result the way its middleware does',
  http_template: 'Another system over HTTP — give the address as a template',
  tcp: 'Hand the raw transmission to a program on the network',
};

export const FORWARD_TARGET_HINTS: Record<ForwardTarget, string> = {
  lhims_api: 'The call the LHIMS client makes: api/update_result.php with a specimen id, a measure id and a value.',
  http_template: 'For any other receiving system with an HTTP interface. Write its address once, with placeholders where each result’s details go.',
  tcp: 'The analyser’s own transmission, unchanged, opened to an address and port. For a middleware that parses the raw message itself.',
};

/* ============================================================================
   Describing another system's address
   ----------------------------------------------------------------------------
   A template is the receiving system's URL with placeholders where this
   result's details belong. Everything outside a placeholder is sent exactly as
   written, so a laboratory can match whatever its own system expects — a query
   string, a path segment, an API key — without anybody changing code.
   ========================================================================= */

export interface ForwardField {
  token: string;
  label: string;
  /** What it stands for, in the words somebody configuring this would use. */
  meaning: string;
}

export const FORWARD_TEMPLATE_FIELDS: ForwardField[] = [
  { token: 'specimen', label: 'Specimen identifier', meaning: 'The sample number the analyser transmitted.' },
  { token: 'code', label: 'Parameter identifier', meaning: 'What the receiving system calls this parameter — the value set against the analyser’s code on this link.' },
  { token: 'analyser_code', label: 'Analyser’s own code', meaning: 'What the analyser called the parameter, before any mapping.' },
  { token: 'value', label: 'Result', meaning: 'The result itself, as the analyser reported it.' },
  { token: 'decimals', label: 'Decimal places', meaning: 'How many decimal places the analyser reported, so the number is stored as measured.' },
  { token: 'unit', label: 'Unit', meaning: 'The unit the analyser reported, where it reported one.' },
  { token: 'flag', label: 'Flag', meaning: 'The analyser’s own flag for the result, such as H or L.' },
  { token: 'username', label: 'Username', meaning: 'The username set on this link.' },
  { token: 'password', label: 'Password', meaning: 'The password set on this link.' },
  { token: 'run_at', label: 'Run time', meaning: 'When the analyser says it ran the test.' },
];

/** `{specimen}` and the rest, replaced; anything else is left exactly as written. */
export function fillTemplate(template: string, fields: Record<string, string>): string {
  return String(template ?? '').replace(/\{(\w+)\}/g, (whole, token: string) => {
    const value = fields[token];
    return value === undefined ? whole : encodeURIComponent(value);
  });
}

/** Placeholders written in a template that this system does not know. */
export function unknownTokens(template: string): string[] {
  const known = new Set(FORWARD_TEMPLATE_FIELDS.map(f => f.token));
  const found = String(template ?? '').match(/\{(\w+)\}/g) ?? [];
  return [...new Set(found.map(t => t.slice(1, -1)).filter(t => !known.has(t)))];
}

/** The password, never written to a screen or a log. */
export function safeTemplateUrl(url: string): string {
  return String(url ?? '').replace(/([?&](?:password|passwd|pwd|token|key|secret)=)[^&]*/gi, '$1•••');
}

/* ============================================================================
   What is a result, and what is the analyser talking about itself
   ----------------------------------------------------------------------------
   A haematology analyser's transmission is not only measurements. A Humacount
   5D sends Take Mode, Blood Mode, Test Mode, Age, Remark and Ref Group in the
   same OBX segments it sends WBC and NEU% in, because that is what the segment
   is for. SECHLIMS keeps all of it, which is right — the record is the whole
   transmission, and throwing a field away because this version of this file did
   not recognise it is how data goes missing.

   Delivering all of it onward is a different matter. A receiving system wants
   results, and being told that six of the analyser's own settings have no
   identifier is noise that buries the two parameters that genuinely need one.

   So each code the analyser sends is one of three things, and the LABORATORY
   decides which, once, per link: it has an identifier in the receiving system,
   or it is not a result and is never sent, or nobody has said yet. The
   suggestion below is only a first guess to save typing — it decides nothing.
   ========================================================================= */

/**
 * Does this look like something that was measured?
 *
 * A number, possibly signed, possibly with a comparator an analyser puts on a
 * result below its linearity ("<0.01", ">1000"). Deliberately shallow: it
 * steers a suggestion, and a person confirms it.
 */
export function looksLikeMeasurement(value: unknown): boolean {
  const raw = String(value ?? '').trim();
  if (!raw) return false;
  return /^[<>]?\s*[+-]?(\d+\.?\d*|\.\d+)(\s*[eE][+-]?\d+)?$/.test(raw);
}

/**
 * Codes an analyser commonly uses for its own settings rather than for a
 * result. Only a suggestion, and only where the laboratory has said nothing:
 * a receiving system that genuinely wants the patient's age is configured to
 * take it, and this never overrides that.
 */
const DESCRIBES_ITSELF = [
  /^take\s*mode$/i, /^blood\s*mode$/i, /^test\s*mode$/i, /^analysis\s*mode$/i,
  /^ref\s*group$/i, /^reference\s*group$/i, /^remark$/i, /^comment$/i, /^note$/i,
  /^operator$/i, /^instrument$/i, /^serial/i, /^software/i, /^version$/i,
  /^patient\s*(name|id)$/i, /^sex$/i, /^gender$/i, /^age$/i, /^dob$/i, /^date\s*of\s*birth$/i,
  /^sample\s*(id|no|type)$/i, /^rack/i, /^position$/i, /^seq/i, /^department$/i, /^ward$/i,
];

export type ParameterKind = 'measurement' | 'describes_itself';

/**
 * A first guess at what a code is, from its name and the values seen against it.
 *
 * Named values decide it: a code whose results are words is the analyser
 * describing itself however familiar its name looks. Only when the values are
 * numbers does the name get a say, which is what keeps a numeric Age out of a
 * receiving system that was never asked to store one.
 */
export function suggestParameterKind(code: string, samples: unknown[]): ParameterKind {
  const seen = samples.map(s => String(s ?? '').trim()).filter(Boolean);
  if (seen.length && !seen.some(looksLikeMeasurement)) return 'describes_itself';
  return DESCRIBES_ITSELF.some(p => p.test(String(code ?? '').trim())) ? 'describes_itself' : 'measurement';
}

/* ============================================================================
   Taking a mapping the laboratory already has
   ----------------------------------------------------------------------------
   A haematology analyser reports thirty parameters, and the identifiers the
   receiving system knows them by are not a thing anybody remembers. They are
   already written down: in the LHIMS middleware's own ParameterMappings table,
   which pairs InstParameterCode with ParameterID, in a client configuration
   file, or in a spreadsheet somebody keeps.

   So they are pasted rather than typed. The shapes below are what that table
   and those files actually look like when copied out, and the parser is
   deliberately forgiving of all of them, because the alternative is thirty
   boxes filled in by hand and a transposed digit filing a haemoglobin under a
   platelet count.
   ========================================================================= */

export interface PastedMapping { code: string; identifier: string }

export interface PastedMappingResult {
  rows: PastedMapping[];
  /** Lines that carried no recognisable pair, so nothing is dropped silently. */
  ignored: string[];
}

/** Words a header row uses, which must never become a mapping. */
const HEADERS = /^(inst(rument)?[_ ]?parameter[_ ]?code|parameter[_ ]?id|measure[_ ]?id|code|id|analyser|analyzer|test|parameter|name|value)$/i;

/**
 * Read pairs of "what the analyser calls it" and "what the receiver calls it".
 *
 * Accepts a comma, a tab, an equals sign, a colon, a pipe or runs of spaces
 * between the two; tolerates the mysql client's `| a | b |` borders and its
 * `+---+` rules; skips headers and blank lines. The code may contain spaces
 * and punctuation, because analysers send "NEUT#", "RDW-SD" and "Take Mode".
 */
export function parsePastedMappings(text: string): PastedMappingResult {
  const rows: PastedMapping[] = [];
  const ignored: string[] = [];
  const seen = new Set<string>();

  for (const line of String(text ?? '').split(/\r?\n/)) {
    const raw = line.trim();
    if (!raw || /^[+|\-\s=]+$/.test(raw)) continue;

    // The mysql client draws borders; strip them before splitting.
    const bare = raw.replace(/^\|/, '').replace(/\|$/, '').trim();
    const parts = bare.split(/\s*[\t,;=:|]\s*|\s{2,}/).map(p => p.trim()).filter(Boolean);

    /*
     * A single space is only a separator when what follows it could BE an
     * identifier: a number, or a token carrying a digit or an underscore. That
     * is what keeps "Take Mode 41" and "WBC wbc_count" splitting while a line
     * of prose stays a line of prose rather than becoming a mapping of its
     * last two words.
     */
    let fields = parts;
    if (fields.length < 2) {
      const split = bare.split(/\s+(?=\S+$)/).map(p => p.trim()).filter(Boolean);
      const tail = split[split.length - 1] ?? '';
      if (split.length === 2 && (/^\d+$/.test(tail) || /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(tail) && /[\d_]/.test(tail))) {
        fields = split;
      }
    }
    if (fields.length < 2) { ignored.push(raw); continue; }

    // Either order: some exports put the identifier first.
    let [code, identifier] = [fields[0], fields[fields.length - 1]];
    if (/^\d+$/.test(code) && !/^\d+$/.test(identifier)) [code, identifier] = [identifier, code];
    if (!code || !identifier || HEADERS.test(code) || HEADERS.test(identifier)) { ignored.push(raw); continue; }

    const key = code.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ code, identifier });
  }
  return { rows, ignored };
}
