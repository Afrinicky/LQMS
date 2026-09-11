/**
 * One training file per person, gathered from everywhere it was recorded.
 *
 * Training was being written down in four places that did not know about one
 * another: a session booked in Personnel Management, training on an instrument
 * recorded in Equipment Management, a course somebody entered on their own
 * portal, and the competency assessment that proved any of it worked. Asking
 * "what training has this person had?" meant opening four screens and adding
 * up by hand, which is precisely the question a training file exists to
 * answer.
 *
 * So the question is answered here, once, and every screen that asks it — the
 * staff profile, the portal, Personnel Management, an export — gets the same
 * answer in the same shape. Where a record was made is kept as its ORIGIN and
 * shown, because somebody will want the original; it is never used to decide
 * whether the record belongs on the file. It does. It is their training.
 *
 * Nothing is written here. This reads what the modules own and puts it in one
 * order, so a record cannot drift from the module that owns it.
 */
import {
  sortTrainingRecord, summariseTrainingRecord, trainerDisplayName,
  type TrainingRecordEntry,
} from '../../shared/constants/training.js';

type DB = any;

const str = (value: unknown): string | null => {
  const text = String(value ?? '').trim();
  return text ? text : null;
};
const num = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

/**
 * Sessions the laboratory ran, as they apply to this person.
 *
 * Driven from attendance rather than from the events table: an event this
 * person was not invited to is not their training, and an event they were
 * invited to but did not attend is — the record that they were expected and
 * did not come is exactly what a supervisor needs to see.
 */
function fromTrainingEvents(db: DB, staffId: number): TrainingRecordEntry[] {
  const rows = db.prepare(`SELECT a.id AS attendance_id, a.attendance_status, a.outcome, a.hours AS attendance_hours,
        a.certificate_file_id, a.remarks, a.effectiveness_outcome AS person_effectiveness,
        e.id AS event_id, e.training_number, e.title, e.description, e.category, e.training_type,
        e.training_format, e.delivery_mode, e.trainer_type, e.external_trainer_name,
        e.external_trainer_organisation, e.provider, e.training_date, e.end_date, e.duration_hours,
        e.location, e.status, e.equipment_id, e.effectiveness_outcome, e.effectiveness_due_date,
        e.evidence_file_id, e.source_module,
        t.full_name AS trainer_name, eq.name AS equipment_name
      FROM training_attendance a
      JOIN training_events e ON e.id = a.training_event_id
      LEFT JOIN staff t ON t.id = e.trainer_staff_id
      LEFT JOIN equipment_items eq ON eq.id = e.equipment_id
      WHERE a.staff_id = ?`).all(staffId) as any[];

  return rows.map(row => ({
    // A session raised from the equipment file is shown as what it is, so
    // somebody looking for "the training the engineer gave on the Sysmex"
    // recognises it and can follow it back to the instrument.
    origin: row.source_module === 'equipment' ? 'equipment' : 'personnel',
    sourceId: Number(row.event_id),
    reference: str(row.training_number),
    title: String(row.title ?? 'Training'),
    category: str(row.category) ?? str(row.training_type),
    deliveryMode: row.delivery_mode === 'external' ? 'external' : 'internal',
    trainerType: row.trainer_type === 'external_person' ? 'external_person' : 'internal_staff',
    trainerName: trainerDisplayName(row),
    provider: str(row.provider),
    date: str(row.training_date),
    endDate: str(row.end_date),
    // What this person actually did, before what the session was scheduled for.
    // Somebody who attended half a day of a two-day course has four hours on
    // their file, not sixteen.
    hours: num(row.attendance_hours) ?? num(row.duration_hours),
    location: str(row.location),
    format: str(row.training_format),
    attendanceStatus: str(row.attendance_status) ?? 'invited',
    outcome: str(row.outcome) ?? 'not_assessed',
    effectivenessOutcome: str(row.person_effectiveness) ?? str(row.effectiveness_outcome) ?? 'pending',
    effectivenessDueDate: str(row.effectiveness_due_date),
    equipmentId: num(row.equipment_id),
    equipmentName: str(row.equipment_name),
    verificationStatus: null,
    certificateFileId: num(row.certificate_file_id) ?? num(row.evidence_file_id),
    notes: str(row.remarks) ?? str(row.description),
  }));
}

