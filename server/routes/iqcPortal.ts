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
import { unitScopePayload, resolveUnitScope } from '../services/unitScope.js';
import { linksForControl } from '../services/controlAnalyser.js';
import { feedMessageValues, messageFacts } from '../services/feedMessageValues.js';
import { listTransmissions } from '../services/transmissionList.js';
import { resolvePermission } from '../services/permissionResolver.js';
import { mayActOnUnit, leadsAnyUnit } from '../services/unitLeadership.js';
import { equipmentIsDiagnostic } from '../../shared/constants/equipment.js';
import { generateRecordNumber } from '../utils/recordNumber.js';
import {
  IQC_ENTRY_METHODS, parseEntryMethods, FEED_TRANSPORTS, FEED_PROTOCOLS,
  type IqcEntryMethod,
} from '../../shared/constants/routineWork.js';
import { tierFeatureKey, TIER_ACTION } from '../../shared/constants/activities.js';
import { IQC_RECORDING_BASES, lotExpired } from '../../shared/constants/iqc.js';
import { effectiveTarget, withEffectiveTarget } from '../services/iqcTargets.js';
import { chartStatistics } from '../services/iqcEvaluation.js';
import {
  bestLabel, findAnalyte, splitPasted, numberFrom, detectOrientation, mapRows, mapColumns,
  type Mapping,
} from '../services/iqcAnalyteMatching.js';
import { currentBridge } from '../services/instrumentBridge/index.js';
import { linkIsOurs } from '../../shared/constants/instruments.js';

const numericOnly = (req: any, _res: any, next: any) => (/^\d+$/.test(req.params.id) ? next() : next('route'));

/** Running and accepting a control is registered scientific work. */
const PERFORM_TIER = 'technical';

