/**
 * IQC, from the bench's point of view.
 *
 * The IQC module already knows how to define a control, judge a run against
 * Westgard and draw a Levey-Jennings chart. What it did not have was a way for
 * the person actually running the control to do it without leaving their
 * portal — so controls were defined in one place and never run, which is the
 * worst of both.
 *
 * This adds three things.
 *
 * A BOARD. Every control that belongs to the reader's unit, on the instruments
 * their unit runs, with one fact at the front: has it been done today or not.
 * Everybody in the unit sees that — a technician is entitled to know the
 * chemistry controls have not been run before they release a result off that
 * analyser. Only somebody holding the technical tier gets the button.
 *
 * The scope is narrow on purpose. Only diagnostic equipment carries IQC — a
 * refrigerator has no result to control — and only controls tied to the
 * reader's own unit appear, because a haematology technician does not need the
 * microbiology board.
 *
 * WAYS IN for the numbers. A malaria RDT control is one line. An FBC control is
 * twenty-three parameters on three levels, every day, and typing 69 numbers off
 * a printout is how control records stop being kept. So a control declares
 * which ways its results may be entered — typed, pasted, filled into a
 * spreadsheet, uploaded as the analyser's own export, read off a scan, or taken
 * from the instrument over the network — and the bench uses whichever suits the
 * moment. Every one of them lands in the same run through the same evaluation:
 * the entry method is how the numbers arrived, never what they mean.
 *
 * PARSING that is honest about ambiguity. Every route here returns a mapping
 * for the bench to confirm, never a saved run. The system saying "I think
 * column 4 is MCHC" and being wrong is a wrong control record with somebody's
 * name on it; the system asking is thirty seconds.
 */
import { Router } from 'express';
import multer from 'multer';
import * as XLSX from 'xlsx';
import AdmZip from 'adm-zip';
import { getDb } from '../db/database.js';
import { requireAuth } from '../middleware/auth.js';
import { requirePermission } from '../middleware/permissions.js';
import { audit } from '../services/auditService.js';
import { parseIntNullable, getCurrentStaffId } from './routeHelpers.js';
import { resolvePermission } from '../services/permissionResolver.js';
import { equipmentIsDiagnostic } from '../../shared/constants/equipment.js';
import { generateRecordNumber } from '../utils/recordNumber.js';
import {
  IQC_ENTRY_METHODS, parseEntryMethods, FEED_TRANSPORTS, FEED_PROTOCOLS,
  type IqcEntryMethod,
} from '../../shared/constants/routineWork.js';
import { tierFeatureKey, TIER_ACTION } from '../../shared/constants/activities.js';
import { effectiveTarget, withEffectiveTarget } from '../services/iqcTargets.js';

const numericOnly = (req: any, _res: any, next: any) => (/^\d+$/.test(req.params.id) ? next() : next('route'));

/** Running and accepting a control is registered scientific work. */
const PERFORM_TIER = 'technical';

