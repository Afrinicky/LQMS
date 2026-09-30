/**
 * Previously run samples, kept so a bench can still control an analyser when
 * the control material has run out.
 *
 *   GET    /iqc/materials/:id/retained-samples    the samples enrolled for a control
 *   GET    /iqc/materials/:id/retained-candidates what the analyser has sent that could be enrolled
 *   POST   /iqc/retained-samples                  enrol a sample and its original result
 *   GET    /iqc/retained-samples/:id              the sample, its original result and its traceability
 *   DELETE /iqc/retained-samples/:id              take it out of use
 *
 * The sample carries traceability rather than replacing it: every record names
 * the run that produced the original result and the control run that was in
 * control at the time, so a re-read can be followed back to control material.
 */
import { Router } from 'express';
import { getDb } from '../db/database.js';
import { requirePermission } from '../middleware/permissions.js';
import { mayActOnUnit } from '../services/unitLeadership.js';
import { audit } from '../services/auditService.js';
import { generateRecordNumber } from '../utils/recordNumber.js';
import { parseIntNullable } from './routeHelpers.js';

const num = (v: unknown) => (v === '' || v === null || v === undefined || Number.isNaN(Number(v)) ? null : Number(v));

export function iqcRetainedRoutes() {
  const router = Router();

  function controlSectionId(materialId: unknown): number | null {
    const row = getDb().prepare(`SELECT COALESCE(m.performing_section_id, m.section_id, e.section_id) AS resolved
        FROM iqc_materials m LEFT JOIN equipment_items e ON e.id = m.equipment_id WHERE m.id = ?`)
      .get(materialId) as { resolved: number | null } | undefined;
    return row?.resolved ?? null;
  }

  /** Enrolling and retiring a sample is the same right as running the control. */
  function retainedWrite(action: string, message: string) {
    return (req: any, res: any, next: any) => {
      const fromBody = parseIntNullable(req.body?.iqcMaterialId);
      const fromRecord = req.params?.id
        ? (getDb().prepare('SELECT iqc_material_id FROM iqc_retained_samples WHERE id = ?').get(req.params.id) as
            { iqc_material_id: number } | undefined)?.iqc_material_id ?? null
        : null;
      const materialId = fromBody ?? fromRecord;
      if (mayActOnUnit(req, 'iqc', action, controlSectionId(materialId))) return next();
      return res.status(403).json({ error: message });
    };
  }

  /** The original readings held for one sample, named so a screen can draw them. */
  function valuesFor(sampleId: number) {
    return getDb().prepare(`SELECT v.*, a.analyte, a.unit, a.decimal_places, a.display_order
      FROM iqc_retained_sample_values v
      JOIN iqc_analytes a ON a.id = v.iqc_analyte_id
      WHERE v.retained_sample_id = ? ORDER BY a.display_order, a.id`).all(sampleId);
  }

  /* --------------------------------------------------------------- register */

  router.get('/materials/:id/retained-samples', requirePermission('iqc', 'view'), (req, res) => {
    const db = getDb();
    const rows = db.prepare(`SELECT s.*, e.name AS equipment_name, sec.name AS section_name,
        orig.run_number AS original_run_number, orig.run_date AS original_control_date,
        orig.status AS original_control_status,
        (SELECT COUNT(*) FROM iqc_runs r WHERE r.retained_sample_id = s.id) AS rerun_count,
        (SELECT MAX(r.run_date) FROM iqc_runs r WHERE r.retained_sample_id = s.id) AS last_rerun_date
      FROM iqc_retained_samples s
      LEFT JOIN equipment_items e ON e.id = s.equipment_id
      LEFT JOIN sections sec ON sec.id = s.section_id
      LEFT JOIN iqc_runs orig ON orig.id = s.original_iqc_run_id
      WHERE s.iqc_material_id = ?${req.query.all === '1' ? '' : ' AND s.is_active = 1'}
      ORDER BY s.is_active DESC, s.original_run_date DESC, s.id DESC`).all(req.params.id) as any[];
    res.json(rows.map(r => ({ ...r, values: valuesFor(r.id) })));
  });

  router.get('/retained-samples/:id', requirePermission('iqc', 'view'), (req, res) => {
    const db = getDb();
    const sample = db.prepare(`SELECT s.*, e.name AS equipment_name, sec.name AS section_name,
        m.material_name, m.lot_number, m.test_name, m.control_type,
        m.continuity_tolerance_kind, m.continuity_tolerance_value,
        orig.run_number AS original_run_number, orig.run_date AS original_control_date,
        orig.run_time AS original_control_time, orig.status AS original_control_status,
        orig.rule_summary AS original_control_rule
      FROM iqc_retained_samples s
      JOIN iqc_materials m ON m.id = s.iqc_material_id
      LEFT JOIN equipment_items e ON e.id = s.equipment_id
      LEFT JOIN sections sec ON sec.id = s.section_id
      LEFT JOIN iqc_runs orig ON orig.id = s.original_iqc_run_id
      WHERE s.id = ?`).get(req.params.id) as any;
    if (!sample) return res.status(404).json({ error: 'That sample is not on the register.' });
    const reruns = db.prepare(`SELECT id, run_number, run_date, run_time, status, rule_summary, patient_results_released
      FROM iqc_runs WHERE retained_sample_id = ? ORDER BY run_date DESC, id DESC LIMIT 50`).all(sample.id);
    res.json({ ...sample, values: valuesFor(sample.id), reruns });
  });

  /**
   * The control runs a sample's original result can be traced to: this
   * control's own accepted runs, most recent first, so the bench picks the one
   * that covered the day the sample was first tested.
   */
  router.get('/materials/:id/retained-coverage', requirePermission('iqc', 'view'), (req, res) => {
    const db = getDb();
    const on = String(req.query.on ?? '').trim();
    const rows = db.prepare(`SELECT id, run_number, run_date, run_time, status, rule_summary
      FROM iqc_runs
      WHERE iqc_material_id = ? AND run_kind = 'control' AND status != 'out_of_control'
        ${on ? 'AND run_date <= ?' : ''}
      ORDER BY run_date DESC, id DESC LIMIT 30`).all(...(on ? [req.params.id, on] : [req.params.id]));
    res.json(rows);
  });

  /**
   * What the analyser has sent that could be enrolled as a previously run
   * sample. The same messages the instrument feed parks on the bench: reading
   * the original result off the analyser is more honest than typing it.
   */
  router.get('/materials/:id/retained-candidates', requirePermission('iqc', 'view'), (req, res) => {
    const db = getDb();
    const material = db.prepare('SELECT feed_id, equipment_id FROM iqc_materials WHERE id = ?').get(req.params.id) as
      { feed_id: number | null; equipment_id: number | null } | undefined;
    if (!material) return res.status(404).json({ error: 'IQC material not found' });
    const rows = db.prepare(`SELECT msg.id, msg.sample_id, msg.received_at, msg.instrument_run_at, msg.parsed_values,
        f.name AS feed_name
      FROM iqc_feed_messages msg
      LEFT JOIN iqc_instrument_feeds f ON f.id = msg.feed_id
      WHERE (? IS NULL OR msg.feed_id = ?)
      ORDER BY msg.received_at DESC LIMIT 40`).all(material.feed_id, material.feed_id) as any[];
    res.json(rows.map(r => {
      let parsed: unknown = [];
      try { parsed = r.parsed_values ? JSON.parse(r.parsed_values) : []; } catch { parsed = []; }
      return { ...r, parsed_values: parsed };
    }));
  });

  /* ------------------------------------------------------------- enrolment */

  router.post('/retained-samples', retainedWrite('create',
    'Enrolling a previously run sample needs the create right on Quality Control, or the running of the unit the control belongs to.'), (req, res) => {
    const db = getDb();
    const materialId = parseIntNullable(req.body?.iqcMaterialId);
    if (!materialId) return res.status(400).json({ error: 'Say which control this sample stands in for.' });
    const material = db.prepare('SELECT id, control_type, section_id, performing_section_id, equipment_id FROM iqc_materials WHERE id = ?')
      .get(materialId) as any;
    if (!material) return res.status(404).json({ error: 'IQC material not found' });

    const reference = String(req.body?.sampleReference ?? '').trim();
    if (!reference) return res.status(400).json({ error: 'Give the laboratory number the sample was reported under.' });
    const originalRunDate = String(req.body?.originalRunDate ?? '').trim();
    if (!originalRunDate) return res.status(400).json({ error: 'Say when the sample was originally tested.' });
    if (originalRunDate > new Date().toISOString().slice(0, 10)) {
      return res.status(400).json({ error: 'A sample cannot have been originally tested in the future.' });
    }

    const rows = Array.isArray(req.body?.values) ? req.body.values : [];
    const usable = rows.filter((v: any) => parseIntNullable(v?.analyteId)
      && (num(v?.originalValue) !== null || String(v?.originalQualitativeResult ?? '').trim()));
    if (usable.length === 0) return res.status(400).json({ error: 'Record what the sample originally gave for at least one parameter.' });

    const originalIqcRunId = parseIntNullable(req.body?.originalIqcRunId);
    if (originalIqcRunId) {
      const covering = db.prepare("SELECT id FROM iqc_runs WHERE id = ? AND iqc_material_id = ? AND status != 'out_of_control'")
        .get(originalIqcRunId, materialId);
      if (!covering) return res.status(400).json({ error: 'That control run does not belong to this control, or was itself rejected.' });
    }

    const createdAt = new Date().toISOString();
    const sampleCode = generateRecordNumber(db, 'iqc_retained_samples', 'QCS', createdAt, 'sample_code');
    const source = req.body?.source === 'instrument' ? 'instrument' : 'entered';

    let sampleId = 0;
    const tx = db.transaction(() => {
      const r = db.prepare(`INSERT INTO iqc_retained_samples (sample_code, iqc_material_id, sample_reference, sample_type,
          section_id, equipment_id, original_run_date, original_run_time, original_iqc_run_id, source, feed_message_id,
          reason, notes, created_by, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(sampleCode, materialId, reference, req.body?.sampleType ?? null,
          parseIntNullable(req.body?.sectionId) ?? material.performing_section_id ?? material.section_id,
          parseIntNullable(req.body?.equipmentId) ?? material.equipment_id,
          originalRunDate, req.body?.originalRunTime ?? null, originalIqcRunId, source,
          parseIntNullable(req.body?.feedMessageId), req.body?.reason ?? null, req.body?.notes ?? null,
          req.user!.id, createdAt);
      sampleId = Number(r.lastInsertRowid);

      const insert = db.prepare(`INSERT INTO iqc_retained_sample_values (retained_sample_id, iqc_analyte_id,
          original_value, original_qualitative_result, original_interpretation) VALUES (?, ?, ?, ?, ?)`);
      for (const v of usable) {
        const text = String(v?.originalQualitativeResult ?? '').trim() || null;
        insert.run(sampleId, parseIntNullable(v.analyteId), num(v?.originalValue),
          material.control_type === 'culture_sensitivity' ? null : text,
          material.control_type === 'culture_sensitivity' ? text : null);
      }
    });
    tx();

    audit(req, { action: 'create', entity: 'iqc_retained_samples', entityId: sampleId, newValue: { sampleCode, reference, materialId } });
    res.status(201).json({ id: sampleId, sampleCode });
  });

  router.delete('/retained-samples/:id', retainedWrite('edit',
    'Taking a sample out of use needs the edit right on Quality Control, or the running of the unit the control belongs to.'), (req, res) => {
    const db = getDb();
    const sample = db.prepare('SELECT * FROM iqc_retained_samples WHERE id = ?').get(req.params.id) as any;
    if (!sample) return res.status(404).json({ error: 'That sample is not on the register.' });
    // A sample that has been re-read is part of the record and is retired, not
    // erased; one that was never used was a mistake and goes.
    const used = (db.prepare('SELECT COUNT(*) AS n FROM iqc_runs WHERE retained_sample_id = ?').get(sample.id) as { n: number }).n;
    if (used > 0) db.prepare('UPDATE iqc_retained_samples SET is_active = 0 WHERE id = ?').run(sample.id);
    else {
      db.prepare('DELETE FROM iqc_retained_sample_values WHERE retained_sample_id = ?').run(sample.id);
      db.prepare('DELETE FROM iqc_retained_samples WHERE id = ?').run(sample.id);
    }
    audit(req, { action: used > 0 ? 'edit' : 'delete', entity: 'iqc_retained_samples', entityId: sample.id, oldValue: sample });
    res.json({ ok: true, retired: used > 0, reruns: used });
  });

  return router;
}
