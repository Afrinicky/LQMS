/**
 * The internal quality control programme, over HTTP.
 *
 *   GET    /iqc/programme                      the plan, what was done, and the gaps
 *   PUT    /iqc/programme/controls/:id/schedule   what a control is expected to do
 *   POST   /iqc/programme/missed               why a scheduled run did not happen
 *   DELETE /iqc/programme/missed/:id           withdraw that account of it
 *   POST   /iqc/programme/exemptions           leave an examination out, with the ground
 *   POST   /iqc/programme/exemptions/:id/withdraw   bring it back in
 *
 * Nothing here records a control run. A missed run is closed by recording the
 * run itself — on the day it was actually performed, through the run form that
 * evaluates it like any other — or by stating why it was not run. Those are
 * the only two ways, and this surface offers the second one only.
 */
import { Router } from 'express';
import { getDb } from '../db/database.js';
import { requireAuth } from '../middleware/auth.js';
import { requirePermission } from '../middleware/permissions.js';
import { mayActOnUnit } from '../services/unitLeadership.js';
import { resolveUnitScope, unitScopePayload } from '../services/unitScope.js';
import { audit } from '../services/auditService.js';
import { parseIntNullable, getStaffIdOrCurrent } from './routeHelpers.js';
import { programmeFor } from '../services/iqcProgramme.js';
import {
  EXEMPTION_GROUNDS, EXEMPTION_REVIEW_MONTHS, IQC_SHIFTS, PROGRAMME_FREQUENCIES, WEEKDAYS,
  type IqcShift, type ProgrammeFrequency, type Weekday,
} from '../../shared/constants/iqcProgramme.js';

const numericOnly = (req: any, _res: any, next: any) => (/^\d+$/.test(req.params.id) ? next() : next('route'));

function day(value: unknown): string | null {
  const raw = String(value ?? '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;
}

function text(value: unknown, limit = 400): string | null {
  const raw = String(value ?? '').trim();
  return raw ? raw.slice(0, limit) : null;
}

/** The month a screen opens on, when it asks for no particular period. */
function defaultPeriod(): { from: string; to: string } {
  const now = new Date();
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0));
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}

