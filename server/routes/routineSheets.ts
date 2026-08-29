/**
 * The monthly log sheet, over HTTP.
 *
 *   GET    /routine-sheets                       the unit's sheets for a month
 *   GET    /routine-sheets/:id                   one sheet with its grid
 *   POST   /routine-sheets/open                  open (or fetch) a subject's month
 *   POST   /routine-sheets/:id/cells             record one or many cells
 *   POST   /routine-sheets/:id/submit            close the month for verification
 *   POST   /routine-sheets/:id/reopen            put it back into use
 *   POST   /routine-sheets/:id/verify            supervisor signs it
 *   POST   /routine-sheets/:id/archive           file the signed month
 *   POST   /routine-sheets/:id/nc                raise an NC against the month
 *   GET    /routine-sheets/:id/export.xlsx       the grid and the entry listing
 *   GET    /routine-sheets/:id/template.xlsx     a blank month to fill offline
 *   POST   /routine-sheets/:id/import            load a filled template back
 *   GET    /routine-sheets/:id/print             the sheet as the laboratory knows it
 *   POST   /routine-sheets/:id/attachment        attach the month's paper chart
 *   POST   /routine-sheets/:id/extract           read the attached chart into cells
 *
 * Two different rights are at work and they are deliberately not the same one.
 * Filling a cell is routine work: anyone on duty in the unit does it, gated on
 * the routine_work tier the activity carries. Verifying the month is a
 * supervisor's act and gated on the owning module's approve right — because a
 * signature that anyone can apply is not a signature.
 */
import { Router } from 'express';
import multer from 'multer';
import * as XLSX from 'xlsx';
import { getDb, uploadRoot } from '../db/database.js';
import { requireAuth } from '../middleware/auth.js';
import { requireResolvedPermission } from '../middleware/permissions.js';
import { audit } from '../services/auditService.js';
import { safeStoredFilename } from '../utils/safeFilename.js';
import { parseIntNullable, getCurrentStaffId } from './routeHelpers.js';
import { resolvePermission } from '../services/permissionResolver.js';
import { recordSignature } from '../services/signatureService.js';
import {
  openSheet, refreshSheetRows, sheetPayload, saveCells, submitSheet, reopenSheet,
  verifySheet, archiveSheet, raiseSheetNc, sheetsForSection, subjectsForSection,
} from '../services/routineSheets.js';
import { sheetToHtml, sheetToWorkbook, sheetTemplateWorkbook, parseSheetWorkbook } from '../services/routineSheetRender.js';
import { extractSheetFromFile } from '../services/routineSheetExtraction.js';
import {
  SHEET_KINDS, SHEET_KIND_MODULE, MAX_ATTACHMENT_MB, DEFAULT_ATTACHMENT_MB,
  monthOf, type SheetKind,
} from '../../shared/constants/routineWork.js';
import { tierFeatureKey, TIER_ACTION } from '../../shared/constants/activities.js';

const numericOnly = (req: any, _res: any, next: any) => (/^\d+$/.test(req.params.id) ? next() : next('route'));

