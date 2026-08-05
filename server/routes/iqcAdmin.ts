/**
 * Correcting the control record.
 *
 * Two different things live here, and they are deliberately not governed the
 * same way.
 *
 * A control's DEFINITION is ordinary editable data: a lot's expiry was typed
 * wrong, the manufacturer's insert gives a tighter SD, an analyte was left out.
 * Anyone with edit rights on IQC may fix it, with the guard rails that keep the
 * fix honest — a lot that already has runs cannot change what kind of control it
 * is, and moving the statistical target on such a lot has to say why, because
 * every z-score already recorded was measured against the old one.
 *
 * A control RUN is a quality record. It says what the instrument did on a day
 * and whether patient results could go out, and somebody may have acted on it.
 * Changing or removing one is not a permission a laboratory hands out; it is an
 * administrator override, it must give a reason, and the audit trail keeps what
 * was there before. ISO 15189 §8.4 wants exactly that: amendable, but never
 * quietly.
 *
 *   PUT    /iqc/materials/:id                 edit the control's parameters
 *   GET    /iqc/materials/:id/deletion-impact what removing it would cost
 *   DELETE /iqc/materials/:id?mode=…          retire it, or (admin) erase it
 *   POST   /iqc/materials/:id/reactivate      put a retired lot back in use
 *   PUT    /iqc/runs/:id                      administrator only — correct a run
 *   DELETE /iqc/runs/:id                      administrator only — remove a run
 */
import { Router } from 'express';
import { getDb } from '../db/database.js';
import { requirePermission } from '../middleware/permissions.js';
import { requireAdministrator, requiredReason, isAdministrator } from '../middleware/administrator.js';
import { audit } from '../services/auditService.js';
import { parseIntNullable, getStaffIdOrCurrent } from './routeHelpers.js';
import { evaluateRun, type AnalyteDef, type History } from '../services/iqcEvaluation.js';
import {
  IQC_SOURCES, IQC_CONTROL_TYPES, IQC_FREQUENCIES, IQC_RULE_PROFILES,
  QUALITATIVE_OUTCOMES, PROFILES_FOR_TYPE,
  type IqcControlType, type IqcRuleProfile,
} from '../../shared/constants/iqc.js';

const num = (v: unknown) => (v === '' || v === null || v === undefined || Number.isNaN(Number(v)) ? null : Number(v));
/** Take the caller's value when they sent the field at all, otherwise keep what is stored. */
const given = <T>(sent: unknown, current: T): T | string | null =>
  sent === undefined ? current : (sent === '' ? null : (sent as string));

