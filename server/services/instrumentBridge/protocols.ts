/**
 * What analysers actually say, and how to answer them.
 *
 * Two protocols cover every instrument in this laboratory and most others:
 * ASTM E1394 for the haematology and chemistry analysers, HL7 v2 over MLLP for
 * the newer Mindray. Both are byte-level protocols with framing and
 * handshaking, which is why "just open a socket and read" produces a stream of
 * half-messages and an analyser that eventually gives up and shows a
 * communication error on its own screen.
 *
 * The parsers here are deliberately forgiving about CONTENT and strict about
 * FRAMING. An analyser that sends a field the standard does not mention should
 * still have its results read; an analyser whose checksum does not match should
 * not, because that is a corrupted line and a corrupted haemoglobin is worse
 * than a missing one.
 *
 * Nothing in this file touches the network. It turns bytes into records and
 * records into bytes, which makes it testable without an analyser in the room —
 * and the test script does exactly that.
 */

/* ============================================================================
   ASTM E1394 control characters
   ========================================================================= */
export const ENQ = 0x05;   // "may I speak"
export const ACK = 0x06;   // "go ahead" / "got that"
export const NAK = 0x15;   // "say that again"
export const EOT = 0x04;   // "I have finished"
export const STX = 0x02;   // start of frame
export const ETX = 0x03;   // end of a final frame
export const ETB = 0x17;   // end of an intermediate frame
export const CR = 0x0d;
export const LF = 0x0a;

/* HL7 MLLP */
export const VT = 0x0b;    // start block
export const FS = 0x1c;    // end block

export interface AstmResult {
  /** The analyser's own mnemonic, before mapping. */
  code: string;
  value: string;
  unit: string | null;
  flag: string | null;
  completedAt: string | null;
}

export interface AnalyserMessage {
  sampleId: string | null;
  /** The control lot or level, when the analyser names one separately. */
  lotNumber: string | null;
  instrument: string | null;
  runAt: string | null;
  results: AstmResult[];
  /**
   * The analyser said, in the protocol's own words, that this run is a control.
   *
   * ASTM has a field for exactly this — the order record's action code, 'Q',
   * meaning "treat this specimen as a quality control specimen" — and HL7 has
   * the same thing in OBR-11. When an analyser fills it in, no pattern needs to
   * be configured and no identifier needs to look like anything in particular.
   * `null` means the analyser said nothing either way, which is the usual case
   * and is where the identifier patterns take over.
   */
  controlHint: boolean | null;
  /** Everything received, verbatim, for the audit trail and for mapping later. */
  raw: string;
}

function blankMessage(instrument: string | null, raw: string): AnalyserMessage {
  return { sampleId: null, lotNumber: null, instrument, runAt: null, results: [], controlHint: null, raw };
}

/* ============================================================================
   ASTM: the checksum
   ----------------------------------------------------------------------------
   The sum of every byte after STX up to and including ETX/ETB, modulo 256, as
   two uppercase hex digits.
   ========================================================================= */
export function astmChecksum(bytes: Buffer): string {
  let sum = 0;
  for (const b of bytes) sum = (sum + b) & 0xff;
  return sum.toString(16).toUpperCase().padStart(2, '0');
}

/**
 * Pull the record text out of one ASTM frame.
 *
 * A frame is  STX <fn> <text> ETX|ETB <c1><c2> CR LF. The checksum is verified
 * when it is present and well-formed; a frame that fails it is rejected, which
 * makes the caller send NAK and the analyser repeat it. That repeat is the
 * whole point of the protocol and the reason a bad reading never lands.
 */
export function readAstmFrame(frame: Buffer): { text: string; frameNumber: number; ok: boolean; intermediate: boolean } {
  // frame arrives without STX, ending at the checksum + CRLF
  let end = frame.length;
  let intermediate = false;
  let terminatorAt = -1;
  for (let i = 0; i < frame.length; i++) {
    if (frame[i] === ETX || frame[i] === ETB) { terminatorAt = i; intermediate = frame[i] === ETB; break; }
  }
  if (terminatorAt === -1) {
    // No terminator: take what is there rather than losing the record. Some
    // analysers in the field omit it on the last frame.
    return { text: frame.toString('latin1').replace(/[\r\n]+$/, '').slice(1), frameNumber: frame[0] - 0x30, ok: true, intermediate: false };
  }

  const checksumBytes = frame.subarray(terminatorAt + 1, terminatorAt + 3).toString('latin1').trim();
  const computed = astmChecksum(frame.subarray(0, terminatorAt + 1));
  const ok = checksumBytes.length < 2 || checksumBytes.toUpperCase() === computed;
  end = terminatorAt;

  const body = frame.subarray(0, end).toString('latin1');
  const frameNumber = Number(body[0]);
  return { text: body.slice(1), frameNumber: Number.isFinite(frameNumber) ? frameNumber : 0, ok, intermediate };
}

