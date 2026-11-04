/**
 * One way in, for every transmission.
 *
 * An analyser's results reach this host by more than one road — a socket the
 * bridge opened, a log it follows, a folder it sweeps, and a middleware or
 * driver that posts what it parsed over HTTP. What arrives is the same thing
 * in every case: a sample identifier, a lot, a moment, and a set of readings.
 *
 * It used not to be recorded the same way. Everything the bridge read was
 * written to `instrument_messages` — the verbatim record the Result Filler,
 * the middleware, the Message Explorer and every module's "take it off the
 * analyser" button all read from. A control posted to an IQC feed was written
 * only to `iqc_feed_messages`, so the same transmission existed on the IQC
 * bench and nowhere else: the Result Filler could not see it, the explorer did
 * not list it, and no module but Quality Control could use it.
 *
 * So the recording lives here, once, and every road in goes through it:
 *
 *   RECORD IT VERBATIM FIRST. `instrument_messages` is the record, whatever the
 *   message turns out to be and whoever delivered it.
 *
 *   THEN PARK IT WHERE IT BELONGS. A control run is additionally parked on the
 *   IQC bench, tied back to the transmission it came from, where a person
 *   accepts or rejects it. Nothing here accepts anything.
 *
 * Nothing in this file forwards, delivers or decides. Transmission OUT of
 * SECHLIMS — the copy that reaches the LIS — is untouched by it.
 */

type DB = any;

/** One reading, as the parser left it. */
export interface IntakeValue {
  /** The analyser's own mnemonic. */
  code?: string;
  /** That mnemonic under this system's names. */
  analyte?: string;
  value?: unknown;
  unit?: string | null;
  flag?: string | null;
}

export interface TransmissionIntake {
  /** The link it came down, where a link received it. */
  linkId?: number | null;
  /** The address that sent it, where the transport knows one. */
  peer?: string | null;
  /** The transmission, verbatim. */
  raw: string;
  sampleId: string | null;
  lotNumber: string | null;
  instrument?: string | null;
  runAt?: string | null;
  values: IntakeValue[];
  /** What the message turned out to be. */
  kind: 'patient' | 'control' | 'unknown';
  /** What makes this transmission itself, for recognising a re-read. */
  fingerprint?: string | null;
  /** 'pending' where a copy is to go onward, else 'not_required'. */
  forwardStatus?: 'pending' | 'not_required';
}

/** The verbatim record of one transmission, and nothing else. */
export function recordTransmission(db: DB, intake: TransmissionIntake): number {
  const inserted = db.prepare(`INSERT INTO instrument_messages
      (link_id, peer, raw_message, sample_id, lot_number, instrument_name, instrument_run_at,
       result_count, parsed_values, kind, forward_status, message_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(intake.linkId ?? null, intake.peer ?? null, String(intake.raw ?? '').slice(0, 60_000),
      intake.sampleId, intake.lotNumber, intake.instrument ?? null, intake.runAt ?? null,
      intake.values.length, JSON.stringify(intake.values), intake.kind,
      intake.forwardStatus ?? 'not_required', intake.fingerprint ?? null);

  if (intake.linkId) {
    db.prepare(`UPDATE instrument_links SET last_message_at = CURRENT_TIMESTAMP,
        messages_received = messages_received + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(intake.linkId);
  }
  return Number(inserted.lastInsertRowid);
}

/** Has this link already recorded this exact transmission? */
export function alreadyRecorded(db: DB, linkId: number, fingerprint: string): boolean {
  if (!fingerprint) return false;
  try {
    return Boolean(db.prepare('SELECT id FROM instrument_messages WHERE link_id = ? AND message_hash = ?')
      .get(linkId, fingerprint));
  } catch {
    // Without the column, record it: a duplicate is visible, a lost result is not.
    return false;
  }
}

export interface ControlMatch {
  id: number;
  material_name?: string | null;
  material_code?: string | null;
  [key: string]: unknown;
}

/**
 * Which control material a run belongs to.
 *
 * The lot is the strongest signal, then the identifier the analyser used for
 * the sample, then — where a feed declares patterns — the feed's own control,
 * and last the instrument, but only where that instrument runs exactly one
 * active control. Guessing between Level 1 and Level 2 is how a control record
 * becomes fiction, so an ambiguous instrument matches nothing and the bench
 * matches it by hand.
 */