export function iqcAdminRoutes() {
  const router = Router();

  /* ================================================== the control definition */

  /**
   * Edit a control's parameters.
   *
   * Everything the New Control form asks for can be corrected here, analytes
   * included, in one call — the form submits a whole control, not a field at a
   * time. What it will not do is let an edit rewrite the meaning of results
   * already recorded against the lot.
   */
  router.put('/materials/:id', requirePermission('iqc', 'edit'), (req, res) => {
    const db = getDb();
    const before = db.prepare('SELECT * FROM iqc_materials WHERE id = ?').get(req.params.id) as Record<string, any> | undefined;
    if (!before) return res.status(404).json({ error: 'Control material not found' });

    const runCount = (db.prepare('SELECT COUNT(*) AS n FROM iqc_runs WHERE iqc_material_id = ?').get(req.params.id) as { n: number }).n;

    const source = String(given(req.body?.source, before.source) ?? 'commercial').toLowerCase();
    if (!IQC_SOURCES.includes(source as never)) {
      return res.status(400).json({ error: `Source must be ${IQC_SOURCES.join(' or ')}.` });
    }
    const controlType = String(given(req.body?.controlType, before.control_type) ?? 'quantitative').toLowerCase() as IqcControlType;
    if (!IQC_CONTROL_TYPES.includes(controlType)) {
      return res.status(400).json({ error: `Control type must be one of: ${IQC_CONTROL_TYPES.join(', ')}.` });
    }
    // A lot that has been run cannot change what kind of result it gives. Its
    // recorded readings were judged as numbers or as matches, and reinterpreting
    // them the other way would make the history say something it never said.
    if (runCount > 0 && controlType !== before.control_type) {
      return res.status(400).json({
        error: `This lot already has ${runCount} recorded run(s) judged as a ${String(before.control_type).replace(/_/g, '-')} control, so its type cannot be changed. Retire it and register the corrected control as a new lot.`,
      });
    }

    let ruleProfile = String(given(req.body?.ruleProfile, before.rule_profile) ?? '').toLowerCase() as IqcRuleProfile;
    if (!IQC_RULE_PROFILES.includes(ruleProfile)) ruleProfile = PROFILES_FOR_TYPE[controlType][0];
    if (!PROFILES_FOR_TYPE[controlType].includes(ruleProfile)) ruleProfile = PROFILES_FOR_TYPE[controlType][0];

    const frequency = String(given(req.body?.qcFrequency, before.qc_frequency) ?? 'each_run').toLowerCase();
    const qcFrequency = IQC_FREQUENCIES.includes(frequency as never) ? frequency : 'each_run';

    const preparationMethod = given(req.body?.preparationMethod, before.preparation_method);
    if (source === 'in_house' && !String(preparationMethod ?? '').trim()) {
      return res.status(400).json({ error: 'An in-house control must record how it was prepared (ISO 15189 §7.3.7.2).' });
    }

    const materialName = String(given(req.body?.materialName, before.material_name) ?? '').trim();
    const lotNumber = String(given(req.body?.lotNumber, before.lot_number) ?? '').trim();
    const testName = String(given(req.body?.testName, before.test_name) ?? '').trim();
    if (!materialName || !lotNumber || !testName) {
      return res.status(400).json({ error: 'A control needs a name, a test and a lot number.' });
    }
    const clash = db.prepare('SELECT id FROM iqc_materials WHERE material_name = ? COLLATE NOCASE AND lot_number = ? COLLATE NOCASE AND id != ?')
      .get(materialName, lotNumber, req.params.id) as { id: number } | undefined;
    if (clash) return res.status(409).json({ error: `Another control is already registered as "${materialName}" lot ${lotNumber}.` });

    /* ---- analytes, if the caller sent them ---- */
    const sent = Array.isArray(req.body?.analytes) ? req.body.analytes as Record<string, unknown>[] : null;
    if (sent && sent.filter(a => String(a.analyte ?? '').trim()).length === 0) {
      return res.status(400).json({ error: 'A control has to measure something — keep at least one analyte.' });
    }
    if (sent && controlType === 'qualitative') {
      const missing = sent.filter(a => String(a.analyte ?? '').trim() && !String(a.expectedResult ?? '').trim());
      if (missing.length > 0) {
        return res.status(400).json({ error: `A qualitative control needs the result it is expected to give (${QUALITATIVE_OUTCOMES.join(', ')}) — missing for ${missing.map(a => a.analyte).join(', ')}.` });
      }
    }

    // Moving a target mean or SD on a lot that has been run changes what its
    // recorded z-scores meant. It is allowed — a manufacturer reissues a value
    // sheet, a lab establishes its own mean after 20 runs — but it has to say
    // why, and the answer to "why is the chart different" has to be on file.
    const analytesBefore = db.prepare('SELECT * FROM iqc_analytes WHERE iqc_material_id = ? ORDER BY display_order, id').all(req.params.id) as Record<string, any>[];
    let targetsMoved: string[] = [];
    if (sent) {
      const byName = new Map(analytesBefore.map(a => [String(a.analyte).toLowerCase(), a]));
      for (const a of sent) {
        const name = String(a.analyte ?? '').trim();
        const old = byName.get(name.toLowerCase());
        if (!old) continue;
        const movedMean = a.targetMean !== undefined && num(a.targetMean) !== old.target_mean;
        const movedSd = a.targetSd !== undefined && num(a.targetSd) !== old.target_sd;
        if (movedMean || movedSd) targetsMoved.push(name);
      }
    }
    const reason = requiredReason(req.body?.reason);
    if (targetsMoved.length > 0 && runCount > 0 && !reason) {
      return res.status(400).json({
        error: `Changing the target for ${targetsMoved.join(', ')} re-scales ${runCount} recorded run(s) on this lot. Say why (at least a sentence) before applying it.`,
        needsReason: true, targetsMoved, affectedRuns: runCount,
      });
    }

    const after = {
      material_name: materialName,
      test_name: testName,
      lot_number: lotNumber,
      level_label: given(req.body?.levelLabel, before.level_label),
      source, control_type: controlType, rule_profile: ruleProfile, qc_frequency: qcFrequency,
      manufacturer: given(req.body?.manufacturer, before.manufacturer),
      expiry_date: given(req.body?.expiryDate, before.expiry_date),
      open_vial_expiry: given(req.body?.openVialExpiry, before.open_vial_expiry),
      storage_condition: given(req.body?.storageCondition, before.storage_condition),
      section_id: req.body?.sectionId === undefined ? before.section_id : parseIntNullable(req.body.sectionId),
      equipment_id: req.body?.equipmentId === undefined ? before.equipment_id : parseIntNullable(req.body.equipmentId),
      prepared_by_staff_id: req.body?.preparedByStaffId === undefined ? before.prepared_by_staff_id : parseIntNullable(req.body.preparedByStaffId),
      preparation_date: given(req.body?.preparationDate, before.preparation_date),
      preparation_method: preparationMethod,
      base_material: given(req.body?.baseMaterial, before.base_material),
      validation_summary: given(req.body?.validationSummary, before.validation_summary),
      stability_period: given(req.body?.stabilityPeriod, before.stability_period),
      instructions: given(req.body?.instructions, before.instructions),
      is_active: req.body?.isActive === undefined ? before.is_active : (req.body.isActive ? 1 : 0),
    };

    let analyteChanges = { updated: 0, added: 0, retired: 0 };
    const tx = db.transaction(() => {
      db.prepare(`UPDATE iqc_materials SET material_name = ?, test_name = ?, lot_number = ?, level_label = ?,
          source = ?, control_type = ?, rule_profile = ?, qc_frequency = ?, manufacturer = ?, expiry_date = ?,
          open_vial_expiry = ?, storage_condition = ?, section_id = ?, equipment_id = ?, prepared_by_staff_id = ?,
          preparation_date = ?, preparation_method = ?, base_material = ?, validation_summary = ?,
          stability_period = ?, instructions = ?, is_active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .run(after.material_name, after.test_name, after.lot_number, after.level_label, after.source,
          after.control_type, after.rule_profile, after.qc_frequency, after.manufacturer, after.expiry_date,
          after.open_vial_expiry, after.storage_condition, after.section_id, after.equipment_id,
          after.prepared_by_staff_id, after.preparation_date, after.preparation_method, after.base_material,
          after.validation_summary, after.stability_period, after.instructions, after.is_active, req.params.id);

      if (!sent) return;
      const keep = new Set<number>();
      sent.forEach((a, i) => {
        const name = String(a.analyte ?? '').trim();
        if (!name) return;
        const expected = String(a.expectedResult ?? '').trim().toLowerCase() || null;
        const values = [
          a.unit ?? null, num(a.targetMean), num(a.targetSd), num(a.acceptableLow), num(a.acceptableHigh),
          num(a.decimalPlaces) ?? 2, expected, i, a.isActive === false ? 0 : 1,
        ];
        const existing = db.prepare('SELECT id FROM iqc_analytes WHERE iqc_material_id = ? AND analyte = ? COLLATE NOCASE')
          .get(req.params.id, name) as { id: number } | undefined;
        if (existing) {
          db.prepare(`UPDATE iqc_analytes SET unit = ?, target_mean = ?, target_sd = ?, acceptable_low = ?,
            acceptable_high = ?, decimal_places = ?, expected_result = ?, display_order = ?, is_active = ? WHERE id = ?`)
            .run(...values, existing.id);
          keep.add(existing.id); analyteChanges.updated++;
        } else {
          const r = db.prepare(`INSERT INTO iqc_analytes (iqc_material_id, analyte, unit, target_mean, target_sd,
            acceptable_low, acceptable_high, decimal_places, expected_result, display_order, is_active)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(req.params.id, name, ...values);
          keep.add(Number(r.lastInsertRowid)); analyteChanges.added++;
        }
      });
      // An analyte dropped from the list stops being measured. If it has
      // readings it is retired, never deleted — those readings and their chart
      // are the laboratory's record. If it has none, it was a mistake and goes.
      for (const a of analytesBefore) {
        if (keep.has(a.id)) continue;
        const used = (db.prepare('SELECT COUNT(*) AS n FROM iqc_results WHERE iqc_analyte_id = ?').get(a.id) as { n: number }).n;
        if (used > 0) { db.prepare('UPDATE iqc_analytes SET is_active = 0 WHERE id = ?').run(a.id); analyteChanges.retired++; }
        else db.prepare('DELETE FROM iqc_analytes WHERE id = ?').run(a.id);
      }
    });
    tx();

    audit(req, {
      action: 'edit', entity: 'iqc_materials', entityId: req.params.id,
      oldValue: { material: before, analytes: analytesBefore },
      newValue: { material: after, analytes: analyteChanges, targetsMoved, reason: reason ?? null },
    });
    res.json({
      ok: true,
      analytes: db.prepare('SELECT * FROM iqc_analytes WHERE iqc_material_id = ? ORDER BY display_order, id').all(req.params.id),
      targetsMoved,
      affectedRuns: targetsMoved.length > 0 ? runCount : 0,
      analyteChanges,
    });
  });

  /* ------------------------------------------------------ removing a control */

  /** What is attached to this lot, so the choice to retire or erase is informed. */
  router.get('/materials/:id/deletion-impact', requirePermission('iqc', 'view'), (req, res) => {
    const db = getDb();
    const material = db.prepare('SELECT * FROM iqc_materials WHERE id = ?').get(req.params.id) as Record<string, any> | undefined;
    if (!material) return res.status(404).json({ error: 'Control material not found' });
    const one = (sql: string) => (db.prepare(sql).get(req.params.id) as { n: number }).n;
    const runs = one('SELECT COUNT(*) AS n FROM iqc_runs WHERE iqc_material_id = ?');
    const results = one('SELECT COUNT(*) AS n FROM iqc_results WHERE iqc_material_id = ?');
    const analytes = one('SELECT COUNT(*) AS n FROM iqc_analytes WHERE iqc_material_id = ?');
    const lotChanges = (db.prepare('SELECT COUNT(*) AS n FROM iqc_lot_changes WHERE old_iqc_material_id = ? OR new_iqc_material_id = ?')
      .get(req.params.id, req.params.id) as { n: number }).n;
    const linked = (db.prepare('SELECT COUNT(*) AS n FROM iqc_runs WHERE iqc_material_id = ? AND (nc_id IS NOT NULL OR capa_id IS NOT NULL)')
      .get(req.params.id) as { n: number }).n;
    const range = db.prepare('SELECT MIN(run_date) AS first, MAX(run_date) AS last FROM iqc_runs WHERE iqc_material_id = ?')
      .get(req.params.id) as { first: string | null; last: string | null };
    res.json({
      material: { id: material.id, name: material.material_name, lotNumber: material.lot_number, isActive: Number(material.is_active) === 1 },
      runs, results, analytes, lotChanges, linkedToInvestigations: linked,
      firstRun: range.first, lastRun: range.last,
      // Retiring is always available and always safe. Erasing destroys quality
      // records, so it is offered only when there is no history to destroy —
      // and even then only to an administrator.
      canDeleteOutright: runs === 0 && results === 0 && linked === 0,
      recommendation: runs > 0 ? 'retire' : 'delete',
    });
  });

  /**
   * Remove a control.
   *
   * `retire` is the normal answer: the lot stops being offered for new runs and
   * everything it ever produced stays on the record. `delete` erases it, which
   * is only for a lot registered by mistake — it needs an administrator, a
   * reason, and no history behind it.
   */
  router.delete('/materials/:id', requirePermission('iqc', 'void_archive'), (req, res) => {
    const db = getDb();
    const material = db.prepare('SELECT * FROM iqc_materials WHERE id = ?').get(req.params.id) as Record<string, any> | undefined;
    if (!material) return res.status(404).json({ error: 'Control material not found' });
    const mode = String(req.query.mode ?? 'retire');

    if (mode === 'retire') {
      db.prepare('UPDATE iqc_materials SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(req.params.id);
      audit(req, { action: 'retire', entity: 'iqc_materials', entityId: req.params.id, oldValue: material, newValue: { is_active: 0, reason: String(req.body?.reason ?? '').trim() || null } });
      return res.json({ ok: true, mode: 'retired', message: `${material.material_name} lot ${material.lot_number} is retired. Its runs and charts remain on the record.` });
    }

    if (mode !== 'delete') return res.status(400).json({ error: "mode must be 'retire' or 'delete'" });

    // Erasing is an administrator override — the permission matrix does not
    // grant it, because destroying quality records is not routine work.
    if (!isAdministrator(req.user!.id)) {
      return res.status(403).json({ error: 'Only an administrator may erase a control material. Retire it instead — that keeps its runs on the record.', administratorOnly: true });
    }

    const reason = requiredReason(req.body?.reason);
    if (!reason) return res.status(400).json({ error: 'Say why this control is being erased (at least a sentence). The reason is kept in the audit trail.', needsReason: true });

    const runs = (db.prepare('SELECT COUNT(*) AS n FROM iqc_runs WHERE iqc_material_id = ?').get(req.params.id) as { n: number }).n;
    const linked = (db.prepare('SELECT COUNT(*) AS n FROM iqc_runs WHERE iqc_material_id = ? AND (nc_id IS NOT NULL OR capa_id IS NOT NULL)').get(req.params.id) as { n: number }).n;
    if (linked > 0) {
      return res.status(409).json({ error: `${linked} run(s) on this lot are attached to a nonconformity or CAPA. Those investigations reference them, so the lot cannot be erased — retire it instead.` });
    }
    if (runs > 0 && req.query.force !== '1') {
      return res.status(409).json({
        error: `This lot has ${runs} recorded run(s). Erasing it destroys that quality record. Retire it instead, or repeat with force=1 if it was registered in error.`,
        runs, needsForce: true,
      });
    }

    const analytes = db.prepare('SELECT * FROM iqc_analytes WHERE iqc_material_id = ?').all(req.params.id);
    let removed = { runs: 0, results: 0, analytes: 0, lotChanges: 0 };
    const tx = db.transaction(() => {
      removed.results = db.prepare('DELETE FROM iqc_results WHERE iqc_material_id = ?').run(req.params.id).changes;
      removed.runs = db.prepare('DELETE FROM iqc_runs WHERE iqc_material_id = ?').run(req.params.id).changes;
      removed.analytes = db.prepare('DELETE FROM iqc_analytes WHERE iqc_material_id = ?').run(req.params.id).changes;
      removed.lotChanges = db.prepare('DELETE FROM iqc_lot_changes WHERE old_iqc_material_id = ? OR new_iqc_material_id = ?').run(req.params.id, req.params.id).changes;
      db.prepare('DELETE FROM iqc_materials WHERE id = ?').run(req.params.id);
    });
    tx();

    // The audit entry carries the whole record, so what was erased is still
    // answerable for even though the rows are gone.
    audit(req, { action: 'delete', entity: 'iqc_materials', entityId: req.params.id, oldValue: { material, analytes }, newValue: { removed, reason } });
    res.json({ ok: true, mode: 'deleted', removed, message: `${material.material_name} lot ${material.lot_number} was erased. The audit trail keeps what it contained.` });
  });

  /** Put a retired lot back in use — a lot retired by mistake, or one back in date. */
  router.post('/materials/:id/reactivate', requirePermission('iqc', 'edit'), (req, res) => {
    const db = getDb();
    const material = db.prepare('SELECT * FROM iqc_materials WHERE id = ?').get(req.params.id) as Record<string, any> | undefined;
    if (!material) return res.status(404).json({ error: 'Control material not found' });
    db.prepare('UPDATE iqc_materials SET is_active = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(req.params.id);
    audit(req, { action: 'reactivate', entity: 'iqc_materials', entityId: req.params.id, oldValue: { is_active: material.is_active }, newValue: { is_active: 1 } });
    const expired = material.expiry_date && String(material.expiry_date) < new Date().toISOString().slice(0, 10);
    res.json({ ok: true, warning: expired ? `That lot expired on ${material.expiry_date}, so it still cannot be run.` : null });
  });

  /* ================================================ correcting a control run */

  /**
   * Correct a run — administrator only.
   *
   * A reading typed into the wrong analyte, a run recorded against yesterday's
   * date, a decimal point in the wrong place. The correction is not just stored:
   * the run goes back through the same evaluation as a fresh one, so its
   * outcome, its rules and its patient-results decision follow from the numbers
   * that are now on file rather than the ones that were there before. A run that
   * had been signed off returns to unreviewed, because the thing that was signed
   * has changed.
   */
  router.put('/runs/:id', requireAdministrator('correct a control run'), (req, res) => {
    const db = getDb();
    const before = db.prepare('SELECT * FROM iqc_runs WHERE id = ?').get(req.params.id) as Record<string, any> | undefined;
    if (!before) return res.status(404).json({ error: 'Control run not found' });

    const reason = requiredReason(req.body?.reason);
    if (!reason) return res.status(400).json({ error: 'Say why this run is being corrected (at least a sentence). The reason is kept in the audit trail.', needsReason: true });

    const material = db.prepare('SELECT * FROM iqc_materials WHERE id = ?').get(before.iqc_material_id) as Record<string, any> | undefined;
    if (!material) return res.status(409).json({ error: 'This run belongs to a control that no longer exists.' });

    const runDate = String(given(req.body?.runDate, before.run_date) ?? '').trim() || before.run_date;
    const runTime = given(req.body?.runTime, before.run_time);
    const equipmentId = req.body?.equipmentId === undefined ? before.equipment_id : parseIntNullable(req.body.equipmentId);
    const operatorStaffId = req.body?.operatorStaffId === undefined ? before.operator_staff_id : getStaffIdOrCurrent(req, req.body.operatorStaffId);

    // Every analyte of this control, retired ones included. A run recorded
    // before an analyte was retired still carries its reading, and correcting
    // that run must not refuse or silently drop it.
    const analytes = db.prepare('SELECT * FROM iqc_analytes WHERE iqc_material_id = ? ORDER BY display_order, id')
      .all(before.iqc_material_id) as AnalyteDef[];
    const readingsBefore = db.prepare('SELECT * FROM iqc_results WHERE iqc_run_id = ? ORDER BY id').all(req.params.id) as Record<string, any>[];

    // Readings are optional: an edit may only be fixing the date or the
    // instrument, in which case the numbers stand as recorded.
    const sent = Array.isArray(req.body?.readings) ? req.body.readings as Record<string, unknown>[] : null;
    const readings = sent
      ? sent.map(r => ({
          analyteId: Number(r.analyteId),
          value: r.value === undefined || r.value === null || r.value === '' ? undefined : Number(r.value),
          qualitativeResult: (r.qualitativeResult as string) || undefined,
        })).filter(r => Number.isFinite(r.analyteId))
      : readingsBefore.map(r => ({
          analyteId: Number(r.iqc_analyte_id),
          value: Number(r.is_qualitative) === 1 ? undefined : Number(r.result_value),
          qualitativeResult: Number(r.is_qualitative) === 1 ? String(r.qualitative_result) : undefined,
        })).filter(r => Number.isFinite(r.analyteId));

    if (readings.length === 0) return res.status(400).json({ error: 'A run has to keep at least one reading.' });
    const known = new Set(analytes.map(a => a.id));
    const stray = readings.filter(r => !known.has(r.analyteId));
    if (stray.length > 0) return res.status(400).json({ error: `Reading(s) for analyte id ${stray.map(s => s.analyteId).join(', ')} do not belong to this control.` });
    if (material.control_type === 'qualitative') {
      const bad = readings.filter(r => !r.qualitativeResult || !QUALITATIVE_OUTCOMES.includes(r.qualitativeResult as never));
      if (bad.length > 0) return res.status(400).json({ error: `Every reading needs one of: ${QUALITATIVE_OUTCOMES.join(', ')}.` });
    } else {
      const bad = readings.filter(r => r.value === undefined || Number.isNaN(r.value));
      if (bad.length > 0) return res.status(400).json({ error: 'Every reading needs a number.' });
    }

    // History for the rules, taken as it stands excluding this run itself — a
    // run must never be judged against its own former self.
    const history: History = {};
    const priorStmt = db.prepare(`SELECT res.result_value FROM iqc_results res
      JOIN iqc_runs r ON r.id = res.iqc_run_id
      WHERE res.iqc_analyte_id = ? AND r.id != ? AND r.status != 'out_of_control' AND r.run_date <= ?
      ORDER BY r.run_date DESC, r.id DESC LIMIT 12`);
    for (const a of analytes) {
      const prior = priorStmt.all(a.id, req.params.id, runDate) as { result_value: number }[];
      history[a.id] = (a.target_mean !== null && a.target_sd !== null && a.target_sd > 0)
        ? prior.map(p => (p.result_value - a.target_mean!) / a.target_sd!)
        : [];
    }

    const verdict = evaluateRun(material.control_type as IqcControlType, material.rule_profile as IqcRuleProfile, analytes, readings, history);

    const tx = db.transaction(() => {
      db.prepare(`UPDATE iqc_runs SET run_date = ?, run_time = ?, shift = ?, equipment_id = ?, operator_staff_id = ?,
          reagent_lot = ?, comment = ?, status = ?, rule_summary = ?, patient_results_released = ?,
          reviewed_by_staff_id = NULL, reviewed_at = NULL WHERE id = ?`)
        .run(runDate, runTime, given(req.body?.shift, before.shift), equipmentId, operatorStaffId,
          given(req.body?.reagentLot, before.reagent_lot), given(req.body?.comment, before.comment),
          verdict.status, verdict.ruleSummary, verdict.mayReleasePatientResults ? 1 : 0, req.params.id);

      db.prepare('DELETE FROM iqc_results WHERE iqc_run_id = ?').run(req.params.id);
      const insert = db.prepare(`INSERT INTO iqc_results (iqc_material_id, iqc_run_id, iqc_analyte_id, run_date, run_time,
          result_value, qualitative_result, expected_result, is_qualitative, entered_by_staff_id, equipment_id,
          status, rule_violation, z_score, created_by)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const v of verdict.analytes) {
        const qualitative = v.qualitativeResult !== null && v.qualitativeResult !== undefined;
        insert.run(before.iqc_material_id, req.params.id, v.analyteId, runDate, runTime,
          v.value ?? 0, v.qualitativeResult, v.expectedResult, qualitative ? 1 : 0,
          operatorStaffId, equipmentId, v.status, v.rule, v.zScore, req.user!.id);
      }
    });
    tx();

    audit(req, {
      action: 'correct', entity: 'iqc_runs', entityId: req.params.id,
      oldValue: { run: before, readings: readingsBefore },
      newValue: { status: verdict.status, ruleSummary: verdict.ruleSummary, readings: verdict.analytes, reason },
    });
    res.json({
      ok: true, ...verdict,
      reviewCleared: !!before.reviewed_at,
      message: before.reviewed_at
        ? 'Run corrected. It was already signed off, so it has gone back to awaiting review.'
        : 'Run corrected and re-evaluated.',
    });
  });

  /**
   * Remove a run — administrator only.
   *
   * For a run that should never have been recorded: a duplicate, a test entry,
   * a run logged against the wrong control. It is not the way to deal with a
   * failure — a failure is investigated, acted on and signed off, and deleting
   * it would erase the evidence that the laboratory noticed.
   */
  router.delete('/runs/:id', requireAdministrator('remove a control run'), (req, res) => {
    const db = getDb();
    const run = db.prepare(`SELECT r.*, m.material_name, m.lot_number FROM iqc_runs r
      LEFT JOIN iqc_materials m ON m.id = r.iqc_material_id WHERE r.id = ?`).get(req.params.id) as Record<string, any> | undefined;
    if (!run) return res.status(404).json({ error: 'Control run not found' });

    const reason = requiredReason(req.body?.reason);
    if (!reason) return res.status(400).json({ error: 'Say why this run is being removed (at least a sentence). The reason is kept in the audit trail.', needsReason: true });

    if (run.nc_id || run.capa_id) {
      return res.status(409).json({ error: 'This run is attached to a nonconformity or CAPA, which cites it as evidence. Close or detach that investigation first.' });
    }

    // Removing a run changes the run-length rules for everything after it: a
    // 10ₓ shift counted through this point no longer sees it. Say so, rather
    // than let a chart quietly change shape.
    const later = (db.prepare("SELECT COUNT(*) AS n FROM iqc_runs WHERE iqc_material_id = ? AND (run_date > ? OR (run_date = ? AND id > ?))")
      .get(run.iqc_material_id, run.run_date, run.run_date, run.id) as { n: number }).n;

    const readings = db.prepare('SELECT * FROM iqc_results WHERE iqc_run_id = ?').all(req.params.id);
    const tx = db.transaction(() => {
      db.prepare('DELETE FROM iqc_results WHERE iqc_run_id = ?').run(req.params.id);
      db.prepare('DELETE FROM iqc_runs WHERE id = ?').run(req.params.id);
    });
    tx();

    audit(req, { action: 'delete', entity: 'iqc_runs', entityId: req.params.id, oldValue: { run, readings }, newValue: { reason } });
    res.json({
      ok: true,
      removed: { readings: readings.length },
      subsequentRuns: later,
      message: later > 0
        ? `Run ${run.run_number} removed. ${later} later run(s) on this lot were judged with it in their history — their charts now read without it.`
        : `Run ${run.run_number} removed.`,
    });
  });

  return router;
}