/** Build one ASTM frame the way an analyser expects to receive it. */
export function buildAstmFrame(frameNumber: number, text: string, intermediate = false): Buffer {
  const terminator = intermediate ? ETB : ETX;
  const body = Buffer.from(`${frameNumber % 8}${text}`, 'latin1');
  const withTerminator = Buffer.concat([body, Buffer.from([terminator])]);
  const checksum = astmChecksum(withTerminator);
  return Buffer.concat([
    Buffer.from([STX]), withTerminator, Buffer.from(`${checksum}\r\n`, 'latin1'),
  ]);
}

/* ============================================================================
   Transport noise, and getting rid of it
   ----------------------------------------------------------------------------
   THIS IS THE PART THAT WAS MISSING, and it is why a laboratory could watch a
   result leave the analyser, watch the middleware acknowledge it, and find
   nothing in SECHLIMS.

   Over a socket the framer below strips the protocol's envelope as it reads,
   so what reaches the parser is clean. But a message read from a FILE — the
   LHIMS client's append log, an analyser's own export — has never been through
   a framer. Whatever the client wrote is what is there, and a client that
   writes down what it received writes down the envelope too:

       <ENQ><STX>1H|\^&|||XN-550^…|||E1394-97<ETX>DC<CR><LF>
            <STX>2P|1||||^^|||U|…<ETX>2D<CR><LF>
            <STX>4O|1||^^ CTRL-2609003058^M|…<ETX>0F<CR><LF>
            …
            <STX>2L|1|N<ETX>07<CR><LF><EOT>

   Every record carries a start-of-text byte, a single-digit frame number, an
   end-of-text byte and a two-character checksum. A parser looking for a record
   whose first field is `H` finds `<STX>1H` and recognises nothing; a splitter
   looking for the terminator record `L|` finds `<STX>2L|` and never sees the
   end of the transmission. So every byte is held back waiting for an end that
   has already gone past, the held text eventually grows past the size cap, and
   it is discarded. Nothing arrives, nothing errors, and the screen quite
   correctly says "nothing has ever arrived on this link".

   Taking the envelope off first makes all of it work, and makes it work for
   any client: one that writes the raw bytes, one that writes the records with
   the frame numbers left on, one that writes clean records, and one that
   writes a mixture because it was restarted half way through a transmission.
   Nothing here assumes LHIMS.
   ========================================================================= */

/** One record lifted out of a capture, and where it ended in the source. */
interface RawRecord { text: string; end: number }

const FRAME_NUMBER = /^[0-7](?=[A-Za-z]\|)/;

/** Transport bytes that are not part of any record. */
function isNoise(code: number): boolean {
  return code === ENQ || code === ACK || code === NAK || code === EOT
    || code === CR || code === LF || code === 0x00 || code === 0x1a;
}

/**
 * Strip one record's envelope: the frame number in front, the terminator and
 * checksum behind.
 */
function bareRecord(text: string): string {
  let body = text;
  const terminator = body.search(/[\x03\x17]/);
  if (terminator >= 0) body = body.slice(0, terminator);
  return body.replace(FRAME_NUMBER, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '').trim();
}

/**
 * Turn captured bytes into the records they contain.
 *
 * Framed records are read frame by frame; unframed ones are read line by line;
 * a capture holding both is read correctly because the decision is made per
 * record rather than once for the whole text.
 *
 * `end` on the last record is what lets a caller hold back a capture it caught
 * mid-append: everything after it is an incomplete record and belongs to the
 * next read, not to this one. Without that, half a transmission parses as a
 * whole one and a result lands with half its parameters missing.
 */
export function readRecords(source: string, options: { final?: boolean } = {}): { records: RawRecord[]; consumed: number } {
  const records: RawRecord[] = [];
  let i = 0;
  let consumed = 0;

  while (i < source.length) {
    const code = source.charCodeAt(i);

    if (isNoise(code)) { i++; consumed = i; continue; }

    if (code === STX) {
      let terminator = -1;
      for (let j = i + 1; j < source.length; j++) {
        const c = source.charCodeAt(j);
        if (c === ETX || c === ETB) { terminator = j; break; }
        // A start-of-text inside a frame means the previous one was never
        // finished — a client that was restarted mid-transmission. Give up on
        // the broken frame rather than swallowing the good one behind it.
        if (c === STX) break;
      }
      if (terminator === -1) {
        if (!options.final) break;   // the rest of it has not been written yet
        const text = bareRecord(source.slice(i + 1));
        if (text) records.push({ text, end: source.length });
        i = consumed = source.length;
        continue;
      }
      // The two checksum characters sit after the terminator. Wait for them,
      // because a frame cut between the terminator and its checksum is a frame
      // that has not finished arriving.
      if (terminator + 3 > source.length && !options.final) break;
      let end = Math.min(terminator + 3, source.length);
      while (end < source.length && (source.charCodeAt(end) === CR || source.charCodeAt(end) === LF)) end++;
      const text = bareRecord(source.slice(i + 1, terminator));
      if (text) records.push({ text, end });
      i = consumed = end;
      continue;
    }

    // An unframed record, ending at the next line break — or at a start-of-text
    // byte, for a client that writes some records framed and some not.
    let stop = source.length;
    for (let j = i; j < source.length; j++) {
      const c = source.charCodeAt(j);
      if (c === CR || c === LF || c === STX) { stop = j; break; }
    }
    const terminated = stop < source.length;
    if (!terminated && !options.final) break;    // still being written
    let end = stop;
    while (end < source.length && (source.charCodeAt(end) === CR || source.charCodeAt(end) === LF)) end++;
    const text = bareRecord(source.slice(i, stop));
    if (text) records.push({ text, end });
    i = consumed = end;
  }

  return { records, consumed };
}

