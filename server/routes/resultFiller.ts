/**
 * The SECHLIMS Result Filler, over HTTP.
 *
 *   Used by the extension, as an enrolled browser and a signed-in person:
 *     GET  /result-filler/context            the forms this browser knows
 *     POST /result-filler/verify             does SECHLIMS know this identifier?
 *     POST /result-filler/populate           the boxes to fill, having verified
 *     POST /result-filler/outcome            what the form actually took
 *     POST /result-filler/captured           a form adapter drafted from a page
 *
 *   Used once, to enrol a browser:
 *     POST /result-filler/enrol              a pairing code for a device token
 *
 *   Used by an administrator, inside the middleware module:
 *     GET/POST/PUT/DELETE /result-filler/adapters
 *     GET/PUT             /result-filler/adapters/:id/fields
 *     GET/POST            /result-filler/devices, /devices/:id/pair, /revoke
 *     GET                 /result-filler/activity
 *     GET                 /result-filler/overview
 *     GET                 /result-filler/package      the extension, as a zip
 *
 * Two refusals are worth stating plainly, because they are the point of the
 * whole surface. An identifier that is missing, ambiguous or contradicted never
 * produces a plan — the endpoint returns the verdict and no values. And nothing
 * here writes to an analyser connection, a transmission or a delivery: the
 * extension reads what was recorded and reports what it filled.
 */
import { Router } from 'express';
import { getDb } from '../db/database.js';
import { requireAuth } from '../middleware/auth.js';
import { requirePermission } from '../middleware/permissions.js';
import { audit } from '../services/auditService.js';
import { uuid } from '../utils/uuid.js';
import {
  DEFAULT_LOOKBACK_HOURS, FILLER_PLATFORMS, FILL_STATE_LABELS, IDENTIFIER_KINDS, IDENTIFIER_NORMALISERS,
  MAX_LOOKBACK_HOURS, OVERWRITE_POLICIES, SELECTOR_KINDS, SELECTOR_KIND_HINTS, SELECTOR_KIND_LABELS,
  URL_MATCH_MODES, URL_MATCH_MODE_LABELS, VERIFY_STATUS_LABELS,
  FILLER_PLATFORM_LABELS, IDENTIFIER_KIND_LABELS, IDENTIFIER_NORMALISER_LABELS, OVERWRITE_POLICY_LABELS,
  statusAllowsFill, urlMatches, type IdentifierNormaliser,
} from '../../shared/constants/resultFiller.js';
import { adapterFields, buildPlan, publicAdapter, seedAdapters, type AdapterRow } from '../services/resultFiller/adapters.js';
import { transmissionById, verifyIdentifier } from '../services/resultFiller/pending.js';
import {
  aliasIndex, describeScan, orderCandidates, planFromScan, tidyDetectedFields, tidyDetectedIdentifiers,
  type IdentifierCandidate,
} from '../services/resultFiller/matching.js';
import {
  ANALYTE_DICTIONARY, IDENTIFIER_LABEL_RULES, IDENTIFIER_SHAPES, MATCH_FILL_THRESHOLD,
  analyteKey, canonicalAnalyte,
} from '../../shared/constants/formIntelligence.js';
import { browserOf, enrol, newPairingCode, nextDeviceCode, pairingExpiry, requireDevice } from '../services/resultFiller/devices.js';
import { packageExtension } from '../services/resultFiller/packaging.js';

const F = 'analyser_middleware.result_filler';

const numericOnly = (req: any, _res: any, next: any) => (/^\d+$/.test(req.params.id) ? next() : next('route'));

function json<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  try { return (JSON.parse(value) ?? fallback) as T; } catch { return fallback; }
}

function text(value: unknown, limit = 400): string | null {
  const raw = String(value ?? '').trim();
  return raw ? raw.slice(0, limit) : null;
}

function bounded(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
}

function oneOf<T extends readonly string[]>(value: unknown, allowed: T, fallback: T[number]): T[number] {
  const raw = String(value ?? '').trim();
  return (allowed as readonly string[]).includes(raw) ? raw as T[number] : fallback;
}

/**
 * The identifiers a page offered, in the order they are worth trying.
 *
 * Two shapes arrive here. A configured adapter sends what its selectors read,
 * keyed by kind; a scanned page sends everything it found, because on a real
 * LIS page the sample barcode, the folder number and an insurance number are
 * all printed and only one of them is the one results are filed against. Both
 * become the same ordered list, and the answer says which one matched.
 */
function candidatesFrom(body: any): IdentifierCandidate[] {
  const out: IdentifierCandidate[] = [];
  const detected = tidyDetectedIdentifiers(body?.detectedIdentifiers);
  for (const identifier of detected) {
    out.push({ kind: identifier.kind, label: identifier.label, value: identifier.value, source: identifier.source, confidence: identifier.confidence });
  }
  const keyed = (body?.identifiers ?? {}) as Record<string, unknown>;
  for (const [kind, value] of Object.entries(keyed)) {
    const text = String(value ?? '').trim();
    if (!text) continue;
    if (out.some(candidate => candidate.value === text)) continue;
    out.push({ kind: kind === 'qc_lot' ? 'sample' : kind, label: IDENTIFIER_KIND_LABELS[kind as keyof typeof IDENTIFIER_KIND_LABELS] ?? kind, value: text, source: 'adapter', confidence: 80 });
  }
  return orderCandidates(out);
}

/**
 * Try each identifier the page carries until one is recognised.
 *
 * The verdict returned is the FIRST that verified; if none did, the verdict of
 * the most authoritative candidate is returned instead, so the bench is told
 * about the sample barcode that is not on the record rather than about an
 * insurance number nobody expected to find.
 */
