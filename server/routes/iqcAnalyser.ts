/**
 * Taking a control's results off the analyser, from wherever the control is
 * being run.
 *
 *   GET  /iqc/materials/:id/analyser                  is an analyser attached, and what is waiting
 *   POST /iqc/materials/:id/analyser/fetch            ask it to look now
 *   GET  /iqc/materials/:id/analyser/messages         the control runs waiting to be brought in
 *   GET  /iqc/materials/:id/analyser/messages/:m/map  those readings against this control's parameters
 *   GET  /iqc/materials/:id/analyser/patient-samples  patient results, for enrolling a previously run sample
 *
 * The bench and the module used to reach this through different routes, so a
 * control could offer the analyser on one screen and not the other. It is one
 * answer now: a control is linked when its instrument has a link, or when a
 * feed was attached to it by hand, and the option appears wherever that is true
 * and nowhere else. A button that cannot do anything teaches people the feature
 * does not work.
 *
 * Nothing here accepts a result. An analyser message is evidence that something
 * was run, not a decision that it passed — it fills the boxes, and a person
 * still presses record.
 */
import { Router } from 'express';
import { getDb } from '../db/database.js';
import { requirePermission } from '../middleware/permissions.js';
import { audit } from '../services/auditService.js';

import { mapRows } from '../services/iqcAnalyteMatching.js';
import { currentBridge } from '../services/instrumentBridge/index.js';
import { linkIsOurs } from '../../shared/constants/instruments.js';

const numericOnly = (req: any, _res: any, next: any) => (/^\d+$/.test(req.params.id) ? next() : next('route'));

function safeJson(value: unknown): any {
  if (typeof value !== 'string' || !value.trim()) return null;
  try { return JSON.parse(value); } catch { return null; }
}

/** Only a folder or a followed log can be asked to look again. */
function canFetch(mode?: string | null): boolean {
  return mode === 'file_drop' || mode === 'lhims_tap';
}