/**
 * The same capture as clean text, for anything that only wants to read it.
 *
 * Used by the parsers, by protocol detection and by the "try a message"
 * screen, so a transmission pasted straight out of a client's log is
 * understood exactly as one read from the file would be.
 */
export function cleanTransmission(source: string): string {
  if (!source) return '';
  return readRecords(source, { final: true }).records.map(r => r.text).join('\r\n');
}

/**
 * Strip HL7's own envelope — the MLLP block characters a client writes down
 * along with the message.
 */
export function cleanHl7(source: string): string {
  return String(source ?? '').replace(/[\x0b\x1c]/g, '');
}

/* ============================================================================
   Working out what an analyser speaks
   ----------------------------------------------------------------------------
   A laboratory connecting an analyser knows its make and its port. It does not
   necessarily know whether the thing it is about to plug in talks ASTM or HL7,
   and getting that one dropdown wrong produces a link that receives messages
   and understands none of them — which looks exactly like a link that receives
   nothing.

   So the protocol can be left as "work it out", and this is what works it out:
   the shape of the records, not the make of the machine. An analyser nobody
   has ever heard of is read correctly on its first message.
   ========================================================================= */
export function detectProtocol(source: string): 'astm' | 'hl7' | 'delimited' | null {
  const text = String(source ?? '');
  if (!text.trim()) return null;
  if (/(^|[\r\n\x0b])\s*MSH\s*[|^]/.test(text)) return 'hl7';
  const clean = cleanTransmission(text);
  // An ASTM record is a single letter, a pipe, and a sequence number.
  if (/(^|[\r\n])[HPOQRCLMS]\|/.test(clean)) return 'astm';
  if (/[,;\t]/.test(clean) || /^[^\r\n]+\s*[:=]\s*\S/m.test(clean)) return 'delimited';
  return null;
}

/**
 * The protocol to actually use for this text.
 *
 * `auto` asks; anything else is honoured as configured, because a laboratory
 * that has said what the analyser speaks should not be second-guessed on every
 * message. The one exception is handled by the caller: a configured protocol
 * that yields nothing is worth re-reading as what the message actually looks
 * like, rather than recording a message nobody can see inside.
 */
export function effectiveProtocol(configured: string | null | undefined, text: string): string {
  const set = String(configured ?? '').trim().toLowerCase();
  if (set && set !== 'auto') return set;
  return detectProtocol(text) ?? 'astm';
}

/* ============================================================================
   ASTM: records into a message
   ----------------------------------------------------------------------------
   H = header (the instrument), P = patient, O = order (the sample), R = result,
   C = comment, L = terminator. Fields are | separated, components ^ separated,
   repeats \ separated. Field 1 is the record type, so the array index and the
   standard's field numbers are off by one — which is the single most common
   source of a wrong column, so it is stated here once and honoured throughout:
   `field(record, n)` uses the STANDARD's numbering.
   ========================================================================= */
function field(record: string[], n: number): string {
  return (record[n - 1] ?? '').trim();
}

function component(value: string, n: number): string {
  return (value.split('^')[n - 1] ?? '').trim();
}

/**
 * The first component of a field that actually says something.
 *
 * ASTM's specimen identifier is a composite, and where in it the analyser puts
 * the number is a vendor decision: Sysmex sends `^^ CTRL-2609003058^M` — rack
 * and position empty, the identifier third — while others fill the first
 * component and leave the rest. Taking component 1 and falling back to the
 * WHOLE field, as this did, produced the sample identifier
 * `^^ CTRL-2609003058^M`: not what the analyser meant, not what matches a
 * control material, and not something anybody can search for.
 */
function identifier(value: string): string {
  const parts = String(value ?? '').split('^').map(p => p.trim()).filter(Boolean);
  if (parts.length) return parts[0];
  return String(value ?? '').trim();
}

/**
 * The analyser's own mnemonic for a parameter, out of the universal test ID.
 *
 * ASTM gives field 3 of a result record four components — the test id, its
 * name, its type, and the manufacturer's own code — and vendors use them as
 * they please. Most haematology analysers leave the first three empty and put
 * the mnemonic last: `^^^WBC`. A Sysmex XN does not. It writes `^^^^WBC^1`,
 * with a numeric sub-identifier after the mnemonic, and some clients write the
 * repeat delimiter around it as well: `^^^^\WBC\1`.
 *
 * Taking the last component, as this did, therefore read every parameter of a
 * Sysmex XbarM transmission as `1`. Sixteen parameters arrived, sixteen were
 * stored, and the control screen filled in none of them and reported that the
 * analyser had sent "1", which this control does not measure — perfectly
 * accurately, and uselessly.
 *
 * So the mnemonic is the last component that actually contains a LETTER, with
 * a preference for one carrying no spaces, since a component with spaces in it
 * is a test NAME and the one beside it is the code. A test id that is genuinely
 * numeric all the way through keeps the old answer, because then the number is
 * all there is.
 */