export function iqcProgrammeRoutes() {
  const router = Router();
  /*
   * Everything here needs a person, and reading needs nothing more.
   *
   * The unit's board is readable by everybody who works on it — a technician
   * about to release a result is entitled to know whether the control was run
   * — and the programme is the same question asked over a month. Gating it on
   * the Quality Control view right would hide it from exactly the bench it is
   * written for. Reading is clamped to the reader's own unit by
   * `resolveUnitScope`; writing is gated, control by control, below.
   */
  router.use(requireAuth);

  /** The unit a control belongs to, for the right to act on it. */
  function controlSection(db: any, materialId: number): number | null {
    const row = db.prepare(`SELECT COALESCE(m.performing_section_id, m.section_id, e.section_id) AS resolved
        FROM iqc_materials m LEFT JOIN equipment_items e ON e.id = m.equipment_id WHERE m.id = ?`)
      .get(materialId) as any;
    return row?.resolved ?? null;
  }

  /**
   * The programme, for a unit and a period.
   *
   * Scoped the way every other quality control screen is: the Quality Control
   * right answers for the laboratory, running a unit answers for that unit.
   * The module passes the unit it is looking at; the bench passes its own.
   */
  router.get('/programme', (req, res) => {
    const db = getDb();
    const scope = unitScopePayload(req, req.query.sectionId);
    const period = defaultPeriod();
    const from = day(req.query.from) ?? period.from;
    const to = day(req.query.to) ?? period.to;
    if (to < from) return res.status(400).json({ error: 'The period ends before it begins.' });

    const answer = programmeFor(db, { sectionId: scope.sectionId, from, to });
    res.json({
      ...answer,
      units: scope.units,
      canChooseUnit: scope.canChooseUnit,
      canPlan: mayActOnUnit(req, 'iqc', 'edit', scope.sectionId),
      canExempt: mayActOnUnit(req, 'iqc', 'approve', scope.sectionId),
      canRecord: mayActOnUnit(req, 'iqc', 'create', scope.sectionId),
      vocabulary: {
        frequencies: PROGRAMME_FREQUENCIES,
        weekdays: WEEKDAYS,
        shifts: IQC_SHIFTS,
        grounds: EXEMPTION_GROUNDS,
      },
    });
  });

  /**
   * What a control is expected to do.
   *
   * The plan is the laboratory's. What ships is a default read off the
   * frequency the control was registered with, and saving here replaces it
   * with a statement somebody is accountable for.
   */
  router.put('/programme/controls/:id/schedule', numericOnly, (req, res) => {
    const db = getDb();
    const materialId = Number(req.params.id);
    const material = db.prepare('SELECT id, material_name FROM iqc_materials WHERE id = ?').get(materialId) as any;
    if (!material) return res.status(404).json({ error: 'Control not found' });
    if (!mayActOnUnit(req, 'iqc', 'edit', controlSection(db, materialId))) {
      return res.status(403).json({ error: 'Planning a control needs the edit right on Quality Control, or the running of the unit it belongs to.' });
    }

    const frequency = (PROGRAMME_FREQUENCIES as readonly string[]).includes(String(req.body?.frequency))
      ? String(req.body.frequency) as ProgrammeFrequency : 'daily';
    const weekdays = Array.isArray(req.body?.weekdays)
      ? [...new Set(req.body.weekdays.map(Number).filter((d: number) => (WEEKDAYS as readonly number[]).includes(d)))].sort() as Weekday[]
      : [];
    const shifts = Array.isArray(req.body?.shifts)
      ? [...new Set(req.body.shifts.map(String).filter((s: string) => (IQC_SHIFTS as readonly string[]).includes(s)))] as IqcShift[]
      : [];
    if (frequency === 'per_shift' && shifts.length === 0) {
      return res.status(400).json({ error: 'Say which shifts the control is run on.' });
    }
    const startsOn = day(req.body?.startsOn);
    const endsOn = day(req.body?.endsOn);
    if (startsOn && endsOn && endsOn < startsOn) {
      return res.status(400).json({ error: 'The schedule ends before it begins.' });
    }
    const isActive = req.body?.isActive === false ? 0 : 1;

    db.prepare(`INSERT INTO iqc_schedules (iqc_material_id, frequency, weekdays, shifts, starts_on, ends_on,
        is_active, notes, created_by, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(iqc_material_id) DO UPDATE SET
          frequency = excluded.frequency, weekdays = excluded.weekdays, shifts = excluded.shifts,
          starts_on = excluded.starts_on, ends_on = excluded.ends_on, is_active = excluded.is_active,
          notes = excluded.notes, updated_at = CURRENT_TIMESTAMP`)
      .run(materialId, frequency, JSON.stringify(weekdays), JSON.stringify(shifts),
        startsOn, endsOn, isActive, text(req.body?.notes, 400), req.user!.id);

    audit(req, {
      action: 'edit', entity: 'iqc_schedules', entityId: materialId,
      newValue: { control: material.material_name, frequency, weekdays, shifts, startsOn, endsOn, isActive: Boolean(isActive) },
    });
    res.json({ ok: true });
  });

  /**
   * Why a scheduled run did not happen.
   *
   * The alternative to this is a laboratory that invents the run, so it is
   * deliberately easy to reach and deliberately impossible to leave blank. It
   * accounts for the day; it does not pretend a control was run.
   */
  router.post('/programme/missed', (req, res) => {
    const db = getDb();
    const materialId = parseIntNullable(req.body?.iqcMaterialId);
    if (!materialId) return res.status(400).json({ error: 'Say which control this is about.' });
    const material = db.prepare('SELECT id, material_name FROM iqc_materials WHERE id = ?').get(materialId) as any;
    if (!material) return res.status(404).json({ error: 'Control not found' });
    if (!mayActOnUnit(req, 'iqc', 'create', controlSection(db, materialId))) {
      return res.status(403).json({ error: 'Accounting for a missed run needs the create right on Quality Control, or the running of the unit the control belongs to.' });
    }

    const dueDate = day(req.body?.dueDate);
    if (!dueDate) return res.status(400).json({ error: 'Say which day was missed.' });
    if (dueDate > new Date().toISOString().slice(0, 10)) {
      return res.status(400).json({ error: 'That day has not happened yet.' });
    }
    const reason = text(req.body?.reason, 400);
    if (!reason) return res.status(400).json({ error: 'Record why the control was not run.' });
    const shift = (IQC_SHIFTS as readonly string[]).includes(String(req.body?.shift)) ? String(req.body.shift) : null;

    // A run recorded for that day answers for it, and an account of why it was
    // not run would then contradict the record.
    const ran = db.prepare(`SELECT id FROM iqc_runs WHERE iqc_material_id = ? AND run_date = ?
        AND (? IS NULL OR shift IS NULL OR shift = ?) LIMIT 1`).get(materialId, dueDate, shift, shift) as any;
    if (ran) return res.status(409).json({ error: 'A run is already recorded for that day. Nothing was missed.' });

    const staffId = getStaffIdOrCurrent(req, req.body?.recordedByStaffId);
    db.prepare(`INSERT INTO iqc_missed_runs (iqc_material_id, due_date, shift, reason, recorded_by_staff_id, created_by)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(iqc_material_id, due_date, IFNULL(shift, '')) DO UPDATE SET
          reason = excluded.reason, recorded_by_staff_id = excluded.recorded_by_staff_id,
          recorded_at = CURRENT_TIMESTAMP`)
      .run(materialId, dueDate, shift, reason, staffId, req.user!.id);

    audit(req, {
      action: 'create', entity: 'iqc_missed_runs', entityId: materialId,
      newValue: { control: material.material_name, dueDate, shift, reason },
    });
    res.status(201).json({ ok: true });
  });

  /** Withdraw an account of a missed run — it goes back to being a gap. */
  router.delete('/programme/missed/:id', numericOnly, (req, res) => {
    const db = getDb();
    const row = db.prepare('SELECT * FROM iqc_missed_runs WHERE id = ?').get(req.params.id) as any;
    if (!row) return res.status(404).json({ error: 'That record is no longer there.' });
    if (!mayActOnUnit(req, 'iqc', 'create', controlSection(db, Number(row.iqc_material_id)))) {
      return res.status(403).json({ error: 'Withdrawing this needs the create right on Quality Control, or the running of the unit the control belongs to.' });
    }
    db.prepare('DELETE FROM iqc_missed_runs WHERE id = ?').run(row.id);
    audit(req, {
      action: 'delete', entity: 'iqc_missed_runs', entityId: Number(row.id),
      oldValue: { dueDate: row.due_date, shift: row.shift, reason: row.reason },
    });
    res.json({ ok: true });
  });

  /**
   * Leave an examination out of the programme.
   *
   * Not every examination carries internal quality control — a test referred
   * elsewhere, a kit whose own internal control runs on every use, a method
   * for which no control material exists. Those are legitimate, and a
   * programme that cannot express them is one a laboratory works around.
   *
   * So it is a decision on the record: the ground, the reason in words, who
   * decided, and when it is looked at again. An exemption past its review date
   * is reported like anything else that is overdue.
   */
  router.post('/programme/exemptions', (req, res) => {
    const db = getDb();
    const testId = parseIntNullable(req.body?.testId);
    if (!testId) return res.status(400).json({ error: 'Say which examination this is about.' });
    const test = db.prepare('SELECT id, test_name, section_id FROM lab_test_catalog WHERE id = ?').get(testId) as any;
    if (!test) return res.status(404).json({ error: 'Examination not found' });
    if (!mayActOnUnit(req, 'iqc', 'approve', test.section_id ?? null)) {
      return res.status(403).json({ error: 'Leaving an examination out of the programme needs the approve right on Quality Control, or the running of the unit it belongs to.' });
    }

    const reason = text(req.body?.reason, 400);
    if (!reason) return res.status(400).json({ error: 'Record why this examination is not controlled.' });
    const ground = (EXEMPTION_GROUNDS as readonly string[]).includes(String(req.body?.ground))
      ? String(req.body.ground) : 'other';

    // Reviewed within the year unless the laboratory names a date, because an
    // exemption nobody revisits is how an examination quietly stops being
    // controlled.
    const review = new Date();
    review.setMonth(review.getMonth() + EXEMPTION_REVIEW_MONTHS);
    const reviewOn = day(req.body?.reviewOn) ?? review.toISOString().slice(0, 10);

    const live = db.prepare('SELECT id FROM iqc_test_exemptions WHERE test_id = ? AND is_active = 1').get(testId) as any;
    if (live) return res.status(409).json({ error: 'This examination is already out of the programme.' });

    const inserted = db.prepare(`INSERT INTO iqc_test_exemptions
        (test_id, section_id, ground, reason, review_on, approved_by_staff_id, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(testId, test.section_id ?? null, ground, reason, reviewOn,
        getStaffIdOrCurrent(req, req.body?.approvedByStaffId), req.user!.id);

    audit(req, {
      action: 'create', entity: 'iqc_test_exemptions', entityId: Number(inserted.lastInsertRowid),
      newValue: { test: test.test_name, ground, reason, reviewOn },
    });
    res.status(201).json({ ok: true, id: Number(inserted.lastInsertRowid), reviewOn });
  });

  /** Bring an examination back into the programme. */
  router.post('/programme/exemptions/:id/withdraw', numericOnly, (req, res) => {
    const db = getDb();
    const row = db.prepare('SELECT * FROM iqc_test_exemptions WHERE id = ? AND is_active = 1').get(req.params.id) as any;
    if (!row) return res.status(404).json({ error: 'That exemption is not in force.' });
    if (!mayActOnUnit(req, 'iqc', 'approve', row.section_id ?? null)) {
      return res.status(403).json({ error: 'Withdrawing an exemption needs the approve right on Quality Control, or the running of the unit it belongs to.' });
    }
    db.prepare(`UPDATE iqc_test_exemptions SET is_active = 0, withdrawn_at = CURRENT_TIMESTAMP,
        withdrawn_by = ?, withdrawal_reason = ? WHERE id = ?`)
      .run(req.user!.id, text(req.body?.reason, 400), row.id);
    audit(req, {
      action: 'edit', entity: 'iqc_test_exemptions', entityId: Number(row.id),
      newValue: { withdrawn: true, reason: text(req.body?.reason, 400) },
    });
    res.json({ ok: true });
  });

  /** Every exemption on the record, in force or withdrawn, for the register. */
  router.get('/programme/exemptions', requirePermission('iqc', 'view'), (req, res) => {
    const scope = resolveUnitScope(req, req.query.sectionId);
    const rows = getDb().prepare(`SELECT x.*, t.test_name, t.test_code, s.full_name AS approved_by_name
        FROM iqc_test_exemptions x
        JOIN lab_test_catalog t ON t.id = x.test_id
        LEFT JOIN staff s ON s.id = x.approved_by_staff_id
        WHERE (? IS NULL OR x.section_id = ?)
        ORDER BY x.is_active DESC, t.test_name`).all(scope.sectionId, scope.sectionId);
    res.json(rows);
  });

  return router;
}
