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
  /** Everything received, verbatim, for the audit trail and for mapping later. */
  raw: string;
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
  const lines = text.split(/[\r\n]+/).map(l => l.trim()).filter(Boolean);
  const messages: AnalyserMessage[] = [];
  let current: AnalyserMessage | null = null;
  let instrument: string | null = null;

  const push = () => {
    if (current && (current.sampleId || current.results.length)) messages.push(current);
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
      // instrument's own. A control usually names itself in one or the other.
      const specimen = field(record, 3) || field(record, 4);
      current = {
        sampleId: component(specimen, 1) || specimen || null,
        lotNumber: null,
        instrument,
        runAt: astmTime(field(record, 23) || field(record, 22) || null),
        results: [],
        raw: text,
      };
      continue;
    }

    if (type === 'P') {
      // A control run often carries its level or lot in the patient name slot,
      // because there is no patient. Kept when there is nothing better.
      const name = field(record, 6);
      if (current && !current.sampleId && name) current.sampleId = component(name, 1) || name;
      continue;
    }

    if (type === 'R') {
      if (!current) {
        current = { sampleId: null, lotNumber: null, instrument, runAt: null, results: [], raw: text };
      }
      // Field 3 is the universal test ID: ^^^WBC or ^^^^WBC depending on
      // vendor, so take the last non-empty component rather than a fixed one.
      const testId = field(record, 3);
      const parts = testId.split('^').map(p => p.trim()).filter(Boolean);
      const code = parts.length ? parts[parts.length - 1] : testId;
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
  const lines = text.split(/[\r\n]+/).map(l => l.trim()).filter(Boolean);
  const messages: AnalyserMessage[] = [];
  let current: AnalyserMessage | null = null;
  let instrument: string | null = null;
  let sending: string | null = null;

  const push = () => {
    if (current && (current.sampleId || current.results.length)) messages.push(current);
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
      current = {
        sampleId: specimen.split('^')[0] || specimen || null,
        lotNumber: null,
        instrument,
        runAt: hl7Time(record[7] ?? record[6] ?? null),
        results: [],
        raw: text,
      };
      continue;
    }

    if (type === 'OBX') {
      if (!current) current = { sampleId: null, lotNumber: null, instrument, runAt: null, results: [], raw: text };
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
      if (current && !current.sampleId && specimen) current.sampleId = specimen.split('^')[0] || specimen;
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
export function parseDelimited(text: string): AnalyserMessage[] {
  const lines = text.split(/[\r\n]+/).map(l => l.trim()).filter(Boolean);
  if (!lines.length) return [];
  const delimiter = lines[0].includes('\t') ? '\t' : lines[0].includes(';') ? ';' : ',';
  const results: AstmResult[] = [];
  let sampleId: string | null = null;

  for (const line of lines) {
    const cells = line.split(delimiter).map(c => c.trim());
    if (!sampleId && /^(sample|specimen|id|sid)\b/i.test(cells[0] ?? '')) { sampleId = cells[1] ?? null; continue; }
    if (cells.length < 2) continue;
    const value = cells[1];
    if (value === '' || Number.isNaN(Number(value.replace(/[^0-9.-]/g, '')))) continue;
    results.push({ code: cells[0], value, unit: cells[2] ?? null, flag: cells[3] ?? null, completedAt: null });
  }
  if (!results.length && !sampleId) return [];
  return [{ sampleId, lotNumber: null, instrument: null, runAt: null, results, raw: text }];
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

export function framerFor(protocol: string, maxBytes?: number): Framer {
  if (protocol === 'hl7') return new Hl7Framer(maxBytes);
  if (protocol === 'delimited') return new LineFramer(maxBytes);
  return new AstmFramer(maxBytes);
}

export function parseFor(protocol: string, text: string): AnalyserMessage[] {
  if (protocol === 'hl7') return parseHl7(text);
  if (protocol === 'delimited') return parseDelimited(text);
  return parseAstm(text);
}


/* ============================================================================
   Splitting an append log back into transmissions
   ----------------------------------------------------------------------------
   The LHIMS client writes each message it receives to the end of one file, one
   after another, with no separator of its own. What marks the boundary is the
   protocol's own terminator: ASTM ends a transmission with an L record, HL7
   with the end of the message segment group.

   Anything after the last terminator is held back rather than parsed, because
   the file may have been read half way through an append — and half a
   transmission parsed as a whole one is a result with parameters missing.
   ========================================================================= */
export function splitTransmissions(text: string, protocol: string): { complete: string[]; remainder: string } {
  if (!text) return { complete: [], remainder: '' };

  if (protocol === 'hl7') {
    // Each message starts at an MSH. A new MSH means the previous one finished.
    const parts = text.split(/(?=MSH\|)/g).filter(p => p.trim());
    if (parts.length <= 1) return { complete: [], remainder: text };
    return { complete: parts.slice(0, -1), remainder: parts[parts.length - 1] };
  }

  const lines = text.split(/\r\n|\r|\n/);
  const complete: string[] = [];
  let current: string[] = [];
  let lastTerminated = -1;

  lines.forEach((line, index) => {
    current.push(line);
    // An ASTM terminator record: L, optionally with a frame number in front.
    if (/^\d?L\|/.test(line.trim())) {
      complete.push(current.join('\r\n'));
      current = [];
      lastTerminated = index;
    }
  });

  if (lastTerminated === -1) return { complete: [], remainder: text };
  return { complete, remainder: current.join('\r\n') };
}