function testCode(universalTestId: string): string {
  const raw = String(universalTestId ?? '').trim();
  // Both ASTM separators: components are ^, repeats are \.
  const parts = raw.split(/[\^\\]/).map(p => p.trim()).filter(Boolean);
  if (!parts.length) return raw;
  const named = parts.filter(p => /[A-Za-z]/.test(p));
  if (!named.length) return parts[parts.length - 1];
  const tight = named.filter(p => !/\s/.test(p));
  const chosen = tight.length ? tight : named;
  return chosen[chosen.length - 1];
}

/**
 * Did the analyser itself say "this is a control"?
 *
 * ASTM's order record has a field for it — the action code, 'Q', meaning treat
 * this specimen as a quality control specimen. An analyser that fills it in
 * has told us plainly, and no pattern, identifier or configuration is needed.
 * Nothing is inferred here: only an explicit Q counts.
 */
function astmSaysControl(record: string[]): boolean {
  const action = field(record, 12).toUpperCase() || field(record, 11).toUpperCase();
  return action === 'Q' || action === 'QC';
}

/** ASTM timestamps are YYYYMMDDHHMMSS, sometimes truncated. */
export function astmTime(value: string | null | undefined): string | null {
  const raw = String(value ?? '').replace(/\D/g, '');
  if (raw.length < 8) return null;
  const [y, m, d] = [raw.slice(0, 4), raw.slice(4, 6), raw.slice(6, 8)];
  const time = raw.length >= 14 ? `${raw.slice(8, 10)}:${raw.slice(10, 12)}:${raw.slice(12, 14)}`
    : raw.length >= 12 ? `${raw.slice(8, 10)}:${raw.slice(10, 12)}:00`
    : '00:00:00';
  return `${y}-${m}-${d}T${time}`;
}

/**
 * Turn a complete ASTM transmission into the messages it carries.
 *
 * One transmission can hold several samples — an analyser that has been running
 * while the link was down sends its backlog in one go — so this returns a list,
 * and each O record starts a new one.
 */
export function parseAstm(text: string): AnalyserMessage[] {
  // Whatever envelope the capture carried comes off first. Over a socket the
  // framer has already done this; from a file it has not, and that difference
  // is what made a transmission read from a client's log unreadable.
  const lines = cleanTransmission(text).split(/[\r\n]+/).map(l => l.trim()).filter(Boolean);
  const messages: AnalyserMessage[] = [];
  let current: AnalyserMessage | null = null;
  let instrument: string | null = null;

  const push = () => {
    if (current && (current.sampleId || current.results.length)) {
      // Many analysers leave the order record's timestamps empty and stamp each
      // result instead. Taking the first stamped result is the difference
      // between a control run that lands on the right day and one that lands on
      // whatever day it happened to be read.
      if (!current.runAt) current.runAt = current.results.find(r => r.completedAt)?.completedAt ?? null;
      messages.push(current);
    }
    current = null;
  };

  for (const line of lines) {
    const record = line.split('|');
    const type = (record[0] ?? '').replace(/^\d+/, '').toUpperCase();

    if (type === 'H') {
      // Field 5 is the sender: "XN-550^..." or "Sysmex^XN^..."
      const sender = field(record, 5);
      instrument = component(sender, 1) || sender || null;
      continue;
    }

    if (type === 'O') {
      push();
      // Field 3 is the specimen ID the laboratory gave it; field 4 is the
      // instrument's own. A control usually names itself in one or the other,
      // and either may be a composite with the identifier buried in it.
      const specimen = identifier(field(record, 3)) || identifier(field(record, 4));
      current = {
        ...blankMessage(instrument, text),
        sampleId: specimen || null,
        runAt: astmTime(field(record, 23) || field(record, 22) || null),
        controlHint: astmSaysControl(record) ? true : null,
      };
      continue;
    }

    if (type === 'P') {
      // A control run often carries its level or lot in the patient name slot,
      // because there is no patient. Kept when there is nothing better.
      const name = field(record, 6);
      if (current && !current.sampleId && name) current.sampleId = identifier(name) || null;
      continue;
    }

    if (type === 'R') {
      if (!current) current = blankMessage(instrument, text);
      // Field 3 is the universal test ID, and which component holds the
      // mnemonic is a vendor decision. See `testCode`.
      const code = testCode(field(record, 3));
      const value = field(record, 4);
      if (!code) continue;
      current.results.push({
        code,
        value: component(value, 1) || value,
        unit: field(record, 5) || null,
        flag: field(record, 7) || null,
        completedAt: astmTime(field(record, 13) || null),
      });
      continue;
    }

    if (type === 'C') {
      // Comments sometimes carry the control lot: "QC LOT 12345".
      const comment = field(record, 4);
      const lot = comment.match(/lot[\s:]*([A-Za-z0-9-]+)/i);
      if (current && lot && !current.lotNumber) current.lotNumber = lot[1];
      continue;
    }

    if (type === 'Q') {
      // A query record: the analyser asking for a worklist, not sending one.
      // Nothing to record, and nothing to mistake for a result.
      continue;
    }

    if (type === 'L') { push(); continue; }
  }

  push();
  return messages;
}