/**
 * Training on an instrument, recorded against the instrument.
 *
 * Only the records that have NOT raised a training event of their own, because
 * those already arrived above and showing both would double the person's
 * training. Older records, made before the two were joined up, come through
 * here — which is the point: a competence record from two years ago is still
 * this person's training and must not vanish from their file because of when
 * it was entered.
 */
function fromEquipmentCompetence(db: DB, staffId: number): TrainingRecordEntry[] {
  const rows = db.prepare(`SELECT c.*, e.name AS equipment_name, e.equipment_number,
        t.full_name AS trainer_name
      FROM equipment_competencies c
      LEFT JOIN equipment_items e ON e.id = c.equipment_id
      LEFT JOIN staff t ON t.id = c.trainer_staff_id
      WHERE c.staff_id = ? AND c.training_event_id IS NULL`).all(staffId) as any[];

  return rows.map(row => ({
    origin: 'equipment' as const,
    sourceId: Number(row.id),
    reference: str(row.equipment_number),
    title: `Training on ${row.equipment_name ?? 'equipment'}`,
    category: 'equipment',
    deliveryMode: row.delivery_mode === 'external' ? 'external' as const : 'internal' as const,
    trainerType: row.trainer_type === 'external_person' ? 'external_person' as const : 'internal_staff' as const,
    trainerName: trainerDisplayName(row),
    provider: str(row.provider),
    date: str(row.training_date) ?? str(row.assessment_date),
    endDate: null,
    hours: num(row.training_hours),
    location: null,
    format: 'bench_side',
    // A competence record is only ever made about somebody who was there.
    attendanceStatus: 'attended',
    outcome: str(row.outcome) ?? 'not_assessed',
    effectivenessOutcome: row.outcome && String(row.outcome).startsWith('competent') ? 'effective' : 'pending',
    effectivenessDueDate: null,
    equipmentId: num(row.equipment_id),
    equipmentName: str(row.equipment_name),
    verificationStatus: null,
    certificateFileId: null,
    notes: str(row.notes),
  }));
}

/** What the person put on their own file. A claim until Personnel verifies it. */
function fromCpd(db: DB, staffId: number): TrainingRecordEntry[] {
  const rows = db.prepare('SELECT * FROM staff_cpd_records WHERE staff_id = ?').all(staffId) as any[];
  return rows.map(row => ({
    origin: 'self_declared' as const,
    sourceId: Number(row.id),
    reference: str(row.certificate_reference),
    title: String(row.title ?? 'Continuing professional development'),
    category: str(row.category) ?? 'continuing_professional_development',
    deliveryMode: row.delivery_mode === 'internal' ? 'internal' as const : 'external' as const,
    trainerType: 'external_person' as const,
    trainerName: str(row.trainer_name) ?? str(row.provider) ?? 'Not named',
    provider: str(row.provider),
    date: str(row.start_date) ?? str(row.end_date),
    endDate: str(row.end_date),
    hours: num(row.hours),
    location: str(row.location),
    format: str(row.training_type),
    attendanceStatus: 'attended',
    outcome: 'not_assessed',
    // A course somebody went to on their own time has no effectiveness review
    // owed against it, and showing one outstanding forever would make the
    // laboratory's real outstanding reviews impossible to find.
    effectivenessOutcome: null,
    effectivenessDueDate: null,
    equipmentId: null,
    equipmentName: null,
    verificationStatus: str(row.verification_status) ?? 'declared',
    certificateFileId: num(row.file_id),
    notes: str(row.description),
  }));
}

/**
 * Competency assessments.
 *
 * Not training, and never counted as training — they carry no hours and are
 * marked as their own origin. They are on the file because they are the
 * evidence that training worked, and a training file read without them says
 * what somebody attended but not what they can do.
 */
