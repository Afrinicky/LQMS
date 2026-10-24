/**
 * What SECHLIMS already holds for the identifier on the form.
 *
 * The extension asks one question — "do you know this sample, and what did the
 * analyser say about it?" — and this answers it. The answer is a VERDICT, not
 * a list: a fill proceeds only when the identifier on the form and the
 * identifier the analyser transmitted are the same identifier, and the verdict
 * says under which rule they were judged the same.
 *
 * The failure this guards against is specific. Typing a result into the wrong
 * patient is an error the manual process already allows; doing it automatically
 * would be the same error at machine speed, with the laboratory's confidence
 * behind it. So anything short of agreement stops here, with the two
 * identifiers shown side by side, and a person decides.
 *
 * Nothing in this file writes to a transmission table. It reads
 * `instrument_messages` — the bridge's own verbatim record — and joins the
 * middleware's view of the same message where there is one.
 */
import {
  compareIdentifiers, normaliseIdentifier, type IdentifierAgreement, type IdentifierNormaliser, type VerifyStatus,
} from '../../../shared/constants/resultFiller.js';
import { mapAnalyte } from '../../../shared/constants/instruments.js';
import { demographicsOf, type Demographics } from './demographics.js';

type DB = any;

/** How many transmissions one lookup will consider before it stops. */
const SCAN_LIMIT = 5_000;

export interface Reading {
  code: string;
  analyte: string;
  value: string;
  unit: string | null;
  flag: string | null;
}

export interface Transmission {
  id: number;
  linkId: number | null;
  linkName: string | null;
  equipmentName: string | null;
  profileKey: string | null;
  sampleId: string | null;
  lotNumber: string | null;
  instrumentName: string | null;
  instrumentRunAt: string | null;
  receivedAt: string;
  kind: string;
  resultCount: number;
  readings: Reading[];
  /** How this transmission's identifier compares with the one on the form. */
  agreement: IdentifierAgreement;
  /** The middleware's view of the same message, where it has one. */
  mwMessageId: number | null;
  mwStatus: string | null;
  deliveries: number;
  delivered: number;
  /** Times this transmission has already been filled into a form. */
  priorFills: number;
  lastFilledAt: string | null;
  lastFilledBy: string | null;
  demographics: Demographics;
}

function json<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  try { return (JSON.parse(value) ?? fallback) as T; } catch { return fallback; }
}

function since(hours: number): string {
  return new Date(Date.now() - Math.max(1, hours) * 3_600_000).toISOString().replace('T', ' ').slice(0, 19);
}

/**
 * The parameters a transmission carries, under this laboratory's own names.
 *
 * The analyser's mnemonic is kept beside the mapped name: a form may label its
 * boxes either way, and discarding the code would make the one the analyser
 * actually sent unavailable to match on.
 */
export function readingsOf(row: any): Reading[] {
  const values = json<any[]>(row?.parsed_values, []);
  const linkMap = json<Record<string, string>>(row?.analyte_map, {});
  return values
    .map(value => {
      const code = String(value?.code ?? value?.analyte ?? '').trim();
      if (!code) return null;
      return {
        code,
        analyte: String(value?.analyte ?? mapAnalyte(code, linkMap, row?.profile_key)).trim() || code,
        value: String(value?.value ?? '').trim(),
        unit: value?.unit ? String(value.unit) : null,
        flag: value?.flag ? String(value.flag) : null,
      } as Reading;
    })
    .filter((r): r is Reading => Boolean(r));
}