/* ============================================================================
   HL7 v2 ORU^R01
   ========================================================================= */

/** HL7 timestamps are YYYYMMDDHHMMSS[.S][+/-ZZZZ]. */
export function hl7Time(value: string | null | undefined): string | null {
  return astmTime(String(value ?? '').split(/[.+-]/)[0]);
}

export function parseHl7(text: string): AnalyserMessage[] {
  // The MLLP block characters come off first, for the same reason the ASTM
  // envelope does: a message read from a file still has them on it.
  const lines = cleanHl7(text).split(/[\r\n]+/).map(l => l.trim()).filter(Boolean);
  const messages: AnalyserMessage[] = [];
  let current: AnalyserMessage | null = null;
  let instrument: string | null = null;
  let sending: string | null = null;

  const push = () => {
    if (current && (current.sampleId || current.results.length)) {
      if (!current.runAt) current.runAt = current.results.find(r => r.completedAt)?.completedAt ?? null;
      messages.push(current);
    }
    current = null;
  };

  for (const line of lines) {
    const record = line.split('|');
    const type = (record[0] ?? '').toUpperCase();

    if (type === 'MSH') {
      // MSH is off by one from every other segment: the field separator itself
      // occupies position 1, so MSH-3 is record[2], not record[3].
      sending = (record[2] ?? '').split('^')[0] || null;
      instrument = (record[3] ?? '').split('^')[0] || sending;
      continue;
    }

    if (type === 'OBR') {
      push();
      const specimen = (record[3] ?? '').trim() || (record[2] ?? '').trim();
      // OBR-11, the specimen action code. 'Q' is HL7's way of saying the same
      // thing ASTM's order record says: treat this as quality control.
      const action = (record[11] ?? '').trim().toUpperCase();
      current = {
        ...blankMessage(instrument, text),
        sampleId: identifier(specimen) || null,
        runAt: hl7Time(record[7] ?? record[6] ?? null),
        controlHint: (action === 'Q' || action === 'QC') ? true : null,
      };
      continue;
    }

    if (type === 'OBX') {
      if (!current) current = blankMessage(instrument, text);
      // OBX-3 is the identifier, OBX-5 the value, OBX-6 the unit, OBX-8 flags.
      const identifier = (record[3] ?? '').trim();
      const parts = identifier.split('^').map(p => p.trim()).filter(Boolean);
      const code = parts.length > 1 ? parts[1] : parts[0] ?? '';
      const value = (record[5] ?? '').trim();
      if (!code) continue;
      current.results.push({
        code,
        value: value.split('^')[0] || value,
        unit: (record[6] ?? '').trim() || null,
        flag: (record[8] ?? '').trim() || null,
        completedAt: hl7Time(record[14] ?? null),
      });
      continue;
    }

    if (type === 'SPM') {
      // The specimen segment carries the sample id on newer analysers.
      const specimen = (record[2] ?? '').trim();
      if (current && !current.sampleId && specimen) current.sampleId = identifier(specimen) || null;
      continue;
    }

    if (type === 'INV' || type === 'NTE') {
      // An inventory segment names the control material and its lot outright;
      // a note sometimes carries the lot in prose. Either beats guessing.
      const joined = record.slice(1).join('|');
      const lot = joined.match(/lot[\s:#]*([A-Za-z0-9][A-Za-z0-9._-]{2,})/i);
      if (current && lot && !current.lotNumber) current.lotNumber = lot[1];
      if (current && type === 'INV' && current.controlHint === null) current.controlHint = true;
      continue;
    }
  }

  push();
  return messages;
}

/** The acknowledgement an HL7 sender waits for before sending the next message. */
export function buildHl7Ack(message: string): Buffer {
  const msh = message.split(/[\r\n]+/).find(l => l.startsWith('MSH')) ?? '';
  const fields = msh.split('|');
  const sendingApp = fields[2] ?? '';
  const sendingFacility = fields[3] ?? '';
  const controlId = fields[9] ?? String(Date.now());
  const now = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const ack = [
    `MSH|^~\\&|SECHLIMS|SECHLIMS|${sendingApp}|${sendingFacility}|${now}||ACK^R01|${controlId}|P|2.3.1`,
    `MSA|AA|${controlId}`,
  ].join('\r');
  return Buffer.concat([Buffer.from([VT]), Buffer.from(ack, 'latin1'), Buffer.from([FS, CR])]);
}

/* ============================================================================
   Plain delimited text
   ========================================================================= */
/**
 * Which words an analyser uses for the sample it just ran.
 *
 * Every one of these has been seen on some machine's text export, and a link
 * that only understood `sample` or `id` silently filed the rest under no
 * sample at all.
 */
const SAMPLE_KEYS = /^(sample(\s*(id|no|number))?|specimen(\s*id)?|sid|s[\s_-]?id|barcode|bar[\s_-]?code|rack|seq(uence)?[\s_-]?no|patient[\s_-]?id|pid|accession)$/i;
const LOT_KEYS = /^(lot(\s*(no|number))?|control[\s_-]?lot|qc[\s_-]?lot)$/i;
const CONTROL_KEYS = /^(control|qc|control[\s_-]?(name|id|level)|qc[\s_-]?(name|id|level))$/i;
const INSTRUMENT_KEYS = /^(instrument|analyser|analyzer|device|machine|model)$/i;
const TIME_KEYS = /^(date|time|date[\s_-]?time|run[\s_-]?(at|date|time)|measured[\s_-]?(at|on)|completed[\s_-]?at)$/i;

export function parseDelimited(text: string): AnalyserMessage[] {
  const lines = cleanTransmission(text).split(/[\r\n]+/).map(l => l.trim()).filter(Boolean);
  if (!lines.length) return [];
  // The delimiter is whichever separator actually appears, decided over the
  // whole block rather than from the first line — which may be a title.
  const body = lines.join('\n');
  const delimiter = body.includes('\t') ? '\t' : body.includes(';') ? ';' : body.includes(',') ? ',' : '|';
  const results: AstmResult[] = [];
  let sampleId: string | null = null;
  let lotNumber: string | null = null;
  let instrument: string | null = null;
  let runAt: string | null = null;
  let controlHint: boolean | null = null;

  for (const line of lines) {
    // `WBC = 6.80` and `WBC: 6.80` are as common as `WBC,6.80`, and a link that
    // understood only one of the three read half of the analysers in the room.
    const pair = line.includes(delimiter) ? null : line.match(/^([^:=]{1,40}?)\s*[:=]\s*(.*)$/);
    const cells = pair ? [pair[1].trim(), pair[2].trim()] : line.split(delimiter).map(c => c.trim());
    const key = cells[0] ?? '';
    const value = cells[1] ?? '';

    if (SAMPLE_KEYS.test(key)) { if (!sampleId && value) sampleId = value; continue; }
    if (LOT_KEYS.test(key)) { if (!lotNumber && value) lotNumber = value; continue; }
    if (INSTRUMENT_KEYS.test(key)) { if (!instrument && value) instrument = value; continue; }
    if (TIME_KEYS.test(key)) { if (!runAt && value) runAt = astmTime(value) ?? runAt; continue; }
    if (CONTROL_KEYS.test(key)) {
      if (value) { controlHint = !/^(no|n|false|0|off|patient)$/i.test(value); if (!sampleId) sampleId = value; }
      continue;
    }

    if (cells.length < 2 || !key) continue;
    if (value === '' || Number.isNaN(Number(value.replace(/[^0-9.eE+-]/g, '')))) continue;
    results.push({ code: key, value, unit: cells[2] || null, flag: cells[3] || null, completedAt: null });
  }
  if (!results.length && !sampleId) return [];
  return [{ sampleId, lotNumber, instrument, runAt, results, controlHint, raw: text }];
}

/* ============================================================================
   Framing: turning a byte stream into whole messages
   ----------------------------------------------------------------------------
   TCP gives no message boundaries. A reader that treats each `data` event as a
   message works perfectly on a bench test and then splits a haemoglobin across
   two packets on the day it matters. These accumulators exist so that never
   happens: bytes go in, complete messages come out, and a partial message waits
   for the rest of itself.
   ========================================================================= */

export type Reply = Buffer | null;

export interface FramerOutput {
  /** Bytes to send straight back to the analyser (ACK, NAK, the HL7 ACK). */
  replies: Buffer[];
  /** Complete transmissions, ready to parse. */
  messages: string[];
}

/**
 * ASTM's session framing.
 *
 * The analyser sends ENQ and waits for ACK before it will send anything at all.
 * Every frame is acknowledged individually; EOT ends the transmission and is
 * the point at which the accumulated records are a complete message. An
 * implementation that skips the handshake receives nothing, and one that skips
 * the per-frame ACK receives the first frame and then a timeout.
 */
export class AstmFramer {
  private buffer = Buffer.alloc(0);
  private records: string[] = [];
  private maxBytes: number;

  constructor(maxBytes = 512 * 1024) { this.maxBytes = maxBytes; }

  push(chunk: Buffer): FramerOutput {
    const out: FramerOutput = { replies: [], messages: [] };
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > this.maxBytes) {
      // A runaway sender must not be allowed to exhaust the host. Drop what is
      // held, tell it to stop, and let it start again cleanly.
      this.buffer = Buffer.alloc(0);
      this.records = [];
      out.replies.push(Buffer.from([NAK]));
      return out;
    }

    for (;;) {
      if (!this.buffer.length) break;

      const first = this.buffer[0];

      if (first === ENQ) {
        this.buffer = this.buffer.subarray(1);
        this.records = [];
        out.replies.push(Buffer.from([ACK]));
        continue;
      }

      if (first === EOT) {
        this.buffer = this.buffer.subarray(1);
        if (this.records.length) { out.messages.push(this.records.join('\r\n')); this.records = []; }
        continue;
      }

      if (first === ACK || first === NAK || first === CR || first === LF) {
        this.buffer = this.buffer.subarray(1);
        continue;
      }

      if (first === STX) {
        // A frame ends at its terminator plus two checksum characters; wait if
        // the whole of it has not arrived.
        let terminatorAt = -1;
        for (let i = 1; i < this.buffer.length; i++) {
          if (this.buffer[i] === ETX || this.buffer[i] === ETB) { terminatorAt = i; break; }
        }
        if (terminatorAt === -1 || this.buffer.length < terminatorAt + 3) break;

        const frame = this.buffer.subarray(1, terminatorAt + 3);
        const parsed = readAstmFrame(frame);
        // Consume the frame and any trailing CR/LF.
        let consumed = terminatorAt + 3;
        while (consumed < this.buffer.length && (this.buffer[consumed] === CR || this.buffer[consumed] === LF)) consumed++;
        this.buffer = this.buffer.subarray(consumed);

        if (!parsed.ok) { out.replies.push(Buffer.from([NAK])); continue; }
        this.records.push(parsed.text);
        out.replies.push(Buffer.from([ACK]));
        continue;
      }

      // Anything else is noise between frames — a stray byte from a serial
      // converter, a keep-alive. Skip it rather than stalling the link.
      this.buffer = this.buffer.subarray(1);
    }

    return out;
  }

  /** Whatever is held but not yet terminated, for a link that is closing. */
  flush(): string | null {
    if (!this.records.length) return null;
    const text = this.records.join('\r\n');
    this.records = [];
    return text;
  }
}

/** HL7's MLLP framing: 0x0B … 0x1C 0x0D, with an ACK for each message. */
export class Hl7Framer {
  private buffer = Buffer.alloc(0);
  private maxBytes: number;

  constructor(maxBytes = 512 * 1024) { this.maxBytes = maxBytes; }

  push(chunk: Buffer): FramerOutput {
    const out: FramerOutput = { replies: [], messages: [] };
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > this.maxBytes) { this.buffer = Buffer.alloc(0); return out; }

    for (;;) {
      const start = this.buffer.indexOf(VT);
      if (start === -1) { this.buffer = Buffer.alloc(0); break; }
      const end = this.buffer.indexOf(FS, start + 1);
      if (end === -1) { if (start > 0) this.buffer = this.buffer.subarray(start); break; }

      const message = this.buffer.subarray(start + 1, end).toString('latin1');
      let consumed = end + 1;
      if (this.buffer[consumed] === CR) consumed++;
      this.buffer = this.buffer.subarray(consumed);

      out.messages.push(message);
      out.replies.push(buildHl7Ack(message));
    }
    return out;
  }

  flush(): string | null { return null; }
}

