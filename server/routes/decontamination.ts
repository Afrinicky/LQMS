/**
 * Decontamination — the programme, and how it reaches the bench.
 *
 * Three things had to be true for this to be usable rather than another
 * register nobody fills in:
 *
 *   The laboratory sets the general programme once. Benches, floors, sinks,
 *   fans, cobwebs — the work every unit does. It ships as a set of frameworks
 *   with sensible frequencies so nobody starts from an empty form, and a unit
 *   head can adjust the frequency for their own room without forking the
 *   definition or asking the quality office.
 *
 *   A unit adds what its own room needs on top. The store room's shelving, the
 *   phlebotomy couch, the microbiology anteroom — these are not laboratory-wide
 *   and pretending they are only produces a programme full of "N/A".
 *
 *   Everybody in the unit can do it. Decontamination is the one piece of
 *   routine work that genuinely is everybody's, so it sits at the general tier
 *   and nothing in the portal asks for a competence the person does not need.
 *
 * A definition is not a reminder. Turning it into one — an entry on the duty
 * list of whoever is rostered that day, at the right frequency — is what
 * `syncSchedule` does, and it runs whenever a definition or a unit's reading of
 * it changes, so the two can never drift apart.
 */
import { Router } from 'express';
import { getDb } from '../db/database.js';
import { requireAuth } from '../middleware/auth.js';
import { requirePermission } from '../middleware/permissions.js';
import { audit } from '../services/auditService.js';
import { parseIntNullable, getCurrentStaffId } from './routeHelpers.js';
import { resolvePermission } from '../services/permissionResolver.js';
import { generateOccurrences } from '../services/activityService.js';
import {
  DECON_FRAMEWORKS, DECON_FREQUENCIES, DECON_TO_ACTIVITY_FREQUENCY, DECON_SCOPES,
  deconTimesPerDay, monthOf,
} from '../../shared/constants/routineWork.js';
import { ACTIVITY_TIERS } from '../../shared/constants/activities.js';
import { sheetsForSection, openSheet, refreshSheetRows } from '../services/routineSheets.js';

const MODULE = 'facilities_safety.decontamination';
const numericOnly = (req: any, _res: any, next: any) => (/^\d+$/.test(req.params.id) ? next() : next('route'));

