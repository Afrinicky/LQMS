/**
 * The standardised control procedure: define once, run the same way every time.
 *
 *   GET/POST/PUT  /iqc/materials/:id/analytes    what this control measures
 *   POST          /iqc/runs                      record one control run
 *   GET           /iqc/runs                      the run register
 *   GET           /iqc/runs/:id                  one run with its readings
 *   POST          /iqc/runs/:id/review           accept the run
 *   POST          /iqc/runs/:id/release          decide on patient results
 *   GET           /iqc/analytes/:id/chart        Levey-Jennings with statistics
 *
 * A run is the unit of work, not an individual number: one vial goes on the
 * analyser and every parameter comes off it together, and it is the run as a
 * whole that decides whether patient results can be reported.
 */
import { Router } from 'express';
import { getDb } from '../db/database.js';
import { requirePermission } from '../middleware/permissions.js';
import { audit } from '../services/auditService.js';
import { generateRecordNumber } from '../utils/recordNumber.js';
import { parseIntNullable, getStaffIdOrCurrent } from './routeHelpers.js';
import { evaluateRun, chartStatistics, type AnalyteDef, type History } from '../services/iqcEvaluation.js';
import {
  effectiveTarget, withEffectiveTarget, establishTargets, establishForMaterial, refreshEstablishedTargets,
  DEFINITIVE_POINTS, DEFINITIVE_DAYS, INTERIM_POINTS, INTERIM_DAYS,
} from '../services/iqcTargets.js';
import type { IqcControlType, IqcRuleProfile } from '../../shared/constants/iqc.js';

type MaterialRow = {
  id: number; material_name: string; lot_number: string; test_name: string;
  control_type: IqcControlType; rule_profile: IqcRuleProfile; source: string;
  level_label: string | null; expiry_date: string | null; is_active: number;
};