/** A line-delimited stream, ended by a blank line or simply by time. */
export class LineFramer {
  private buffer = '';
  private maxBytes: number;

  constructor(maxBytes = 512 * 1024) { this.maxBytes = maxBytes; }

  push(chunk: Buffer): FramerOutput {
    this.buffer += chunk.toString('latin1');
    if (this.buffer.length > this.maxBytes) this.buffer = '';
    const out: FramerOutput = { replies: [], messages: [] };
    // A blank line ends a block; otherwise the caller flushes on idle.
    const blocks = this.buffer.split(/\r?\n\r?\n/);
    if (blocks.length > 1) {
      this.buffer = blocks.pop() ?? '';
      for (const block of blocks) if (block.trim()) out.messages.push(block);
    }
    return out;
  }

  flush(): string | null {
    const text = this.buffer.trim();
    this.buffer = '';
    return text || null;
  }
}

export interface Framer {
  push(chunk: Buffer): FramerOutput;
  flush(): string | null;
}

/**
 * A framer that decides what it is reading from the first thing it is sent.
 *
 * An analyser announces its protocol in its very first byte: 0x0B begins an
 * HL7 block, ENQ or STX begins an ASTM session, and anything else is text. So
 * a link whose protocol nobody wrote down does not have to guess in advance —
 * it waits one byte and then knows. Until that byte arrives nothing is
 * consumed, so no handshake is missed.
 */
