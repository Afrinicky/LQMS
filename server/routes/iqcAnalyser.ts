/**
 * Taking a control's results off the analyser, from wherever the control is
 * being run.
 *
 *   GET  /iqc/materials/:id/analyser                  is an analyser attached, and what is waiting
 *   POST /iqc/materials/:id/analyser/fetch            ask it to look now
 *   POST /iqc/materials/:id/analyser/listen           stand ready for the next transmission
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
import { parseIntNullable } from './routeHelpers.js';

import { bestLabel, mapRows } from '../services/iqcAnalyteMatching.js';
import { currentBridge } from '../services/instrumentBridge/index.js';
import { linkIsOurs } from '../../shared/constants/instruments.js';
import { linksForControl } from '../services/controlAnalyser.js';
import { feedMessageValues, messageFacts } from '../services/feedMessageValues.js';
import { listTransmissions } from '../services/transmissionList.js';

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
   * Matching only the control's own equipment_id was too narrow, and the way it
   * failed was invisible: a laboratory that registered "Sysmex XN550" as its
   * instrument and set the link up against "SYSMEX XN-550" has two equipment
   * rows for one machine, no match, and the whole panel silently absent — so
   * the bench went back to typing twenty-three numbers off a printout with no
   * indication that anything was wrong.
   *
   * So the question is asked of the INSTRUMENT, and only of the instrument:
   * the one chosen on the run itself, else the one recorded on the control.
   * Every link registered against that machine is a candidate, and nothing
   * else is.
   *
   * It used to widen further than that — to any link on the unit, and then to
   * "the only analyser this laboratory owns" — and both of those attach a
   * control run to a machine it was not run on. A control run is a statement
   * about one instrument's performance: CLSI C24 has a mean, a standard
   * deviation and a Levey-Jennings chart kept per instrument, and ISO 15189
   * has the laboratory demonstrate comparability BETWEEN instruments, neither
   * of which survives a run filed against the wrong one. An accepted run
   * cannot be un-attributed afterwards, so the guess has to be right or absent.
   */
  function attachmentFor(materialId: unknown, preferredEquipmentId?: number | null, preferredLinkId?: number | null) {
    const db = getDb();
    const material = db.prepare('SELECT * FROM iqc_materials WHERE id = ?').get(materialId) as any;
    if (!material) return null;

    // The instrument this run is on: what the run says, else what the control
    // says. A control with neither has no analyser, which is the honest answer
    // for a manual method. One machine registered twice under slightly
    // different spellings is still one machine — the rule, and why it is drawn
    // exactly there, is in `controlAnalyser.ts`.
    const equipmentId = preferredEquipmentId ?? material.equipment_id ?? null;
    const options: any[] = linksForControl(db, { equipment_id: equipmentId });

    // The bench may say which of this instrument's links it means; it may not
    // name one belonging to a different machine.
    const named: any = preferredLinkId
      ? options.find(l => Number(l.id) === Number(preferredLinkId)) ?? null
      : null;
    const link: any = named ?? options[0] ?? null;

    const feed = material.feed_id
      ? db.prepare('SELECT * FROM iqc_instrument_feeds WHERE id = ? AND is_active = 1').get(material.feed_id) as any
      : null;

    return { material, link, feed, options };
  }

  /**
   * The waiting control runs for this control, newest first.
   *
   * `since` is what makes standing ready work: the screen remembers the newest
   * message at the moment somebody pressed Fetch, and asks only for what has
   * landed after it. Anything else and the run sitting there from yesterday
   * would be taken for the one the analyser has just sent.
   */
  function waitingFor(materialId: number, linkId: number | null, feedId: number | null, since?: number | null) {
    const db = getDb();
    // Everything this analyser has sent that has not been accepted, whichever
    // control the system guessed it belonged to, NEWEST FIRST.
    //
    // It used to put the runs matched to a control above the rest, and that
    // quietly broke the screen. A run matched to ANOTHER control scores higher
    // than one matched to nothing, so two September runs belonging to other
    // controls sat permanently at the top while every unmatched run — which is
    // most of them, and includes every X-bar M the analyser sends — sorted
    // below. Showing the newest five then showed five old ones, and the control
    // somebody had just transmitted was nowhere, however correctly it had
    // arrived.
    //
    // The question this list answers is "what has just come in", so it is
    // answered by when things came in. Finding a particular run is a different
    // question, and the register answers that one with filters.
    //
    // Guessing is all it can do: an analyser that puts no lot number in its
    // transmission leaves only the sample identifier and the instrument to go
    // on, so a run of THIS control gets parked against whichever other control
    // shares the machine. Hiding it then is the worst of both — the bench ran
    // the control, watched the screen, and saw nothing. So it is offered, and
    // said plainly to have been read as another control's, and the reading is
    // mapped onto whichever control the bench is actually running.
    return (db.prepare(`SELECT m.id, m.sample_id, m.lot_number, m.received_at, m.instrument_run_at,
          m.parsed_values, m.status, m.status_note, m.iqc_material_id,
          COALESCE(f.name, l.name) AS source_name,
          CASE WHEN m.iqc_material_id IS NOT NULL AND m.iqc_material_id != ?
               THEN mat.material_name END AS matched_elsewhere
        FROM iqc_feed_messages m
        LEFT JOIN iqc_instrument_feeds f ON f.id = m.feed_id
        LEFT JOIN instrument_links l ON l.id = m.link_id
        LEFT JOIN iqc_materials mat ON mat.id = m.iqc_material_id
        WHERE m.status IN ('matched', 'unmatched')
          AND (m.iqc_material_id = ? OR m.link_id = ? OR m.feed_id = ?)
          AND (? IS NULL OR m.id > ?)
        ORDER BY m.received_at DESC, m.id DESC LIMIT 25`)
      .all(materialId, materialId, linkId, feedId, since ?? null, since ?? null) as any[])
      .map(r => ({ ...r, parsed_values: safeJson(r.parsed_values) ?? [] }));
  }

  /**
   * The newest thing this control's analyser has sent, as TWO marks.
   *
   * Control runs are numbered in iqc_feed_messages and patient results in
   * instrument_messages, and those are separate sequences. One mark across both
   * takes the larger of two unrelated numbers, and the smaller table's
   * genuinely new rows then sit below it and are never seen — the bench presses
   * Fetch, the analyser transmits, and nothing appears.
   */
  function newestWatermark(linkId: number | null, feedId: number | null): { control: number; patient: number } {
    const db = getDb();
    const control = db.prepare(`SELECT MAX(id) AS id FROM iqc_feed_messages
        WHERE (? IS NOT NULL AND link_id = ?) OR (? IS NOT NULL AND feed_id = ?)`)
      .get(linkId, linkId, feedId, feedId) as { id: number | null } | undefined;
    const patient = linkId
      ? (db.prepare('SELECT MAX(id) AS id FROM instrument_messages WHERE link_id = ?').get(linkId) as { id: number | null } | undefined)
      : undefined;
    return { control: Number(control?.id ?? 0), patient: Number(patient?.id ?? 0) };
  }

  router.get('/materials/:id/analyser', numericOnly, requirePermission('iqc', 'view'), (req, res) => {
    const found = attachmentFor(req.params.id, parseIntNullable(req.query.equipmentId), parseIntNullable(req.query.linkId));
    if (!found) return res.status(404).json({ error: 'IQC material not found' });
    const { material, link, feed, options } = found;

    // Every link registered against this instrument, so a machine carrying two
    // of them — read directly and followed through a middleware's log — is a
    // dropdown rather than a guess.
    const choices = options.map(l => ({
      id: l.id, name: l.name, equipmentName: l.equipment_name ?? null,
      state: l.state, open: linkIsOurs(l.role, l.mode),
      /** Can this link be asked for results, or only waited on? */
      canPull: canFetch(l.mode) && linkIsOurs(l.role, l.mode),
    }));

    if (!link && !feed) {
      const equipmentId = parseIntNullable(req.query.equipmentId) ?? material.equipment_id ?? null;
      return res.json({
        linked: false,
        // Two different problems with two different remedies, and the bench
        // cannot act on a wording that conflates them: either the control does
        // not say which machine it runs on, or that machine has no link.
        why: equipmentId == null
          ? 'This control does not say which instrument it runs on, so there is no analyser to take results from. Set the instrument on the control.'
          : 'No analyser link is registered against this control’s instrument. One is added under Analyser Links.',
        options: choices,
        waiting: [],
      });
    }

    const since = parseIntNullable(req.query.since);
    const waiting = waitingFor(Number(material.id), link?.id ?? null, feed?.id ?? null, since);
    res.json({
      linked: true,
      options: choices,
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
    const found = attachmentFor(req.params.id,
      parseIntNullable(req.body?.equipmentId), parseIntNullable(req.body?.linkId));
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
   * Stand ready for the next transmission.
   *
   * What "fetch" means for an analyser that dials in rather than being asked:
   * there is nothing to pull, so the honest thing is to be ready and to say so.
   * The link is started if it is one SECHLIMS may open, and the newest message
   * this analyser has sent is handed back as a watermark. Everything after that
   * watermark is new — which is what stops yesterday's run being taken for the
   * one somebody is standing at the analyser waiting for.
   */
  router.post('/materials/:id/analyser/listen', numericOnly, requirePermission('iqc', 'view'), (req, res) => {
    const found = attachmentFor(req.params.id,
      parseIntNullable(req.body?.equipmentId), parseIntNullable(req.body?.linkId));
    if (!found) return res.status(404).json({ error: 'IQC material not found' });
    const { link, feed } = found;
    if (!link && !feed) return res.status(400).json({ error: 'No analyser is attached to this control.' });

    const since = newestWatermark(link?.id ?? null, feed?.id ?? null);
    let note = 'Ready. Send the sample from the analyser and it will appear here.';
    let listening = true;

    if (link) {
      if (!linkIsOurs(link.role, link.mode)) {
        listening = false;
        note = 'This link is recorded as one LHIMS owns, so SECHLIMS never opens it and nothing will arrive. '
          + 'Set it to follow the LHIMS client\'s log to take a copy instead.';
      } else {
        const bridge = currentBridge();
        if (!bridge) {
          listening = false;
          note = 'The analyser bridge is not running on this host.';
        } else {
          // Standing ready has to actually open the door. A screen that says
          // "waiting" over a link that was never started waits for ever.
          if (!bridge.isRunning(Number(link.id))) bridge.restart(Number(link.id));

          /**
           * Ask, where asking is possible; wait, where it is not.
           *
           * Which of the two happens is a property of the link, not something
           * the bench should have to know. An analyser that dials in decides
           * for itself when to transmit, so there the only honest thing is to
           * stand ready. But where SECHLIMS is itself the middleware — a folder
           * the analyser exports into, a client's log it follows — the results
           * may already be sitting there, and pressing fetch must go and look,
           * exactly as the LHIMS client's own fetch does. This was skipped
           * entirely whenever the link had just been started, which is the one
           * moment a backlog is most likely to be waiting.
           */
          if (canFetch(link.mode)) {
            try { bridge.fetchNow(Number(link.id)); }
            catch { /* what landed is measured below, not taken on trust */ }
          }

          // Measured, not assumed: starting a stopped link sweeps its folder on
          // the way up, so the fetch that follows reports "nothing new" about
          // results it has just brought in. What arrived since the watermark is
          // the honest answer, and the watermark handed back is still the one
          // taken before any of it, so the waiting screen collects them.
          const landed = newestWatermark(link?.id ?? null, feed?.id ?? null).control - since.control;
          if (landed > 0) {
            note = `${landed} control run${landed === 1 ? '' : 's'} brought in. Still listening in case the analyser sends again.`;
          } else if (canFetch(link.mode)) {
            note = 'Nothing waiting. Standing by — send the sample from the analyser.';
          }
        }
      }
      audit(req, { action: 'edit', entity: 'instrument_links', entityId: link.id, newValue: { armedForControl: req.params.id } });
    }

    res.json({ listening, since, note });
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
    // Read from the transmission itself, so a run already on the bench gets the
    // benefit of every later improvement to the parser. See `feedMessageValues`.
    const values = feedMessageValues(db, message);
    const source = message.feed_id
      ? db.prepare('SELECT analyte_map FROM iqc_instrument_feeds WHERE id = ?').get(message.feed_id) as any
      : message.link_id
        ? db.prepare('SELECT analyte_map FROM instrument_links WHERE id = ?').get(message.link_id) as any
        : null;
    const map = safeJson(source?.analyte_map) ?? {};

    // Both the mapped name and the analyser's own mnemonic are offered to the
    // matcher: a control whose parameter is called "HGB" and one whose
    // parameter is called "Haemoglobin" are the same control to a bench, and
    // only one of the two labels will match either of them.
    const grid = values.map(v => [
      bestLabel([map[String(v.analyte)] ?? v.analyte, v.code], analytes), v.value,
    ]);
    res.json({
      message: { ...message, parsed_values: values, ...messageFacts(db, message) },
      materialId: material.id,
      ...mapRows(grid, analytes),
    });
  });

  /**
   * Every control run the analysers have sent, searchable.
   *
   * The run form shows the newest few, because a bench is looking for the one
   * they have just put on the machine. This is the rest of them — narrowed by
   * day, by control, by analyser or by the identifier the machine used — so
   * "the newest few" does not mean a fortnight's runs falling off the bottom
   * of a list with nowhere to look them up.
   */
  router.get('/analyser/transmissions', requirePermission('iqc', 'view'), (req, res) => {
    const q = req.query as Record<string, unknown>;
    res.json(listTransmissions(getDb(), {
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

  /**
   * Patient results the analyser has sent.
   *
   * This is what a previously run sample is enrolled from. The sample was a
   * patient's, its result came off this analyser, and typing that result back
   * in by hand is how a transcription error becomes a QC record. A control run
   * is deliberately not offered here — it is not a previously run sample.
   */
  router.get('/materials/:id/analyser/patient-samples', numericOnly, requirePermission('iqc', 'view'), (req, res) => {
    const found = attachmentFor(req.params.id,
      parseIntNullable(req.query.equipmentId), parseIntNullable(req.query.linkId));
    if (!found) return res.status(404).json({ error: 'IQC material not found' });
    const { link } = found;
    if (!link) return res.json([]);

    const since = parseIntNullable(req.query.since);
    const rows = getDb().prepare(`SELECT id, sample_id, received_at, instrument_run_at, parsed_values, result_count
        FROM instrument_messages
        WHERE link_id = ? AND kind = 'patient' AND result_count > 0
          AND (? IS NULL OR id > ?)
        ORDER BY id DESC LIMIT 60`).all(link.id, since, since) as any[];

    const map = safeJson(link.analyte_map) ?? {};
    // Lined up against this control's parameters here rather than in the
    // browser — see the note on the bench's own copy of this route. A Sysmex
    // sends PLT, the link maps it to Platelets, and the control calls it PLT;
    // comparing the two strings on the screen filled nothing.
    const analytes = getDb().prepare('SELECT * FROM iqc_analytes WHERE iqc_material_id = ? AND is_active = 1 ORDER BY display_order, id')
      .all(found.material.id) as any[];
    res.json(rows.map(r => {
      const values = (safeJson(r.parsed_values) ?? []) as any[];
      const named = values.map(v => ({ ...v, analyte: map[String(v.analyte)] ?? v.analyte }));
      const grid = named.map(v => [bestLabel([v.analyte, v.code], analytes), v.value]);
      const { readings } = mapRows(grid, analytes);
      return { ...r, source_name: link.name, parsed_values: named, readings };
    }));
  });

  return router;
}