export function iqcPortalRoutes() {
  const router = Router();
  router.use(requireAuth);
  const fileUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

  function mayPerform(req: any): boolean {
    return resolvePermission(req.user!.id, tierFeatureKey(PERFORM_TIER), TIER_ACTION).allowed
      || resolvePermission(req.user!.id, 'iqc', 'create').allowed;
  }
  function mayReview(req: any): boolean {
    return resolvePermission(req.user!.id, 'iqc', 'approve').allowed
      || resolvePermission(req.user!.id, tierFeatureKey('supervisory'), TIER_ACTION).allowed;
  }
  function currentSection(db: any, req: any): number | null {
    const staffId = getCurrentStaffId(req);
    if (staffId === null) return null;
    return (db.prepare('SELECT section_id FROM staff WHERE id = ?').get(staffId) as any)?.section_id ?? null;
  }

  /* ======================================================================
     The board
     ==================================================================== */

  /**
   * What this unit's controls look like right now.
   *
   * Grouped by instrument, because that is how a bench thinks: "has the
   * chemistry analyser been controlled this morning?" is one question about one
   * machine, not eight questions about eight analytes. Tests that are run
   * without an instrument — an RDT, a manual method — group under their own
   * heading rather than being hidden because they have no equipment row.
   */
  router.get('/portal/board', (req, res) => {
    const db = getDb();
    const sectionId = parseIntNullable(req.query.sectionId) ?? currentSection(db, req);
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date)) ? String(req.query.date) : new Date().toISOString().slice(0, 10);

    if (!sectionId) {
      return res.json({
        date, sectionId: null, groups: [], counts: { due: 0, done: 0, failed: 0, pendingReview: 0 },
        canPerform: mayPerform(req), canReview: mayReview(req),
        message: 'Your account is not linked to a unit, so no controls can be listed for you. Ask an administrator to link your staff record to your section.',
      });
    }

    // Which unit a control belongs to, in the order the laboratory means it:
    //
    //   the unit recorded as performing it — set explicitly, so it wins;
    //   the unit that administers it, for the many laboratories that never
    //     filled the performing-unit field in;
    //   the unit that owns the ANALYSER it runs on, because a control with no
    //     unit of its own is still unmistakably run wherever its instrument
    //     lives, and dropping it would leave a bench with an empty board and a
    //     drawer full of controls.
    const materials = db.prepare(`SELECT m.*, e.name AS equipment_name, e.equipment_number, e.category AS equipment_category,
          e.equipment_archetype, e.equipment_category AS equipment_category_key, e.status AS equipment_status,
          s.name AS section_name,
          COALESCE(m.performing_section_id, m.section_id, e.section_id) AS resolved_section_id
        FROM iqc_materials m
        LEFT JOIN equipment_items e ON e.id = m.equipment_id
        LEFT JOIN sections s ON s.id = COALESCE(m.performing_section_id, m.section_id, e.section_id)
        WHERE m.is_active = 1 AND COALESCE(m.performing_section_id, m.section_id, e.section_id) = ?
        ORDER BY e.name, m.test_name, m.level_label, m.material_name`).all(sectionId) as any[];

    // Only diagnostic equipment carries IQC. A control that has been attached
    // to a fridge is a configuration error, and it is shown as one rather than
    // silently dropped — otherwise nobody ever fixes it.
    const usable: any[] = [];
    const misfiled: any[] = [];
    for (const m of materials) {
      if (!m.equipment_id) { usable.push(m); continue; }
      const diagnostic = equipmentIsDiagnostic({
        equipment_archetype: m.equipment_archetype,
        equipment_category: m.equipment_category_key,
        name: m.equipment_name, category: m.equipment_category,
      });
      (diagnostic ? usable : misfiled).push(m);
    }

    const today = db.prepare(`SELECT r.iqc_material_id, r.id, r.run_number, r.status, r.run_time, r.reviewed_at,
          r.patient_results_released, r.entry_method, s.full_name AS operator_name
        FROM iqc_runs r LEFT JOIN staff s ON s.id = r.operator_staff_id
        WHERE r.run_date = ? ORDER BY r.id DESC`).all(date) as any[];
    const runsToday = new Map<number, any[]>();
    for (const run of today) {
      const list = runsToday.get(Number(run.iqc_material_id)) ?? [];
      list.push(run);
      runsToday.set(Number(run.iqc_material_id), list);
    }

    const lastRun = db.prepare(`SELECT iqc_material_id, MAX(run_date) AS last_date FROM iqc_runs GROUP BY iqc_material_id`).all() as any[];
    const lastByMaterial = new Map(lastRun.map(r => [Number(r.iqc_material_id), r.last_date]));

    const analyteCounts = db.prepare('SELECT iqc_material_id, COUNT(*) AS n FROM iqc_analytes WHERE is_active = 1 GROUP BY iqc_material_id').all() as any[];
    const analytesByMaterial = new Map(analyteCounts.map(r => [Number(r.iqc_material_id), Number(r.n)]));

    const rows = usable.map(m => {
      const runs = runsToday.get(Number(m.id)) ?? [];
      const latest = runs[0] ?? null;
      const expired = m.expiry_date && m.expiry_date < date;
      return {
        id: m.id, materialName: m.material_name, materialCode: m.material_code,
        testName: m.test_name, levelLabel: m.level_label, lotNumber: m.lot_number,
        controlType: m.control_type, ruleProfile: m.rule_profile, frequency: m.frequency,
        equipmentId: m.equipment_id, equipmentName: m.equipment_name, equipmentNumber: m.equipment_number,
        expiryDate: m.expiry_date, expired: Boolean(expired),
        analyteCount: analytesByMaterial.get(Number(m.id)) ?? 0,
        entryMethods: parseEntryMethods(m.entry_methods),
        preferredEntryMethod: m.preferred_entry_method || null,
        feedId: m.feed_id ?? null,
        importLayoutId: m.import_layout_id ?? null,
        runsToday: runs,
        doneToday: runs.length > 0,
        statusToday: latest?.status ?? null,
        pendingReview: runs.some(r => !r.reviewed_at),
        lastRunDate: lastByMaterial.get(Number(m.id)) ?? null,
      };
    });

    // Group by the instrument. Manual methods keep their own group rather than
    // disappearing among the analysers.
    const groups = new Map<string, any>();
    for (const row of rows) {
      const key = row.equipmentId ? `eq:${row.equipmentId}` : 'manual';
      const group = groups.get(key) ?? {
        key,
        equipmentId: row.equipmentId,
        name: row.equipmentName || 'Manual and near-patient methods',
        equipmentNumber: row.equipmentNumber ?? null,
        controls: [] as any[],
      };
      group.controls.push(row);
      groups.set(key, group);
    }

    const pendingFeed = db.prepare(`SELECT COUNT(*) AS n FROM iqc_feed_messages fm
        LEFT JOIN iqc_instrument_feeds f ON f.id = fm.feed_id
        WHERE fm.status IN ('matched', 'unmatched') AND (f.section_id IS NULL OR f.section_id = ?)`).get(sectionId) as any;

    res.json({
      date, sectionId,
      groups: [...groups.values()],
      counts: {
        controls: rows.length,
        due: rows.filter(r => !r.doneToday && !r.expired).length,
        done: rows.filter(r => r.doneToday).length,
        failed: rows.filter(r => r.statusToday === 'out_of_control').length,
        pendingReview: rows.filter(r => r.pendingReview).length,
        expired: rows.filter(r => r.expired).length,
        pendingFeed: Number(pendingFeed?.n ?? 0),
      },
      misfiled: misfiled.map(m => ({
        id: m.id, materialName: m.material_name, equipmentName: m.equipment_name,
        why: `${m.equipment_name} is not diagnostic equipment, so a control on it has no examination to control. Move the control to the analyser that reports the result, or correct the equipment's category.`,
      })),
      canPerform: mayPerform(req),
      canReview: mayReview(req),
    });
  });

  /* ======================================================================
     What the unit's tests are controlled by, and what they are not
     ----------------------------------------------------------------------
     The board answers "has today's control been run?". It cannot answer the
     question that comes first — "is this examination controlled at all?" — and
     a unit whose board is empty was being told only that no controls exist,
     with no way to see how big the gap was or to close it.

     The unit's own test menu is the denominator. ISO 15189:2022 §7.3.7.1
     requires a QC procedure for each examination, so a test on the menu with no
     control against it is a finding, and it is one the unit head can act on.
     ==================================================================== */

  /** A test name and a control's test name are the same string, loosely compared. */
  function testKey(value: unknown): string {
    return String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  }

  /**
   * Whether the reader may set their unit's controls up.
   *
   * A unit head is accountable for their unit's quality control and is the
   * person who ought to be defining it. Holding the module's create right
   * qualifies anybody; being the head of the unit in question qualifies them
   * for that unit alone, which is the narrower and more honest grant.
   */
  function mayDefineFor(req: any, sectionId: number | null): boolean {
    if (resolvePermission(req.user!.id, 'iqc', 'create').allowed) return true;
    if (!sectionId) return false;
    const staffId = getCurrentStaffId(req);
    if (staffId === null) return false;
    const head = getDb().prepare('SELECT head_staff_id FROM sections WHERE id = ?').get(sectionId) as any;
    return Boolean(head?.head_staff_id && Number(head.head_staff_id) === Number(staffId));
  }

  router.get('/portal/coverage', (req, res) => {
    const db = getDb();
    const sectionId = parseIntNullable(req.query.sectionId) ?? currentSection(db, req);
    if (!sectionId) {
      return res.json({
        sectionId: null, sectionName: null, tests: [], counts: { tests: 0, covered: 0, uncovered: 0, controls: 0, needingLimits: 0 },
        canDefine: false, equipment: [],
        message: 'Your account is not linked to a unit, so there is no test menu to check controls against.',
      });
    }

    const section = db.prepare('SELECT id, name FROM sections WHERE id = ?').get(sectionId) as any;
    const tests = db.prepare(`SELECT t.id, t.test_code, t.test_name, t.method_name, t.equipment_id, t.status,
          e.name AS equipment_name, e.equipment_number
        FROM lab_test_catalog t LEFT JOIN equipment_items e ON e.id = t.equipment_id
        WHERE t.section_id = ? AND COALESCE(t.status, 'active') = 'active'
        ORDER BY t.test_name`).all(sectionId) as any[];

    const controls = db.prepare(`SELECT m.id, m.material_name, m.test_name, m.level_label, m.lot_number,
          m.control_type, m.expiry_date, m.equipment_id, m.is_active,
          e.name AS equipment_name
        FROM iqc_materials m LEFT JOIN equipment_items e ON e.id = m.equipment_id
        WHERE m.is_active = 1 AND COALESCE(m.performing_section_id, m.section_id, e.section_id) = ?
        ORDER BY m.test_name, m.level_label`).all(sectionId) as any[];

    // Which controls belong to which test. A test may carry several levels, and
    // a control may exist for a test that is not on the menu — both are worth
    // seeing, so neither side is dropped.
    const byTest = new Map<string, any[]>();
    for (const c of controls) {
      const key = testKey(c.test_name);
      const list = byTest.get(key) ?? [];
      list.push(c);
      byTest.set(key, list);
    }

    const today = new Date().toISOString().slice(0, 10);
    const analyteStats = db.prepare(`SELECT iqc_material_id,
          COUNT(*) AS n,
          SUM(CASE WHEN (target_sd IS NOT NULL AND target_sd > 0)
                     OR (established_sd IS NOT NULL AND established_sd > 0) THEN 1 ELSE 0 END) AS with_sd
        FROM iqc_analytes WHERE is_active = 1 GROUP BY iqc_material_id`).all() as any[];
    const statsByMaterial = new Map(analyteStats.map(r => [Number(r.iqc_material_id), r]));

    const decorate = (c: any) => {
      const stats = statsByMaterial.get(Number(c.id));
      const analytes = Number(stats?.n ?? 0);
      const withSd = Number(stats?.with_sd ?? 0);
      return {
        id: c.id, materialName: c.material_name, testName: c.test_name, levelLabel: c.level_label,
        lotNumber: c.lot_number, controlType: c.control_type, equipmentName: c.equipment_name ?? null,
        expiryDate: c.expiry_date, expired: Boolean(c.expiry_date && c.expiry_date < today),
        analytes,
        // A quantitative control whose parameters have no SD records results
        // and judges nothing. It is "set up" and not yet working, and that
        // distinction is the whole point of showing it.
        analytesWithoutLimits: c.control_type === 'quantitative' ? Math.max(0, analytes - withSd) : 0,
      };
    };

    const rows = tests.map(t => {
      const matched = (byTest.get(testKey(t.test_name)) ?? []).map(decorate);
      return {
        id: t.id, testCode: t.test_code, testName: t.test_name, methodName: t.method_name,
        equipmentId: t.equipment_id, equipmentName: t.equipment_name, equipmentNumber: t.equipment_number,
        controls: matched,
        covered: matched.length > 0,
        needingLimits: matched.reduce((sum: number, c: any) => sum + c.analytesWithoutLimits, 0),
      };
    });

    // Controls the unit runs for something that is not on its test menu. Not an
    // error — a menu is often incomplete — but the unit head should see them
    // rather than have them vanish out of the count.
    const menuKeys = new Set(tests.map(t => testKey(t.test_name)));
    const unlisted = controls.filter(c => !menuKeys.has(testKey(c.test_name))).map(decorate);

    // The instruments a control could be attached to, so the setup form can
    // offer them without a second round trip.
    const equipment = (db.prepare(`SELECT id, name, equipment_number, category, equipment_archetype, equipment_category, status
        FROM equipment_items WHERE section_id = ? AND status != 'decommissioned' ORDER BY name`).all(sectionId) as any[])
      .filter(e => equipmentIsDiagnostic(e))
      .map(e => ({ id: e.id, name: e.name, equipmentNumber: e.equipment_number }));

    res.json({
      sectionId, sectionName: section?.name ?? null,
      tests: rows,
      unlisted,
      equipment,
      counts: {
        tests: rows.length,
        covered: rows.filter(r => r.covered).length,
        uncovered: rows.filter(r => !r.covered).length,
        controls: controls.length,
        needingLimits: rows.reduce((sum, r) => sum + r.needingLimits, 0)
          + unlisted.reduce((sum: number, c: any) => sum + c.analytesWithoutLimits, 0),
        unlisted: unlisted.length,
      },
      canDefine: mayDefineFor(req, sectionId),
      message: null,
    });
  });

  /**
   * Define a control for THIS unit, from the bench.
   *
   * The full definition screen lives in the IQC module and stays there — it
   * carries in-house provenance, culture and sensitivity panels, import
   * layouts, instrument feeds. This is the narrow path a unit head needs and
   * could not previously take: a test on their menu has no control, and they
   * are the person accountable for that.
   *
   * Two things it does that the module screen cannot.
   *
   * The unit is not a field. It is the caller's own unit, taken from their
   * staff record and written to BOTH section_id and performing_section_id, so
   * the control cannot be saved unowned — which is exactly how controls were
   * ending up invisible to the bench that owned them.
   *
   * The SD is optional and saying so is the point. Most commercial inserts give
   * a mean and a range and no SD; refusing the control until somebody invents
   * one is why controls do not get defined. It is accepted without, and this
   * laboratory's own SD is established from its runs.
   */
  router.post('/portal/controls', (req, res) => {
    const db = getDb();
    const sectionId = currentSection(db, req);
    if (!sectionId) return res.status(400).json({ error: 'Your staff record is not linked to a unit, so a control cannot be filed against one. Ask an administrator to set your section.' });
    if (!mayDefineFor(req, sectionId)) {
      return res.status(403).json({ error: 'Defining a control is the unit head\u2019s, or somebody holding the right to create controls. Ask your unit head to set this one up.' });
    }

    const materialName = String(req.body?.materialName ?? '').trim();
    const testName = String(req.body?.testName ?? '').trim();
    const lotNumber = String(req.body?.lotNumber ?? '').trim();
    if (!materialName) return res.status(400).json({ error: 'Give the control material a name.' });
    if (!testName) return res.status(400).json({ error: 'Say which examination this control is for.' });
    if (!lotNumber) return res.status(400).json({ error: 'A lot or batch number is required — a control without one cannot be traced to the vial it came from.' });

    const source = req.body?.source === 'in_house' ? 'in_house' : 'commercial';
    const controlType = ['quantitative', 'qualitative', 'semi_quantitative'].includes(req.body?.controlType)
      ? req.body.controlType : 'quantitative';
    if (source === 'in_house' && !String(req.body?.preparationMethod ?? '').trim()) {
      return res.status(400).json({ error: 'An in-house control has no manufacturer to vouch for it, so how it was prepared is what makes it traceable (ISO 15189:2022 \u00a77.3.7.2). Record that first.' });
    }

    const analytes = (Array.isArray(req.body?.analytes) ? req.body.analytes : [])
      .filter((a: any) => String(a?.analyte ?? '').trim());
    if (!analytes.length) return res.status(400).json({ error: 'Add at least one parameter \u2014 what does this control measure?' });
    if (controlType === 'qualitative' && analytes.some((a: any) => !String(a?.expectedResult ?? '').trim())) {
      return res.status(400).json({ error: 'A qualitative control is judged against the result it is expected to give, so every parameter needs one.' });
    }

    // Only the unit's own diagnostic instruments. A control cannot be filed
    // against another unit's analyser from here, and never against a fridge.
    let equipmentId = parseIntNullable(req.body?.equipmentId);
    if (equipmentId !== null) {
      const item = db.prepare('SELECT * FROM equipment_items WHERE id = ?').get(equipmentId) as any;
      if (!item) return res.status(400).json({ error: 'That instrument does not exist.' });
      if (Number(item.section_id) !== Number(sectionId)) {
        return res.status(400).json({ error: `${item.name} belongs to another unit. Choose one of your own, or leave the instrument blank for a manual method.` });
      }
      if (!equipmentIsDiagnostic(item)) {
        return res.status(400).json({ error: `${item.name} does not report a patient result, so there is no examination on it to control. Choose the analyser that reports the result.` });
      }
    }

    const ruleProfile = controlType === 'qualitative' ? 'match_expected'
      : controlType === 'semi_quantitative' ? 'range_only'
      : (['westgard_standard', 'westgard_simple'].includes(req.body?.ruleProfile) ? req.body.ruleProfile : 'westgard_standard');

    const createdAt = new Date().toISOString();
    const materialCode = generateRecordNumber(db, 'iqc_materials', 'IQCM', createdAt, 'material_code');
    const n = (v: unknown) => (v === undefined || v === '' || v === null || Number.isNaN(Number(v)) ? null : Number(v));

    let materialId = 0;
    const tx = db.transaction(() => {
      const result = db.prepare(`INSERT INTO iqc_materials (material_code, material_name, section_id, performing_section_id,
          test_name, analyte, lot_number, manufacturer, expiry_date, open_vial_expiry, storage_condition,
          equipment_id, is_active, created_by, created_at, source, control_type, level_label, qc_frequency, rule_profile,
          prepared_by_staff_id, preparation_date, preparation_method, base_material, validation_summary, instructions)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(materialCode, materialName, sectionId, sectionId, testName,
          String(analytes[0].analyte).trim(), lotNumber,
          req.body?.manufacturer ?? null, req.body?.expiryDate ?? null, req.body?.openVialExpiry ?? null,
          req.body?.storageCondition ?? null, equipmentId, req.user!.id, createdAt,
          source, controlType, req.body?.levelLabel ?? null,
          req.body?.qcFrequency ?? 'each_run', ruleProfile,
          parseIntNullable(req.body?.preparedByStaffId), req.body?.preparationDate ?? null,
          req.body?.preparationMethod ?? null, req.body?.baseMaterial ?? null,
          req.body?.validationSummary ?? null, req.body?.instructions ?? null);
      materialId = Number(result.lastInsertRowid);

      const insert = db.prepare(`INSERT INTO iqc_analytes (iqc_material_id, analyte, unit, target_mean, target_sd,
          acceptable_low, acceptable_high, decimal_places, expected_result, display_order)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      analytes.forEach((a: any, index: number) => {
        insert.run(materialId, String(a.analyte).trim(), a.unit ?? null,
          n(a.targetMean), n(a.targetSd), n(a.acceptableLow), n(a.acceptableHigh),
          n(a.decimalPlaces) ?? 2, a.expectedResult ?? null, index);
      });
    });
    tx();

    audit(req, {
      action: 'create', entity: 'iqc_materials', entityId: materialId,
      newValue: { materialCode, materialName, testName, lotNumber, sectionId, controlType, analytes: analytes.length, via: 'portal' },
    });

    const missingSd = controlType === 'quantitative'
      && analytes.filter((a: any) => n(a.targetSd) === null).length;
    res.status(201).json({
      id: materialId, materialCode,
      // Said plainly, once, at the moment it matters: the control is usable
      // now, and it starts judging properly once the runs are in.
      note: missingSd
        ? `${missingSd} of its ${analytes.length} parameter${analytes.length === 1 ? '' : 's'} have no SD. Results will be checked against the acceptable range straight away; the SD and the Levey-Jennings chart appear once this laboratory has run it 20 times over 20 days, which the system does for you.`
        : null,
    });
  });

  /**
   * One control, everything the entry screen needs: its analytes in order, its
   * limits, what the bench used last time, and which ways in it allows.
   */
  router.get('/portal/controls/:id', numericOnly, (req, res) => {
    const db = getDb();
    const material = db.prepare(`SELECT m.*, e.name AS equipment_name, s.name AS section_name
        FROM iqc_materials m LEFT JOIN equipment_items e ON e.id = m.equipment_id
        LEFT JOIN sections s ON s.id = COALESCE(m.performing_section_id, m.section_id) WHERE m.id = ?`).get(req.params.id) as any;
    if (!material) return res.status(404).json({ error: 'Control not found' });

    // The bench sees the limits the run will actually be judged against: what
    // was entered, or what this laboratory established from its own runs. A
    // screen showing a blank SD next to an evaluation that used one is how a
    // technician stops trusting the evaluation.
    const analytes = (db.prepare('SELECT * FROM iqc_analytes WHERE iqc_material_id = ? AND is_active = 1 ORDER BY display_order, id').all(req.params.id) as any[])
      .map(withEffectiveTarget);
    const recent = db.prepare(`SELECT r.id, r.run_number, r.run_date, r.run_time, r.status, r.rule_summary,
          r.reviewed_at, r.patient_results_released, r.entry_method, s.full_name AS operator_name
        FROM iqc_runs r LEFT JOIN staff s ON s.id = r.operator_staff_id
        WHERE r.iqc_material_id = ? ORDER BY r.run_date DESC, r.id DESC LIMIT 10`).all(req.params.id);
    const layout = material.import_layout_id
      ? db.prepare('SELECT * FROM iqc_import_layouts WHERE id = ?').get(material.import_layout_id) : null;
    const feed = material.feed_id
      ? db.prepare('SELECT id, name, transport, protocol, last_message_at, last_error, is_active FROM iqc_instrument_feeds WHERE id = ?').get(material.feed_id) : null;
    const waiting = material.feed_id
      ? db.prepare("SELECT COUNT(*) AS n FROM iqc_feed_messages WHERE iqc_material_id = ? AND status = 'matched'").get(req.params.id) as any
      : { n: 0 };

    res.json({
      material: {
        ...material,
        entryMethods: parseEntryMethods(material.entry_methods),
        preferredEntryMethod: material.preferred_entry_method || null,
      },
      analytes, recent, layout, feed,
      feedWaiting: Number(waiting?.n ?? 0),
      canPerform: mayPerform(req),
      canReview: mayReview(req),
    });
  });

  /* ======================================================================
     Which ways in a control allows
     ==================================================================== */

  /**
   * Set when the control is created, and changeable afterwards — a laboratory
   * that starts by typing and later gets the analyser's export working should
   * not have to redefine the control to use it.
   */
  router.put('/portal/controls/:id/entry-methods', numericOnly, requirePermission('iqc', 'edit'), (req, res) => {
    const db = getDb();
    const material = db.prepare('SELECT id FROM iqc_materials WHERE id = ?').get(req.params.id);
    if (!material) return res.status(404).json({ error: 'Control not found' });

    const wanted = Array.isArray(req.body?.entryMethods) ? req.body.entryMethods.map(String) : [];
    const invalid = wanted.filter((m: string) => !(IQC_ENTRY_METHODS as readonly string[]).includes(m));
    if (invalid.length) return res.status(400).json({ error: `Unknown entry method: ${invalid.join(', ')}.` });
    const methods = parseEntryMethods(wanted);

    const preferred = req.body?.preferredEntryMethod ? String(req.body.preferredEntryMethod) : null;
    if (preferred && !methods.includes(preferred as IqcEntryMethod)) {
      return res.status(400).json({ error: 'The preferred way of entering results has to be one of the ways this control allows.' });
    }

    db.prepare(`UPDATE iqc_materials SET entry_methods = ?, preferred_entry_method = ?,
        import_layout_id = ?, feed_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(JSON.stringify(methods), preferred,
        parseIntNullable(req.body?.importLayoutId), parseIntNullable(req.body?.feedId), req.params.id);
    audit(req, { action: 'edit', entity: 'iqc_materials', entityId: req.params.id, newValue: { entryMethods: methods, preferred } });
    res.json({ ok: true, entryMethods: methods, preferredEntryMethod: preferred });
  });

  /** Which unit's bench actually runs this control, day to day. */
  router.put('/portal/controls/:id/performing-section', numericOnly, requirePermission('iqc', 'edit'), (req, res) => {
    const db = getDb();
    const sectionId = parseIntNullable(req.body?.sectionId);
    db.prepare('UPDATE iqc_materials SET performing_section_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(sectionId, req.params.id);
    audit(req, { action: 'edit', entity: 'iqc_materials', entityId: req.params.id, newValue: { performingSectionId: sectionId } });
    res.json({ ok: true });
  });

  /* ======================================================================
     Pasting a table
     ==================================================================== */

  /**
   * Take whatever was pasted and line it up with the control's analytes.
   *
   * The bench copies out of Excel or Word, so what arrives is tab- or
   * comma-separated text in whatever order the analyser prints. Matching is by
   * NAME, not position: the analyser's "MCHC" finds the control's "MCHC"
   * wherever it sits, and a parameter the control does not have is reported as
   * unmatched instead of being quietly dropped into the next free slot.
   *
   * Two shapes are handled, because both are what people actually paste: one
   * analyte per row (the common printout), and one analyte per column with the
   * values underneath (the common spreadsheet). The shape is detected and
   * stated back, so a wrong guess is visible before anything is saved.
   */
  router.post('/portal/controls/:id/parse-paste', numericOnly, (req, res) => {
    const db = getDb();
    const analytes = db.prepare('SELECT * FROM iqc_analytes WHERE iqc_material_id = ? AND is_active = 1 ORDER BY display_order, id').all(req.params.id) as any[];
    if (!analytes.length) return res.status(400).json({ error: 'This control has no parameters defined yet.' });

    const text = String(req.body?.text ?? '');
    if (!text.trim()) return res.status(400).json({ error: 'Nothing was pasted.' });

    const grid = splitPasted(text);
    if (!grid.length) return res.status(400).json({ error: 'That did not look like a table. Copy the block of results including the parameter names.' });

    const orientation = req.body?.orientation === 'columns' || req.body?.orientation === 'rows'
      ? String(req.body.orientation) : detectOrientation(grid, analytes);
    const mapped = orientation === 'columns' ? mapColumns(grid, analytes) : mapRows(grid, analytes);
    res.json({ orientation, ...mapped });
  });

  /* ======================================================================
     The spreadsheet the control's table already is
     ==================================================================== */

  /**
   * The control's entry table, as a spreadsheet, in exactly the order the
   * system stores it — so a bench can paste the analyser's block into it,
   * check the alignment in a tool they already know, and send it back whole.
   */
  router.get('/portal/controls/:id/worksheet.xlsx', numericOnly, (req, res) => {
    const db = getDb();
    const material = db.prepare('SELECT * FROM iqc_materials WHERE id = ?').get(req.params.id) as any;
    if (!material) return res.status(404).json({ error: 'Control not found' });
    const analytes = db.prepare('SELECT * FROM iqc_analytes WHERE iqc_material_id = ? AND is_active = 1 ORDER BY display_order, id').all(req.params.id) as any[];

    const aoa: any[][] = [
      [`${material.material_name} — control worksheet`],
      [`Test: ${material.test_name}`, `Lot: ${material.lot_number}`, material.level_label ? `Level: ${material.level_label}` : ''],
      ['Paste the analyser\'s results into the Result column. Do not change the Parameter column — it is what the values are matched on.'],
      [],
      ['Parameter', 'Unit', 'Result', 'Target mean', 'Target SD', 'Acceptable from', 'Acceptable to', 'Expected'],
      ...analytes.map(a => [a.analyte, a.unit ?? '', null, a.target_mean ?? '', a.target_sd ?? '',
        a.acceptable_low ?? '', a.acceptable_high ?? '', a.expected_result ?? a.expected_interpretation ?? '']),
    ];
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(aoa), 'Control run');
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${slug(material.material_name)}_worksheet.xlsx"`);
    res.send(buffer);
  });

  /* ======================================================================
     The analyser's own export
     ==================================================================== */

  /**
   * Read the file the analyser produced.
   *
   * Every analyser exports differently — a different number of header lines, a
   * different name for the same parameter, values in rows on one machine and
   * columns on another. So the shape is adjustable and, once it is right, saved
   * as a layout against that instrument. Next month's file lands correctly
   * without anybody touching it, and the month after that.
   *
   * Nothing is saved as a run here: the mapping comes back for the bench to
   * confirm. A system that quietly decides column 4 is MCHC and is wrong has
   * written a false control record with a real name on it.
   */
  router.post('/portal/controls/:id/parse-file', numericOnly, fileUpload.single('file'), (req, res) => {
    const db = getDb();
    const material = db.prepare('SELECT * FROM iqc_materials WHERE id = ?').get(req.params.id) as any;
    if (!material) return res.status(404).json({ error: 'Control not found' });
    if (!req.file) return res.status(400).json({ error: 'No file was uploaded.' });
    const analytes = db.prepare('SELECT * FROM iqc_analytes WHERE iqc_material_id = ? AND is_active = 1 ORDER BY display_order, id').all(req.params.id) as any[];
    if (!analytes.length) return res.status(400).json({ error: 'This control has no parameters defined yet.' });

    const name = String(req.file.originalname || '').toLowerCase();
    let grid: any[][];
    try {
      if (name.endsWith('.docx')) grid = largestWordTable(req.file.buffer);
      else {
        const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
        const first = workbook.Sheets[workbook.SheetNames[0]];
        grid = XLSX.utils.sheet_to_json<any[]>(first, { header: 1, blankrows: false, defval: null });
      }
    } catch (error) {
      return res.status(400).json({ error: `That file could not be read (${(error as Error).message}). CSV, Excel and Word tables are supported.` });
    }
    if (!grid.length) return res.status(400).json({ error: 'That file had no readable table in it.' });

    // A stored layout says where this analyser puts things; the request may
    // override it while the bench is getting the alignment right.
    const stored = material.import_layout_id
      ? db.prepare('SELECT * FROM iqc_import_layouts WHERE id = ?').get(material.import_layout_id) as any : null;
    const skipRows = parseIntNullable(req.body?.skipRows) ?? (stored ? Number(stored.first_data_row) - 1 : 0);
    const orientation = String(req.body?.orientation || stored?.orientation || detectOrientation(grid.slice(skipRows), analytes));
    const shifted = grid.slice(Math.max(0, skipRows));

    const mapped = orientation === 'columns' ? mapColumns(shifted, analytes) : mapRows(shifted, analytes);
    res.json({
      orientation, skipRows,
      // The rows around where the reader started, so the bench can nudge the
      // start point up or down until the parameters line up — which is the
      // thing that actually goes wrong with an analyser export.
      preview: grid.slice(0, Math.min(grid.length, skipRows + 12)).map(r => (Array.isArray(r) ? r.slice(0, 12) : [])),
      totalRows: grid.length,
      layout: stored,
      ...mapped,
    });
  });

  /** Remember an analyser's export shape once the bench has it lined up. */
  router.post('/portal/controls/:id/layout', numericOnly, requirePermission('iqc', 'edit'), (req, res) => {
    const db = getDb();
    const material = db.prepare('SELECT * FROM iqc_materials WHERE id = ?').get(req.params.id) as any;
    if (!material) return res.status(404).json({ error: 'Control not found' });

    const name = String(req.body?.name ?? '').trim() || `${material.material_name} import layout`;
    const code = `IQCLAY-${req.params.id}-${Date.now().toString(36).toUpperCase()}`;
    const analyteMap = req.body?.analyteMap ? JSON.stringify(req.body.analyteMap) : null;

    const existing = material.import_layout_id
      ? db.prepare('SELECT id FROM iqc_import_layouts WHERE id = ?').get(material.import_layout_id) as any : null;

    if (existing) {
      db.prepare(`UPDATE iqc_import_layouts SET name = ?, file_kind = ?, orientation = ?, header_row = ?,
          first_data_row = ?, analyte_map = ?, sample_headers = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .run(name, req.body?.fileKind ?? 'csv', req.body?.orientation ?? 'rows',
          parseIntNullable(req.body?.headerRow) ?? 1, parseIntNullable(req.body?.firstDataRow) ?? 2,
          analyteMap, req.body?.sampleHeaders ? JSON.stringify(req.body.sampleHeaders) : null, existing.id);
      audit(req, { action: 'edit', entity: 'iqc_import_layouts', entityId: existing.id });
      return res.json({ id: existing.id });
    }

    const result = db.prepare(`INSERT INTO iqc_import_layouts
        (layout_code, name, equipment_id, iqc_material_id, file_kind, orientation, header_row, first_data_row, analyte_map, sample_headers, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(code, name, material.equipment_id, material.id, req.body?.fileKind ?? 'csv',
        req.body?.orientation ?? 'rows', parseIntNullable(req.body?.headerRow) ?? 1,
        parseIntNullable(req.body?.firstDataRow) ?? 2, analyteMap,
        req.body?.sampleHeaders ? JSON.stringify(req.body.sampleHeaders) : null, req.user!.id);
    const id = Number(result.lastInsertRowid);
    db.prepare('UPDATE iqc_materials SET import_layout_id = ? WHERE id = ?').run(id, material.id);
    audit(req, { action: 'create', entity: 'iqc_import_layouts', entityId: id, newValue: { name } });
    res.status(201).json({ id });
  });

  /* ======================================================================
     Instrument feeds
     ==================================================================== */

  router.get('/portal/feeds', (req, res) => {
    const db = getDb();
    const sectionId = parseIntNullable(req.query.sectionId) ?? currentSection(db, req);
    res.json(db.prepare(`SELECT f.*, e.name AS equipment_name,
          (SELECT COUNT(*) FROM iqc_feed_messages m WHERE m.feed_id = f.id AND m.status IN ('matched','unmatched')) AS waiting
        FROM iqc_instrument_feeds f LEFT JOIN equipment_items e ON e.id = f.equipment_id
        WHERE f.is_active = 1 AND (f.section_id IS NULL OR f.section_id = ? OR ? IS NULL)
        ORDER BY f.name`).all(sectionId, sectionId));
  });

  router.post('/portal/feeds', requirePermission('iqc', 'edit'), (req, res) => {
    const db = getDb();
    const b = req.body ?? {};
    const name = String(b.name ?? '').trim();
    if (!name) return res.status(400).json({ error: 'A name is required.' });
    const transport = String(b.transport ?? 'tcp_server');
    if (!(FEED_TRANSPORTS as readonly string[]).includes(transport)) return res.status(400).json({ error: `Transport must be one of: ${FEED_TRANSPORTS.join(', ')}.` });
    const protocol = String(b.protocol ?? 'astm');
    if (!(FEED_PROTOCOLS as readonly string[]).includes(protocol)) return res.status(400).json({ error: `Protocol must be one of: ${FEED_PROTOCOLS.join(', ')}.` });

    const code = String(b.feedCode ?? '').trim() || `FEED-${Date.now().toString(36).toUpperCase()}`;
    const result = db.prepare(`INSERT INTO iqc_instrument_feeds
        (feed_code, name, equipment_id, section_id, transport, protocol, host, port, watch_path,
         control_id_patterns, analyte_map, auto_accept, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(code, name, parseIntNullable(b.equipmentId), parseIntNullable(b.sectionId), transport, protocol,
        b.host ?? null, parseIntNullable(b.port), b.watchPath ?? null,
        b.controlIdPatterns ? JSON.stringify(b.controlIdPatterns) : null,
        b.analyteMap ? JSON.stringify(b.analyteMap) : null,
        // A control accepted by nobody is not quality control. Auto-accept
        // exists for a laboratory that has decided otherwise, and it is off.
        b.autoAccept ? 1 : 0, req.user!.id);
    audit(req, { action: 'create', entity: 'iqc_instrument_feeds', entityId: result.lastInsertRowid, newValue: { name, transport, protocol } });
    res.status(201).json({ id: result.lastInsertRowid, feedCode: code });
  });

  /**
   * Control results the analysers have sent and nobody has dealt with yet.
   *
   * They wait here rather than becoming runs on their own: an analyser message
   * is evidence that a control was run, not a decision that it passed and that
   * patient results may go out. That decision is a person's.
   */
  router.get('/portal/feed-messages', (req, res) => {
    const db = getDb();
    const sectionId = parseIntNullable(req.query.sectionId) ?? currentSection(db, req);
    const status = typeof req.query.status === 'string' ? req.query.status : null;
    const rows = db.prepare(`SELECT m.*, f.name AS feed_name, f.protocol, e.name AS equipment_name,
          mat.material_name, mat.test_name, mat.level_label
        FROM iqc_feed_messages m
        LEFT JOIN iqc_instrument_feeds f ON f.id = m.feed_id
        LEFT JOIN equipment_items e ON e.id = f.equipment_id
        LEFT JOIN iqc_materials mat ON mat.id = m.iqc_material_id
        WHERE (f.section_id IS NULL OR f.section_id = ? OR ? IS NULL)
          AND (? IS NULL OR m.status = ?)
        ORDER BY m.received_at DESC LIMIT 200`).all(sectionId, sectionId, status, status) as any[];
    res.json(rows.map(r => ({ ...r, parsed_values: safeJson(r.parsed_values) })));
  });

  /**
   * Ingest one message.
   *
   * Deliberately an ordinary authenticated endpoint rather than a listening
   * socket: the laboratory's analysers already reach a middleware or a driver
   * that speaks their transport, and that is the right place for RS-232 timing
   * and ASTM framing to live. What the LIMS owes is a stable place to put the
   * parsed result and a bench screen that acts on it.
   */
  router.post('/portal/feeds/:id/messages', numericOnly, (req, res) => {
    const db = getDb();
    const feed = db.prepare('SELECT * FROM iqc_instrument_feeds WHERE id = ? AND is_active = 1').get(req.params.id) as any;
    if (!feed) return res.status(404).json({ error: 'Feed not found' });

    const sampleId = String(req.body?.sampleId ?? '').trim() || null;
    const values = Array.isArray(req.body?.values) ? req.body.values : [];
    const lot = req.body?.lotNumber ? String(req.body.lotNumber) : null;

    // Which control is this? The lot number is the strongest signal, then the
    // sample identifier the analyser used, then the patterns the feed declares.
    let material: any = null;
    if (lot) material = db.prepare('SELECT * FROM iqc_materials WHERE lot_number = ? AND is_active = 1').get(lot);
    if (!material && sampleId) {
      material = db.prepare('SELECT * FROM iqc_materials WHERE is_active = 1 AND (material_code = ? OR lot_number = ?)').get(sampleId, sampleId);
    }
    if (!material && sampleId) {
      const patterns = safeJson(feed.control_id_patterns) as string[] | null;
      if (Array.isArray(patterns) && patterns.some(p => sampleId.toLowerCase().includes(String(p).toLowerCase()))) {
        material = db.prepare('SELECT * FROM iqc_materials WHERE feed_id = ? AND is_active = 1 ORDER BY id LIMIT 1').get(feed.id);
      }
    }

    const result = db.prepare(`INSERT INTO iqc_feed_messages
        (feed_id, raw_message, sample_id, lot_number, instrument_run_at, parsed_values, iqc_material_id, status, status_note)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(feed.id, req.body?.raw ?? null, sampleId, lot, req.body?.runAt ?? null,
        JSON.stringify(values), material?.id ?? null,
        material ? 'matched' : 'unmatched',
        material ? null : 'No active control matched this lot or sample identifier. Match it by hand on the bench, or add the identifier to the feed\'s control patterns.');

    db.prepare('UPDATE iqc_instrument_feeds SET last_message_at = CURRENT_TIMESTAMP, last_error = NULL WHERE id = ?').run(feed.id);
    res.status(201).json({ id: result.lastInsertRowid, matched: Boolean(material), materialId: material?.id ?? null });
  });

  /** Line an arriving message up against a control's analytes, for the bench to accept. */
  router.get('/portal/feed-messages/:id/mapping', numericOnly, (req, res) => {
    const db = getDb();
    const message = db.prepare('SELECT * FROM iqc_feed_messages WHERE id = ?').get(req.params.id) as any;
    if (!message) return res.status(404).json({ error: 'Message not found' });
    const materialId = parseIntNullable(req.query.materialId) ?? message.iqc_material_id;
    if (!materialId) return res.status(400).json({ error: 'This message is not matched to a control yet. Choose which control it belongs to.' });

    const analytes = db.prepare('SELECT * FROM iqc_analytes WHERE iqc_material_id = ? AND is_active = 1 ORDER BY display_order, id').all(materialId) as any[];
    const values = (safeJson(message.parsed_values) as any[]) ?? [];
    const feed = message.feed_id ? db.prepare('SELECT analyte_map FROM iqc_instrument_feeds WHERE id = ?').get(message.feed_id) as any : null;
    const map = (safeJson(feed?.analyte_map) as Record<string, string> | null) ?? {};

    const grid = values.map(v => [String(map[String(v.analyte)] ?? v.analyte ?? ''), v.value]);
    const mapped = mapRows(grid, analytes);
    res.json({ message: { ...message, parsed_values: values }, materialId, ...mapped });
  });

  router.post('/portal/feed-messages/:id/reject', numericOnly, (req, res) => {
    const db = getDb();
    if (!mayPerform(req)) return res.status(403).json({ error: 'Accepting or rejecting a control run needs the technical routine-work tier.' });
    db.prepare(`UPDATE iqc_feed_messages SET status = 'rejected', status_note = ?, handled_by_staff_id = ?,
        handled_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(String(req.body?.reason ?? '').trim() || null, getCurrentStaffId(req), req.params.id);
    audit(req, { action: 'edit', entity: 'iqc_feed_messages', entityId: req.params.id, newValue: { status: 'rejected' } });
    res.json({ ok: true });
  });

  /** Tie an accepted message to the run it produced, once the run is saved. */
  router.post('/portal/feed-messages/:id/link-run', numericOnly, (req, res) => {
    const db = getDb();
    const runId = parseIntNullable(req.body?.runId);
    if (!runId) return res.status(400).json({ error: 'runId is required' });
    db.prepare(`UPDATE iqc_feed_messages SET status = 'accepted', iqc_run_id = ?, handled_by_staff_id = ?,
        handled_at = CURRENT_TIMESTAMP WHERE id = ?`).run(runId, getCurrentStaffId(req), req.params.id);
    db.prepare('UPDATE iqc_runs SET feed_message_id = ?, entry_method = ? WHERE id = ?').run(req.params.id, 'instrument', runId);
    res.json({ ok: true });
  });

  return router;
}

/* ============================================================================
   Matching parameter names
   ----------------------------------------------------------------------------
   Analysers write the same parameter half a dozen ways: "HGB", "Hgb", "HB",
   "Haemoglobin", "Hemoglobin". Matching exactly means nothing ever lines up;
   matching too loosely means "MCH" quietly takes the value of "MCHC", which is
   worse than not matching at all. So it goes in stages, strictest first, and
   whatever does not match is reported rather than guessed.
   ========================================================================= */

const SYNONYMS: Record<string, string[]> = {
  haemoglobin: ['hgb', 'hb', 'hemoglobin', 'haemoglobin'],
  haematocrit: ['hct', 'pcv', 'hematocrit', 'haematocrit'],
  wbc: ['wbc', 'leucocytes', 'leukocytes', 'whitecellcount', 'totalwbc'],
  rbc: ['rbc', 'erythrocytes', 'redcellcount'],
  platelets: ['plt', 'platelets', 'plateletcount'],
  neutrophils: ['neut', 'ne', 'neutrophils', 'neu'],
  lymphocytes: ['lymph', 'ly', 'lymphocytes', 'lym'],
  monocytes: ['mono', 'mo', 'monocytes'],
  eosinophils: ['eos', 'eo', 'eosinophils'],
  basophils: ['baso', 'ba', 'basophils'],
  glucose: ['glu', 'gluc', 'glucose'],
  urea: ['urea', 'bun'],
  creatinine: ['crea', 'creat', 'creatinine'],
  sodium: ['na', 'sodium'],
  potassium: ['k', 'potassium'],
  chloride: ['cl', 'chloride'],
  calcium: ['ca', 'calcium'],
  albumin: ['alb', 'albumin'],
  bilirubin: ['tbil', 'bili', 'bilirubin', 'totalbilirubin'],
  alt: ['alt', 'sgpt', 'alanineaminotransferase'],
  ast: ['ast', 'sgot', 'aspartateaminotransferase'],
  alp: ['alp', 'alkalinephosphatase'],
};

function normalise(value: unknown): string {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function synonymGroup(name: string): string | null {
  const key = normalise(name);
  for (const [group, members] of Object.entries(SYNONYMS)) {
    if (members.includes(key) || normalise(group) === key) return group;
  }
  return null;
}

/** Find the analyte a label refers to, or nothing. Never a near-miss. */
function findAnalyte(label: string, analytes: any[]): any | null {
  const target = normalise(label);
  if (!target) return null;
  const exact = analytes.find(a => normalise(a.analyte) === target);
  if (exact) return exact;

  const group = synonymGroup(label);
  if (group) {
    const bySynonym = analytes.find(a => synonymGroup(a.analyte) === group);
    if (bySynonym) return bySynonym;
  }

  // A prefix match, but only where it is unambiguous. "MCH" against a control
  // holding both MCH and MCHC matches nothing, which is the correct answer.
  const prefix = analytes.filter(a => {
    const candidate = normalise(a.analyte);
    return candidate.startsWith(target) || target.startsWith(candidate);
  });
  return prefix.length === 1 ? prefix[0] : null;
}

/** Split pasted text on tabs, then on commas, then on runs of spaces. */
function splitPasted(text: string): any[][] {
  const lines = text.replace(/\r/g, '').split('\n').filter(l => l.trim() !== '');
  if (!lines.length) return [];
  const delimiter = lines[0].includes('\t') ? '\t' : lines[0].includes(',') ? ',' : null;
  return lines.map(line => (delimiter ? line.split(delimiter) : line.trim().split(/\s{2,}/)).map(c => c.trim()));
}

function numberFrom(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  // Analysers decorate values: "12.4 H", "*8.9", "< 0.5". Take the number.
  const match = String(value).replace(/,/g, '.').match(/-?\d+(\.\d+)?/);
  if (!match) return null;
  const num = Number(match[0]);
  return Number.isFinite(num) ? num : null;
}

/**
 * Which way round is the pasted block?
 *
 * Decided by counting how many of the control's parameters are recognisable
 * down the first column versus across the first row — evidence, rather than a
 * rule about how analysers "usually" print.
 */
function detectOrientation(grid: any[][], analytes: any[]): 'rows' | 'columns' {
  const downFirstColumn = grid.filter(row => Array.isArray(row) && findAnalyte(String(row[0] ?? ''), analytes)).length;
  const acrossFirstRow = (grid[0] ?? []).filter(cell => findAnalyte(String(cell ?? ''), analytes)).length;
  return acrossFirstRow > downFirstColumn ? 'columns' : 'rows';
}

interface Mapping {
  readings: Array<{ analyteId: number; analyte: string; unit: string | null; value: number | null; qualitativeResult?: string | null; raw: string }>;
  unmatchedLabels: string[];
  missingAnalytes: Array<{ analyteId: number; analyte: string }>;
  matched: number;
}

/** One parameter per row: name in the first column, value in the next usable one. */
function mapRows(grid: any[][], analytes: any[]): Mapping {
  const readings: Mapping['readings'] = [];
  const unmatched: string[] = [];
  const seen = new Set<number>();

  for (const row of grid) {
    if (!Array.isArray(row) || !row.length) continue;
    const label = String(row[0] ?? '').trim();
    if (!label) continue;
    const analyte = findAnalyte(label, analytes);
    if (!analyte) {
      if (row.slice(1).some(c => numberFrom(c) !== null)) unmatched.push(label);
      continue;
    }
    if (seen.has(Number(analyte.id))) continue;
    // The first cell after the name that holds a number. Analysers put a unit,
    // a flag or a blank between the name and the value often enough that
    // taking column 2 blindly is wrong.
    let value: number | null = null;
    let raw = '';
    for (const cell of row.slice(1)) {
      const num = numberFrom(cell);
      if (num !== null) { value = num; raw = String(cell); break; }
    }
    const qualitative = value === null ? qualitativeFrom(row.slice(1)) : null;
    if (value === null && !qualitative) continue;
    seen.add(Number(analyte.id));
    readings.push({
      analyteId: Number(analyte.id), analyte: analyte.analyte, unit: analyte.unit ?? null,
      value, qualitativeResult: qualitative, raw: raw || qualitative || '',
    });
  }

  return {
    readings, unmatchedLabels: [...new Set(unmatched)].slice(0, 20),
    missingAnalytes: analytes.filter(a => !seen.has(Number(a.id))).map(a => ({ analyteId: Number(a.id), analyte: a.analyte })),
    matched: readings.length,
  };
}

/** One parameter per column: names across the top, values on the row below. */
function mapColumns(grid: any[][], analytes: any[]): Mapping {
  const header = grid[0] ?? [];
  // The first row under the header that carries numbers is the result row; a
  // spreadsheet often has a units row in between.
  const valueRow = grid.slice(1).find(row => Array.isArray(row) && row.some(c => numberFrom(c) !== null)) ?? [];

  const readings: Mapping['readings'] = [];
  const unmatched: string[] = [];
  const seen = new Set<number>();

  header.forEach((cell, index) => {
    const label = String(cell ?? '').trim();
    if (!label) return;
    const analyte = findAnalyte(label, analytes);
    if (!analyte) {
      if (numberFrom(valueRow[index]) !== null) unmatched.push(label);
      return;
    }
    if (seen.has(Number(analyte.id))) return;
    const value = numberFrom(valueRow[index]);
    const qualitative = value === null ? qualitativeFrom([valueRow[index]]) : null;
    if (value === null && !qualitative) return;
    seen.add(Number(analyte.id));
    readings.push({
      analyteId: Number(analyte.id), analyte: analyte.analyte, unit: analyte.unit ?? null,
      value, qualitativeResult: qualitative, raw: String(valueRow[index] ?? ''),
    });
  });

  return {
    readings, unmatchedLabels: [...new Set(unmatched)].slice(0, 20),
    missingAnalytes: analytes.filter(a => !seen.has(Number(a.id))).map(a => ({ analyteId: Number(a.id), analyte: a.analyte })),
    matched: readings.length,
  };
}

/** A reactive/non-reactive style result, for the qualitative controls. */
function qualitativeFrom(cells: unknown[]): string | null {
  const words: Record<string, string> = {
    reactive: 'reactive', nonreactive: 'non_reactive', 'non-reactive': 'non_reactive',
    positive: 'positive', negative: 'negative', pos: 'positive', neg: 'negative',
    detected: 'detected', notdetected: 'not_detected', 'not-detected': 'not_detected',
  };
  for (const cell of cells) {
    const key = String(cell ?? '').trim().toLowerCase().replace(/\s+/g, '');
    if (words[key]) return words[key];
  }
  return null;
}

function largestWordTable(buffer: Buffer): any[][] {
  const zip = new AdmZip(buffer);
  const entry = zip.getEntry('word/document.xml');
  if (!entry) throw new Error('no document.xml in that file');
  const xml = zip.readAsText(entry);
  let best: any[][] = [];
  for (const table of xml.match(/<w:tbl>[\s\S]*?<\/w:tbl>/g) ?? []) {
    const rows: any[][] = [];
    for (const row of table.match(/<w:tr[\s\S]*?<\/w:tr>/g) ?? []) {
      const cells = (row.match(/<w:tc>[\s\S]*?<\/w:tc>/g) ?? []).map(cell =>
        (cell.match(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g) ?? []).map(t => t.replace(/<[^>]+>/g, '')).join('')
          .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim());
      if (cells.length) rows.push(cells);
    }
    if (rows.length * (rows[0]?.length ?? 0) > best.length * (best[0]?.length ?? 0)) best = rows;
  }
  return best;
}

function safeJson(value: unknown): unknown {
  if (typeof value !== 'string') return value ?? null;
  try { return JSON.parse(value); } catch { return null; }
}

function slug(value: string): string {
  return String(value).replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').slice(0, 50) || 'control';
}