class AutoFramer implements Framer {
  private inner: Framer | null = null;
  private maxBytes: number | undefined;
  private peeked = Buffer.alloc(0);

  constructor(maxBytes?: number) { this.maxBytes = maxBytes; }

  /** Which protocol this link turned out to be speaking, once it has spoken. */
  decided(): string | null {
    if (this.inner instanceof Hl7Framer) return 'hl7';
    if (this.inner instanceof AstmFramer) return 'astm';
    if (this.inner instanceof LineFramer) return 'delimited';
    return null;
  }

  push(chunk: Buffer): FramerOutput {
    if (!this.inner) {
      this.peeked = Buffer.concat([this.peeked, chunk]);
      // Skip whitespace an analyser may send before it says anything.
      let i = 0;
      while (i < this.peeked.length && (this.peeked[i] === CR || this.peeked[i] === LF)) i++;
      if (i >= this.peeked.length) return { replies: [], messages: [] };
      const first = this.peeked[i];
      this.inner = first === VT ? new Hl7Framer(this.maxBytes)
        : (first === ENQ || first === STX || first === EOT) ? new AstmFramer(this.maxBytes)
        : new LineFramer(this.maxBytes);
      const held = this.peeked;
      this.peeked = Buffer.alloc(0);
      return this.inner.push(held);
    }
    return this.inner.push(chunk);
  }