function verifyCandidates(db: any, adapter: AdapterRow, candidates: IdentifierCandidate[]) {
  const tried: Array<{ kind: string; label: string; value: string; status: string }> = [];
  let fallback: { verdict: ReturnType<typeof verifyIdentifier>; candidate: IdentifierCandidate } | null = null;
  const patient = candidates.find(candidate => candidate.kind === 'patient')?.value ?? null;

  for (const candidate of candidates.slice(0, 8)) {
    const verdict = verifyIdentifier(db, {
      identifier: candidate.value,
      normaliser: adapter.normaliser as IdentifierNormaliser,
      lookbackHours: Number(adapter.lookback_hours) || DEFAULT_LOOKBACK_HOURS,
      messageKind: adapter.message_kind,
      // A patient identifier is corroboration, never the thing matched on, so
      // it is not held against itself.
      patientIdentifier: candidate.kind === 'patient' ? null : patient,
    });
    tried.push({ kind: candidate.kind, label: candidate.label, value: candidate.value, status: verdict.status });
    if (statusAllowsFill(verdict.status) || verdict.status === 'blocked') return { verdict, candidate, tried };
    if (!fallback && candidate.kind !== 'patient') fallback = { verdict, candidate };
  }

  if (fallback) return { verdict: fallback.verdict, candidate: fallback.candidate, tried };
  const first = candidates[0];
  if (!first) {
    return {
      verdict: verifyIdentifier(db, {
        identifier: '', normaliser: adapter.normaliser as IdentifierNormaliser,
        lookbackHours: Number(adapter.lookback_hours) || DEFAULT_LOOKBACK_HOURS,
        messageKind: adapter.message_kind,
      }),
      candidate: null as IdentifierCandidate | null,
      tried,
    };
  }
  return {
    verdict: verifyIdentifier(db, {
      identifier: first.value, normaliser: adapter.normaliser as IdentifierNormaliser,
      lookbackHours: Number(adapter.lookback_hours) || DEFAULT_LOOKBACK_HOURS,
      messageKind: adapter.message_kind,
    }),
    candidate: first,
    tried,
  };
}