export function decontaminationRoutes() {
  const router = Router();
  router.use(requireAuth);

  /* ======================================================================
     The frameworks the laboratory can start from
     ==================================================================== */
  router.get('/frameworks', requirePermission(MODULE, 'view'), (_req, res) => {
    const db = getDb();
    const used = new Set((db.prepare('SELECT framework_key FROM decontamination_definitions WHERE framework_key IS NOT NULL').all() as any[])
      .map(r => String(r.framework_key)));
    res.json(DECON_FRAMEWORKS.map(f => ({ ...f, inUse: used.has(f.key) })));
  });

  /* ======================================================================
     Definitions
     ==================================================================== */

  /**
   * The programme, from the reader's point of view.
   *
   * With a section, this is what that unit actually carries: the
   * laboratory-wide definitions at whatever frequency the unit runs them, plus
   * the unit's own, less anything it has been excused from. Without one, it is
   * the whole catalogue as the quality office maintains it.
   */
  router.get('/definitions', requirePermission(MODULE, 'view'), (req, res) => {
    const db = getDb();
    const sectionId = parseIntNullable(req.query.sectionId);
    const includeInactive = req.query.active === 'all';

    ensureDeconSchedules(db, req.user!.id);

    if (sectionId === null) {
      return res.json(db.prepare(`SELECT d.*, s.name AS section_name,
            (SELECT COUNT(*) FROM decontamination_unit_settings u WHERE u.definition_id = d.id AND u.is_excluded = 1) AS excluded_units
          FROM decontamination_definitions d
          LEFT JOIN sections s ON s.id = d.section_id
          ${includeInactive ? '' : 'WHERE d.is_active = 1'}
          ORDER BY CASE d.scope WHEN 'general' THEN 0 ELSE 1 END, s.name, d.name`).all());
    }

    res.json(db.prepare(`SELECT d.*, s.name AS section_name,
          COALESCE(u.frequency, d.frequency) AS effective_frequency,
          COALESCE(u.decontaminant, d.decontaminant) AS effective_decontaminant,
          COALESCE(u.is_excluded, 0) AS is_excluded,
          u.exclusion_reason,
          u.id AS unit_setting_id
        FROM decontamination_definitions d
        LEFT JOIN sections s ON s.id = d.section_id
        LEFT JOIN decontamination_unit_settings u ON u.definition_id = d.id AND u.section_id = ?
        WHERE ${includeInactive ? '1 = 1' : 'd.is_active = 1'}
          AND (d.section_id IS NULL OR d.section_id = ?)
        ORDER BY CASE d.scope WHEN 'general' THEN 0 ELSE 1 END, d.name`).all(sectionId, sectionId));
  });

  router.get('/definitions/:id', numericOnly, requirePermission(MODULE, 'view'), (req, res) => {
    const db = getDb();
    const definition = db.prepare(`SELECT d.*, s.name AS section_name FROM decontamination_definitions d
        LEFT JOIN sections s ON s.id = d.section_id WHERE d.id = ?`).get(req.params.id);
    if (!definition) return res.status(404).json({ error: 'Decontamination not found' });
    const units = db.prepare(`SELECT u.*, s.name AS section_name FROM decontamination_unit_settings u
        JOIN sections s ON s.id = u.section_id WHERE u.definition_id = ? ORDER BY s.name`).all(req.params.id);
    res.json({ ...definition, units });
  });

  function definitionBody(req: any, existing: any = {}) {
    const b = req.body ?? {};
    const pick = <T>(value: T | undefined, fallback: T) => (value === undefined ? fallback : value);
    return {
      name: String(pick(b.name, existing.name) ?? '').trim(),
      scope: String(pick(b.scope, existing.scope) ?? 'general'),
      sectionId: b.sectionId !== undefined ? parseIntNullable(b.sectionId) : (existing.section_id ?? null),
      departmentId: b.departmentId !== undefined ? parseIntNullable(b.departmentId) : (existing.department_id ?? null),
      benchId: b.benchId !== undefined ? parseIntNullable(b.benchId) : (existing.bench_id ?? null),
      surfaceType: pick(b.surfaceType, existing.surface_type) ?? null,
      frequency: String(pick(b.frequency, existing.frequency) ?? 'daily'),
      decontaminant: pick(b.decontaminant, existing.decontaminant) ?? null,
      method: pick(b.method, existing.method) ?? null,
      instructions: pick(b.instructions, existing.instructions) ?? null,
      contactTimeMinutes: b.contactTimeMinutes !== undefined ? parseIntNullable(b.contactTimeMinutes) : (existing.contact_time_minutes ?? null),
      performerTier: String(pick(b.performerTier, existing.performer_tier) ?? 'general'),
      frameworkKey: pick(b.frameworkKey, existing.framework_key) ?? null,
      isActive: b.isActive !== undefined ? (b.isActive ? 1 : 0) : (existing.is_active ?? 1),
    };
  }

  function validate(v: ReturnType<typeof definitionBody>): string | null {
    if (!v.name) return 'A name is required.';
    if (!DECON_SCOPES.includes(v.scope as any)) return `Scope must be one of: ${DECON_SCOPES.join(', ')}.`;
    if (!DECON_FREQUENCIES.includes(v.frequency as any)) return `Frequency must be one of: ${DECON_FREQUENCIES.join(', ')}.`;
    if (!ACTIVITY_TIERS.includes(v.performerTier as any)) return `Who performs it must be one of: ${ACTIVITY_TIERS.join(', ')}.`;
    if (v.scope === 'unit' && !v.sectionId) return 'A unit decontamination needs the unit it belongs to.';
    return null;
  }

  /**
   * Add a decontamination.
   *
   * A unit head may add their own unit's work without holding rights over the
   * laboratory-wide programme — that is the whole point of letting units extend
   * the general set. Changing what every unit carries is a different act and
   * needs the module's own create right.
   */
  router.post('/definitions', (req, res) => {
    const db = getDb();
    const v = definitionBody(req);
    const error = validate(v);
    if (error) return res.status(400).json({ error });

    const labWide = v.scope === 'general';
    const allowed = labWide
      ? resolvePermission(req.user!.id, MODULE, 'create').allowed
      : resolvePermission(req.user!.id, MODULE, 'create').allowed || mayRunUnit(db, req, v.sectionId);
    if (!allowed) {
      return res.status(403).json({
        error: labWide
          ? 'Adding a decontamination for the whole laboratory is the quality office\'s. You can still add one for your own unit.'
          : 'You can only add a decontamination for a unit you lead.',
      });
    }

    const code = String(req.body?.definitionCode ?? '').trim()
      || `DECON-${(v.scope === 'unit' ? 'U' : 'G')}-${Date.now().toString(36).toUpperCase()}`;
    if (db.prepare('SELECT id FROM decontamination_definitions WHERE definition_code = ?').get(code)) {
      return res.status(409).json({ error: `A decontamination with the code "${code}" already exists.` });
    }

    const result = db.prepare(`INSERT INTO decontamination_definitions
        (definition_code, name, scope, section_id, department_id, bench_id, surface_type, frequency,
         decontaminant, method, instructions, contact_time_minutes, performer_tier, framework_key, is_active, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(code, v.name, v.scope, v.sectionId, v.departmentId, v.benchId, v.surfaceType, v.frequency,
        v.decontaminant, v.method, v.instructions, v.contactTimeMinutes, v.performerTier, v.frameworkKey, v.isActive, req.user!.id);

    const id = Number(result.lastInsertRowid);
    syncSchedule(db, id, req.user!.id);
    audit(req, { action: 'create', entity: 'decontamination_definitions', entityId: id, newValue: { code, ...v } });
    res.status(201).json({ id, definitionCode: code });
  });

  router.put('/definitions/:id', numericOnly, (req, res) => {
    const db = getDb();
    const existing = db.prepare('SELECT * FROM decontamination_definitions WHERE id = ?').get(req.params.id) as any;
    if (!existing) return res.status(404).json({ error: 'Decontamination not found' });
    const v = definitionBody(req, existing);
    const error = validate(v);
    if (error) return res.status(400).json({ error });

    const allowed = existing.scope === 'general'
      ? resolvePermission(req.user!.id, MODULE, 'edit').allowed
      : resolvePermission(req.user!.id, MODULE, 'edit').allowed || mayRunUnit(db, req, existing.section_id);
    if (!allowed) return res.status(403).json({ error: 'You cannot change this decontamination.' });

    db.prepare(`UPDATE decontamination_definitions SET name = ?, scope = ?, section_id = ?, department_id = ?,
        bench_id = ?, surface_type = ?, frequency = ?, decontaminant = ?, method = ?, instructions = ?,
        contact_time_minutes = ?, performer_tier = ?, is_active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(v.name, v.scope, v.sectionId, v.departmentId, v.benchId, v.surfaceType, v.frequency, v.decontaminant,
        v.method, v.instructions, v.contactTimeMinutes, v.performerTier, v.isActive, req.params.id);

    syncSchedule(db, Number(req.params.id), req.user!.id);
    audit(req, { action: 'edit', entity: 'decontamination_definitions', entityId: req.params.id, oldValue: existing, newValue: v });
    res.json({ ok: true });
  });

  /**
   * Retiring a decontamination deactivates it rather than deleting it: the
   * months already logged against it are records, and a register that loses its
   * own history when somebody tidies the catalogue is not a register.
   */
  router.delete('/definitions/:id', numericOnly, requirePermission(MODULE, 'edit'), (req, res) => {
    const db = getDb();
    const existing = db.prepare('SELECT * FROM decontamination_definitions WHERE id = ?').get(req.params.id) as any;
    if (!existing) return res.status(404).json({ error: 'Decontamination not found' });
    db.prepare('UPDATE decontamination_definitions SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(req.params.id);
    if (existing.activity_id) db.prepare('UPDATE unit_activities SET is_active = 0 WHERE id = ?').run(existing.activity_id);
    db.prepare('UPDATE unit_activities SET is_active = 0 WHERE id IN (SELECT activity_id FROM decontamination_unit_settings WHERE definition_id = ? AND activity_id IS NOT NULL)').run(req.params.id);
    audit(req, { action: 'delete', entity: 'decontamination_definitions', entityId: req.params.id, oldValue: existing });
    res.json({ ok: true });
  });

  /* ======================================================================
     A unit's reading of the general programme
     ==================================================================== */

  /**
   * "We wipe our benches twice a day; the store room's floor is weekly."
   *
   * A unit adjusting the frequency of a laboratory-wide decontamination is
   * normal practice, not a deviation, so it is a first-class setting rather
   * than a copied definition. Excusing the unit from one entirely is a
   * deviation, and it takes a reason.
   */
  router.put('/definitions/:id/units/:sectionId', numericOnly, (req, res) => {
    const db = getDb();
    const definition = db.prepare('SELECT * FROM decontamination_definitions WHERE id = ?').get(req.params.id) as any;
    if (!definition) return res.status(404).json({ error: 'Decontamination not found' });
    const sectionId = Number(req.params.sectionId);
    if (!Number.isFinite(sectionId)) return res.status(400).json({ error: 'A valid unit is required.' });

    if (!resolvePermission(req.user!.id, MODULE, 'edit').allowed && !mayRunUnit(db, req, sectionId)) {
      return res.status(403).json({ error: 'Only a unit head, or the quality office, can change how a unit runs a decontamination.' });
    }

    const frequency = req.body?.frequency ? String(req.body.frequency) : null;
    if (frequency && !DECON_FREQUENCIES.includes(frequency as any)) {
      return res.status(400).json({ error: `Frequency must be one of: ${DECON_FREQUENCIES.join(', ')}.` });
    }
    const excluded = req.body?.isExcluded === true;
    const reason = String(req.body?.exclusionReason ?? '').trim();
    if (excluded && !reason) {
      return res.status(400).json({ error: 'Excusing a unit from a laboratory-wide decontamination needs a reason. An unexplained gap and a considered exemption look identical in a register, and only one of them is acceptable.' });
    }

    db.prepare(`INSERT INTO decontamination_unit_settings (definition_id, section_id, frequency, decontaminant, is_excluded, exclusion_reason, updated_by, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(definition_id, section_id) DO UPDATE SET
          frequency = excluded.frequency, decontaminant = excluded.decontaminant,
          is_excluded = excluded.is_excluded, exclusion_reason = excluded.exclusion_reason,
          updated_by = excluded.updated_by, updated_at = CURRENT_TIMESTAMP`)
      .run(req.params.id, sectionId, frequency, req.body?.decontaminant ?? null, excluded ? 1 : 0, reason || null, req.user!.id);

    syncSchedule(db, Number(req.params.id), req.user!.id);
    audit(req, { action: 'edit', entity: 'decontamination_unit_settings', entityId: `${req.params.id}:${sectionId}`, newValue: { frequency, excluded, reason } });
    res.json({ ok: true });
  });

  /** Is this person the head of that unit, or otherwise runs it? */
  function mayRunUnit(db: any, req: any, sectionId: number | null): boolean {
    if (!sectionId) return false;
    const staffId = getCurrentStaffId(req);
    if (staffId === null) return false;
    const head = db.prepare('SELECT 1 FROM sections WHERE id = ? AND head_staff_id = ?').get(sectionId, staffId);
    if (head) return true;
    // A laboratory that has not filled in section heads still needs somebody
    // able to run the unit's programme, so the supervisory tier stands in.
    return resolvePermission(req.user!.id, 'routine_work.supervisory', 'create').allowed;
  }

  /* ======================================================================
     Adopting the shipped frameworks
     ==================================================================== */

  /**
   * Take one or more frameworks into the laboratory's programme, editing them
   * on the way in. A laboratory setting up on a Monday morning should be
   * recording decontamination by Monday afternoon.
   */
  router.post('/adopt', requirePermission(MODULE, 'create'), (req, res) => {
    const db = getDb();
    const wanted = Array.isArray(req.body?.frameworks) ? req.body.frameworks : [];
    if (!wanted.length) return res.status(400).json({ error: 'Choose at least one decontamination to adopt.' });

    const created: number[] = [];
    const skipped: string[] = [];
    const insert = db.prepare(`INSERT INTO decontamination_definitions
        (definition_code, name, scope, section_id, surface_type, frequency, decontaminant, method, instructions, framework_key, performer_tier, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'general', ?)`);

    const tx = db.transaction(() => {
      for (const item of wanted) {
        const framework = DECON_FRAMEWORKS.find(f => f.key === String(item.key ?? item));
        if (!framework) continue;
        const sectionId = parseIntNullable(item.sectionId);
        const scope = sectionId ? 'unit' : 'general';
        const code = `DECON-${scope === 'unit' ? `U${sectionId}` : 'GEN'}-${framework.key.toUpperCase().replace(/_/g, '-')}`;
        if (db.prepare('SELECT id FROM decontamination_definitions WHERE definition_code = ?').get(code)) { skipped.push(framework.name); continue; }
        const result = insert.run(code, item.name || framework.name, scope, sectionId, framework.surfaceType,
          item.frequency || framework.frequency, item.decontaminant || framework.decontaminant,
          framework.method, item.instructions || framework.instructions, framework.key, req.user!.id);
        created.push(Number(result.lastInsertRowid));
      }
    });
    tx();
    for (const id of created) syncSchedule(db, id, req.user!.id);
    audit(req, { action: 'create', entity: 'decontamination_definitions', newValue: { adopted: created.length } });
    res.status(201).json({ created: created.length, ids: created, skipped });
  });

  /* ======================================================================
     The monthly logs
     ==================================================================== */

  /** The unit's decontamination logs for a month, ready to work on. */
  router.get('/logs', (req, res) => {
    const db = getDb();
    const month = /^\d{4}-\d{2}$/.test(String(req.query.month)) ? String(req.query.month) : monthOf(new Date().toISOString().slice(0, 10));
    const sectionId = parseIntNullable(req.query.sectionId) ?? currentSection(db, req);
    if (!sectionId) return res.json({ month, sectionId: null, sheets: [] });
    ensureDeconSchedules(db, req.user!.id);
    res.json({ month, sectionId, sheets: sheetsForSection(db, 'decontamination', sectionId, month, { userId: req.user!.id }) });
  });

  /** Open one definition's log for a month directly. */
  router.post('/logs/open', (req, res) => {
    const db = getDb();
    const definitionId = parseIntNullable(req.body?.definitionId);
    const sectionId = parseIntNullable(req.body?.sectionId) ?? currentSection(db, req);
    const month = /^\d{4}-\d{2}$/.test(String(req.body?.month)) ? String(req.body.month) : monthOf(new Date().toISOString().slice(0, 10));
    if (!definitionId) return res.status(400).json({ error: 'definitionId is required' });
    const sheet = openSheet(db, { kind: 'decontamination', subjectId: definitionId, month, sectionId, userId: req.user!.id });
    if (!sheet) return res.status(404).json({ error: 'Decontamination not found' });
    refreshSheetRows(db, sheet);
    res.json({ sheetId: sheet.id });
  });

  function currentSection(db: any, req: any): number | null {
    const staffId = getCurrentStaffId(req);
    if (staffId === null) return null;
    return (db.prepare('SELECT section_id FROM staff WHERE id = ?').get(staffId) as any)?.section_id ?? null;
  }

  return router;
}

/**
 * Make sure every active decontamination has become work on somebody's list.
 *
 * The laboratory-wide programme is seeded into the catalogue when the database
 * is first built, and units are created afterwards — so a definition and a unit
 * that need each other can perfectly well come into existence weeks apart with
 * nothing to introduce them. Without this, a laboratory that adds Haematology
 * in March finds its decontamination programme visible in the register and
 * absent from every bench's duty list, which is the silent failure this whole
 * feature exists to prevent.
 *
 * It is cheap: one query that returns nothing at all once the programme has
 * settled, and it only ever adds what is missing.
 */
export function ensureDeconSchedules(db: any, userId: number | null): void {
  const missing = db.prepare(`SELECT d.id FROM decontamination_definitions d
      WHERE d.is_active = 1 AND (
        (d.section_id IS NOT NULL AND d.activity_id IS NULL)
        OR (d.section_id IS NULL AND EXISTS (
             SELECT 1 FROM sections s WHERE COALESCE(s.is_active, 1) = 1
               AND NOT EXISTS (
                 SELECT 1 FROM decontamination_unit_settings u
                 WHERE u.definition_id = d.id AND u.section_id = s.id AND u.activity_id IS NOT NULL)
               AND NOT EXISTS (
                 SELECT 1 FROM decontamination_unit_settings x
                 WHERE x.definition_id = d.id AND x.section_id = s.id AND x.is_excluded = 1)))
      )`).all() as Array<{ id: number }>;
  for (const row of missing) {
    try { syncSchedule(db, Number(row.id), userId); }
    catch (error) {
      // One malformed definition must not stop the rest of the programme
      // reaching the bench.
      // eslint-disable-next-line no-console
      console.error('[decontamination] could not schedule definition', row.id, (error as Error).message);
    }
  }
}

/* ============================================================================
   Turning a definition into work on somebody's list
   ----------------------------------------------------------------------------
   A definition that never becomes a reminder is a policy document. This is what
   makes it a to-do: one unit_activities row per (definition × unit that carries
   it), at that unit's frequency, assigned to whoever the roster placed there.

   General definitions fan out to every unit; a unit definition makes one. An
   excused unit's activity is deactivated rather than deleted, so the exemption
   and its reason stay visible instead of the work quietly vanishing.
   ========================================================================= */
export function syncSchedule(db: any, definitionId: number, userId: number | null): void {
  const definition = db.prepare('SELECT * FROM decontamination_definitions WHERE id = ?').get(definitionId) as any;
  if (!definition) return;

  const targets: Array<{ sectionId: number; frequency: string; settingId: number | null; excluded: boolean }> = [];
  if (definition.section_id) {
    const setting = db.prepare('SELECT * FROM decontamination_unit_settings WHERE definition_id = ? AND section_id = ?')
      .get(definitionId, definition.section_id) as any;
    targets.push({
      sectionId: definition.section_id,
      frequency: setting?.frequency || definition.frequency,
      settingId: setting?.id ?? null,
      excluded: Boolean(setting?.is_excluded),
    });
  } else {
    const sections = db.prepare('SELECT id FROM sections WHERE COALESCE(is_active, 1) = 1').all() as any[];
    for (const section of sections) {
      const setting = db.prepare('SELECT * FROM decontamination_unit_settings WHERE definition_id = ? AND section_id = ?')
        .get(definitionId, section.id) as any;
      targets.push({
        sectionId: section.id,
        frequency: setting?.frequency || definition.frequency,
        settingId: setting?.id ?? null,
        excluded: Boolean(setting?.is_excluded),
      });
    }
  }

  for (const target of targets) {
    const isOwnSection = definition.section_id === target.sectionId;
    const existingId = isOwnSection
      ? definition.activity_id
      : (db.prepare('SELECT activity_id FROM decontamination_unit_settings WHERE definition_id = ? AND section_id = ?')
          .get(definitionId, target.sectionId) as any)?.activity_id ?? null;

    if (target.excluded || !definition.is_active) {
      if (existingId) db.prepare('UPDATE unit_activities SET is_active = 0 WHERE id = ?').run(existingId);
      continue;
    }

    const frequency = DECON_TO_ACTIVITY_FREQUENCY[target.frequency as keyof typeof DECON_TO_ACTIVITY_FREQUENCY] ?? 'daily';
    const twice = deconTimesPerDay(target.frequency) >= 2;
    const name = definition.name;
    const description = twice
      ? `${definition.name} — before work begins and again after work ends.`
      : definition.name;
    const instructions = [definition.method, definition.decontaminant ? `Decontaminant: ${definition.decontaminant}.` : null,
      definition.contact_time_minutes ? `Leave in contact for ${definition.contact_time_minutes} minutes.` : null,
      definition.instructions].filter(Boolean).join(' ');
    const route = `/facilities-safety?tab=Decontamination&definition=${definitionId}`;

    if (existingId) {
      db.prepare(`UPDATE unit_activities SET name = ?, description = ?, instructions = ?, frequency = ?,
          performer_tier = ?, target_route = ?, is_active = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .run(name, description, instructions, frequency, definition.performer_tier, route, existingId);
      continue;
    }

    const code = `ACT-DECON-${definitionId}-${target.sectionId}`;
    const already = db.prepare('SELECT id FROM unit_activities WHERE activity_code = ?').get(code) as any;
    const activityId = already ? Number(already.id) : Number(db.prepare(`INSERT INTO unit_activities
        (activity_code, name, description, instructions, category, section_id, bench_id, target_module_key, target_route,
         frequency, assign_mode, performer_tier, priority, estimated_minutes, is_active, created_by)
        VALUES (?, ?, ?, ?, 'cleaning', ?, ?, 'facilities_safety.decontamination', ?, ?, 'on_duty', ?, 'normal', ?, 1, ?)`)
      .run(code, name, description, instructions, target.sectionId, definition.bench_id, route, frequency,
        definition.performer_tier, twice ? 10 : 15, userId).lastInsertRowid);

    if (already) db.prepare('UPDATE unit_activities SET is_active = 1, name = ?, frequency = ?, target_route = ? WHERE id = ?').run(name, frequency, route, activityId);

    if (isOwnSection) {
      db.prepare('UPDATE decontamination_definitions SET activity_id = ? WHERE id = ?').run(activityId, definitionId);
    } else {
      db.prepare(`INSERT INTO decontamination_unit_settings (definition_id, section_id, activity_id, updated_by, updated_at)
          VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(definition_id, section_id) DO UPDATE SET activity_id = excluded.activity_id`)
        .run(definitionId, target.sectionId, activityId, userId);
    }
  }

  // Put today's entries on the bench's list straight away rather than waiting
  // for the overnight tick: a unit head who has just added the cobweb sweep
  // wants to see it now.
  try { generateOccurrences(db, {}); } catch { /* the scheduler will catch up */ }
}
