/**
 * The appointment register, over HTTP.
 *
 *   GET  /appointments                      every post, every unit, who holds what
 *   POST /appointments                      appoint somebody to a post
 *   POST /appointments/vacate               end an appointment
 *   PUT  /appointments/posts/:id/supervises which unit a post supervises
 *
 * This is the only surface that changes who holds a post. The screens that
 * used to do it — the organogram, the unit profile, the personnel register —
 * now show the appointment and send the person here to change it, and the
 * routes behind them no longer write one.
 */
import { Router } from 'express';
import { getDb } from '../db/database.js';
import { requireAuth } from '../middleware/auth.js';
import { requirePermission } from '../middleware/permissions.js';
import { resolvePermission } from '../services/permissionResolver.js';
import { audit } from '../services/auditService.js';
import { appoint, appointmentRegister, setSupervisedUnit, vacate } from '../services/appointments.js';

export function appointmentRoutes() {
  const router = Router();
  router.use(requireAuth);

  /**
   * The register, as one answer.
   *
   * Read by anybody who may see the settings area: who runs which unit is not
   * a secret, and the screens that link here show the same thing read-only.
   */
  router.get('/', requirePermission('settings', 'view'), (req, res) => {
    /*
     * What this reader may actually do, decided once by the server.
     *
     * Appointing to a post and standing somebody in for a unit are governed by
     * different rights — one is the laboratory's establishment, the other its
     * rosters — and a screen that draws buttons the API will refuse is a
     * screen people stop trusting.
     */
    const may = (key: string, action: string) => resolvePermission(req.user!.id, key, action).allowed;
    res.json({
      ...appointmentRegister(getDb()),
      may: {
        appoint: may('settings', 'edit'),
        acting: may('personnel.rosters', 'create'),
        endActing: may('personnel.rosters', 'edit'),
        deleteActing: may('personnel.rosters', 'void_archive'),
        print: may('personnel.rosters', 'print'),
      },
    });
  });

  /** Appoint somebody. One post, one holder; the predecessor's ends here. */
  router.post('/', requirePermission('settings', 'edit'), (req, res) => {
    const outcome = appoint(getDb(), {
      positionId: req.body?.positionId,
      staffId: req.body?.staffId,
      kind: req.body?.kind,
      note: req.body?.note,
    });
    if (!outcome.ok) return res.status(outcome.status ?? 400).json({ error: outcome.error });

    audit(req, {
      action: 'appoint', entity: 'staff_position_assignments', entityId: outcome.positionId,
      newValue: {
        positionId: outcome.positionId, staffId: outcome.staffId, kind: outcome.kind,
        replacedStaffId: outcome.replacedStaffId, sectionId: outcome.sectionId,
        note: req.body?.note ?? null, summary: outcome.summary,
      },
    });
    res.status(201).json(outcome);
  });

  /** End an appointment, leaving the post vacant and saying so. */
  router.post('/vacate', requirePermission('settings', 'edit'), (req, res) => {
    const outcome = vacate(getDb(), { positionId: req.body?.positionId, staffId: req.body?.staffId });
    if (!outcome.ok) return res.status(outcome.status ?? 400).json({ error: outcome.error });
    audit(req, {
      action: 'vacate', entity: 'staff_position_assignments', entityId: outcome.positionId,
      newValue: { positionId: outcome.positionId, staffId: outcome.staffId, summary: outcome.summary },
    });
    res.json(outcome);
  });

  /**
   * Which unit a post supervises.
   *
   * Named on the post rather than read out of its title, so renaming
   * "Microbiology Unit Supervisor" does not quietly detach it from
   * Microbiology — and so a laboratory whose posts are called something else
   * entirely still has unit supervisors the system understands.
   */
  router.put('/posts/:id/supervises', requirePermission('settings', 'edit'), (req, res) => {
    const outcome = setSupervisedUnit(getDb(), req.params.id, req.body?.sectionId ?? null);
    if (!outcome.ok) return res.status(outcome.status ?? 400).json({ error: outcome.error });
    audit(req, {
      action: 'edit', entity: 'positions', entityId: Number(req.params.id),
      newValue: { supervisesSectionId: req.body?.sectionId ?? null },
    });
    res.json({ ok: true });
  });

  return router;
}