function isMonth(value: unknown): boolean {
  return typeof value === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

function isKind(value: unknown): value is SheetKind {
  return typeof value === 'string' && (SHEET_KINDS as readonly string[]).includes(value);
}

/**
 * Which module a sheet answers to, resolved from the sheet itself.
 *
 * A log sheet has no fixed module: a temperature chart belongs to environmental
 * monitoring, a decontamination log to the decontamination programme, a
 * maintenance chart to Equipment. So taking a month out to Excel, loading one
 * back in or printing one is guarded on the right in THAT module — which means
 * the module key has to be looked up per request rather than named in the
 * route. `requireResolvedPermission` is exactly that shape.
 */
function moduleOfSheet(req: any): string | null {
  const sheet = getDb().prepare('SELECT sheet_kind FROM routine_log_sheets WHERE id = ?').get(req.params.id) as any;
  if (!sheet) return null;
  return SHEET_KIND_MODULE[sheet.sheet_kind as SheetKind] ?? 'facilities_safety';
}

export function routineSheetRoutes() {
  const router = Router();
  router.use(requireAuth);

  const attachmentUpload = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => cb(null, uploadRoot),
      filename: (_req, file, cb) => cb(null, safeStoredFilename(file.originalname)),
    }),
    limits: { fileSize: MAX_ATTACHMENT_MB * 1024 * 1024 },
  });
  const workbookUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

  /* ======================================================================
     Who may do what to a sheet
     ==================================================================== */

  /**
   * Filling in a cell is performing routine work. The tier comes from the
   * activity that schedules this sheet's subject where there is one, and
   * otherwise from the kind: charting and decontamination are general work,
   * equipment maintenance is technical unless the laboratory has said otherwise.
   */
  function mayRecord(req: any, sheet: any): boolean {
    const tier = tierForSheet(getDb(), sheet);
    return resolvePermission(req.user!.id, tierFeatureKey(tier), TIER_ACTION).allowed;
  }

  function tierForSheet(db: any, sheet: any): string {
    if (sheet.sheet_kind === 'decontamination') {
      const definition = db.prepare('SELECT performer_tier FROM decontamination_definitions WHERE id = ?').get(sheet.subject_id) as any;
      return definition?.performer_tier || 'general';
    }
    if (sheet.sheet_kind === 'equipment_maintenance') {
      // The chart carries several tasks; the least demanding tier that appears
      // on it decides, because a technician who may do the daily clean should
      // be able to record the daily clean even though the monthly service on
      // the same chart is a scientist's.
      const tiers = (db.prepare('SELECT DISTINCT performer_tier FROM equipment_maintenance_tasks WHERE equipment_id = ? AND is_active = 1').all(sheet.subject_id) as any[])
        .map(t => String(t.performer_tier || 'general'));
      if (tiers.includes('general')) return 'general';
      if (tiers.includes('technical')) return 'technical';
      return tiers[0] || 'general';
    }
    return 'general';
  }

  /** Verifying is the supervisor's, and it is the owning module's approve right. */
  function mayVerify(req: any, sheet: any): boolean {
    const moduleKey = SHEET_KIND_MODULE[sheet.sheet_kind as SheetKind] ?? 'facilities_safety';
    if (resolvePermission(req.user!.id, moduleKey, 'approve').allowed) return true;
    // A unit supervisor holding the supervisory routine-work tier verifies their
    // own unit's sheets without needing rights over the whole module.
    return resolvePermission(req.user!.id, tierFeatureKey('supervisory'), TIER_ACTION).allowed;
  }

  function mayView(req: any, sheet: any): boolean {
    const moduleKey = SHEET_KIND_MODULE[sheet.sheet_kind as SheetKind] ?? 'facilities_safety';
    if (resolvePermission(req.user!.id, moduleKey, 'view').allowed) return true;
    // Everybody reads their own unit's programme; that is the whole point of
    // the portal, and a record nobody may look at does not get kept.
    return resolvePermission(req.user!.id, tierFeatureKey('general'), 'view').allowed
      || resolvePermission(req.user!.id, 'notifications.inbox', 'view').allowed;
  }

  function loadSheet(req: any, res: any): any | null {
    const sheet = getDb().prepare('SELECT * FROM routine_log_sheets WHERE id = ?').get(req.params.id) as any;
    if (!sheet) { res.status(404).json({ error: 'Log sheet not found' }); return null; }
    return sheet;
  }

  /* ======================================================================
     Listing and opening
     ==================================================================== */

  /**
   * Every subject of a kind that a unit charts, with its sheet for the month.
   *
   * The sheets are created on demand: a unit that has never opened a chart
   * still sees its whole programme with empty months, rather than an empty
   * screen that suggests there is nothing to do.
   */
  router.get('/', (req, res) => {
    const db = getDb();
    const kind = isKind(req.query.kind) ? req.query.kind : null;
    if (!kind) return res.status(400).json({ error: `kind must be one of: ${SHEET_KINDS.join(', ')}` });
    const month = isMonth(req.query.month) ? String(req.query.month) : monthOf(new Date().toISOString().slice(0, 10));
    const sectionId = parseIntNullable(req.query.sectionId) ?? currentSectionId(db, req);

    const moduleKey = SHEET_KIND_MODULE[kind];
    if (!resolvePermission(req.user!.id, moduleKey, 'view').allowed
      && !resolvePermission(req.user!.id, tierFeatureKey('general'), 'view').allowed) {
      return res.status(403).json({ error: 'You do not have access to this register.' });
    }

    const rows = sheetsForSection(db, kind, sectionId, month, { userId: req.user!.id });
    res.json({
      kind, month, sectionId,
      sheets: rows,
      canVerify: mayVerify(req, { sheet_kind: kind }),
      canRecord: resolvePermission(req.user!.id, tierFeatureKey('general'), TIER_ACTION).allowed,
    });
  });

  /** The unit the signed-in person belongs to, when the caller did not say. */
  function currentSectionId(db: any, req: any): number | null {
    const staffId = getCurrentStaffId(req);
    if (staffId === null) return null;
    const row = db.prepare('SELECT section_id FROM staff WHERE id = ?').get(staffId) as any;
    return row?.section_id ?? null;
  }

  /** What a unit could be charting, whether or not a sheet exists yet. */
  router.get('/subjects', (req, res) => {
    const kind = isKind(req.query.kind) ? req.query.kind : null;
    if (!kind) return res.status(400).json({ error: 'kind is required' });
    const sectionId = parseIntNullable(req.query.sectionId) ?? currentSectionId(getDb(), req);
    res.json(subjectsForSection(getDb(), kind, sectionId));
  });

  router.post('/open', (req, res) => {
    const db = getDb();
    const kind = isKind(req.body?.kind) ? req.body.kind : null;
    const subjectId = parseIntNullable(req.body?.subjectId);
    const month = isMonth(req.body?.month) ? String(req.body.month) : monthOf(new Date().toISOString().slice(0, 10));
    if (!kind || !subjectId) return res.status(400).json({ error: 'kind and subjectId are required' });

    const sheet = openSheet(db, { kind, subjectId, month, sectionId: parseIntNullable(req.body?.sectionId), userId: req.user!.id });
    if (!sheet) return res.status(404).json({ error: 'That subject does not exist, or has nothing to record on it yet.' });
    refreshSheetRows(db, sheet);
    audit(req, { action: 'create', entity: 'routine_log_sheets', entityId: sheet.id, newValue: { kind, subjectId, month } });
    res.json(sheetPayload(db, sheet.id));
  });

  router.get('/:id', numericOnly, (req, res) => {
    const db = getDb();
    const sheet = loadSheet(req, res);
    if (!sheet) return;
    if (!mayView(req, sheet)) return res.status(403).json({ error: 'You do not have access to this register.' });
    refreshSheetRows(db, sheet);
    const payload = sheetPayload(db, sheet.id);
    res.json({
      ...payload,
      permissions: {
        canRecord: mayRecord(req, sheet) && !payload.sheet.locked,
        canVerify: mayVerify(req, sheet),
        canRaiseNc: resolvePermission(req.user!.id, 'nc_capa', 'create').allowed,
        tier: tierForSheet(db, sheet),
      },
    });
  });

  /* ======================================================================
     Recording
     ==================================================================== */

  /**
   * One cell or a hundred, through the same call.
   *
   * A bench recording this morning's fridge temperature sends one; a unit
   * pasting a month off a spreadsheet sends the lot. Both are the same act —
   * asserting what happened — so both go through the same validation, the same
   * excursion handling and the same audit entry.
   */
  router.post('/:id/cells', numericOnly, (req, res) => {
    const db = getDb();
    const sheet = loadSheet(req, res);
    if (!sheet) return;
    if (!mayRecord(req, sheet)) {
      return res.status(403).json({
        error: `Recording on this sheet needs the "${tierForSheet(db, sheet)}" routine-work tier. Ask your unit head, or an administrator, to grant it to your profile.`,
      });
    }
    const cells = Array.isArray(req.body?.cells) ? req.body.cells
      : req.body?.cell ? [req.body.cell] : null;
    if (!cells || !cells.length) return res.status(400).json({ error: 'Nothing to record.' });

    const staffId = getCurrentStaffId(req);
    const initials = typeof req.body?.initials === 'string' ? req.body.initials.trim().slice(0, 8) : defaultInitials(db, staffId);

    try {
      const result = saveCells(db, sheet.id, cells, { staffId, userId: req.user!.id, initials });
      audit(req, {
        action: 'edit', entity: 'routine_log_sheets', entityId: sheet.id,
        newValue: { recorded: result.saved, breaches: result.breaches.length },
      });
      res.json({ ...result, ...sheetPayload(db, sheet.id) });
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });

  /** A person's initials, from their name, so the bench does not retype them. */
  function defaultInitials(db: any, staffId: number | null): string | null {
    if (staffId === null) return null;
    const staff = db.prepare('SELECT full_name FROM staff WHERE id = ?').get(staffId) as any;
    if (!staff?.full_name) return null;
    return String(staff.full_name).split(/\s+/).filter(Boolean).map((p: string) => p[0]).join('').toUpperCase().slice(0, 4);
  }

  /* ======================================================================
     Closing the month
     ==================================================================== */

  router.post('/:id/submit', numericOnly, (req, res) => {
    const db = getDb();
    const sheet = loadSheet(req, res);
    if (!sheet) return;
    if (!mayRecord(req, sheet)) return res.status(403).json({ error: 'Only staff who record on this sheet can submit it.' });
    try {
      submitSheet(db, sheet.id, getCurrentStaffId(req));
      audit(req, { action: 'edit', entity: 'routine_log_sheets', entityId: sheet.id, newValue: { status: 'submitted' } });
      res.json(sheetPayload(db, sheet.id));
    } catch (error) { res.status(400).json({ error: (error as Error).message }); }
  });

  router.post('/:id/reopen', numericOnly, (req, res) => {
    const db = getDb();
    const sheet = loadSheet(req, res);
    if (!sheet) return;
    if (!mayVerify(req, sheet)) return res.status(403).json({ error: 'Only a supervisor can put a submitted sheet back into use.' });
    try {
      reopenSheet(db, sheet.id);
      audit(req, { action: 'edit', entity: 'routine_log_sheets', entityId: sheet.id, newValue: { status: 'open' } });
      res.json(sheetPayload(db, sheet.id));
    } catch (error) { res.status(400).json({ error: (error as Error).message }); }
  });

  /**
   * The supervisor's verification.
   *
   * This is the act the paper form ends with, and it is the one that has to be
   * real: a named person, a time, a device, a statement of what they are
   * attesting to, and a signature record in the audit trail. Signing a month
   * with gaps is allowed — a laboratory sometimes must — but the gaps are
   * counted back to the signer first, and the count goes into the signature's
   * meaning so nobody can later claim the sheet looked complete.
   */
  router.post('/:id/verify', numericOnly, (req, res) => {
    const db = getDb();
    const sheet = loadSheet(req, res);
    if (!sheet) return;
    if (!mayVerify(req, sheet)) {
      return res.status(403).json({ error: 'Verifying a monthly log sheet is the unit supervisor\'s. Your profile does not hold that right.' });
    }
    const payload = sheetPayload(db, sheet.id);
    if (payload.sheet.locked) return res.status(400).json({ error: 'This sheet has already been verified.' });

    const stats = payload.completeness;
    if (stats.missingCount > 0 && req.body?.acknowledgeGaps !== true) {
      return res.status(409).json({
        error: 'gaps',
        message: `${stats.missingCount} of ${stats.expected} entries were never recorded. You can still verify the month, but the gaps will be written into your signature and normally warrant a nonconformity.`,
        completeness: stats,
      });
    }

    const comments = typeof req.body?.comments === 'string' ? req.body.comments.trim() : '';
    const meaning = `Verified ${payload.sheet.title} for ${payload.sheet.monthLabel}: `
      + `${stats.recorded} of ${stats.expected} entries recorded (${stats.percent}%), `
      + `${stats.missingCount} not recorded, ${stats.breaches} out of range or not done.`;

    try {
      const signature = recordSignature(req, {
        moduleKey: SHEET_KIND_MODULE[sheet.sheet_kind as SheetKind] ?? 'facilities_safety',
        recordType: 'routine_log_sheets', recordId: sheet.id,
        purpose: 'monthly_log_verification', meaning,
        signatureImageFileId: parseIntNullable(req.body?.signatureImageFileId),
      });
      verifySheet(db, sheet.id, { staffId: getCurrentStaffId(req), signatureId: signature.id, comments: comments || null });

      let ncId: number | null = null;
      if (req.body?.raiseNc === true) {
        ncId = raiseSheetNc(db, sheet.id, {
          title: req.body?.ncTitle, description: req.body?.ncDescription,
          severity: req.body?.ncSeverity, staffId: getCurrentStaffId(req), userId: req.user!.id,
        });
      }
      audit(req, { action: 'approve', entity: 'routine_log_sheets', entityId: sheet.id, newValue: { signatureId: signature.id, ncId, comments } });
      res.json({ ...sheetPayload(db, sheet.id), signature, ncId });
    } catch (error) { res.status(400).json({ error: (error as Error).message }); }
  });

  router.post('/:id/nc', numericOnly, (req, res) => {
    const db = getDb();
    const sheet = loadSheet(req, res);
    if (!sheet) return;
    if (!resolvePermission(req.user!.id, 'nc_capa', 'create').allowed) {
      return res.status(403).json({ error: 'Raising a nonconformity needs the NC & CAPA create right.' });
    }
    try {
      const ncId = raiseSheetNc(db, sheet.id, {
        title: req.body?.title, description: req.body?.description, severity: req.body?.severity,
        staffId: getCurrentStaffId(req), userId: req.user!.id,
      });
      audit(req, { action: 'create', entity: 'nonconforming_events', entityId: ncId, newValue: { fromSheet: sheet.id } });
      res.status(201).json({ ncId, ...sheetPayload(db, sheet.id) });
    } catch (error) { res.status(400).json({ error: (error as Error).message }); }
  });

  router.post('/:id/archive', numericOnly, (req, res) => {
    const db = getDb();
    const sheet = loadSheet(req, res);
    if (!sheet) return;
    if (!mayVerify(req, sheet)) return res.status(403).json({ error: 'Archiving a verified sheet is the supervisor\'s.' });
    try {
      const archiveId = archiveSheet(db, sheet.id, {
        staffId: getCurrentStaffId(req), userId: req.user!.id,
        retentionMonths: parseIntNullable(req.body?.retentionMonths), notes: req.body?.notes ?? null,
      });
      audit(req, { action: 'archive', entity: 'routine_log_sheets', entityId: sheet.id, newValue: { archiveId } });
      res.json({ archiveId, ...sheetPayload(db, sheet.id) });
    } catch (error) { res.status(400).json({ error: (error as Error).message }); }
  });

  /* ======================================================================
     Paper in, paper out
     ==================================================================== */

  router.get('/:id/print', numericOnly, requireResolvedPermission(moduleOfSheet, 'print'), (req, res) => {
    const sheet = loadSheet(req, res);
    if (!sheet) return;
    const html = sheetToHtml(getDb(), Number(req.params.id), req.query.autoprint !== '0');
    if (!html) return res.status(404).json({ error: 'Log sheet not found' });
    audit(req, { action: 'print', entity: 'routine_log_sheets', entityId: sheet.id });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  });

  /**
   * The Excel copy.
   *
   * Exporting and importing a whole month is deliberately a stronger right than
   * filling a cell: it is how a month gets rewritten wholesale, so it belongs
   * with the people who answer for the record rather than with everyone on the
   * bench. The laboratory asked for exactly that.
   */
  router.get('/:id/export.xlsx', numericOnly, requireResolvedPermission(moduleOfSheet, 'export'), (req, res) => {
    const sheet = loadSheet(req, res);
    if (!sheet) return;
    const workbook = sheetToWorkbook(getDb(), Number(req.params.id));
    if (!workbook) return res.status(404).json({ error: 'Log sheet not found' });
    audit(req, { action: 'export', entity: 'routine_log_sheets', entityId: sheet.id });
    sendWorkbook(res, workbook, `${slug(sheet.title)}_${sheet.month}.xlsx`);
  });

  router.get('/:id/template.xlsx', numericOnly, (req, res) => {
    const sheet = loadSheet(req, res);
    if (!sheet) return;
    if (!mayRecord(req, sheet)) return res.status(403).json({ error: 'You do not record on this sheet.' });
    const workbook = sheetTemplateWorkbook(getDb(), Number(req.params.id));
    if (!workbook) return res.status(404).json({ error: 'Log sheet not found' });
    sendWorkbook(res, workbook, `${slug(sheet.title)}_${sheet.month}_blank.xlsx`);
  });

  router.post('/:id/import', numericOnly, requireResolvedPermission(moduleOfSheet, 'import'), workbookUpload.single('file'), (req, res) => {
    const db = getDb();
    const sheet = loadSheet(req, res);
    if (!sheet) return;
    if (!req.file) return res.status(400).json({ error: 'No file was uploaded.' });
    try {
      const parsed = parseSheetWorkbook(db, sheet.id, req.file.buffer);
      if (!parsed.cells.length) {
        return res.status(400).json({ error: 'Nothing in that file matched this sheet. Download the blank month and fill that, or check the entry names in the first column.', unmatched: parsed.unmatched });
      }
      const result = saveCells(db, sheet.id, parsed.cells, {
        staffId: getCurrentStaffId(req), userId: req.user!.id, initials: null,
      });
      audit(req, { action: 'import', entity: 'routine_log_sheets', entityId: sheet.id, newValue: { recorded: result.saved } });
      res.json({ ...result, unmatched: parsed.unmatched, ...sheetPayload(db, sheet.id) });
    } catch (error) { res.status(400).json({ error: (error as Error).message }); }
  });

  /**
   * Attach the month's paper chart.
   *
   * Capped, and told plainly why: a laboratory that attaches a 10 MB photograph
   * per fridge per month has a 4 GB database in three years, on hardware that
   * cannot carry it. The cap is a setting; the default is deliberately small.
   */
  router.post('/:id/attachment', numericOnly, attachmentUpload.single('file'), (req, res) => {
    const db = getDb();
    const sheet = loadSheet(req, res);
    if (!sheet) return;
    if (!mayRecord(req, sheet)) return res.status(403).json({ error: 'You do not record on this sheet.' });
    if (!req.file) return res.status(400).json({ error: 'No file was uploaded.' });

    const settings = db.prepare('SELECT max_attachment_mb, chart_upload_enabled FROM environmental_settings WHERE id = 1').get() as any;
    const capMb = Number(settings?.max_attachment_mb ?? DEFAULT_ATTACHMENT_MB);
    if (req.file.size > capMb * 1024 * 1024) {
      return res.status(413).json({ error: `That file is ${(req.file.size / 1048576).toFixed(1)} MB. The laboratory's cap for an attached chart is ${capMb} MB — photograph the chart in black and white, or scan it at a lower resolution.` });
    }

    const file = db.prepare('INSERT INTO files (original_name, stored_name, mime_type, size_bytes, storage_area, uploaded_by) VALUES (?, ?, ?, ?, ?, ?)')
      .run(req.file.originalname, req.file.filename, req.file.mimetype, req.file.size, 'uploads', req.user!.id);
    db.prepare(`UPDATE routine_log_sheets SET attachment_file_id = ?, attachment_kind = ?,
        extraction_status = 'pending', updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(Number(file.lastInsertRowid), req.body?.kind || 'chart', sheet.id);
    audit(req, { action: 'create', entity: 'routine_log_sheets', entityId: sheet.id, newValue: { attachment: req.file.originalname } });
    res.json(sheetPayload(db, sheet.id));
  });

  /**
   * Read the attached chart into the sheet's cells.
   *
   * A digital file — the analyser's CSV, an Excel chart, a Word table — is read
   * exactly. A photograph of a handwritten chart is read as far as the
   * configured reader can, every cell it produces is marked for review, and
   * anything it could not read stays empty for the person to fill. It never
   * silently accepts a number it is not sure of: a confidently wrong
   * temperature is worse than a blank one, because a blank one gets noticed.
   */
  router.post('/:id/extract', numericOnly, async (req, res) => {
    const db = getDb();
    const sheet = loadSheet(req, res);
    if (!sheet) return;
    if (!mayRecord(req, sheet)) return res.status(403).json({ error: 'You do not record on this sheet.' });
    if (!sheet.attachment_file_id) return res.status(400).json({ error: 'Nothing is attached to this sheet yet.' });

    try {
      const outcome = await extractSheetFromFile(db, sheet.id);
      if (outcome.cells.length) {
        saveCells(db, sheet.id, outcome.cells, { staffId: getCurrentStaffId(req), userId: req.user!.id, initials: null, skipIngest: true });
      }
      db.prepare('UPDATE routine_log_sheets SET extraction_status = ?, extraction_note = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run(outcome.status, outcome.note, sheet.id);
      audit(req, { action: 'import', entity: 'routine_log_sheets', entityId: sheet.id, newValue: { extracted: outcome.cells.length, status: outcome.status } });
      res.json({ extraction: outcome, ...sheetPayload(db, sheet.id) });
    } catch (error) {
      db.prepare("UPDATE routine_log_sheets SET extraction_status = 'failed', extraction_note = ? WHERE id = ?")
        .run((error as Error).message, sheet.id);
      res.status(400).json({ error: (error as Error).message });
    }
  });

  /** Confirm the cells a reader was unsure of, one by one or in a batch. */
  router.post('/:id/confirm-review', numericOnly, (req, res) => {
    const db = getDb();
    const sheet = loadSheet(req, res);
    if (!sheet) return;
    if (!mayRecord(req, sheet)) return res.status(403).json({ error: 'You do not record on this sheet.' });
    const ids = Array.isArray(req.body?.cellIds) ? req.body.cellIds.map(Number).filter(Number.isFinite) : [];
    if (ids.length) {
      const q = ids.map(() => '?').join(',');
      db.prepare(`UPDATE routine_log_cells SET needs_review = 0, recorded_by_staff_id = ?, updated_at = CURRENT_TIMESTAMP
          WHERE sheet_id = ? AND id IN (${q})`).run(getCurrentStaffId(req), sheet.id, ...ids);
    } else if (req.body?.all === true) {
      db.prepare('UPDATE routine_log_cells SET needs_review = 0, recorded_by_staff_id = ?, updated_at = CURRENT_TIMESTAMP WHERE sheet_id = ?')
        .run(getCurrentStaffId(req), sheet.id);
    }
    const remaining = (db.prepare('SELECT COUNT(*) AS n FROM routine_log_cells WHERE sheet_id = ? AND needs_review = 1').get(sheet.id) as any).n;
    db.prepare('UPDATE routine_log_sheets SET extraction_status = ? WHERE id = ?').run(remaining ? 'partial' : 'complete', sheet.id);
    res.json(sheetPayload(db, sheet.id));
  });

  return router;
}

function slug(value: string): string {
  return String(value).replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'log_sheet';
}

function sendWorkbook(res: any, workbook: XLSX.WorkBook, filename: string) {
  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(buffer);
}