function fromCompetency(db: DB, staffId: number): TrainingRecordEntry[] {
  const rows = db.prepare(`SELECT c.*, a.full_name AS assessor_name
      FROM competency_assessments c
      LEFT JOIN staff a ON a.id = c.assessor_staff_id
      WHERE c.staff_id = ?`).all(staffId) as any[];
  return rows.map(row => ({
    origin: 'competency' as const,
    sourceId: Number(row.id),
    reference: str(row.competency_number),
    title: String(row.activity ?? 'Competency assessment'),
    category: 'quality_management',
    deliveryMode: null,
    trainerType: null,
    trainerName: str(row.assessor_name),
    provider: null,
    date: str(row.assessment_date),
    endDate: null,
    hours: null,
    location: null,
    format: str(row.assessment_method),
    attendanceStatus: 'attended',
    outcome: str(row.outcome) ?? 'not_assessed',
    effectivenessOutcome: null,
    effectivenessDueDate: str(row.next_assessment_due),
    equipmentId: null,
    equipmentName: null,
    verificationStatus: null,
    certificateFileId: num(row.evidence_file_id),
    notes: str(row.findings),
  }));
}

/**
 * Everything, in one order.
 *
 * A missing table is survived rather than fatal: this is read on the staff
 * profile and on every portal load, and a database part-way through an upgrade
 * should cost one panel a section, not the whole page.
 */
export function trainingRecordFor(db: DB, staffId: number): TrainingRecordEntry[] {
  const sources: Array<() => TrainingRecordEntry[]> = [
    () => fromTrainingEvents(db, staffId),
    () => fromEquipmentCompetence(db, staffId),
    () => fromCpd(db, staffId),
    () => fromCompetency(db, staffId),
  ];
  const entries: TrainingRecordEntry[] = [];
  for (const read of sources) {
    try { entries.push(...read()); }
    catch { /* one source unavailable must not empty the file */ }
  }
  return sortTrainingRecord(entries);
}

/** The file, and what it adds up to. */
export function trainingFileFor(db: DB, staffId: number) {
  const entries = trainingRecordFor(db, staffId);
  return { entries, summary: summariseTrainingRecord(entries) };
}

/* ============================================================================
   Keeping the two registers joined
   ========================================================================= */

/**
 * Raise the personnel training event behind a piece of equipment training.
 *
 * This is what makes training recorded on an analyser appear on the person's
 * own file, in Personnel Management and on their portal, without anybody
 * entering it twice. The equipment record stays the master — it owns the
 * competence decision and the authorisation — and this is its shadow in the
 * training register, carrying `source_module = 'equipment'` so both screens can
 * say where it came from.
 *
 * Idempotent by the competence record's id: calling it again for a record that
 * already has an event updates that event rather than creating a second one. A
 * person's file gaining a duplicate every time somebody corrects a typo is
 * exactly the failure this is meant to prevent.
 */