const SELECT = `SELECT m.id, m.link_id, m.received_at, m.sample_id, m.lot_number, m.instrument_name,
      m.instrument_run_at, m.result_count, m.parsed_values, m.kind, m.raw_message,
      l.name AS link_name, l.profile_key, l.analyte_map, e.name AS equipment_name,
      x.id AS mw_id, x.status AS mw_status,
      (SELECT COUNT(*) FROM mw_deliveries d WHERE d.message_id = x.id) AS deliveries,
      (SELECT COUNT(*) FROM mw_deliveries d WHERE d.message_id = x.id AND d.state = 'delivered') AS delivered,
      (SELECT COUNT(*) FROM rf_fills f WHERE f.instrument_message_id = m.id AND f.state IN ('applied','partial')) AS prior_fills,
      (SELECT MAX(f.reported_at) FROM rf_fills f WHERE f.instrument_message_id = m.id AND f.state IN ('applied','partial')) AS last_filled_at,
      (SELECT u.username FROM rf_fills f LEFT JOIN users u ON u.id = f.user_id
         WHERE f.instrument_message_id = m.id AND f.state IN ('applied','partial')
         ORDER BY f.id DESC LIMIT 1) AS last_filled_by
    FROM instrument_messages m
    LEFT JOIN instrument_links l ON l.id = m.link_id
    LEFT JOIN equipment_items e ON e.id = l.equipment_id
    LEFT JOIN mw_messages x ON x.instrument_message_id = m.id`;

function hydrate(row: any, agreement: IdentifierAgreement): Transmission {
  return {
    id: Number(row.id),
    linkId: row.link_id == null ? null : Number(row.link_id),
    linkName: row.link_name ?? null,
    equipmentName: row.equipment_name ?? null,
    profileKey: row.profile_key ?? null,
    sampleId: row.sample_id ?? null,
    lotNumber: row.lot_number ?? null,
    instrumentName: row.instrument_name ?? null,
    instrumentRunAt: row.instrument_run_at ?? null,
    receivedAt: String(row.received_at),
    kind: String(row.kind ?? 'unknown'),
    resultCount: Number(row.result_count ?? 0),
    readings: readingsOf(row),
    agreement,
    mwMessageId: row.mw_id == null ? null : Number(row.mw_id),
    mwStatus: row.mw_status ?? null,
    deliveries: Number(row.deliveries ?? 0),
    delivered: Number(row.delivered ?? 0),
    priorFills: Number(row.prior_fills ?? 0),
    lastFilledAt: row.last_filled_at ?? null,
    lastFilledBy: row.last_filled_by ?? null,
    demographics: demographicsOf(row.raw_message, row.instrument_run_at ?? row.received_at),
  };
}

export interface LookupOptions {
  identifier: string;
  normaliser: IdentifierNormaliser;
  lookbackHours: number;
  /** 'patient', 'control' or 'any'. */
  messageKind: string;
  linkId?: number | null;
}

/**
 * Every transmission in the window whose identifier relates to this one.
 *
 * The comparison is done here rather than in SQL because the rule is the
 * adapter's — a laboratory that matches on digits only and one that matches
 * exactly must get different answers from the same database, and a LIKE
 * expression cannot express either honestly.
 */
export function findTransmissions(db: DB, options: LookupOptions): Transmission[] {
  const wanted = String(options.identifier ?? '').trim();
  if (!wanted) return [];

  const where: string[] = ['m.received_at >= ?', "COALESCE(m.sample_id, '') != ''"];
  const args: any[] = [since(options.lookbackHours)];
  if (options.messageKind === 'patient' || options.messageKind === 'control') {
    where.push('m.kind = ?');
    args.push(options.messageKind);
  }
  if (options.linkId) { where.push('m.link_id = ?'); args.push(options.linkId); }

  const rows = db.prepare(`${SELECT} WHERE ${where.join(' AND ')} ORDER BY m.received_at DESC, m.id DESC LIMIT ?`)
    .all(...args, SCAN_LIMIT) as any[];

  const found: Transmission[] = [];
  for (const row of rows) {
    const agreement = compareIdentifiers(wanted, row.sample_id, options.normaliser);
    if (agreement === 'different') continue;
    found.push(hydrate(row, agreement));
  }
  return found;
}