  flush(): string | null { return this.inner ? this.inner.flush() : null; }
}

export function framerFor(protocol: string, maxBytes?: number): Framer {
  if (protocol === 'hl7') return new Hl7Framer(maxBytes);
  if (protocol === 'delimited') return new LineFramer(maxBytes);
  if (protocol === 'auto') return new AutoFramer(maxBytes);
  return new AstmFramer(maxBytes);
}

export function parseFor(protocol: string, text: string): AnalyserMessage[] {
  const kind = (!protocol || protocol === 'auto') ? (detectProtocol(text) ?? 'astm') : protocol;
  if (kind === 'hl7') return parseHl7(text);
  if (kind === 'delimited') return parseDelimited(text);
  return parseAstm(text);
}


/* ============================================================================
   Splitting an append log back into transmissions
   ----------------------------------------------------------------------------
   A client writes each message it receives to the end of one file, one after
   another, with no separator of its own. What marks the boundary is the
   protocol's own terminator: ASTM ends a transmission with an L record, HL7
   with the start of the next message's MSH.

   Anything after the last terminator is held back rather than parsed, because
   the file may have been read half way through an append — and half a
   transmission parsed as a whole one is a result with parameters missing.

   `final` says the source has ended and will not grow: a file that was read
   whole rather than followed. Then the last transmission counts even if the
   client never wrote its terminator, which some do not.
   ========================================================================= */
export function splitTransmissions(
  text: string, protocol: string, options: { final?: boolean } = {},
): { complete: string[]; remainder: string } {
  if (!text) return { complete: [], remainder: '' };
  const kind = String(protocol ?? '').toLowerCase();
  let resolved = (!kind || kind === 'auto') ? (detectProtocol(text) ?? 'astm') : kind;

  // A link set to ASTM that is being handed HL7 would wait for an ASTM
  // terminator that is never coming, holding every message back until the size
  // cap discarded them — silently, and for as long as the mistake stood. HL7
  // announces itself unmistakably, so the split follows the text rather than
  // the setting. Nothing is lost by being right: the message is still parsed
  // by whatever the link says, and the checklist names the mismatch.
  if (resolved !== 'hl7' && detectProtocol(text) === 'hl7') resolved = 'hl7';

  if (resolved === 'hl7') {
    // Each message starts at an MSH. A new MSH means the previous one finished.
    const clean = cleanHl7(text);
    const parts = clean.split(/(?=MSH\s*[|^])/g).filter(p => p.trim());
    if (!parts.length) return { complete: [], remainder: text };
    if (options.final) return { complete: parts, remainder: '' };
    if (parts.length <= 1) return { complete: [], remainder: text };
    return { complete: parts.slice(0, -1), remainder: parts[parts.length - 1] };
  }

  // The envelope comes off before anything is looked for. This is the fix: a
  // terminator record inside an ASTM frame reads as `<STX>2L|1|N<ETX>07`, which
  // matches nothing, so every transmission was held back for ever and the held
  // text was eventually discarded for being too large. Nothing arrived, and
  // nothing said why.
  const { records } = readRecords(text, { final: options.final });

  const complete: string[] = [];
  let current: string[] = [];
  let closedAt = -1;

  for (const record of records) {
    current.push(record.text);
    // ASTM's terminator record. Delimited text has none, so a delimited source
    // is only ever whole when the caller says it has ended.
    if (resolved !== 'delimited' && /^L\|/i.test(record.text.trim())) {
      complete.push(current.join('\r\n'));
      current = [];
      closedAt = record.end;
    }
  }

  if (options.final) {
    // Nothing more is coming. An unterminated tail is a whole transmission from
    // a client that does not write the terminator, not a half-written one.
    if (current.length) complete.push(current.join('\r\n'));
    return { complete, remainder: '' };
  }

  // Everything after the last terminator waits for the rest of itself.
  if (closedAt === -1) return { complete: [], remainder: text };
  return { complete, remainder: text.slice(closedAt) };
}