export function syncEquipmentTrainingEvent(
  db: DB,
  competencyId: number,
  opts: { userId?: number | null; makeNumber: (db: DB, table: string, prefix: string, createdAt: string) => string },
): number | null {
  const row = db.prepare(`SELECT c.*, e.name AS equipment_name, e.equipment_number, e.section_id
      FROM equipment_competencies c
      LEFT JOIN equipment_items e ON e.id = c.equipment_id
      WHERE c.id = ?`).get(competencyId) as any;
  if (!row) return null;

  // No date, nothing to record. A competence record whose training date was
  // never filled in is an assessment, not a session, and inventing a date for
  // it would put a training event on somebody's file that never happened.
  const trainingDate = str(row.training_date);
  if (!trainingDate) return null;

  const title = `Training on ${row.equipment_name ?? 'equipment'}${row.equipment_number ? ` (${row.equipment_number})` : ''}`;
  const fields = {
    title,
    description: str(row.notes),
    category: 'equipment',
    delivery_mode: row.delivery_mode === 'external' ? 'external' : 'internal',
    trainer_type: row.trainer_type === 'external_person' ? 'external_person' : 'internal_staff',
    trainer_staff_id: row.trainer_type === 'external_person' ? null : (row.trainer_staff_id ?? null),
    external_trainer_name: str(row.external_trainer_name),
    external_trainer_organisation: str(row.external_trainer_organisation),
    external_trainer_qualifications: str(row.external_trainer_qualifications),
    provider: str(row.provider),
    training_format: 'bench_side',
    duration_hours: num(row.training_hours),
    training_date: trainingDate,
    equipment_id: row.equipment_id ?? null,
    section_id: row.section_id ?? null,
    // The assessment on the equipment record IS the effectiveness check, and
    // saying so stops the same piece of work being asked for twice.
    effectiveness_method: row.assessment_date ? 'competency_assessment' : 'not_required',
    effectiveness_outcome: String(row.outcome ?? '').startsWith('competent') ? 'effective' : 'pending',
  };

  let eventId = num(row.training_event_id);
  if (eventId) {
    db.prepare(`UPDATE training_events SET title = ?, description = ?, category = ?, delivery_mode = ?,
        trainer_type = ?, trainer_staff_id = ?, external_trainer_name = ?, external_trainer_organisation = ?,
        external_trainer_qualifications = ?, provider = ?, training_format = ?, duration_hours = ?,
        training_date = ?, equipment_id = ?, section_id = ?, effectiveness_method = ?,
        effectiveness_outcome = ?, status = 'completed', updated_at = CURRENT_TIMESTAMP
        WHERE id = ?`)
      .run(fields.title, fields.description, fields.category, fields.delivery_mode, fields.trainer_type,
        fields.trainer_staff_id, fields.external_trainer_name, fields.external_trainer_organisation,
        fields.external_trainer_qualifications, fields.provider, fields.training_format, fields.duration_hours,
        fields.training_date, fields.equipment_id, fields.section_id, fields.effectiveness_method,
        fields.effectiveness_outcome, eventId);
  } else {
    const createdAt = new Date().toISOString();
    const number = opts.makeNumber(db, 'training_events', 'TRN', createdAt);
    const inserted = db.prepare(`INSERT INTO training_events
        (training_number, title, description, category, delivery_mode, trainer_type, trainer_staff_id,
         external_trainer_name, external_trainer_organisation, external_trainer_qualifications, provider,
         training_format, duration_hours, training_date, equipment_id, section_id,
         effectiveness_method, effectiveness_outcome, status,
         source_module, source_record_type, source_record_id, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', 'equipment', 'equipment_competencies', ?, ?, ?)`)
      .run(number, fields.title, fields.description, fields.category, fields.delivery_mode, fields.trainer_type,
        fields.trainer_staff_id, fields.external_trainer_name, fields.external_trainer_organisation,
        fields.external_trainer_qualifications, fields.provider, fields.training_format, fields.duration_hours,
        fields.training_date, fields.equipment_id, fields.section_id, fields.effectiveness_method,
        fields.effectiveness_outcome, competencyId, opts.userId ?? null, createdAt);
    eventId = Number(inserted.lastInsertRowid);
    db.prepare('UPDATE equipment_competencies SET training_event_id = ? WHERE id = ?').run(eventId, competencyId);
  }

  // The person was there — that is what a competence record means — so the
  // attendance row says attended rather than invited, and carries the outcome
  // the equipment record reached.
  const outcome = String(row.outcome ?? '').startsWith('competent') ? 'competent'
    : row.outcome === 'not_yet_competent' ? 'needs_further_training' : 'not_assessed';
  const existing = db.prepare('SELECT id FROM training_attendance WHERE training_event_id = ? AND staff_id = ?')
    .get(eventId, row.staff_id) as any;
  if (existing) {
    db.prepare(`UPDATE training_attendance SET attendance_status = 'attended', outcome = ?, hours = ?,
        updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(outcome, num(row.training_hours), existing.id);
  } else {
    db.prepare(`INSERT INTO training_attendance
        (training_event_id, staff_id, attendance_status, signed_at, outcome, hours, remarks, created_by)
        VALUES (?, ?, 'attended', CURRENT_TIMESTAMP, ?, ?, ?, ?)`)
      .run(eventId, row.staff_id, outcome, num(row.training_hours), str(row.notes), opts.userId ?? null);
  }

  return eventId;
}