/** Has this identifier ever been seen, window aside? Separates "unknown" from "stale". */
export function seenOutsideWindow(db: DB, identifier: string, normaliser: IdentifierNormaliser): { at: string; sampleId: string } | null {
  const wanted = normaliseIdentifier(identifier, normaliser);
  if (!wanted) return null;
  const rows = db.prepare(`SELECT sample_id, received_at FROM instrument_messages
      WHERE COALESCE(sample_id, '') != '' ORDER BY received_at DESC, id DESC LIMIT ?`).all(SCAN_LIMIT) as any[];
  for (const row of rows) {
    if (normaliseIdentifier(row.sample_id, normaliser) === wanted) {
      return { at: String(row.received_at), sampleId: String(row.sample_id) };
    }
  }
  return null;
}


/**
 * Are these two identifiers drawn from the same series?
 *
 * Compared by SHAPE rather than by value: `AAJ7447` and `AAJ7448` are two
 * numbers of one kind and disagreeing about which is a real contradiction;
 * `AAJ7447` and `UW-A11-AAB2287` are a laboratory number and a folder number,
 * and their disagreeing means nothing at all.
 */
export function sameIdentifierShape(a: string, b: string): boolean {
  const shape = (value: string) => String(value ?? '').trim().toUpperCase()
    .replace(/[A-Z]/g, 'A').replace(/[0-9]/g, '9').replace(/[^A9]/g, '-');
  const shapeA = shape(a);
  const shapeB = shape(b);
  if (!shapeA || !shapeB) return false;
  return shapeA === shapeB;
}

export interface Verdict {
  status: VerifyStatus;
  /** One line a person can act on. The screens show this and nothing else. */
  summary: string;
  /** Sorted newest first; the first is the one a fill would use. */
  transmissions: Transmission[];
  warnings: string[];
  /** The identifier as the form gave it, and as the analyser sent it. */
  formIdentifier: string;
  recordIdentifier: string | null;
  agreement: IdentifierAgreement | null;
}

/**
 * The verdict on one identifier.
 *
 * Read the order of these tests as the order of the questions: is there an
 * identifier at all, do we hold anything for it, does more than one thing match
 * it, is what matches recent enough to be this sample, and has it already been
 * filled in once.
 */