export function iqcRunRoutes() {
  const router = Router();

  /* ---------------------------------------------------------------- analytes */

  router.get('/materials/:id/analytes', requirePermission('iqc', 'view'), (req, res) => {
    res.json(getDb().prepare('SELECT * FROM iqc_analytes WHERE iqc_material_id = ? ORDER BY display_order, id').all(req.params.id));
  });

  // Replace the whole analyte set in one call. Defining a control is a single
  // act — you do not add eight FBC parameters one request at a time — and the
  // form that does it submits the finished list.
  router.put('/materials/:id/analytes', requirePermission('iqc', 'edit'), (req, res) => {
    const db = getDb();
    const material = db.prepare('SELECT id FROM iqc_materials WHERE id = ?').get(req.params.id);
    if (!material) return res.status(404).json({ error: 'IQC material not found' });
    const rows = Array.isArray(req.body?.analytes) ? req.body.analytes : null;
    if (!rows) return res.status(400).json({ error: 'analytes must be an array' });
    if (rows.length === 0) return res.status(400).json({ error: 'A control must measure at least one analyte.' });

    const num = (v: unknown) => (v === '' || v === null || v === undefined || Number.isNaN(Number(v)) ? null : Number(v));
    const tx = db.transaction(() => {
      // Keep analytes that already carry results; only their definition changes.
      const keep = new Set<number>();
      rows.forEach((a: Record<string, unknown>, i: number) => {
        const name = String(a.analyte ?? '').trim();
        if (!name) return;
        const existing = db.prepare('SELECT id FROM iqc_analytes WHERE iqc_material_id = ? AND analyte = ?').get(req.params.id, name) as { id: number } | undefined;
        const values = [
          a.unit ?? null, num(a.targetMean), num(a.targetSd), num(a.acceptableLow), num(a.acceptableHigh),
          num(a.decimalPlaces) ?? 2, (a.expectedResult as string) || null,
          (a.astMethod as string) || null, (a.expectedInterpretation as string) || null,
          i, a.isActive === false ? 0 : 1,
        ];
        if (existing) {
          db.prepare(`UPDATE iqc_analytes SET unit = ?, target_mean = ?, target_sd = ?, acceptable_low = ?, acceptable_high = ?,
              decimal_places = ?, expected_result = ?, ast_method = ?, expected_interpretation = ?, display_order = ?, is_active = ? WHERE id = ?`).run(...values, existing.id);
          keep.add(existing.id);
        } else {
          const r = db.prepare(`INSERT INTO iqc_analytes (iqc_material_id, analyte, unit, target_mean, target_sd, acceptable_low,
              acceptable_high, decimal_places, expected_result, ast_method, expected_interpretation, display_order, is_active)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(req.params.id, name, ...values);
          keep.add(Number(r.lastInsertRowid));
        }
      });
      // Anything dropped from the list is deactivated rather than deleted, so
      // its historical results and charts survive.
      const all = db.prepare('SELECT id FROM iqc_analytes WHERE iqc_material_id = ?').all(req.params.id) as { id: number }[];
      for (const a of all) if (!keep.has(a.id)) db.prepare('UPDATE iqc_analytes SET is_active = 0 WHERE id = ?').run(a.id);
    });
    tx();
    audit(req, { action: 'edit', entity: 'iqc_analytes', entityId: req.params.id, newValue: { count: rows.length } });
    res.json({ ok: true, analytes: db.prepare('SELECT * FROM iqc_analytes WHERE iqc_material_id = ? ORDER BY display_order, id').all(req.params.id) });
  });

  /* -------------------------------------------------------------------- runs */

  router.get('/runs', requirePermission('iqc', 'view'), (req, res) => {
    const db = getDb();
    const where: string[] = []; const params: unknown[] = [];
    if (req.query.materialId) { where.push('r.iqc_material_id = ?'); params.push(Number(req.query.materialId)); }
    if (req.query.status) { where.push('r.status = ?'); params.push(String(req.query.status)); }
    if (req.query.from) { where.push('r.run_date >= ?'); params.push(String(req.query.from)); }
    if (req.query.to) { where.push('r.run_date <= ?'); params.push(String(req.query.to)); }
    if (req.query.pendingReview === '1') where.push('r.reviewed_at IS NULL');
    let q = `SELECT r.*, m.material_name, m.lot_number, m.test_name, m.control_type, m.level_label,
        e.name AS equipment_name, s.full_name AS operator_name, rev.full_name AS reviewed_by
      FROM iqc_runs r
      JOIN iqc_materials m ON m.id = r.iqc_material_id
      LEFT JOIN equipment_items e ON e.id = r.equipment_id
      LEFT JOIN staff s ON s.id = r.operator_staff_id
      LEFT JOIN staff rev ON rev.id = r.reviewed_by_staff_id`;
    if (where.length) q += ` WHERE ${where.join(' AND ')}`;
    q += ' ORDER BY r.run_date DESC, r.id DESC LIMIT 500';
    res.json(db.prepare(q).all(...params));
  });

  router.get('/runs/:id', requirePermission('iqc', 'view'), (req, res) => {
    const db = getDb();
    const run = db.prepare(`SELECT r.*, m.material_name, m.lot_number, m.test_name, m.control_type, m.rule_profile,
        m.level_label, m.source, e.name AS equipment_name, s.full_name AS operator_name, rev.full_name AS reviewed_by
      FROM iqc_runs r JOIN iqc_materials m ON m.id = r.iqc_material_id
      LEFT JOIN equipment_items e ON e.id = r.equipment_id
      LEFT JOIN staff s ON s.id = r.operator_staff_id
      LEFT JOIN staff rev ON rev.id = r.reviewed_by_staff_id
      WHERE r.id = ?`).get(req.params.id);
    if (!run) return res.status(404).json({ error: 'Control run not found' });
    const readings = db.prepare(`SELECT res.*, a.analyte, a.unit, a.target_mean, a.target_sd, a.acceptable_low, a.acceptable_high, a.decimal_places,
        a.ast_method, a.expected_interpretation
      FROM iqc_results res LEFT JOIN iqc_analytes a ON a.id = res.iqc_analyte_id
      WHERE res.iqc_run_id = ? ORDER BY a.display_order, res.id`).all(req.params.id);
    res.json({ ...run, readings });
  });

  /**
   * Record a control run. The rules that apply come from the material, so the
   * same call works for an eight-parameter FBC control and a single reactive
   * HBsAg control — the caller supplies readings, not judgements.
   */
  router.post('/runs', requirePermission('iqc', 'create'), (req, res) => {
    const db = getDb();
    const materialId = parseIntNullable(req.body?.iqcMaterialId);
    if (!materialId) return res.status(400).json({ error: 'iqcMaterialId is required' });
    const material = db.prepare('SELECT * FROM iqc_materials WHERE id = ?').get(materialId) as MaterialRow | undefined;
    if (!material) return res.status(404).json({ error: 'IQC material not found' });
    if (material.is_active !== 1) return res.status(400).json({ error: 'That control material is no longer active.' });

    const runDate = String(req.body?.runDate ?? '').trim() || new Date().toISOString().slice(0, 10);
    if (material.expiry_date && material.expiry_date < runDate) {
      return res.status(400).json({ error: `That control lot expired on ${material.expiry_date}. Use a current lot.` });
    }

    const isCs = material.control_type === 'culture_sensitivity';
    const observedOrganism = isCs ? (String(req.body?.observedOrganism ?? '').trim() || null) : null;

    // The limits the run is judged against are the effective ones: what a human
    // entered where they entered it, and otherwise what this laboratory has
    // established from its own runs of this lot. A control whose vendor gave no
    // SD is still judged, on the laboratory's own imprecision, exactly as ISO
    // 15189 §7.3.7.2 intends — instead of passing everything by default.
    const analytes = (db.prepare('SELECT * FROM iqc_analytes WHERE iqc_material_id = ? AND is_active = 1 ORDER BY display_order, id').all(materialId) as any[])
      .map(withEffectiveTarget) as AnalyteDef[];
    // An identification-only C&S control has no antimicrobial panel — it is run
    // on the organism alone, so the "must have analytes" rule is lifted for it.
    if (analytes.length === 0 && !isCs) return res.status(400).json({ error: 'This control has no analytes defined yet. Define what it measures first.' });

    const readings = Array.isArray(req.body?.readings) ? req.body.readings : [];
    if (readings.length === 0 && !(isCs && observedOrganism)) {
      return res.status(400).json({ error: isCs ? 'Record the organism identified and/or at least one susceptibility category.' : 'Enter at least one reading.' });
    }

    // Prior accepted readings per analyte, most recent first — the history the
    // run-length rules need. Rejected runs are excluded: they were investigated
    // and repeated, so counting them would re-flag work already closed out.
    const history: History = {};
    const priorStmt = db.prepare(`SELECT res.result_value FROM iqc_results res
      JOIN iqc_runs r ON r.id = res.iqc_run_id
      WHERE res.iqc_analyte_id = ? AND r.status != 'out_of_control' AND r.run_date <= ?
      ORDER BY r.run_date DESC, r.id DESC LIMIT 12`);
    for (const a of analytes) {
      const rows = priorStmt.all(a.id, runDate) as { result_value: number }[];
      const mean = a.target_mean, sd = a.target_sd;
      history[a.id] = (mean !== null && sd !== null && sd > 0)
        ? rows.map(r => (r.result_value - mean) / sd)
        : [];
    }

    const expectedOrganism = (material as MaterialRow & { expected_organism?: string | null }).expected_organism ?? null;
    const verdict = evaluateRun(material.control_type, material.rule_profile, analytes, readings, history,
      isCs ? { expected: expectedOrganism, observed: observedOrganism } : undefined);

    const createdAt = new Date().toISOString();
    // The run number lands in a UNIQUE column, so derive it collision-safely.
    const runNumber = generateRecordNumber(db, 'iqc_runs', 'QCR', createdAt, 'run_number');
    const operatorStaffId = getStaffIdOrCurrent(req, req.body?.operatorStaffId);

    let runId = 0;
    const tx = db.transaction(() => {
      const r = db.prepare(`INSERT INTO iqc_runs (run_number, iqc_material_id, run_date, run_time, shift, equipment_id,
          section_id, operator_staff_id, reagent_lot, status, rule_summary, patient_results_released, comment, observed_organism, created_by)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(runNumber, materialId, runDate, req.body?.runTime ?? null, req.body?.shift ?? null,
          parseIntNullable(req.body?.equipmentId), parseIntNullable(req.body?.sectionId), operatorStaffId,
          req.body?.reagentLot ?? null, verdict.status, verdict.ruleSummary,
          verdict.mayReleasePatientResults ? 1 : 0, req.body?.comment ?? null, observedOrganism, req.user!.id);
      runId = Number(r.lastInsertRowid);

      const insert = db.prepare(`INSERT INTO iqc_results (iqc_material_id, iqc_run_id, iqc_analyte_id, run_date, run_time,
          result_value, qualitative_result, expected_result, is_qualitative, interpretation_result, entered_by_staff_id, equipment_id,
          status, rule_violation, z_score, comment, created_by)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const v of verdict.analytes) {
        // The organism check rides as a synthetic verdict with analyteId 0; it
        // is recorded on the run itself, not as an analyte reading, so skip it.
        if (!v.analyteId) continue;
        const qualitative = !isCs && v.qualitativeResult !== null && v.qualitativeResult !== undefined;
        insert.run(materialId, runId, v.analyteId, runDate, req.body?.runTime ?? null,
          // result_value is NOT NULL in the original schema; a qualitative or
          // categorical reading stores 0 and carries its meaning elsewhere.
          v.value ?? 0,
          isCs ? null : v.qualitativeResult, v.expectedResult, qualitative ? 1 : 0,
          isCs ? v.qualitativeResult : null,
          operatorStaffId, parseIntNullable(req.body?.equipmentId),
          v.status, v.rule, v.zScore, null, req.user!.id);
      }
    });
    tx();

    // This run is one more point in the cumulative set. Recomputing here is
    // what makes the twentieth run the one that turns a control that could not
    // be judged into a control that can, on the day it happens rather than
    // whenever somebody next remembers to press a button.
    refreshEstablishedTargets(db, materialId, req.user!.id);

    audit(req, { action: 'create', entity: 'iqc_runs', entityId: runId, newValue: { runNumber, status: verdict.status, rule: verdict.ruleSummary } });
    res.status(201).json({ id: runId, runNumber, ...verdict, targets: currentTargets(db, materialId) });
  });

  /* ------------------------------------------------- establishing the target */

  /**
   * Establish this control's mean and SD from the laboratory's own runs.
   *
   * Runs by itself after every run, so this is here for the two moments a
   * person needs it: seeing where a control stands before it has enough data,
   * and deliberately recalculating after a change — a service, a new reagent
   * lot, a method adjustment — where the old limits no longer describe the
   * system. `force` is what makes that second case possible, and it is the only
   * thing that will overwrite a figure somebody typed in.
   */
  router.post('/materials/:id/establish-targets', requirePermission('iqc', 'edit'), (req, res) => {
    const db = getDb();
    const material = db.prepare('SELECT id, material_name, control_type FROM iqc_materials WHERE id = ?').get(req.params.id) as any;
    if (!material) return res.status(404).json({ error: 'Control not found' });
    if (material.control_type !== 'quantitative') {
      return res.status(400).json({ error: 'Only a quantitative control has a mean and SD to establish. A qualitative control is judged against the result it is expected to give.' });
    }
    const force = req.body?.force === true || req.body?.force === 'true';
    const outcomes = establishForMaterial(db, Number(req.params.id), { userId: req.user!.id, force });
    const changed = outcomes.filter(o => o.changed);
    if (changed.length) {
      audit(req, {
        action: 'edit', entity: 'iqc_analytes', entityId: req.params.id,
        newValue: { established: changed.map(o => ({ analyte: o.analyte, sd: o.target.sd, n: o.target.n, days: o.target.days, basis: o.target.basis })), force },
      });
    }
    res.json({ materialId: material.id, changed: changed.length, outcomes });
  });

  /** One analyte, for a panel where only one parameter needs re-establishing. */
  router.post('/analytes/:id/establish-targets', requirePermission('iqc', 'edit'), (req, res) => {
    const db = getDb();
    try {
      const force = req.body?.force === true || req.body?.force === 'true';
      const outcome = establishTargets(db, Number(req.params.id), { userId: req.user!.id, force });
      if (outcome.changed) {
        audit(req, {
          action: 'edit', entity: 'iqc_analytes', entityId: req.params.id,
          newValue: { sd: outcome.target.sd, n: outcome.target.n, days: outcome.target.days, basis: outcome.target.basis, force },
        });
      }
      res.json(outcome);
    } catch (e) { res.status(404).json({ error: (e as Error).message }); }
  });

  /**
   * How every analyte on a control stands: what it is judged against now, and
   * how far off a definitive set it is. This is what a unit head opens when the
   * chart says it cannot be drawn.
   */
  router.get('/materials/:id/targets', requirePermission('iqc', 'view'), (req, res) => {
    const db = getDb();
    const material = db.prepare('SELECT id, material_name, lot_number, control_type FROM iqc_materials WHERE id = ?').get(req.params.id) as any;
    if (!material) return res.status(404).json({ error: 'Control not found' });
    const analytes = db.prepare('SELECT * FROM iqc_analytes WHERE iqc_material_id = ? AND is_active = 1 ORDER BY display_order, id').all(req.params.id) as any[];
    const counted = db.prepare(`SELECT COUNT(*) AS n, COUNT(DISTINCT run_date) AS days FROM iqc_results
        WHERE iqc_analyte_id = ? AND COALESCE(is_qualitative, 0) != 1 AND status IN ('accepted', 'warning')`);
    res.json({
      material,
      requirement: { points: DEFINITIVE_POINTS, days: DEFINITIVE_DAYS, interimPoints: INTERIM_POINTS, interimDays: INTERIM_DAYS },
      analytes: analytes.map(a => {
        const usable = counted.get(a.id) as any;
        return {
          id: a.id, analyte: a.analyte, unit: a.unit, decimalPlaces: a.decimal_places,
          enteredMean: a.target_mean, enteredSd: a.target_sd,
          usableResults: Number(usable?.n ?? 0), usableDays: Number(usable?.days ?? 0),
          ...effectiveTarget(a),
        };
      }),
      canEstablish: true,
    });
  });

  /** What each analyte on a control is being judged against, and where it came from. */
  function currentTargets(db: any, materialId: number) {
    return (db.prepare('SELECT * FROM iqc_analytes WHERE iqc_material_id = ? AND is_active = 1 ORDER BY display_order, id').all(materialId) as any[])
      .map(a => ({ analyteId: a.id, analyte: a.analyte, ...effectiveTarget(a) }));
  }

  router.post('/runs/:id/review', requirePermission('iqc', 'approve'), (req, res) => {
    const db = getDb();
    const run = db.prepare('SELECT * FROM iqc_runs WHERE id = ?').get(req.params.id) as { id: number; status: string } | undefined;
    if (!run) return res.status(404).json({ error: 'Control run not found' });
    const staffId = getStaffIdOrCurrent(req, req.body?.reviewedByStaffId);
    // An out-of-control run may not simply be signed off: ISO 15189 §7.3.7.3
    // wants the action taken recorded, so the field is required here.
    if (run.status === 'out_of_control' && !String(req.body?.correctiveAction ?? '').trim()) {
      return res.status(400).json({ error: 'Record what was done about this failure before signing it off.' });
    }
    db.prepare(`UPDATE iqc_runs SET reviewed_by_staff_id = ?, reviewed_at = CURRENT_TIMESTAMP,
        corrective_action = COALESCE(?, corrective_action) WHERE id = ?`)
      .run(staffId, req.body?.correctiveAction ?? null, run.id);
    db.prepare('UPDATE iqc_results SET reviewed_by_staff_id = ?, reviewed_at = CURRENT_TIMESTAMP WHERE iqc_run_id = ?').run(staffId, run.id);
    audit(req, { action: 'review', entity: 'iqc_runs', entityId: run.id, newValue: { correctiveAction: req.body?.correctiveAction ?? null } });
    res.json({ ok: true });
  });

  /** The decision the run exists to support: do patient results go out? */
  router.post('/runs/:id/release', requirePermission('iqc', 'approve'), (req, res) => {
    const db = getDb();
    const run = db.prepare('SELECT id FROM iqc_runs WHERE id = ?').get(req.params.id);
    if (!run) return res.status(404).json({ error: 'Control run not found' });
    const released = req.body?.released === true || req.body?.released === 'true';
    if (!released && !String(req.body?.note ?? '').trim()) {
      return res.status(400).json({ error: 'Say why patient results are being withheld.' });
    }
    db.prepare('UPDATE iqc_runs SET patient_results_released = ?, release_decision_note = ? WHERE id = ?')
      .run(released ? 1 : 0, req.body?.note ?? null, req.params.id);
    audit(req, { action: released ? 'release_results' : 'withhold_results', entity: 'iqc_runs', entityId: req.params.id, newValue: { note: req.body?.note ?? null } });
    res.json({ ok: true });
  });

  /* --------------------------------------------------- Levey-Jennings chart */

  /**
   * Everything the chart needs, computed server-side so the same numbers appear
   * on screen, in an export and in a report: the points, the target lines, the
   * observed statistics, and the lot changes that explain a step in the series.
   */
  router.get('/analytes/:id/chart', requirePermission('iqc', 'view'), (req, res) => {
    const db = getDb();
    const analyte = db.prepare(`SELECT a.*, m.material_name, m.lot_number, m.test_name, m.control_type,
        m.level_label, m.source, m.id AS material_id
      FROM iqc_analytes a JOIN iqc_materials m ON m.id = a.iqc_material_id WHERE a.id = ?`).get(req.params.id) as
      (AnalyteDef & { material_id: number; material_name: string; lot_number: string; test_name: string; control_type: string; level_label: string | null; source: string; decimal_places: number }) | undefined;
    if (!analyte) return res.status(404).json({ error: 'Analyte not found' });

    const limit = Math.min(Math.max(Number(req.query.limit) || 120, 10), 500);
    const where: string[] = ['res.iqc_analyte_id = ?']; const params: unknown[] = [req.params.id];
    if (req.query.from) { where.push('res.run_date >= ?'); params.push(String(req.query.from)); }
    if (req.query.to) { where.push('res.run_date <= ?'); params.push(String(req.query.to)); }

    const rows = db.prepare(`SELECT res.id, res.run_date, res.run_time, res.result_value, res.qualitative_result,
        res.expected_result, res.is_qualitative, res.z_score, res.status, res.rule_violation,
        r.id AS run_id, r.run_number, r.equipment_id, e.name AS equipment_name, s.full_name AS operator_name
      FROM iqc_results res
      LEFT JOIN iqc_runs r ON r.id = res.iqc_run_id
      LEFT JOIN equipment_items e ON e.id = res.equipment_id
      LEFT JOIN staff s ON s.id = res.entered_by_staff_id
      WHERE ${where.join(' AND ')}
      ORDER BY res.run_date DESC, res.id DESC LIMIT ?`).all(...params, limit) as Record<string, unknown>[];

    const points = rows.reverse();
    const numeric = points.filter(p => Number(p.is_qualitative) !== 1).map(p => Number(p.result_value)).filter(v => !Number.isNaN(v));
    // What the chart is drawn against: the vendor's pair where one was entered,
    // and otherwise this laboratory's own established SD. The chart says which,
    // because "±0.4 g/dL, established here from 24 runs over 22 days" and
    // "±0.4 g/dL, off the insert" are not the same claim.
    const target = effectiveTarget(analyte);
    const stats = chartStatistics(numeric, target.mean, target.sd);

    // Lot changes for the parent material, so a step in the series has a
    // visible cause rather than looking like a fault.
    const lotChanges = db.prepare(`SELECT change_date, reason FROM iqc_lot_changes
      WHERE old_iqc_material_id = ? OR new_iqc_material_id = ? ORDER BY change_date`).all(analyte.material_id, analyte.material_id);

    res.json({
      analyte: {
        id: analyte.id, name: analyte.analyte, unit: analyte.unit, decimalPlaces: analyte.decimal_places,
        targetMean: target.mean, targetSd: target.sd,
        // What was actually entered on the definition, kept separate so the
        // chart can show a vendor mean beside a laboratory-established SD.
        enteredMean: analyte.target_mean, enteredSd: analyte.target_sd,
        acceptableLow: analyte.acceptable_low, acceptableHigh: analyte.acceptable_high,
        expectedResult: analyte.expected_result,
      },
      target,
      material: {
        id: analyte.material_id, name: analyte.material_name, lotNumber: analyte.lot_number,
        testName: analyte.test_name, controlType: analyte.control_type,
        levelLabel: analyte.level_label, source: analyte.source,
      },
      statistics: stats,
      lotChanges,
      points,
    });
  });

  return router;
}
