/**
 * Who the sample belonged to, read back out of the transmission itself.
 *
 * SECHLIMS is a quality management system and holds no patient register — but
 * the analyser's own message usually carries the demographics the printed
 * report needs, because the machine was given them when the sample was booked.
 * An ASTM patient record and an HL7 PID segment both name the patient, the
 * identifier, the date of birth and the sex, and the order record names the
 * requesting clinician and the ward.
 *
 * Reading them is strictly one-way. Nothing here writes, forwards, or changes a
 * stored message; it parses text that was already recorded so a report can show
 * what the analyser was told rather than a row of dashes.
 *
 * Where a field is absent it stays absent. Inventing a name, or carrying one
 * over from the previous sample, would be far worse than printing nothing.
 */
import { readRecords } from '../instrumentBridge/protocols.js';

export interface Demographics {
  patientId: string | null;
  patientName: string | null;
  sex: string | null;
  birthDate: string | null;
  age: string | null;
  doctor: string | null;
  ward: string | null;
  /** Free comments the analyser attached to the run, in order. */
  comments: string[];
}

export const EMPTY_DEMOGRAPHICS: Demographics = {
  patientId: null, patientName: null, sex: null, birthDate: null, age: null, doctor: null, ward: null, comments: [],
};

const field = (parts: string[], n: number): string => (parts[n - 1] ?? '').trim();
const comp = (value: string, n: number): string => (value.split('^')[n - 1] ?? '').trim();

/** `SMITH^JOHN^K` is one person, however the analyser spaced it. */
function personName(raw: string): string | null {
  const value = String(raw ?? '').trim();
  if (!value) return null;
  const parts = value.split('^').map(p => p.trim()).filter(Boolean);
  if (!parts.length) return null;
  if (parts.length === 1) return parts[0];
  // Surname first is the protocol's order; printed the way a report reads.
  const [surname, given, middle] = parts;
  return [given, middle, surname].filter(Boolean).join(' ');
}

function sexWord(raw: string): string | null {
  const value = String(raw ?? '').trim().toUpperCase();
  if (!value) return null;
  if (value.startsWith('M')) return 'Male';
  if (value.startsWith('F')) return 'Female';
  if (value === 'U' || value.startsWith('UNK')) return 'Unknown';
  return value;
}

/** `19950101` and `1995-01-01` are the same day; anything else is left alone. */
function isoDate(raw: string): string | null {
  const value = String(raw ?? '').trim();
  if (!value) return null;
  const compact = value.match(/^(\d{4})(\d{2})(\d{2})/);
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`;
  const dashed = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (dashed) return dashed[0];
  return null;
}

/** Whole years between a birth date and the run, which is what a report prints. */
export function ageAt(birthDate: string | null, on: string | null): string | null {
  if (!birthDate) return null;
  const born = Date.parse(`${birthDate}T00:00:00Z`);
  const at = on ? Date.parse(String(on).replace(' ', 'T').slice(0, 19) + 'Z') : Date.now();
  if (!Number.isFinite(born) || !Number.isFinite(at) || at < born) return null;
  const years = Math.floor((at - born) / (365.2425 * 24 * 3_600_000));
  return years >= 0 && years < 130 ? String(years) : null;
}

/**
 * Pull what a transmission says about the patient.
 *
 * Both dialects are tried on every message rather than trusting a configured
 * protocol: a capture that holds an HL7 segment inside an ASTM session is
 * common enough, and reading the segment that is actually there costs nothing.
 */
export function demographicsOf(raw: string | null | undefined, runAt?: string | null): Demographics {
  const text = String(raw ?? '');
  if (!text.trim()) return { ...EMPTY_DEMOGRAPHICS };

  const out: Demographics = { ...EMPTY_DEMOGRAPHICS, comments: [] };
  let records: string[] = [];
  try { records = readRecords(text, { final: true }).records.map(r => r.text); } catch { records = []; }
  if (!records.length) records = text.split(/[\r\n]+/).map(line => line.trim()).filter(Boolean);

  for (const record of records) {
    const parts = record.split('|');
    const type = field(parts, 1).replace(/^[0-7]/, '').trim().toUpperCase();

    if (type === 'P') {
      out.patientId = out.patientId ?? (field(parts, 3) || field(parts, 4) || field(parts, 5) || null);
      out.patientName = out.patientName ?? personName(field(parts, 6));
      out.birthDate = out.birthDate ?? isoDate(field(parts, 8));
      out.sex = out.sex ?? sexWord(field(parts, 9));
      out.doctor = out.doctor ?? (personName(field(parts, 14)) || null);
      // ASTM 15 is the physician's address and 26 the location; a ward usually
      // arrives in the location field when it arrives at all.
      out.ward = out.ward ?? (field(parts, 26) || null);
      continue;
    }

    if (type === 'PID') {
      out.patientId = out.patientId ?? (comp(field(parts, 4), 1) || comp(field(parts, 3), 1) || null);
      out.patientName = out.patientName ?? personName(field(parts, 6));
      out.birthDate = out.birthDate ?? isoDate(field(parts, 8));
      out.sex = out.sex ?? sexWord(field(parts, 9));
      continue;
    }

    if (type === 'PV1') {
      out.ward = out.ward ?? (comp(field(parts, 4), 1) || null);
      out.doctor = out.doctor ?? personName(field(parts, 8).replace(/^[^^]*\^/, ''));
      continue;
    }

    if (type === 'O') {
      out.doctor = out.doctor ?? (personName(field(parts, 17)) || null);
      continue;
    }

    if (type === 'OBR') {
      out.doctor = out.doctor ?? personName(field(parts, 17).replace(/^[^^]*\^/, ''));
      continue;
    }

    if (type === 'C' || type === 'NTE') {
      const comment = type === 'C' ? field(parts, 4) : field(parts, 4);
      const clean = comment.replace(/\^/g, ' ').trim();
      if (clean && clean.length > 1 && out.comments.length < 12) out.comments.push(clean);
    }
  }

  out.age = ageAt(out.birthDate, runAt ?? null);
  // An identifier that is only punctuation is not an identifier.
  if (out.patientId && !/[A-Za-z0-9]/.test(out.patientId)) out.patientId = null;
  if (out.patientName && !/[A-Za-z]/.test(out.patientName)) out.patientName = null;
  return out;
}