export function verifyIdentifier(db: DB, options: LookupOptions & {
  /** A second identifier the form carries, checked against the transmission. */
  patientIdentifier?: string | null;
}): Verdict {
  const formIdentifier = String(options.identifier ?? '').trim();
  const base: Verdict = {
    status: 'no_identifier', summary: '', transmissions: [], warnings: [],
    formIdentifier, recordIdentifier: null, agreement: null,
  };

  if (!formIdentifier) {
    return { ...base, summary: 'This form carries no sample identifier, so there is nothing to verify against. Nothing will be filled.' };
  }

  const matches = findTransmissions(db, options);
  if (!matches.length) {
    const stale = seenOutsideWindow(db, formIdentifier, options.normaliser);
    if (stale) {
      return {
        ...base, status: 'no_results',
        summary: `The only transmission for ${formIdentifier} arrived ${String(stale.at).slice(0, 16).replace('T', ' ')}, outside this form’s ${options.lookbackHours}-hour window. It has not been offered, in case the identifier has since been reused.`,
      };
    }
    return { ...base, status: 'not_found', summary: `SECHLIMS holds no analyser transmission for ${formIdentifier}.` };
  }

  const agreed = matches.filter(m => m.agreement === 'exact' || m.agreement === 'normalised');
  const near = matches.filter(m => m.agreement === 'partial');
  const warnings: string[] = [];

  // A partial match is a near miss, and more than one of them is a trap: two
  // different samples whose identifiers both end the same way.
  if (!agreed.length) {
    const distinct = new Set(near.map(m => normaliseIdentifier(m.sampleId, options.normaliser)));
    if (distinct.size > 1) {
      return {
        ...base, status: 'ambiguous', transmissions: near.slice(0, 8),
        summary: `${distinct.size} different samples resemble ${formIdentifier}. Nothing will be filled until the identifier is unambiguous.`,
      };
    }
    const first = near[0];
    return {
      ...base, status: 'near_match', transmissions: near, agreement: 'partial',
      recordIdentifier: first.sampleId,
      summary: `The form says ${formIdentifier}; the analyser sent ${first.sampleId}. These are not identical — confirm they are the same sample before anything is filled.`,
      warnings,
    };
  }

  const chosen = agreed[0];
  if (chosen.agreement === 'normalised') {
    warnings.push(`Matched as the same identifier after ignoring spacing and punctuation: form ${formIdentifier}, analyser ${chosen.sampleId}.`);
  }

  /*
   * The patient identifier beside the sample: corroboration, contradiction, or
   * neither.
   *
   * A hospital rarely gives its analysers the same patient number its LIS
   * shows. Here the form prints a folder number — UW-A11-AAB2287 — while the
   * analyser was given AAJ7447, and both are correct for the same person. So a
   * mismatch cannot mean "wrong patient" on its own, or the filler would refuse
   * every sample in the building.
   *
   * What CAN mean it is two identifiers of the same SHAPE that differ: those
   * are two numbers from the same series, and one of them belongs to somebody
   * else. That is blocked; the rest is said out loud and left to the person.
   */
  const formPatient = String(options.patientIdentifier ?? '').trim();
  const sentPatient = chosen.demographics.patientId;
  if (formPatient && sentPatient) {
    const agreement = compareIdentifiers(formPatient, sentPatient, options.normaliser);
    if (agreement === 'different') {
      if (sameIdentifierShape(formPatient, sentPatient)) {
        return {
          ...base, status: 'blocked', transmissions: [chosen], agreement: chosen.agreement, recordIdentifier: chosen.sampleId,
          summary: `The sample matches, but the patient identifiers do not: this form says ${formPatient} and the transmission carries ${sentPatient}. They are numbers of the same kind, so one of them is a different patient. Nothing will be filled.`,
        };
      }
      warnings.push(`The patient identifier on this form (${formPatient}) is not the one the analyser was given (${sentPatient}). They are different kinds of number, so this was matched on the sample identifier alone — check the name before saving.`);
    } else {
      warnings.push(`The patient identifier agrees as well: ${sentPatient}.`);
    }
  }

  if (agreed.length > 1) {
    warnings.push(`${agreed.length} transmissions carry this identifier. The most recent is offered; choose another if this sample was re-run.`);
  }
  if (!chosen.readings.length) {
    return {
      ...base, status: 'no_results', transmissions: agreed, agreement: chosen.agreement, recordIdentifier: chosen.sampleId,
      summary: `${chosen.sampleId} was received but no parameter could be read out of it, so there is nothing to fill.`,
    };
  }
  if (chosen.mwStatus === 'invalid') {
    warnings.push('The middleware marked this message as having failed validation. Check it in the Message Explorer before relying on it.');
  }

  if (chosen.priorFills > 0) {
    return {
      ...base, status: 'already_entered', transmissions: agreed, agreement: chosen.agreement, recordIdentifier: chosen.sampleId,
      warnings,
      summary: `These results were already filled into a form${chosen.lastFilledBy ? ` by ${chosen.lastFilledBy}` : ''}${chosen.lastFilledAt ? ` on ${String(chosen.lastFilledAt).slice(0, 16).replace('T', ' ')}` : ''}. Filling again is allowed, but confirm this is not a duplicate entry.`,
    };
  }

  return {
    ...base, status: 'verified', transmissions: agreed, agreement: chosen.agreement, recordIdentifier: chosen.sampleId,
    warnings,
    summary: `${chosen.sampleId} verified against the transmission received ${String(chosen.receivedAt).slice(0, 16).replace('T', ' ')}${chosen.linkName ? ` from ${chosen.linkName}` : ''}. ${chosen.readings.length} parameter(s) available.`,
  };
}

/** One transmission by id, hydrated the same way a lookup returns them. */
export function transmissionById(db: DB, id: number): Transmission | null {
  const row = db.prepare(`${SELECT} WHERE m.id = ?`).get(id) as any;
  return row ? hydrate(row, 'exact') : null;
}