export function resultFillerRoutes() {
  const router = Router();

  // The adapters that ship with the extension are put on the record once, so
  // the register is never empty on a laboratory's first visit.
  try { seedAdapters(getDb()); } catch { /* a cold database seeds on the next call */ }

  /* ======================================================================
     Enrolment — the one endpoint a browser may reach before it is known
     ====================================================================== */
  router.post('/enrol', (req, res) => {
    const outcome = enrol(getDb(), String(req.body?.pairingCode ?? ''), String(req.headers['user-agent'] ?? ''));
    if ('error' in outcome) return res.status(400).json(outcome);
    audit(req, { action: 'enrol', entity: 'rf_devices', entityId: outcome.device.id, newValue: { label: outcome.device.label } });
    res.json({
      token: outcome.token,
      device: { code: outcome.device.device_code, label: outcome.device.label },
      note: 'This browser is enrolled. Sign in with your SECHLIMS account to fill a form.',
    });
  });

  /* Everything below needs a person. */
  router.use(requireAuth);

  /* ======================================================================
     The vocabulary the settings screens read from
     ====================================================================== */
  router.get('/reference', requirePermission(F, 'view'), (_req, res) => {
    res.json({
      platforms: FILLER_PLATFORMS.map(key => ({ key, label: FILLER_PLATFORM_LABELS[key] })),
      urlMatchModes: URL_MATCH_MODES.map(key => ({ key, label: URL_MATCH_MODE_LABELS[key] })),
      identifierKinds: IDENTIFIER_KINDS.map(key => ({ key, label: IDENTIFIER_KIND_LABELS[key] })),
      normalisers: IDENTIFIER_NORMALISERS.map(key => ({ key, label: IDENTIFIER_NORMALISER_LABELS[key] })),
      overwritePolicies: OVERWRITE_POLICIES.map(key => ({ key, label: OVERWRITE_POLICY_LABELS[key] })),
      selectorKinds: SELECTOR_KINDS.map(key => ({ key, label: SELECTOR_KIND_LABELS[key], hint: SELECTOR_KIND_HINTS[key] })),
      verifyStatuses: VERIFY_STATUS_LABELS,
      fillStates: FILL_STATE_LABELS,
      defaultLookbackHours: DEFAULT_LOOKBACK_HOURS,
    });
  });

  /* ======================================================================
     The extension's own surface
     ====================================================================== */

  /**
   * Which form is this, and what are the rules for it?
   *
   * The whole active register is returned rather than the server guessing from
   * a URL, because the extension must also check that the form's own marker is
   * on the page before claiming to recognise it. A URL alone is not a form.
   */
  router.get('/context', requireDevice, requirePermission(F, 'view'), (req, res) => {
    const db = getDb();
    const rows = db.prepare('SELECT * FROM rf_adapters WHERE is_active = 1 ORDER BY platform, name').all() as AdapterRow[];
    const url = String(req.query.url ?? '');
    res.json({
      user: { id: req.user!.id, username: req.user!.username },
      device: { code: req.fillerDevice?.device_code, label: req.fillerDevice?.label },
      adapters: rows.map(row => publicAdapter(row, adapterFields(db, row.id))),
      matched: url ? rows.filter(row => urlMatches(row.url_pattern, row.url_match_mode as any, url)).map(row => row.adapter_code) : [],
      mayConfigure: true,
      /*
       * How to read a page, sent rather than built into the extension.
       *
       * The rules for recognising an identifier are the same rules the API
       * verifies against; shipping them as data means the page and the server
       * cannot come to disagree about what a sample barcode looks like, and a
       * laboratory with an unusual one is served by a release of SECHLIMS
       * rather than a reinstall on every bench.
       */
      detection: {
        identifierRules: IDENTIFIER_LABEL_RULES.map(rule => ({
          kind: rule.kind, weight: rule.weight, patterns: rule.patterns.map(pattern => pattern.source),
        })),
        shapes: IDENTIFIER_SHAPES.map(shape => ({
          kind: shape.kind, weight: shape.weight, pattern: shape.shape.source, description: shape.description,
        })),
      },
    });
  });

  /**
   * Does SECHLIMS know this identifier, and what did the analyser say about it?
   *
   * The verdict comes back whatever it is. A refusal is as useful an answer as
   * a match — more so, because it is the one the person needs to see before
   * they type anything in by hand.
   */
  router.post('/verify', requireDevice, requirePermission(F, 'view'), (req, res) => {
    const db = getDb();
    const adapter = db.prepare('SELECT * FROM rf_adapters WHERE adapter_code = ? AND is_active = 1')
      .get(String(req.body?.adapterCode ?? '')) as AdapterRow | undefined;
    if (!adapter) return res.status(404).json({ error: 'No active form adapter matches this page.' });

    const candidates = candidatesFrom(req.body);
    const { verdict, candidate, tried } = verifyCandidates(db, adapter, candidates);
    const fields = tidyDetectedFields(req.body?.detectedFields);
    const identifiers = tidyDetectedIdentifiers(req.body?.detectedIdentifiers);

    res.json({
      status: verdict.status,
      label: VERIFY_STATUS_LABELS[verdict.status],
      summary: verdict.summary,
      warnings: verdict.warnings,
      formIdentifier: verdict.formIdentifier,
      recordIdentifier: verdict.recordIdentifier,
      agreement: verdict.agreement,
      mayFill: statusAllowsFill(verdict.status),
      // Which of the page's identifiers the answer is about, so the bench can
      // see that the barcode was used and the folder number was only checked.
      matchedOn: candidate ? { kind: candidate.kind, label: candidate.label, value: candidate.value, source: candidate.source } : null,
      tried,
      scan: {
        identifiers,
        fields: fields.length,
        recognised: fields.filter(field => canonicalAnalyte(field.label)).length,
        summary: describeScan(identifiers, fields),
      },
      adapter: { code: adapter.adapter_code, name: adapter.name, overwritePolicy: adapter.overwrite_policy, autoDetect: Number(adapter.auto_detect ?? 1) === 1 },
      transmissions: verdict.transmissions.slice(0, 6).map(t => ({
        id: t.id,
        sampleId: t.sampleId,
        receivedAt: t.receivedAt,
        runAt: t.instrumentRunAt,
        analyser: t.linkName ?? t.equipmentName ?? t.instrumentName,
        kind: t.kind,
        results: t.readings.length,
        priorFills: t.priorFills,
        patient: t.demographics.patientName,
        patientId: t.demographics.patientId,
        readings: t.readings.map(r => ({ code: r.code, analyte: r.analyte, value: r.value, unit: r.unit, flag: r.flag })),
      })),
    });
  });

  /**
   * The boxes to fill.
   *
   * Verification is done again here rather than trusting what the extension
   * reports: the browser is where a person works, not where a safety check
   * belongs. A plan is issued only for a transmission that still matches the
   * identifier on the form at the moment the button is pressed.
   */
  router.post('/populate', requireDevice, requirePermission(F, 'view'), (req, res) => {
    const db = getDb();
    const adapter = db.prepare('SELECT * FROM rf_adapters WHERE adapter_code = ? AND is_active = 1')
      .get(String(req.body?.adapterCode ?? '')) as AdapterRow | undefined;
    if (!adapter) return res.status(404).json({ error: 'No active form adapter matches this page.' });

    // Verification is done again here rather than trusting what the extension
    // reports: the browser is where a person works, not where a safety check
    // belongs. A plan is issued only for a transmission that still matches an
    // identifier on the form at the moment the button is pressed.
    const candidates = candidatesFrom(req.body);
    const { verdict, candidate } = verifyCandidates(db, adapter, candidates);
    if (!statusAllowsFill(verdict.status)) {
      return res.status(409).json({ error: verdict.summary, status: verdict.status });
    }
    if ((verdict.status === 'near_match' || verdict.status === 'already_entered') && !req.body?.confirmed) {
      return res.status(409).json({ error: verdict.summary, status: verdict.status, needsConfirmation: true });
    }

    const requested = Number(req.body?.messageId ?? 0);
    const chosen = requested ? verdict.transmissions.find(t => t.id === requested) : verdict.transmissions[0];
    if (!chosen) {
      return res.status(409).json({ error: 'That transmission no longer matches the identifier on this form.', status: 'ambiguous' });
    }
    const transmission = transmissionById(db, chosen.id);
    if (!transmission) return res.status(404).json({ error: 'That transmission is no longer on the record.' });

    const mappings = adapterFields(db, adapter.id);
    const detectedFields = tidyDetectedFields(req.body?.detectedFields);
    const detectedIdentifiers = tidyDetectedIdentifiers(req.body?.detectedIdentifiers);
    const autoDetect = Number(adapter.auto_detect ?? 1) === 1 && detectedFields.length > 0;

    /*
     * Two ways a plan is built, and the page decides which.
     *
     * A page the extension could READ hands back the parameters it is asking
     * for, each with the label printed beside it, and the readings are matched
     * to those labels. A page it could not read falls back to the selectors an
     * administrator configured. The first needs nothing configured; the second
     * still works where a form gives nothing to read.
     */
    let payload: Record<string, unknown>;
    let offered = 0;
    let unmatched: unknown[] = [];

    if (autoDetect) {
      const plan = planFromScan(transmission, detectedFields, {
        fields: mappings,
        aliases: aliasIndex(db, adapter.id),
        threshold: bounded(req.body?.threshold, MATCH_FILL_THRESHOLD, 55, 100),
      });
      if (!plan.assignments.length) {
        return res.status(409).json({
          error: plan.unmatched.length
            ? `None of the ${plan.unmatched.length} parameter(s) in this transmission matches a field on this form. Add a mapping, or an alias, under Result Filler.`
            : 'This transmission carries no value this form can take.',
          status: 'no_results',
          unmatched: plan.unmatched,
          unfilled: plan.unfilled,
          suggestions: plan.suggestions,
        });
      }
      offered = plan.assignments.length;
      unmatched = plan.unmatched;
      payload = {
        mode: 'detected',
        assignments: plan.assignments,
        unmatched: plan.unmatched,
        unfilled: plan.unfilled,
        suggestions: plan.suggestions,
        overwritePolicy: adapter.overwrite_policy,
      };
    } else {
      const plan = buildPlan(adapter, mappings, transmission);
      if (!plan.fields.length) {
        return res.status(409).json({ error: 'Nothing in this transmission maps to a field on this form. Check the field mappings for this adapter.', status: 'no_results' });
      }
      offered = plan.fields.length;
      unmatched = plan.unmatched;
      payload = { mode: 'configured', ...plan };
    }

    const fillUid = uuid();
    const inserted = db.prepare(`INSERT INTO rf_fills
        (fill_uid, device_id, user_id, adapter_id, instrument_message_id, mw_message_id, identifier, identifier_kind,
         identifier_agreement, verify_status, page_url, page_title, state, fields_offered, unmatched)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'issued', ?, ?)`)
      .run(fillUid, req.fillerDevice?.id ?? null, req.user!.id, adapter.id, transmission.id, transmission.mwMessageId,
        verdict.formIdentifier, candidate?.kind ?? 'sample', verdict.agreement, verdict.status,
        text(req.body?.url, 500), text(req.body?.title, 200), offered, JSON.stringify(unmatched));

    // What the page showed and what it was matched against, kept beside the
    // fill so "why did it put that number there" has an answer later.
    try {
      db.prepare(`INSERT INTO rf_scan_records (fill_id, identifiers, fields, assignments)
          VALUES (?, ?, ?, ?)`)
        .run(Number(inserted.lastInsertRowid), JSON.stringify(detectedIdentifiers),
          JSON.stringify(detectedFields.map(field => ({ index: field.index, label: field.label, unit: field.unit }))),
          JSON.stringify(payload.assignments ?? payload.fields ?? []));
    } catch { /* the fill is the record; the scan is the explanation */ }

    audit(req, {
      action: 'populate', entity: 'rf_fills', entityId: fillUid,
      newValue: { adapter: adapter.adapter_code, sample: verdict.formIdentifier, message: transmission.id, fields: offered, mode: payload.mode },
    });

    res.json({
      fillUid,
      adapter: { code: adapter.adapter_code, name: adapter.name },
      matchedOn: candidate ? { kind: candidate.kind, label: candidate.label, value: candidate.value } : null,
      transmission: {
        id: transmission.id, sampleId: transmission.sampleId, receivedAt: transmission.receivedAt,
        analyser: transmission.linkName ?? transmission.equipmentName,
        patient: transmission.demographics.patientName,
      },
      ...payload,
    });
  });

  /** What the form actually took. Closes the fill, and is how a repeat is seen. */
  router.post('/outcome', requireDevice, requirePermission(F, 'view'), (req, res) => {
    const db = getDb();
    const fill = db.prepare('SELECT * FROM rf_fills WHERE fill_uid = ?').get(String(req.body?.fillUid ?? '')) as any;
    if (!fill) return res.status(404).json({ error: 'That fill is not on the record.' });
    if (fill.state !== 'issued') return res.json({ ok: true, note: 'Already reported.' });

    const filled = bounded(req.body?.filled, 0, 0, 9_999);
    const skipped = bounded(req.body?.skipped, 0, 0, 9_999);
    const overwritten = bounded(req.body?.overwritten, 0, 0, 9_999);
    const failures = Array.isArray(req.body?.failures) ? req.body.failures.slice(0, 60).map((f: unknown) => String(f).slice(0, 200)) : [];
    const offered = Number(fill.fields_offered ?? 0);
    const state = req.body?.abandoned ? 'abandoned'
      : filled === 0 ? 'failed'
      : filled < offered ? 'partial' : 'applied';

    db.prepare(`UPDATE rf_fills SET state = ?, fields_filled = ?, fields_skipped = ?, fields_overwritten = ?,
        detail = ?, reported_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(state, filled, skipped, overwritten, failures.length ? JSON.stringify(failures) : null, fill.id);
    if (fill.device_id && (state === 'applied' || state === 'partial')) {
      db.prepare('UPDATE rf_devices SET fills = fills + 1 WHERE id = ?').run(fill.device_id);
    }

    audit(req, { action: 'populate_outcome', entity: 'rf_fills', entityId: fill.fill_uid, newValue: { state, filled, skipped, overwritten } });
    res.json({ ok: true, state, note: FILL_STATE_LABELS[state as keyof typeof FILL_STATE_LABELS] });
  });

  /**
   * A form adapter drafted from a page the administrator pointed at.
   *
   * Saved INACTIVE, always. What the extension captured is a starting point
   * somebody reviews, not a form the next person at the bench is filled from.
   */
  router.post('/captured', requireDevice, requirePermission(F, 'edit'), (req, res) => {
    const db = getDb();
    const name = text(req.body?.name, 120) ?? 'Captured form';
    const url = text(req.body?.url, 500) ?? '';
    if (!url) return res.status(400).json({ error: 'The capture carried no page address.' });

    const code = `CAP-${String(Date.now()).slice(-6)}`;
    const identifiers = Array.isArray(req.body?.identifiers)
      ? req.body.identifiers.slice(0, 6).map((i: any) => ({
        kind: oneOf(i?.kind, IDENTIFIER_KINDS, 'sample'),
        selectorKind: oneOf(i?.selectorKind, SELECTOR_KINDS, 'css'),
        selector: text(i?.selector, 300) ?? '',
        primary: Boolean(i?.primary),
      })).filter((i: any) => i.selector)
      : [];

    const inserted = db.prepare(`INSERT INTO rf_adapters
        (adapter_code, name, platform, description, url_pattern, url_match_mode, form_selector, identifiers,
         normaliser, overwrite_policy, lookback_hours, message_kind, match_by_label, row_container,
         is_builtin, is_active, notes, created_by)
        VALUES (?, ?, ?, ?, ?, 'contains', ?, ?, 'alnum', 'never', ?, 'patient', 1, ?, 0, 0, ?, ?)`)
      .run(code, name, oneOf(req.body?.platform, FILLER_PLATFORMS, 'other'),
        text(req.body?.description, 400), text(req.body?.urlPattern, 300) ?? url.split('?')[0],
        text(req.body?.formSelector, 300), JSON.stringify(identifiers), DEFAULT_LOOKBACK_HOURS,
        text(req.body?.rowContainer, 300), `Captured from ${url} on ${new Date().toISOString().slice(0, 10)}.`, req.user!.id);

    const adapterId = Number(inserted.lastInsertRowid);
    const fields = Array.isArray(req.body?.fields) ? req.body.fields.slice(0, 300) : [];
    const insertField = db.prepare(`INSERT OR IGNORE INTO rf_fields
        (adapter_id, source_code, analyte, selector_kind, selector, unit, is_required, sort_order, note)
        VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`);
    fields.forEach((field: any, index: number) => {
      const sourceCode = text(field?.sourceCode ?? field?.analyte, 80);
      const selector = text(field?.selector, 300);
      if (!sourceCode || !selector) return;
      insertField.run(adapterId, sourceCode, text(field?.analyte, 120), oneOf(field?.selectorKind, SELECTOR_KINDS, 'css'),
        selector, text(field?.unit, 40), index, text(field?.note, 200));
    });

    audit(req, { action: 'create', entity: 'rf_adapters', entityId: adapterId, newValue: { code, name, captured: true, fields: fields.length } });
    res.status(201).json({
      id: adapterId, adapterCode: code,
      note: 'Saved as an inactive draft. Review its fields in Transmission & Middleware → Result Filler before enabling it.',
    });
  });

  /* ======================================================================
     Administration
     ====================================================================== */
  router.get('/overview', requirePermission(F, 'view'), (_req, res) => {
    const db = getDb();
    const count = (sql: string, ...args: any[]) => Number((db.prepare(sql).get(...args) as any)?.n ?? 0);
    res.json({
      adapters: count('SELECT COUNT(*) AS n FROM rf_adapters'),
      adaptersActive: count('SELECT COUNT(*) AS n FROM rf_adapters WHERE is_active = 1'),
      devices: count("SELECT COUNT(*) AS n FROM rf_devices WHERE state = 'enrolled'"),
      devicesPending: count("SELECT COUNT(*) AS n FROM rf_devices WHERE state = 'pending'"),
      fillsToday: count("SELECT COUNT(*) AS n FROM rf_fills WHERE date(issued_at) = date('now')"),
      fieldsToday: count("SELECT COALESCE(SUM(fields_filled), 0) AS n FROM rf_fills WHERE date(issued_at) = date('now')"),
      failures: count("SELECT COUNT(*) AS n FROM rf_fills WHERE state IN ('failed','partial') AND issued_at >= datetime('now', '-7 days')"),
      lastFillAt: (db.prepare('SELECT MAX(issued_at) AS at FROM rf_fills').get() as any)?.at ?? null,
    });
  });

  router.get('/adapters', requirePermission(F, 'view'), (_req, res) => {
    const db = getDb();
    const rows = db.prepare(`SELECT a.*, (SELECT COUNT(*) FROM rf_fields f WHERE f.adapter_id = a.id) AS field_count,
          (SELECT COUNT(*) FROM rf_fills f WHERE f.adapter_id = a.id) AS fill_count
        FROM rf_adapters a ORDER BY a.is_active DESC, a.platform, a.name`).all() as any[];
    res.json(rows.map(row => ({ ...publicAdapter(row), fieldCount: Number(row.field_count ?? 0), fillCount: Number(row.fill_count ?? 0) })));
  });

  function adapterPayload(body: any) {
    return {
      name: text(body?.name, 120),
      platform: oneOf(body?.platform, FILLER_PLATFORMS, 'other'),
      description: text(body?.description, 500),
      urlPattern: text(body?.urlPattern, 300),
      urlMatchMode: oneOf(body?.urlMatchMode, URL_MATCH_MODES, 'glob'),
      formSelector: text(body?.formSelector, 300),
      identifiers: JSON.stringify(Array.isArray(body?.identifiers) ? body.identifiers.slice(0, 6).map((i: any) => ({
        kind: oneOf(i?.kind, IDENTIFIER_KINDS, 'sample'),
        selectorKind: oneOf(i?.selectorKind, SELECTOR_KINDS, 'css'),
        selector: text(i?.selector, 300) ?? '',
        primary: Boolean(i?.primary),
      })).filter((i: any) => i.selector) : []),
      normaliser: oneOf(body?.normaliser, IDENTIFIER_NORMALISERS, 'alnum'),
      overwritePolicy: oneOf(body?.overwritePolicy, OVERWRITE_POLICIES, 'confirm'),
      lookbackHours: bounded(body?.lookbackHours, DEFAULT_LOOKBACK_HOURS, 1, MAX_LOOKBACK_HOURS),
      messageKind: oneOf(body?.messageKind, ['patient', 'control', 'any'] as const, 'patient'),
      matchByLabel: body?.matchByLabel === false ? 0 : 1,
      rowContainer: text(body?.rowContainer, 300),
      rowLabelCell: bounded(body?.rowLabelCell, 1, 1, 20),
      rowValueCell: bounded(body?.rowValueCell, 0, 0, 20),
      isActive: body?.isActive === false ? 0 : 1,
      notes: text(body?.notes, 1_000),
    };
  }

  router.post('/adapters', requirePermission(F, 'edit'), (req, res) => {
    const db = getDb();
    const payload = adapterPayload(req.body);
    if (!payload.name) return res.status(400).json({ error: 'Give the form a name.' });
    if (!payload.urlPattern) return res.status(400).json({ error: 'Say which pages this form is on.' });

    const code = text(req.body?.adapterCode, 40) ?? `RFA-${String(Date.now()).slice(-6)}`;
    try {
      const inserted = db.prepare(`INSERT INTO rf_adapters
          (adapter_code, name, platform, description, url_pattern, url_match_mode, form_selector, identifiers,
           normaliser, overwrite_policy, lookback_hours, message_kind, match_by_label, row_container,
           row_label_cell, row_value_cell, is_builtin, is_active, notes, created_by)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`)
        .run(code.toUpperCase(), payload.name, payload.platform, payload.description, payload.urlPattern,
          payload.urlMatchMode, payload.formSelector, payload.identifiers, payload.normaliser,
          payload.overwritePolicy, payload.lookbackHours, payload.messageKind, payload.matchByLabel,
          payload.rowContainer, payload.rowLabelCell, payload.rowValueCell, payload.isActive, payload.notes, req.user!.id);
      const id = Number(inserted.lastInsertRowid);
      audit(req, { action: 'create', entity: 'rf_adapters', entityId: id, newValue: payload });
      res.status(201).json({ id, adapterCode: code.toUpperCase() });
    } catch (error) {
      res.status(400).json({ error: `That form could not be added: ${(error as Error).message}` });
    }
  });

  router.put('/adapters/:id', numericOnly, requirePermission(F, 'edit'), (req, res) => {
    const db = getDb();
    const before = db.prepare('SELECT * FROM rf_adapters WHERE id = ?').get(req.params.id) as AdapterRow | undefined;
    if (!before) return res.status(404).json({ error: 'That form adapter is not on the register.' });
    const payload = adapterPayload({ ...publicAdapter(before), ...req.body });
    if (!payload.name) return res.status(400).json({ error: 'Give the form a name.' });

    db.prepare(`UPDATE rf_adapters SET name = ?, platform = ?, description = ?, url_pattern = ?, url_match_mode = ?,
        form_selector = ?, identifiers = ?, normaliser = ?, overwrite_policy = ?, lookback_hours = ?, message_kind = ?,
        match_by_label = ?, row_container = ?, row_label_cell = ?, row_value_cell = ?, is_active = ?, notes = ?,
        updated_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(payload.name, payload.platform, payload.description, payload.urlPattern, payload.urlMatchMode,
        payload.formSelector, payload.identifiers, payload.normaliser, payload.overwritePolicy, payload.lookbackHours,
        payload.messageKind, payload.matchByLabel, payload.rowContainer, payload.rowLabelCell, payload.rowValueCell,
        payload.isActive, payload.notes, req.user!.id, req.params.id);

    audit(req, { action: 'update', entity: 'rf_adapters', entityId: req.params.id, oldValue: { name: before.name, active: before.is_active }, newValue: payload });
    res.json({ ok: true });
  });

  router.delete('/adapters/:id', numericOnly, requirePermission(F, 'void_archive'), (req, res) => {
    const db = getDb();
    const row = db.prepare('SELECT * FROM rf_adapters WHERE id = ?').get(req.params.id) as AdapterRow | undefined;
    if (!row) return res.status(404).json({ error: 'That form adapter is not on the register.' });
    const fills = Number((db.prepare('SELECT COUNT(*) AS n FROM rf_fills WHERE adapter_id = ?').get(row.id) as any)?.n ?? 0);
    // A form that has filled results is part of the record of those results.
    if (fills > 0) {
      db.prepare('UPDATE rf_adapters SET is_active = 0, updated_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(req.user!.id, row.id);
      audit(req, { action: 'deactivate', entity: 'rf_adapters', entityId: row.id, oldValue: { name: row.name } });
      return res.json({ ok: true, note: `${row.name} has filled ${fills} form(s), so it was deactivated rather than deleted.` });
    }
    db.prepare('DELETE FROM rf_adapters WHERE id = ?').run(row.id);
    audit(req, { action: 'delete', entity: 'rf_adapters', entityId: row.id, oldValue: { name: row.name } });
    res.json({ ok: true });
  });

  router.get('/adapters/:id/fields', numericOnly, requirePermission(F, 'view'), (req, res) => {
    res.json(adapterFields(getDb(), Number(req.params.id)));
  });

  /** The whole mapping, replaced in one call: a half-saved field map fills wrong. */
  router.put('/adapters/:id/fields', numericOnly, requirePermission(F, 'edit'), (req, res) => {
    const db = getDb();
    const adapter = db.prepare('SELECT * FROM rf_adapters WHERE id = ?').get(req.params.id) as AdapterRow | undefined;
    if (!adapter) return res.status(404).json({ error: 'That form adapter is not on the register.' });
    const rows = Array.isArray(req.body?.fields) ? req.body.fields.slice(0, 400) : [];

    const kept: any[] = [];
    for (const row of rows) {
      const sourceCode = text(row?.source_code ?? row?.sourceCode, 80);
      const selector = text(row?.selector, 300);
      if (!sourceCode || !selector) continue;
      kept.push({
        sourceCode,
        analyte: text(row?.analyte, 120),
        selectorKind: oneOf(row?.selector_kind ?? row?.selectorKind, SELECTOR_KINDS, 'row'),
        selector,
        unit: text(row?.unit, 40),
        decimals: row?.decimals == null || row?.decimals === '' ? null : bounded(row.decimals, 0, 0, 6),
        factor: row?.factor == null || row?.factor === '' ? null : Number(row.factor),
        offsetValue: row?.offset_value == null || row?.offset_value === '' ? null : Number(row.offset_value),
        valueMap: row?.value_map ? String(row.value_map).slice(0, 2_000) : null,
        required: (row?.is_required ?? row?.required) ? 1 : 0,
        note: text(row?.note, 200),
      });
    }

    const apply = db.transaction(() => {
      db.prepare('DELETE FROM rf_fields WHERE adapter_id = ?').run(adapter.id);
      const insert = db.prepare(`INSERT INTO rf_fields
          (adapter_id, source_code, analyte, selector_kind, selector, unit, decimals, factor, offset_value,
           value_map, is_required, is_active, sort_order, note)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`);
      kept.forEach((field, index) => {
        insert.run(adapter.id, field.sourceCode, field.analyte, field.selectorKind, field.selector, field.unit,
          field.decimals, field.factor, field.offsetValue, field.valueMap, field.required, index, field.note);
      });
    });
    try { apply(); } catch (error) { return res.status(400).json({ error: `The mapping could not be saved: ${(error as Error).message}` }); }

    audit(req, { action: 'update', entity: 'rf_fields', entityId: adapter.id, newValue: { adapter: adapter.adapter_code, fields: kept.length } });
    res.json({ ok: true, fields: kept.length });
  });

  /* ------------------------------------------------- the laboratory's names */

  /**
   * What this laboratory calls a parameter, beyond what the dictionary knows.
   *
   * The built-in names cover what these analysers emit and what LHIMS labels
   * its fields. The rest is local — a form that says "HB CONC", an analyser
   * that sends "SGPT" — and is taught here once rather than waiting for a new
   * extension to be built and distributed.
   */
  router.get('/aliases', requirePermission(F, 'view'), (req, res) => {
    const db = getDb();
    const rows = db.prepare(`SELECT a.*, f.name AS adapter_name, u.username AS created_by_name
        FROM rf_aliases a LEFT JOIN rf_adapters f ON f.id = a.adapter_id LEFT JOIN users u ON u.id = a.created_by
        ORDER BY a.canonical, a.alias`).all() as any[];
    res.json({
      rows,
      // The dictionary itself, so the screen can show what is already known and
      // nobody adds an alias the filler already understood.
      dictionary: ANALYTE_DICTIONARY.map(entry => ({
        canonical: entry.canonical, discipline: entry.discipline, aliases: entry.aliases,
      })),
      matchThreshold: MATCH_FILL_THRESHOLD,
    });
  });

  router.post('/aliases', requirePermission(F, 'edit'), (req, res) => {
    const db = getDb();
    const canonical = text(req.body?.canonical, 80);
    const alias = text(req.body?.alias, 80);
    if (!canonical || !alias) return res.status(400).json({ error: 'Give both the parameter and the other name for it.' });
    if (analyteKey(canonical) === analyteKey(alias)) {
      return res.status(400).json({ error: 'That is the same name written twice.' });
    }
    // Already spoken for — either by the dictionary, or by a name this
    // laboratory taught earlier. SQLite's UNIQUE would not catch the second:
    // a null adapter is not equal to another null adapter, so every
    // everywhere-alias would be allowed through.
    const known = canonicalAnalyte(alias) ?? aliasIndex(db, null).get(analyteKey(alias)) ?? null;
    if (known) {
      return res.status(409).json({
        error: known === canonical
          ? `“${alias}” is already understood as ${known}.`
          : `“${alias}” already means ${known}. Two parameters cannot share a name.`,
      });
    }
    try {
      const inserted = db.prepare(`INSERT INTO rf_aliases (canonical, alias, adapter_id, note, created_by)
          VALUES (?, ?, ?, ?, ?)`)
        .run(canonical, alias, req.body?.adapterId ? Number(req.body.adapterId) : null, text(req.body?.note, 200), req.user!.id);
      audit(req, { action: 'create', entity: 'rf_aliases', entityId: Number(inserted.lastInsertRowid), newValue: { canonical, alias } });
      res.status(201).json({ id: Number(inserted.lastInsertRowid) });
    } catch (error) {
      res.status(400).json({ error: `That name could not be added: ${(error as Error).message}` });
    }
  });

  router.delete('/aliases/:id', numericOnly, requirePermission(F, 'edit'), (req, res) => {
    const db = getDb();
    const row = db.prepare('SELECT * FROM rf_aliases WHERE id = ?').get(req.params.id) as any;
    if (!row) return res.status(404).json({ error: 'That name is not on the register.' });
    db.prepare('DELETE FROM rf_aliases WHERE id = ?').run(row.id);
    audit(req, { action: 'delete', entity: 'rf_aliases', entityId: row.id, oldValue: { canonical: row.canonical, alias: row.alias } });
    res.json({ ok: true });
  });

  /* ---------------------------------------------------------- the browsers */
  router.get('/devices', requirePermission(F, 'view'), (_req, res) => {
    const db = getDb();
    res.json(db.prepare(`SELECT d.id, d.device_code, d.label, d.location, d.state, d.browser, d.user_agent,
          d.enrolled_at, d.last_seen_at, d.fills, d.note, d.created_at, d.revoked_at, d.revoke_reason,
          d.pairing_code, d.pairing_expires_at, s.name AS section_name,
          u.username AS created_by_name
        FROM rf_devices d LEFT JOIN sections s ON s.id = d.section_id LEFT JOIN users u ON u.id = d.created_by
        ORDER BY CASE d.state WHEN 'pending' THEN 0 WHEN 'enrolled' THEN 1 ELSE 2 END, d.id DESC`).all());
  });

  router.post('/devices', requirePermission(F, 'edit'), (req, res) => {
    const db = getDb();
    const label = text(req.body?.label, 120);
    if (!label) return res.status(400).json({ error: 'Name the computer this extension is for.' });
    const code = nextDeviceCode(db);
    const pairing = newPairingCode();
    const inserted = db.prepare(`INSERT INTO rf_devices (device_code, label, location, section_id, pairing_code, pairing_expires_at, note, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(code, label, text(req.body?.location, 120), req.body?.sectionId ? Number(req.body.sectionId) : null,
        pairing, pairingExpiry(), text(req.body?.note, 400), req.user!.id);
    audit(req, { action: 'create', entity: 'rf_devices', entityId: Number(inserted.lastInsertRowid), newValue: { label } });
    res.status(201).json({ id: Number(inserted.lastInsertRowid), deviceCode: code, pairingCode: pairing });
  });

  router.post('/devices/:id/pair', numericOnly, requirePermission(F, 'edit'), (req, res) => {
    const db = getDb();
    const row = db.prepare('SELECT * FROM rf_devices WHERE id = ?').get(req.params.id) as any;
    if (!row) return res.status(404).json({ error: 'That browser is not on the register.' });
    const pairing = newPairingCode();
    db.prepare(`UPDATE rf_devices SET pairing_code = ?, pairing_expires_at = ?, state = 'pending', token_hash = NULL WHERE id = ?`)
      .run(pairing, pairingExpiry(), row.id);
    audit(req, { action: 'repair', entity: 'rf_devices', entityId: row.id, newValue: { label: row.label } });
    res.json({ pairingCode: pairing, note: 'The previous enrolment on this browser no longer works.' });
  });

  router.post('/devices/:id/revoke', numericOnly, requirePermission(F, 'edit'), (req, res) => {
    const db = getDb();
    const row = db.prepare('SELECT * FROM rf_devices WHERE id = ?').get(req.params.id) as any;
    if (!row) return res.status(404).json({ error: 'That browser is not on the register.' });
    // The hash is kept rather than cleared. It cannot be used — the state check
    // refuses it — and keeping it is what lets the refusal say "this browser was
    // revoked" instead of "this browser is unknown", which is the difference
    // between a bench that knows to ask for a new code and one that thinks the
    // extension is broken.
    db.prepare(`UPDATE rf_devices SET state = 'revoked', pairing_code = NULL,
        revoked_by = ?, revoked_at = CURRENT_TIMESTAMP, revoke_reason = ? WHERE id = ?`)
      .run(req.user!.id, text(req.body?.reason, 300), row.id);
    audit(req, { action: 'revoke', entity: 'rf_devices', entityId: row.id, oldValue: { label: row.label }, newValue: { reason: req.body?.reason ?? null } });
    res.json({ ok: true });
  });

  router.delete('/devices/:id', numericOnly, requirePermission(F, 'void_archive'), (req, res) => {
    const db = getDb();
    const row = db.prepare('SELECT * FROM rf_devices WHERE id = ?').get(req.params.id) as any;
    if (!row) return res.status(404).json({ error: 'That browser is not on the register.' });
    if (Number(row.fills ?? 0) > 0) {
      return res.status(409).json({ error: `${row.label} has filled ${row.fills} form(s) and is part of their record. Revoke it instead.` });
    }
    db.prepare('DELETE FROM rf_devices WHERE id = ?').run(row.id);
    audit(req, { action: 'delete', entity: 'rf_devices', entityId: row.id, oldValue: { label: row.label } });
    res.json({ ok: true });
  });

  /* ------------------------------------------------------------- the record */
  router.get('/activity', requirePermission(F, 'view'), (req, res) => {
    const db = getDb();
    const limit = bounded(req.query.limit, 100, 1, 500);
    const where: string[] = [];
    const args: any[] = [];
    if (req.query.state) { where.push('f.state = ?'); args.push(String(req.query.state)); }
    if (req.query.adapterId) { where.push('f.adapter_id = ?'); args.push(Number(req.query.adapterId)); }
    if (req.query.search) {
      where.push('(LOWER(IFNULL(f.identifier, \'\')) LIKE ? OR LOWER(IFNULL(f.page_title, \'\')) LIKE ?)');
      const like = `%${String(req.query.search).toLowerCase()}%`;
      args.push(like, like);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const rows = db.prepare(`SELECT f.*, a.name AS adapter_name, a.platform, d.label AS device_label,
          u.username AS user_name, m.sample_id, m.received_at AS message_received_at
        FROM rf_fills f
        LEFT JOIN rf_adapters a ON a.id = f.adapter_id
        LEFT JOIN rf_devices d ON d.id = f.device_id
        LEFT JOIN users u ON u.id = f.user_id
        LEFT JOIN instrument_messages m ON m.id = f.instrument_message_id
        ${clause} ORDER BY f.id DESC LIMIT ?`).all(...args, limit) as any[];
    const total = Number((db.prepare(`SELECT COUNT(*) AS n FROM rf_fills f ${clause}`).get(...args) as any)?.n ?? 0);
    res.json({ total, rows: rows.map(row => ({ ...row, unmatched: json<any[]>(row.unmatched, []), detail: json<any[]>(row.detail, []) })) });
  });

  /* ------------------------------------------------- the extension, as a zip */
  router.get('/package', requirePermission(F, 'view'), async (req, res) => {
    try {
      await packageExtension(res, {
        host: text(req.query.host, 200) ?? `${req.protocol}://${req.get('host') ?? '127.0.0.1:4317'}`,
      });
      audit(req, { action: 'export', entity: 'rf_package', newValue: { host: req.query.host ?? null } });
    } catch (error) {
      if (!res.headersSent) res.status(500).json({ error: `The extension could not be packaged: ${(error as Error).message}` });
    }
  });

  return router;
}
