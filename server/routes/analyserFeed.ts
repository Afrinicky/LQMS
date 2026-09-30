/**
 * Taking readings off an analyser, for any module that would otherwise ask
 * somebody to type them.
 *
 *   GET  <module>/analyser/links      which analysers could be listened to
 *   POST <module>/analyser/listen     stand ready for the next transmission
 *   GET  <module>/analyser/messages   what has arrived since
 *
 * Internal quality control got this first, because that is where the drudgery
 * is worst — twenty-three parameters, three levels, every morning. But the
 * drudgery is not special to it. An external quality assessment sample is run
 * on the same analyser and its results are typed in off the same printout; a
 * precision study is twenty replicates read off the same screen. The analyser
 * has already said all of it, out loud, over a wire.
 *
 * So the mechanics live here once, and each module decides only what to DO with
 * the values that arrive — control readings, a reported EQA result, a replicate
 * row. What it never does is accept anything: an analyser message is evidence
 * that something was measured, not a decision that it is fit to record. It
 * fills the boxes and a person still presses save.
 *
 * Mounted once per module with that module's own view right, so an account that
 * may read EQA does not thereby gain the verification register.
 */
import { Router } from 'express';
import { getDb } from '../db/database.js';
import { requirePermission } from '../middleware/permissions.js';
import { parseIntNullable } from './routeHelpers.js';
import { currentBridge } from '../services/instrumentBridge/index.js';
import { linkIsOurs } from '../../shared/constants/instruments.js';

function safeJson(value: unknown): any {
  if (typeof value !== 'string' || !value.trim()) return null;
  try { return JSON.parse(value); } catch { return null; }
}

/** Only a folder or a followed log can be asked; the rest send when ready. */
function canFetch(mode?: string | null): boolean {
  return mode === 'file_drop' || mode === 'lhims_tap';
}

export function analyserFeedRoutes(moduleKey: string) {
  const router = Router();
  const mayView = requirePermission(moduleKey, 'view');

  /**
   * The analysers this screen could take results from.
   *
   * Ordered by how likely each is to be the one meant: the instrument the work
   * names, then the unit's, then whatever else is transmitting. Every link is
   * listed rather than only the best guess, because a laboratory that
   * registered one machine twice under slightly different names has no exact
   * match and still has an analyser sitting there talking.
   */
  router.get('/analyser/links', mayView, (req, res) => {
    const equipmentId = parseIntNullable(req.query.equipmentId);
    const sectionId = parseIntNullable(req.query.sectionId);
    const rows = getDb().prepare(`SELECT l.id, l.name, l.mode, l.role, l.state, l.equipment_id, l.section_id,
          l.last_message_at, e.name AS equipment_name
        FROM instrument_links l LEFT JOIN equipment_items e ON e.id = l.equipment_id
        WHERE l.is_active = 1
        ORDER BY (l.equipment_id = ?) DESC, (l.section_id = ?) DESC,
                 (l.state IN ('listening','connected','following')) DESC, l.name`)
      .all(equipmentId, sectionId) as any[];

    res.json(rows.map(l => ({
      id: l.id, name: l.name, equipmentName: l.equipment_name ?? null,
      state: l.state, lastMessageAt: l.last_message_at,
      // A link the bridge never opens will never deliver anything, and a
      // screen that lets somebody wait on it wastes their morning.
      open: linkIsOurs(l.role, l.mode),
      canFetch: canFetch(l.mode) && linkIsOurs(l.role, l.mode),
      suggested: (equipmentId != null && Number(l.equipment_id) === equipmentId)
        || (sectionId != null && Number(l.section_id) === sectionId),
    })));
  });

  /**
   * Stand ready for the next transmission.
   *
   * The link is started if it is one SECHLIMS may open, and the newest message
   * it has already sent comes back as a watermark. Everything after that is
   * new — which is what stops this morning's run being taken for the one
   * somebody is standing at the analyser waiting for.
   */
  router.post('/analyser/listen', mayView, (req, res) => {
    const db = getDb();
    const linkId = parseIntNullable(req.body?.linkId);
    if (!linkId) return res.status(400).json({ error: 'Say which analyser to listen to.' });
    const link = db.prepare('SELECT * FROM instrument_links WHERE id = ? AND is_active = 1').get(linkId) as any;
    if (!link) return res.status(404).json({ error: 'That analyser link is not set up.' });

    const newest = db.prepare('SELECT MAX(id) AS id FROM instrument_messages WHERE link_id = ?').get(linkId) as
      { id: number | null } | undefined;
    const since = { control: 0, patient: Number(newest?.id ?? 0) };

    if (!linkIsOurs(link.role, link.mode)) {
      return res.json({
        listening: false, since,
        note: 'This link is recorded as one LHIMS owns, so SECHLIMS never opens it and nothing will arrive. '
          + 'Set it to follow the LHIMS client\'s log to take a copy instead.',
      });
    }
    const bridge = currentBridge();
    if (!bridge) return res.json({ listening: false, since, note: 'The analyser bridge is not running on this host.' });

    let note = 'Ready. Send the sample from the analyser and its results drop in here.';
    if (!bridge.isRunning(linkId)) {
      bridge.restart(linkId);
      note = 'The link was not running, so it was started. Send the sample from the analyser.';
    } else if (canFetch(link.mode)) {
      bridge.fetchNow(linkId);
    }
    res.json({ listening: true, since, note });
  });

  /**
   * What this analyser has said since the watermark.
   *
   * Parsed values come back under the names this system uses, mapped through
   * the link's own analyte map — so "HGB" arrives as Haemoglobin and the
   * screen receiving it does not have to know what a Sysmex calls things.
   */
  router.get('/analyser/messages', mayView, (req, res) => {
    const db = getDb();
    const linkId = parseIntNullable(req.query.linkId);
    if (!linkId) return res.json([]);
    const since = parseIntNullable(req.query.since);
    const kind = typeof req.query.kind === 'string' && req.query.kind ? String(req.query.kind) : null;
    const link = db.prepare('SELECT analyte_map FROM instrument_links WHERE id = ?').get(linkId) as any;
    const map = safeJson(link?.analyte_map) ?? {};

    const rows = db.prepare(`SELECT id, sample_id, lot_number, received_at, instrument_run_at,
          parsed_values, result_count, kind
        FROM instrument_messages
        WHERE link_id = ? AND result_count > 0
          AND (? IS NULL OR kind = ?)
          AND (? IS NULL OR id > ?)
        ORDER BY id DESC LIMIT 50`).all(linkId, kind, kind, since, since) as any[];

    res.json(rows.map(r => {
      const values = (safeJson(r.parsed_values) ?? []) as any[];
      return {
        ...r,
        parsed_values: values.map(v => ({
          ...v,
          analyte: map[String(v.code ?? v.analyte)] ?? v.analyte ?? v.code,
        })),
      };
    }));
  });

  return router;
}