export function iqcAnalyserRoutes() {
  const router = Router();

  /**
   * What is transmitting for this control.
   *
   * An analyser link held against the instrument the control runs on, else a
   * feed somebody attached to the control itself. Both are reported the same
   * way, because the bench does not care which table the arrangement lives in.
   */
  function attachmentFor(materialId: unknown) {
    const db = getDb();
    const material = db.prepare('SELECT * FROM iqc_materials WHERE id = ?').get(materialId) as any;
    if (!material) return null;

    const link = material.equipment_id
      ? db.prepare(`SELECT * FROM instrument_links WHERE equipment_id = ? AND is_active = 1
          ORDER BY (state IN ('listening','connected','following')) DESC, id LIMIT 1`).get(material.equipment_id) as any
      : null;
    const feed = material.feed_id
      ? db.prepare('SELECT * FROM iqc_instrument_feeds WHERE id = ? AND is_active = 1').get(material.feed_id) as any
      : null;

    return { material, link, feed };
  }

  /** The waiting control runs for this control, newest first. */
  function waitingFor(materialId: number, linkId: number | null, feedId: number | null) {
    const db = getDb();
    return (db.prepare(`SELECT m.id, m.sample_id, m.lot_number, m.received_at, m.instrument_run_at,
          m.parsed_values, m.status, m.status_note, m.iqc_material_id,
          COALESCE(f.name, l.name) AS source_name
        FROM iqc_feed_messages m
        LEFT JOIN iqc_instrument_feeds f ON f.id = m.feed_id
        LEFT JOIN instrument_links l ON l.id = m.link_id
        WHERE m.status IN ('matched', 'unmatched')
          AND (m.iqc_material_id = ?
               OR (m.iqc_material_id IS NULL AND (m.link_id = ? OR m.feed_id = ?)))
        ORDER BY m.received_at DESC LIMIT 25`).all(materialId, linkId, feedId) as any[])
      .map(r => ({ ...r, parsed_values: safeJson(r.parsed_values) ?? [] }));
  }

  router.get('/materials/:id/analyser', numericOnly, requirePermission('iqc', 'view'), (req, res) => {
    const found = attachmentFor(req.params.id);
    if (!found) return res.status(404).json({ error: 'IQC material not found' });
    const { material, link, feed } = found;

    if (!link && !feed) {
      return res.json({
        linked: false,
        // Named rather than left blank: "no analyser" and "an analyser this
        // control was never pointed at" are different problems with different
        // remedies, and the bench cannot act on the first wording.
        why: material.equipment_id
          ? 'No analyser link is set up for this control’s instrument yet.'
          : 'This control does not name an instrument, so there is nothing to take results from.',
        waiting: [],
      });
    }

    const waiting = waitingFor(Number(material.id), link?.id ?? null, feed?.id ?? null);
    res.json({
      linked: true,
      source: link
        ? {
            kind: 'link', id: link.id, name: link.name, mode: link.mode, role: link.role,
            protocol: link.protocol, state: link.state, stateDetail: link.state_detail,
            lastError: link.last_error, lastMessageAt: link.last_message_at,
            canFetch: canFetch(link.mode) && linkIsOurs(link.role, link.mode),
            // A link the bridge deliberately never opens will never deliver
            // anything, and saying so here is the difference between a bench
            // waiting all morning and a bench fixing it in a minute.
            open: linkIsOurs(link.role, link.mode),
          }
        : {
            kind: 'feed', id: feed.id, name: feed.name, protocol: feed.protocol,
            state: feed.last_error ? 'error' : 'listening', stateDetail: null,
            lastError: feed.last_error, lastMessageAt: feed.last_message_at,
            canFetch: false, open: true,
          },
      waiting,
    });
  });

  /**
   * Ask the analyser's link to look now.
   *
   * Only a folder or a followed log can answer; an analyser that dials in holds
   * what it has not sent yet, and nothing here can make it send. That is said
   * rather than pretended away.
   */
  router.post('/materials/:id/analyser/fetch', numericOnly, requirePermission('iqc', 'view'), (req, res) => {
    const found = attachmentFor(req.params.id);
    if (!found) return res.status(404).json({ error: 'IQC material not found' });
    const { material, link, feed } = found;
    if (!link && !feed) return res.status(400).json({ error: 'No analyser is attached to this control.' });

    let note = 'The analyser sends when it is ready; there is nothing here to ask.';
    let read = 0;
    if (link && canFetch(link.mode) && linkIsOurs(link.role, link.mode)) {
      const bridge = currentBridge();
      if (!bridge) note = 'The analyser bridge is not running on this host.';
      else {
        const outcome = bridge.fetchNow(Number(link.id));
        note = outcome.note; read = outcome.read;
      }
      audit(req, { action: 'edit', entity: 'instrument_links', entityId: link.id, newValue: { fetchedForControl: material.id, read } });
    }

    res.json({ read, note, waiting: waitingFor(Number(material.id), link?.id ?? null, feed?.id ?? null) });
  });

  /**
   * One message, lined up against this control's parameters.
   *
   * Shown before anything is saved. A system that decides column four is MCHC
   * and is wrong has written a false control record with a real name on it.
   */
  router.get('/materials/:id/analyser/messages/:messageId/map', numericOnly, requirePermission('iqc', 'view'), (req, res) => {
    const db = getDb();
    const material = db.prepare('SELECT * FROM iqc_materials WHERE id = ?').get(req.params.id) as any;
    if (!material) return res.status(404).json({ error: 'IQC material not found' });
    const message = db.prepare('SELECT * FROM iqc_feed_messages WHERE id = ?').get(req.params.messageId) as any;
    if (!message) return res.status(404).json({ error: 'That message is no longer waiting.' });

    const analytes = db.prepare('SELECT * FROM iqc_analytes WHERE iqc_material_id = ? AND is_active = 1 ORDER BY display_order, id')
      .all(material.id) as any[];
    const values = safeJson(message.parsed_values) ?? [];
    const source = message.feed_id
      ? db.prepare('SELECT analyte_map FROM iqc_instrument_feeds WHERE id = ?').get(message.feed_id) as any
      : message.link_id
        ? db.prepare('SELECT analyte_map FROM instrument_links WHERE id = ?').get(message.link_id) as any
        : null;
    const map = safeJson(source?.analyte_map) ?? {};

    const grid = (values as any[]).map(v => [String(map[String(v.analyte)] ?? v.analyte ?? ''), v.value]);
    res.json({
      message: { ...message, parsed_values: values },
      materialId: material.id,
      ...mapRows(grid, analytes),
    });
  });

  /**
   * Patient results the analyser has sent.
   *
   * This is what a previously run sample is enrolled from. The sample was a
   * patient's, its result came off this analyser, and typing that result back
   * in by hand is how a transcription error becomes a QC record. A control run
   * is deliberately not offered here — it is not a previously run sample.
   */
  router.get('/materials/:id/analyser/patient-samples', numericOnly, requirePermission('iqc', 'view'), (req, res) => {
    const found = attachmentFor(req.params.id);
    if (!found) return res.status(404).json({ error: 'IQC material not found' });
    const { link } = found;
    if (!link) return res.json([]);

    const rows = getDb().prepare(`SELECT id, sample_id, received_at, instrument_run_at, parsed_values, result_count
        FROM instrument_messages
        WHERE link_id = ? AND kind = 'patient' AND result_count > 0
        ORDER BY id DESC LIMIT 60`).all(link.id) as any[];

    const map = safeJson(link.analyte_map) ?? {};
    res.json(rows.map(r => {
      const values = (safeJson(r.parsed_values) ?? []) as any[];
      return {
        ...r,
        source_name: link.name,
        parsed_values: values.map(v => ({ ...v, analyte: map[String(v.analyte)] ?? v.analyte })),
      };
    }));
  });

  return router;
}