export function iqcPortalRoutes() {
  const router = Router();
  router.use(requireAuth);
  const fileUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

  function mayPerform(req: any, sectionId?: number | null): boolean {
    return resolvePermission(req.user!.id, tierFeatureKey(PERFORM_TIER), TIER_ACTION).allowed
      || resolvePermission(req.user!.id, 'iqc', 'create').allowed
      // Whoever runs the unit runs its controls. The tier is a competence
      // record and a unit head who has not been ticked on it is still the
      // person accountable for the unit's quality control.
      || (sectionId != null ? mayActOnUnit(req, 'iqc', 'create', sectionId) : leadsAnyUnit(req));
  }
  function mayReview(req: any): boolean {
    return resolvePermission(req.user!.id, 'iqc', 'approve').allowed
      || resolvePermission(req.user!.id, tierFeatureKey('supervisory'), TIER_ACTION).allowed;
  }
  /** Defining a control from the portal is the same right the module asks for. */
  function mayDefine(req: any): boolean {
    return resolvePermission(req.user!.id, 'iqc', 'create').allowed;
  }
  /**
   * Is this control on the caller's own board?
   *
   * The same unit resolution the board uses, so a chart is reachable exactly
   * when the control that produced it is — no wider, and no narrower.
   */
  /**
   * The analyser link that serves a control, asked as widely as the module.
   *
   * The analyser links that belong to THIS control.
   *
   * One rule, and it is a strict one: a link counts only when it is registered
   * against the very instrument the control runs on. Not the unit, not "the
   * only analyser this laboratory owns", not anything else.
   *
   * One machine registered twice under slightly different spellings still
   * counts as one machine; two machines in one room never count as one. The
   * rule and the reasoning live in `controlAnalyser.ts`, so this screen and the
   * module's cannot drift apart about it.
   *
   * Where no link belongs to the control's instrument, none is offered, and
   * the screen says which of the two things is missing: an instrument on the
   * control, or a link on that instrument.
   */
  const linkRowsForControl = (db: any, material: any): any[] => linksForControl(db, material);

  /** The one to listen on by default: a link that is up, else the first. */
  function linkForControl(db: any, material: any) {
    const rows = linkRowsForControl(db, material);
    return rows.find(l => linkIsOurs(l.role, l.mode)) ?? rows[0] ?? null;
  }

  /**
   * The same links, shaped for the screen's picker.
   *
   * More than one is a real arrangement rather than an oddity: an analyser
   * whose results SECHLIMS reads directly and also follows through a
   * middleware's log has two links to one machine, and the bench must be able
   * to say which it is standing in front of.
   */
  function linkOptions(db: any, material: any) {
    return linkRowsForControl(db, material).map(l => ({
      id: l.id, name: l.name, equipmentName: l.equipment_name ?? null,
      state: l.state, lastMessageAt: l.last_message_at,
      open: linkIsOurs(l.role, l.mode),
      // Every option offered now belongs to this control's instrument, so
      // there is no longer such a thing as an unsuggested one.
      suggested: true,
      /** Can this link be asked for results, or only waited on? */
      canPull: l.mode === 'file_drop' || l.mode === 'lhims_tap',
    }));
  }

  function reachableControl(db: any, req: any, materialId: number): boolean {
    const row = db.prepare(`SELECT COALESCE(m.performing_section_id, m.section_id, e.section_id) AS resolved
        FROM iqc_materials m LEFT JOIN equipment_items e ON e.id = m.equipment_id WHERE m.id = ?`).get(materialId) as any;
    if (row?.resolved == null) return false;
    const scope = resolveUnitScope(req, row.resolved);
    // A senior post asked for this control's unit and was given it; everybody
    // else is handed their own, which must then be the control's.
    return Number(scope.sectionId) === Number(row.resolved);
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
    // A unit's controls are a unit's, except for the posts that answer for the
    // whole laboratory — they choose which unit's board they are looking at.
    const scope = unitScopePayload(req, req.query.sectionId);
    const sectionId = scope.sectionId;
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date)) ? String(req.query.date) : new Date().toISOString().slice(0, 10);

    if (!sectionId) {
      return res.json({
        date, sectionId: null, groups: [], counts: { due: 0, done: 0, failed: 0, pendingReview: 0 },
        units: scope.units, canChooseUnit: scope.canChooseUnit,
        canPerform: mayPerform(req), canReview: mayReview(req),
        message: 'Your account is not linked to a unit. Ask an administrator to set it.',
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
      // A retrospective lot is not held to its expiry: the dates its runs carry
      // are the dates the laboratory actually ran it, and the lot itself was
      // finished long before this system held it.
      const expired = lotExpired(m.expiry_date, date, m.recording_basis);
      return {
        id: m.id, materialName: m.material_name, materialCode: m.material_code,
        testName: m.test_name, levelLabel: m.level_label, lotNumber: m.lot_number,
        controlType: m.control_type, ruleProfile: m.rule_profile, frequency: m.frequency,
        equipmentId: m.equipment_id, equipmentName: m.equipment_name, equipmentNumber: m.equipment_number,
        expiryDate: m.expiry_date, expired: Boolean(expired),
        recordingBasis: m.recording_basis ?? 'prospective',
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

    // Control runs waiting on the bench, from a posted feed OR from an analyser
    // link the bridge is holding open. Counting only the first meant the tile
    // read zero while the Sysmex was parking controls all morning.
    const pendingFeed = db.prepare(`SELECT COUNT(*) AS n FROM iqc_feed_messages fm
        LEFT JOIN iqc_instrument_feeds f ON f.id = fm.feed_id
        LEFT JOIN instrument_links l ON l.id = fm.link_id
        WHERE fm.status IN ('matched', 'unmatched')
          AND (COALESCE(f.section_id, l.section_id) IS NULL OR COALESCE(f.section_id, l.section_id) = ?)`).get(sectionId) as any;

    res.json({
      date, sectionId,
      units: scope.units, canChooseUnit: scope.canChooseUnit,
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
        why: `${m.equipment_name} does not report results. Move the control to the analyser, or correct the equipment category.`,
      })),
      canPerform: mayPerform(req, sectionId),
      canReview: mayReview(req),
      canDefine: mayDefine(req),
      sectionName: (db.prepare('SELECT name FROM sections WHERE id = ?').get(sectionId) as any)?.name ?? null,
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
    return mayActOnUnit(req, 'iqc', 'create', sectionId);
  }

  router.get('/portal/coverage', (req, res) => {
    const db = getDb();
    const sectionId = resolveUnitScope(req, req.query.sectionId).sectionId;
    if (!sectionId) {
      return res.json({
        sectionId: null, sectionName: null, tests: [], counts: { tests: 0, covered: 0, uncovered: 0, controls: 0, needingLimits: 0 },
        canDefine: false, equipment: [],
        message: 'Your account is not linked to a unit.',
      });
    }

    const section = db.prepare('SELECT id, name FROM sections WHERE id = ?').get(sectionId) as any;
    /*
     * The tests this unit reports — panels and standalone tests, NOT a panel's
     * own parameters.
     *
     * A full blood count is one test. The analyser reports sixteen numbers for
     * it and the menu holds each of them so a report can be laid out, but
     * nobody runs a control "for MCHC": the control is run for the FBC, on the
     * Sysmex, and it judges every parameter of it at once. Listing the
     * parameters here alongside their own panel made haematology look like
     * seventeen uncontrolled tests when it has nine, and invited somebody to
     * define a second control for HCT that would duplicate the first.
     *
     * So a test that belongs to a panel is represented by its panel. A test
     * that belongs to no panel is itself, exactly as before — a malaria RDT and
     * a sickling test are not components of anything and are not touched.
     */
    const tests = db.prepare(`SELECT t.id, t.test_code, t.test_name, t.method_name, t.equipment_id, t.status,
          e.name AS equipment_name, e.equipment_number
        FROM lab_test_catalog t LEFT JOIN equipment_items e ON e.id = t.equipment_id
        WHERE t.section_id = ? AND COALESCE(t.status, 'active') = 'active'
          AND t.parent_test_id IS NULL
        ORDER BY t.test_name`).all(sectionId) as any[];

    const controls = db.prepare(`SELECT m.id, m.material_name, m.test_name, m.level_label, m.lot_number,
          m.control_type, m.expiry_date, m.recording_basis, m.equipment_id, m.is_active,
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
        expiryDate: c.expiry_date, expired: lotExpired(c.expiry_date, today, c.recording_basis),
        recordingBasis: c.recording_basis ?? 'prospective',
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
    if (!sectionId) return res.status(400).json({ error: 'Your staff record is not linked to a unit. Ask an administrator to set it.' });
    if (!mayDefineFor(req, sectionId)) {
      return res.status(403).json({ error: 'You do not have permission to define controls. Ask your unit supervisor.' });
    }

    const materialName = String(req.body?.materialName ?? '').trim();
    const testName = String(req.body?.testName ?? '').trim();
    const lotNumber = String(req.body?.lotNumber ?? '').trim();
    if (!materialName) return res.status(400).json({ error: 'Give the control a name.' });
    if (!testName) return res.status(400).json({ error: 'Name the test this control is for.' });
    if (!lotNumber) return res.status(400).json({ error: 'A lot or batch number is required — a control without one cannot be traced to the vial it came from.' });

    const source = req.body?.source === 'in_house' ? 'in_house' : 'commercial';
    const controlType = ['quantitative', 'qualitative', 'semi_quantitative'].includes(req.body?.controlType)
      ? req.body.controlType : 'quantitative';
    if (source === 'in_house' && !String(req.body?.preparationMethod ?? '').trim()) {
      return res.status(400).json({ error: 'Record how the in-house control was prepared.' });
    }

    const analytes = (Array.isArray(req.body?.analytes) ? req.body.analytes : [])
      .filter((a: any) => String(a?.analyte ?? '').trim());
    if (!analytes.length) return res.status(400).json({ error: 'Add at least one parameter.' });
    if (controlType === 'qualitative' && analytes.some((a: any) => !String(a?.expectedResult ?? '').trim())) {
      return res.status(400).json({ error: 'Every parameter needs an expected result.' });
    }

    // Only the unit's own diagnostic instruments. A control cannot be filed
    // against another unit's analyser from here, and never against a fridge.
    let equipmentId = parseIntNullable(req.body?.equipmentId);
    if (equipmentId !== null) {
      const item = db.prepare('SELECT * FROM equipment_items WHERE id = ?').get(equipmentId) as any;
      if (!item) return res.status(400).json({ error: 'That instrument does not exist.' });
      if (Number(item.section_id) !== Number(sectionId)) {
        return res.status(400).json({ error: `${item.name} belongs to another unit.` });
      }
      if (!equipmentIsDiagnostic(item)) {
        return res.status(400).json({ error: `${item.name} does not report results. Choose an analyser.` });
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
          prepared_by_staff_id, preparation_date, preparation_method, base_material, validation_summary, instructions,
          recording_basis)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(materialCode, materialName, sectionId, sectionId, testName,
          String(analytes[0].analyte).trim(), lotNumber,
          req.body?.manufacturer ?? null, req.body?.expiryDate ?? null, req.body?.openVialExpiry ?? null,
          req.body?.storageCondition ?? null, equipmentId, req.user!.id, createdAt,
          source, controlType, req.body?.levelLabel ?? null,
          req.body?.qcFrequency ?? 'each_run', ruleProfile,
          parseIntNullable(req.body?.preparedByStaffId), req.body?.preparationDate ?? null,
          req.body?.preparationMethod ?? null, req.body?.baseMaterial ?? null,
          req.body?.validationSummary ?? null, req.body?.instructions ?? null,
          // A lot in current use, unless the bench says it is entering one that
          // was run and finished before this system held it.
          IQC_RECORDING_BASES.includes(req.body?.recordingBasis) ? req.body.recordingBasis : 'prospective');
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
        ? `${missingSd} parameter${missingSd === 1 ? '' : 's'} without an SD — limits are calculated from your own runs.`
        : null,
    });
  });

  /* ======================================================================
     Defining a control from the portal
     ----------------------------------------------------------------------
     The wizard is the module's — literally the same component — so what it
     needs here is only the lists it fills its dropdowns from. They are served
     from this router rather than from /sections, /staff and /equipment so the
     right that governs them is the one that governs defining a control, not
     three unrelated module rights a bench scientist may not hold.
     ==================================================================== */
  router.get('/portal/lookups', requirePermission('iqc', 'create'), (req, res) => {
    const db = getDb();
    const sections = db.prepare('SELECT id, name FROM sections ORDER BY name').all();
    const staff = db.prepare('SELECT id, full_name AS fullName FROM staff WHERE is_active = 1 ORDER BY full_name').all();
    // Only diagnostic equipment carries IQC — the same test the module screen
    // applies, from the same shared helper.
    const equipment = (db.prepare(`SELECT id, name, equipment_number, category, equipment_category, equipment_archetype, section_id, status
        FROM equipment_items ORDER BY name`).all() as any[])
      .filter(item => equipmentIsDiagnostic(item));
    res.json({ sections, staff, equipment, sectionId: currentSection(db, req) });
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
    const controlSection = material.performing_section_id ?? material.section_id ?? null;

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
    // What is transmitting for this control. A posted feed if one is attached;
    // otherwise the analyser link held open against the instrument this control
    // runs on — which is the usual case now and was previously reported as
    // "no instrument feed is attached", sending the bench off to configure
    // something that was already working.
    // What is transmitting for this control, asked as widely as the module asks
    // it. Matching only the control's own equipment_id meant a laboratory that
    // registered its machine as "Sysmex XN550" while the link was set up
    // against "SYSMEX XN-550" — two rows for one analyser — got no feed, no
    // Fetch button, and no hint that anything was wrong.
    const feed = material.feed_id
      ? db.prepare('SELECT id, name, transport, protocol, last_message_at, last_error, is_active FROM iqc_instrument_feeds WHERE id = ?').get(material.feed_id)
      : (() => {
          const l = linkForControl(db, material) as any;
          return l ? {
            id: l.id, name: l.name, transport: l.mode, protocol: l.protocol,
            last_message_at: l.last_message_at, last_error: l.last_error,
            is_active: l.is_active, state: l.state,
          } : null;
        })();
    const waiting = db.prepare(`SELECT COUNT(*) AS n FROM iqc_feed_messages
        WHERE iqc_material_id = ? AND status = 'matched'`).get(req.params.id) as any;

    res.json({
      material: {
        ...material,
        entryMethods: parseEntryMethods(material.entry_methods),
        preferredEntryMethod: material.preferred_entry_method || null,
      },
      analytes, recent, layout, feed,
      feedOptions: linkOptions(db, material),
      feedWaiting: Number(waiting?.n ?? 0),
      canPerform: mayPerform(req, controlSection),
      canReview: mayReview(req),
    });
  });

  /* ======================================================================
     The chart, in the portal
     ----------------------------------------------------------------------
     A bench scientist who has just run a control wants to see where the point
     landed. Sending them to the Quality Control module to look is how a chart
     ends up consulted monthly instead of daily — and the run they just entered
     is the one they most need to see in context.

     Reading a chart is not performing quality control, so it needs no tier: if
     the control is on this person's board, they may look at its chart.
     ==================================================================== */

  /** The analytes of one control, for choosing which chart to look at. */
  router.get('/portal/controls/:id/chart-analytes', numericOnly, (req, res) => {
    const db = getDb();
    if (!reachableControl(db, req, Number(req.params.id))) {
      return res.status(404).json({ error: 'That control is not on your unit\'s board.' });
    }
    // Whether a parameter is qualitative is a property of the control, not of
    // the analyte row — a qualitative control's parameters have an expected
    // result rather than a mean, and nothing numeric to chart.
    const material = db.prepare('SELECT control_type FROM iqc_materials WHERE id = ?').get(req.params.id) as any;
    const qualitative = material?.control_type === 'qualitative' ? 1 : 0;
    const rows = db.prepare(`SELECT id, analyte, unit, decimal_places, target_mean, target_sd, expected_result
        FROM iqc_analytes WHERE iqc_material_id = ? AND is_active = 1 ORDER BY display_order, id`).all(req.params.id) as any[];
    res.json(rows.map(row => ({ ...row, is_qualitative: qualitative })));
  });

  /** The chart itself — the same figures the module\'s chart is drawn from. */
  router.get('/portal/analytes/:id/chart', numericOnly, (req, res) => {
    const db = getDb();
    const analyte = db.prepare(`SELECT a.*, m.material_name, m.lot_number, m.test_name, m.control_type,
        m.level_label, m.source, m.id AS material_id
      FROM iqc_analytes a JOIN iqc_materials m ON m.id = a.iqc_material_id WHERE a.id = ?`).get(req.params.id) as any;
    if (!analyte) return res.status(404).json({ error: 'Analyte not found' });
    if (!reachableControl(db, req, Number(analyte.material_id))) {
      return res.status(404).json({ error: 'That control is not on your unit\'s board.' });
    }

    const limit = Math.min(Math.max(Number(req.query.limit) || 120, 10), 500);
    const rows = db.prepare(`SELECT res.id, res.run_date, res.run_time, res.result_value, res.qualitative_result,
        res.expected_result, res.is_qualitative, res.z_score, res.status, res.rule_violation,
        r.id AS run_id, r.run_number, e.name AS equipment_name, s.full_name AS operator_name
      FROM iqc_results res
      LEFT JOIN iqc_runs r ON r.id = res.iqc_run_id
      LEFT JOIN equipment_items e ON e.id = res.equipment_id
      LEFT JOIN staff s ON s.id = res.entered_by_staff_id
      WHERE res.iqc_analyte_id = ? AND COALESCE(r.run_kind, 'control') = 'control'
      ORDER BY res.run_date DESC, res.id DESC LIMIT ?`).all(req.params.id, limit) as any[];
    const points = rows.reverse();
    const numeric = points.filter(p => Number(p.is_qualitative) !== 1).map(p => Number(p.result_value)).filter(v => !Number.isNaN(v));
    // Drawn against the same target the module's chart uses: the vendor's pair
    // where one was entered, otherwise the SD this laboratory established from
    // its own runs. A portal chart scaled differently from the module's chart
    // of the same analyte would be worse than no portal chart.
    const target = effectiveTarget(analyte);
    const lotChanges = db.prepare(`SELECT change_date, reason FROM iqc_lot_changes
      WHERE old_iqc_material_id = ? OR new_iqc_material_id = ? ORDER BY change_date`).all(analyte.material_id, analyte.material_id);

    res.json({
      analyte: {
        id: analyte.id, name: analyte.analyte, unit: analyte.unit, decimalPlaces: analyte.decimal_places,
        targetMean: target.mean, targetSd: target.sd,
        enteredMean: analyte.target_mean, enteredSd: analyte.target_sd,
        acceptableLow: analyte.acceptable_low, acceptableHigh: analyte.acceptable_high,
      },
      target,
      material: {
        id: analyte.material_id, name: analyte.material_name, lotNumber: analyte.lot_number,
        testName: analyte.test_name, levelLabel: analyte.level_label, source: analyte.source,
      },
      statistics: chartStatistics(numeric, target.mean, target.sd),
      lotChanges, points,
      runIds: [...new Set(points.map(p => Number(p.run_id)).filter(Boolean))],
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
    const sectionId = resolveUnitScope(req, req.query.sectionId).sectionId;
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
    const sectionId = resolveUnitScope(req, req.query.sectionId).sectionId;
    const status = typeof req.query.status === 'string' ? req.query.status : null;
    /*
     * WHICH CONTROL, and which analyser — asked together, and answered the way
     * the module answers it.
     *
     * Narrowing on the link alone is what stopped Fetch Results working on the
     * bench while it went on working in the module. This laboratory registers
     * one machine twice — "SYSMEX XN-550" for the link and "Sysmex XN550" for
     * the control — so one instrument carries two links. The bench's picker
     * defaults to one of them; the analyser transmits down the other; the run
     * is parked against the right control perfectly correctly, and a poll
     * narrowed by link id then threw it away. The bench pressed the button, the
     * LHIMS client reported success, and the boxes stayed empty.
     *
     * So the question is the module's question: what has arrived FOR THIS
     * CONTROL — matched to it, or on a link or feed it is listened to on —
     * since the watermark. Given neither, nothing is narrowed and the unit
     * scope below is the only limit, which is what the bench's inbox wants.
     */
    const linkId = parseIntNullable(req.query.linkId);
    const materialId = parseIntNullable(req.query.materialId);
    const feedId = parseIntNullable(req.query.feedId);
    // Everything after the watermark somebody armed with, so a run that was
    // already sitting there is never taken for the one just transmitted.
    const since = parseIntNullable(req.query.since);
    // A control run reaches the bench from one of two places: a feed something
    // else posts into, or an analyser link the bridge is holding open. Both are
    // read here, and the link's name is taken when there is no feed — a message
    // that arrived straight off the Sysmex was showing as "feed" with nothing
    // to say which machine it came from, which is the one thing the bench needs
    // in order to know whether to trust it.
    const rows = db.prepare(`SELECT m.*,
          COALESCE(f.name, l.name) AS feed_name,
          COALESCE(f.protocol, l.protocol) AS protocol,
          COALESCE(e.name, le.name) AS equipment_name,
          l.id AS link_id_joined, l.state AS link_state,
          mat.material_name, mat.test_name, mat.level_label
        FROM iqc_feed_messages m
        LEFT JOIN iqc_instrument_feeds f ON f.id = m.feed_id
        LEFT JOIN equipment_items e ON e.id = f.equipment_id
        LEFT JOIN instrument_links l ON l.id = m.link_id
        LEFT JOIN equipment_items le ON le.id = l.equipment_id
        LEFT JOIN iqc_materials mat ON mat.id = m.iqc_material_id
        WHERE (COALESCE(f.section_id, l.section_id) IS NULL
               OR COALESCE(f.section_id, l.section_id) = ? OR ? IS NULL)
          AND ((? IS NULL AND ? IS NULL AND ? IS NULL)
               OR m.iqc_material_id = ? OR m.link_id = ? OR m.feed_id = ?)
          AND (? IS NULL OR m.status = ?)
          AND (? IS NULL OR m.id > ?)
        ORDER BY m.received_at DESC LIMIT 200`)
      .all(sectionId, sectionId,
        materialId, linkId, feedId, materialId, linkId, feedId,
        status, status, since, since) as any[];
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
  /**
   * The same searchable list, for the bench — scoped to its own unit's board.
   *
   * The run dialog shows the newest few; this is where the rest live, narrowed
   * by day, control, analyser or sample identifier.
   */
  router.get('/portal/transmissions', (req, res) => {
    const q = req.query as Record<string, unknown>;
    const scope = resolveUnitScope(req, q.sectionId);
    res.json(listTransmissions(getDb(), {
      sectionId: scope.sectionId,
      linkId: parseIntNullable(q.linkId),
      materialId: parseIntNullable(q.materialId),
      from: typeof q.from === 'string' ? q.from : null,
      to: typeof q.to === 'string' ? q.to : null,
      search: typeof q.search === 'string' ? q.search : null,
      state: typeof q.state === 'string' ? q.state : null,
      limit: parseIntNullable(q.limit),
      offset: parseIntNullable(q.offset),
    }));
  });

  router.get('/portal/feed-messages/:id/mapping', numericOnly, (req, res) => {
    const db = getDb();
    const message = db.prepare('SELECT * FROM iqc_feed_messages WHERE id = ?').get(req.params.id) as any;
    if (!message) return res.status(404).json({ error: 'Message not found' });
    const materialId = parseIntNullable(req.query.materialId) ?? message.iqc_material_id;
    if (!materialId) return res.status(400).json({ error: 'This message is not matched to a control yet. Choose which control it belongs to.' });

    const analytes = db.prepare('SELECT * FROM iqc_analytes WHERE iqc_material_id = ? AND is_active = 1 ORDER BY display_order, id').all(materialId) as any[];
    // Read from the transmission itself, so a run already on the bench gets the
    // benefit of every later improvement to the parser. See `feedMessageValues`.
    const values = feedMessageValues(db, message);
    // The map that named these parameters. A message from a bridge link has no
    // feed, and reading the feed table for it returned nothing — so every
    // analyte came through under the analyser's own mnemonic and matched
    // nothing on the control.
    const source = message.feed_id
      ? db.prepare('SELECT analyte_map FROM iqc_instrument_feeds WHERE id = ?').get(message.feed_id) as any
      : message.link_id
        ? db.prepare('SELECT analyte_map FROM instrument_links WHERE id = ?').get(message.link_id) as any
        : null;
    const map = (safeJson(source?.analyte_map) as Record<string, string> | null) ?? {};

    // Both the mapped name and the analyser's own mnemonic, because a control
    // may name its parameter either way and only one of the two will match.
    const grid = values.map(v => [
      bestLabel([map[String(v.analyte)] ?? v.analyte, v.code], analytes), v.value,
    ]);
    const mapped = mapRows(grid, analytes);
    res.json({ message: { ...message, parsed_values: values, ...messageFacts(db, message) }, materialId, ...mapped });
  });

  /**
   * Ask this control's analyser to look now.
   *
   * Everything else here waits to be spoken to. After a night with the host
   * switched off — or on a link that reads a folder rather than holding a
   * socket — this is what catches up, and it belongs on the bench screen
   * rather than only in the settings the bench cannot reach.
   */
  router.post('/portal/controls/:id/analyser-fetch', numericOnly, (req, res) => {
    const db = getDb();
    const material = db.prepare('SELECT * FROM iqc_materials WHERE id = ?').get(req.params.id) as any;
    if (!material) return res.status(404).json({ error: 'Control not found' });
    if (!reachableControl(db, req, Number(req.params.id))) {
      return res.status(404).json({ error: 'That control is not on your unit\'s board.' });
    }
    const link = linkForControl(db, material) as any;
    if (!link || !linkIsOurs(link.role, link.mode) || !(link.mode === 'file_drop' || link.mode === 'lhims_tap')) {
      return res.json({ read: 0, note: 'This analyser sends when it is ready; there is nothing here to ask it for.' });
    }
    const bridge = currentBridge();
    if (!bridge) return res.json({ read: 0, note: 'The analyser bridge is not running on this host.' });
    const outcome = bridge.fetchNow(Number(link.id));
    res.json({ read: outcome.read, note: outcome.note });
  });

  /**
   * The PATIENT samples this analyser has sent, for enrolling one to re-read.
   *
   * A previously run sample is a patient's sample, not a control: the whole
   * point of it is that this laboratory already reported a result for it, so
   * the result to compare against is the one that went out on a report. The
   * bench's enrolment was reading the CONTROL runs instead, which is why the
   * sample number came through as "XbarM2" — a control's name — rather than the
   * laboratory number the sample was reported under.
   *
   * The module has had this route since enrolment was built; this is its
   * counterpart on the bench, scoped by the unit whose board the control is on
   * rather than by the Quality Control view right, which a technician running
   * the morning's controls does not hold.
   */
  router.get('/portal/controls/:id/patient-samples', numericOnly, (req, res) => {
    const db = getDb();
    const material = db.prepare('SELECT * FROM iqc_materials WHERE id = ?').get(req.params.id) as any;
    if (!material) return res.status(404).json({ error: 'Control not found' });
    if (!reachableControl(db, req, Number(req.params.id))) {
      return res.status(404).json({ error: 'That control is not on your unit\'s board.' });
    }
    // The link the bench is standing in front of, where it said; otherwise the
    // control's own. A link belonging to another instrument is ignored rather
    // than obeyed, exactly as it is when standing ready.
    const asked = parseIntNullable(req.query.linkId);
    const mine = linkRowsForControl(db, material);
    const link: any = (asked ? mine.find(l => Number(l.id) === Number(asked)) : undefined)
      ?? linkForControl(db, material);
    if (!link) return res.json([]);

    const since = parseIntNullable(req.query.since);
    const search = String(req.query.search ?? '').trim().toLowerCase();
    const rows = db.prepare(`SELECT id, sample_id, received_at, instrument_run_at, parsed_values, result_count
        FROM instrument_messages
        WHERE link_id = ? AND kind = 'patient' AND result_count > 0
          AND (? IS NULL OR id > ?)
          AND (? IS NULL OR LOWER(IFNULL(sample_id, '')) LIKE ?)
        ORDER BY id DESC LIMIT 60`)
      .all(link.id, since, since, search || null, search ? `%${search}%` : null) as any[];

    const map = (safeJson(link.analyte_map) as Record<string, string> | null) ?? {};
    /*
     * Lined up against this control's parameters HERE, not in the browser.
     *
     * The screen was matching the analyser's label to the control's parameter
     * by comparing the two strings, and a Sysmex sends PLT while the link maps
     * it to Platelets and the control calls it PLT — so the platelet count
     * arrived, was displayed, and silently filled nothing. The host already
     * owns that question for control runs, synonyms and all; asking it the same
     * way for a patient sample is the only way the two screens can agree.
     */
    const analytes = db.prepare('SELECT * FROM iqc_analytes WHERE iqc_material_id = ? AND is_active = 1 ORDER BY display_order, id')
      .all(material.id) as any[];
    res.json(rows.map(r => {
      const values = (safeJson(r.parsed_values) ?? []) as any[];
      const named = values.map(v => ({ ...v, analyte: map[String(v.analyte)] ?? v.analyte }));
      const grid = named.map(v => [bestLabel([v.analyte, v.code], analytes), v.value]);
      const { readings } = mapRows(grid, analytes);
      return { ...r, source_name: link.name, parsed_values: named, readings };
    }));
  });

  /**
   * The previously run samples this control may be re-read against.
   *
   * Scoped the way the bench is scoped — by the unit whose board the control is
   * on — rather than by the Quality Control view right, which a technician
   * running the morning's controls does not hold. Enrolling a sample is still a
   * setup act done in the module; this is only the register to pick from.
   */
  router.get('/portal/controls/:id/retained-samples', numericOnly, (req, res) => {
    const db = getDb();
    if (!reachableControl(db, req, Number(req.params.id))) {
      return res.status(404).json({ error: 'That control is not on your unit\'s board.' });
    }
    const rows = db.prepare(`SELECT s.*, e.name AS equipment_name,
        orig.run_number AS original_run_number, orig.run_date AS original_control_date,
        orig.status AS original_control_status,
        (SELECT COUNT(*) FROM iqc_runs r WHERE r.retained_sample_id = s.id) AS rerun_count,
        (SELECT MAX(r.run_date) FROM iqc_runs r WHERE r.retained_sample_id = s.id) AS last_rerun_date
      FROM iqc_retained_samples s
      LEFT JOIN equipment_items e ON e.id = s.equipment_id
      LEFT JOIN iqc_runs orig ON orig.id = s.original_iqc_run_id
      WHERE s.iqc_material_id = ? AND s.is_active = 1
      ORDER BY s.original_run_date DESC, s.id DESC`).all(req.params.id) as any[];
    res.json(rows.map(r => ({
      ...r,
      values: db.prepare(`SELECT v.*, a.analyte, a.unit FROM iqc_retained_sample_values v
          JOIN iqc_analytes a ON a.id = v.iqc_analyte_id
          WHERE v.retained_sample_id = ? ORDER BY a.display_order, a.id`).all(r.id),
    })));
  });

  /**
   * Stand ready for the next transmission, from the bench.
   *
   * The same act as the module's: start the link if it is one SECHLIMS may
   * open, and hand back the newest message as a watermark so the run sitting
   * there from earlier is not taken for the one somebody is standing at the
   * analyser waiting for.
   */
  router.post('/portal/controls/:id/analyser-listen', numericOnly, (req, res) => {
    const db = getDb();
    const material = db.prepare('SELECT * FROM iqc_materials WHERE id = ?').get(req.params.id) as any;
    if (!material) return res.status(404).json({ error: 'Control not found' });
    if (!reachableControl(db, req, Number(req.params.id))) {
      return res.status(404).json({ error: 'That control is not on your unit\'s board.' });
    }
    // The bench may say which of this control's links it is standing in front
    // of, where the instrument carries more than one. It may not name a link
    // belonging to another instrument: a control run attributed to the wrong
    // analyser corrupts that analyser's own mean and chart, and the request is
    // simply ignored rather than obeyed.
    const asked = parseIntNullable(req.body?.linkId);
    const mine = linkRowsForControl(db, material);
    const named = asked ? mine.find(l => Number(l.id) === Number(asked)) : undefined;
    const link: any = named ?? linkForControl(db, material);

    /*
     * The mark spans everything the waiting screen will look at.
     *
     * It polls for what has arrived for this CONTROL — matched to it, or on a
     * link or feed it listens on — so a mark taken over one link alone sits
     * below runs the screen can already see, and the first poll hands back
     * yesterday's run as if it had just been transmitted.
     */
    const newestId = () => Number((db.prepare(`SELECT MAX(id) AS id FROM iqc_feed_messages
        WHERE iqc_material_id = ?
           OR (? IS NOT NULL AND link_id = ?) OR (? IS NOT NULL AND feed_id = ?)`)
      .get(material.id, link?.id ?? null, link?.id ?? null, material.feed_id, material.feed_id) as { id: number | null })?.id ?? 0);
    // A pair, so the module and the bench speak the same shape. The bench only
    // ever watches control runs, so the patient mark stays at zero.
    const since = { control: newestId(), patient: 0 };

    if (!link) return res.json({ listening: Boolean(material.feed_id), since, note: material.feed_id
      ? 'Ready. Send the control from the analyser and it will appear here.'
      : material.equipment_id
        ? 'No analyser link is registered against this control\'s instrument. One is added under Settings → Analyser Links.'
        : 'This control does not say which instrument it runs on, so there is no analyser to fetch from.' });

    if (!linkIsOurs(link.role, link.mode)) {
      return res.json({ listening: false, since, note: 'This link is one LHIMS owns, so nothing will arrive here.' });
    }
    const bridge = currentBridge();
    if (!bridge) return res.json({ listening: false, since, note: 'The analyser bridge is not running on this host.' });
    if (!bridge.isRunning(Number(link.id))) bridge.restart(Number(link.id));

    /**
     * Ask, where asking is possible; wait, where it is not.
     *
     * Both are "fetch", and which one happens is a property of the link rather
     * than anything the bench should have to know. An analyser that dials in
     * decides for itself when to transmit, so there the only honest thing is to
     * stand ready. But where SECHLIMS is the middleware — a folder the analyser
     * exports into, a client's log it follows — the results may already be
     * sitting there, and pressing fetch should go and look, exactly as the
     * LHIMS client's own fetch does. Pressing it and being told to wait for
     * something that arrived an hour ago is how a bench stops pressing it.
     */
    const canPull = link.mode === 'file_drop' || link.mode === 'lhims_tap';
    if (canPull) {
      try { bridge.fetchNow(Number(link.id)); }
      catch { /* what landed is measured below; a failed look is not a failed fetch */ }
    }

    /**
     * What to say, measured rather than assumed.
     *
     * Asking the bridge how many FILES it read is the wrong question twice
     * over: starting a stopped link sweeps its folder on the way up, so the
     * fetch that follows truthfully reports "nothing new" about results it has
     * just this second brought in — and a bench reading that concludes the
     * button does not work. What matters is whether anything arrived for THIS
     * control since the watermark, which is the same thing the screen is about
     * to poll for.
     *
     * The watermark handed back is the one taken BEFORE any of this, so
     * whatever landed is still ahead of it and the waiting screen collects it
     * on its first poll rather than never.
     */
    const landed = newestId() - since.control;
    res.json({
      listening: true, since,
      note: landed > 0
        ? `${landed} control run${landed === 1 ? '' : 's'} brought in. Still listening in case the analyser sends again.`
        : canPull
          ? 'Nothing waiting. Standing by — run the control on the analyser and it will appear here.'
          : 'Ready. Send the control from the analyser and it will appear here.',
    });
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