export function matchControlMaterial(db: DB, options: {
  sampleId?: string | null;
  lotNumber?: string | null;
  /** The instrument the link or feed belongs to. */
  equipmentId?: number | null;
  /** The IQC feed it was posted to, where one received it. */
  feedId?: number | null;
  /** Identifier fragments that feed declares as its controls. */
  controlPatterns?: string[] | null;
}): ControlMatch | null {
  const lot = String(options.lotNumber ?? '').trim();
  const sample = String(options.sampleId ?? '').trim();

  if (lot) {
    const byLot = db.prepare('SELECT * FROM iqc_materials WHERE lot_number = ? AND is_active = 1').get(lot);
    if (byLot) return byLot as ControlMatch;
  }
  if (sample) {
    const bySample = db.prepare('SELECT * FROM iqc_materials WHERE is_active = 1 AND (material_code = ? OR lot_number = ?)')
      .get(sample, sample);
    if (bySample) return bySample as ControlMatch;
  }
  if (sample && options.feedId && Array.isArray(options.controlPatterns)
      && options.controlPatterns.some(p => sample.toLowerCase().includes(String(p).toLowerCase()))) {
    const byFeed = db.prepare('SELECT * FROM iqc_materials WHERE feed_id = ? AND is_active = 1 ORDER BY id LIMIT 1')
      .get(options.feedId);
    if (byFeed) return byFeed as ControlMatch;
  }
  if (options.equipmentId) {
    const candidates = db.prepare('SELECT * FROM iqc_materials WHERE equipment_id = ? AND is_active = 1')
      .all(options.equipmentId) as ControlMatch[];
    if (candidates.length === 1) return candidates[0];
  }
  return null;
}

export interface ParkedControl {
  feedMessageId: number;
  material: ControlMatch | null;
  /** Why no control matched, in words, or null where one did. */
  note: string | null;
}

/**
 * A control run reaching the bench, tied to the transmission it came from.
 *
 * It is parked, never accepted. An analyser message is evidence that a control
 * was run — not a decision that it passed, and not permission to release
 * patient results. That decision belongs to a person, and the IQC board is
 * where they make it.
 */
export function parkControlRun(db: DB, options: {
  instrumentMessageId: number | null;
  linkId?: number | null;
  feedId?: number | null;
  raw: string;
  sampleId: string | null;
  lotNumber: string | null;
  runAt?: string | null;
  values: IntakeValue[];
  equipmentId?: number | null;
  controlPatterns?: string[] | null;
  /** A control already decided on by the caller. */
  material?: ControlMatch | null;
}): ParkedControl {
  const material = options.material ?? matchControlMaterial(db, {
    sampleId: options.sampleId, lotNumber: options.lotNumber,
    equipmentId: options.equipmentId, feedId: options.feedId,
    controlPatterns: options.controlPatterns,
  });

  const named = options.sampleId ?? options.lotNumber ?? 'the sample identifier';
  const note = material ? null
    : `Recognised as a control from "${named}", but no active control material matched it. `
      + 'Match it by hand on the bench, or add its lot to the control.';

  const inserted = db.prepare(`INSERT INTO iqc_feed_messages
      (feed_id, link_id, instrument_message_id, raw_message, sample_id, lot_number,
       instrument_run_at, parsed_values, iqc_material_id, status, status_note)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(options.feedId ?? null, options.linkId ?? null, options.instrumentMessageId,
      String(options.raw ?? '').slice(0, 60_000), options.sampleId, options.lotNumber,
      options.runAt ?? null, JSON.stringify(options.values), material?.id ?? null,
      material ? 'matched' : 'unmatched', note);

  const feedMessageId = Number(inserted.lastInsertRowid);
  if (options.instrumentMessageId) {
    db.prepare('UPDATE instrument_messages SET iqc_feed_message_id = ? WHERE id = ?')
      .run(feedMessageId, options.instrumentMessageId);
  }
  if (options.linkId) {
    db.prepare('UPDATE instrument_links SET controls_matched = controls_matched + ? WHERE id = ?')
      .run(material ? 1 : 0, options.linkId);
  }
  return { feedMessageId, material, note };
}
