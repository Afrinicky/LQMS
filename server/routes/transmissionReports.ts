/**
 * Transmitted results, as laboratory reports.
 *
 *   GET  /transmission-reports            the register, filtered
 *   GET  /transmission-reports/:id        one report, as data for the viewer
 *   GET  /transmission-reports/:id/print  the same report, as a page to print
 *   GET  /transmission-reports/print      several reports in one document
 *   GET  /transmission-reports/export.docx   Word
 *   GET  /transmission-reports/export.xlsx   Excel
 *   GET/PUT/POST /transmission-reports/templates   how the report looks
 *
 * PDF is the browser's own print-to-PDF, as everywhere else in SECHLIMS. Word
 * is built from the same HTML by the same builder the document library uses,
 * and Excel is one row per parameter so a batch can be worked on as data.
 *
 * Read-only towards the transmission path. Producing a report changes nothing
 * about the message it describes.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Router } from 'express';
import { getDb } from '../db/database.js';
import { requireAuth } from '../middleware/auth.js';
import { requirePermission } from '../middleware/permissions.js';
import { audit } from '../services/auditService.js';
import { buildWorkbook, sendWorkbook } from '../utils/xlsxRegister.js';
import { buildDocxFromHtml } from '../utils/documentBuild.js';
import {
  REPORT_HEADERS, collectReport, loadTemplate, renderReportDocument, reportFilename, reportRows,
} from '../services/labReport.js';
import {
  DEFAULT_TEMPLATE, DENSITIES, FONT_CHOICES, HEADER_STYLES, HEADER_STYLE_LABELS, PAPER_SIZES,
  REPORT_COLUMNS, REPORT_COLUMN_LABELS, REQUIRED_COLUMNS, DENSITY_LABELS,
  type ReportColumn,
} from '../../shared/constants/labReport.js';

const F = 'analyser_middleware.reports';

/** Express 5 takes no inline pattern on a parameter, so a numeric id is guarded. */
const numericOnly = (req: any, _res: any, next: any) => (/^\d+$/.test(req.params.id) ? next() : next('route'));

/** At most this many reports in one document, so a stray filter cannot print a year. */
const MAX_BATCH = 60;

function ids(value: unknown): number[] {
  return String(value ?? '')
    .split(',')
    .map(part => Number(String(part).trim()))
    .filter(n => Number.isInteger(n) && n > 0)
    .slice(0, MAX_BATCH);
}

function text(value: unknown, limit = 400): string | null {
  const raw = String(value ?? '').trim();
  return raw ? raw.slice(0, limit) : null;
}

function oneOf<T extends readonly string[]>(value: unknown, allowed: T, fallback: T[number]): T[number] {
  const raw = String(value ?? '').trim();
  return (allowed as readonly string[]).includes(raw) ? raw as T[number] : fallback;
}

function day(value: unknown): string | null {
  const raw = String(value ?? '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;
}

export function transmissionReportRoutes() {
  const router = Router();
  router.use(requireAuth);

  /* ======================================================================
     The register
     ====================================================================== */
  router.get('/', requirePermission(F, 'view'), (req, res) => {
    const db = getDb();
    const limit = Math.min(Math.max(Number(req.query.limit ?? 100) || 100, 1), 300);
    const offset = Math.max(Number(req.query.offset ?? 0) || 0, 0);

    const where: string[] = ['m.result_count > 0'];
    const args: any[] = [];
    const kind = String(req.query.kind ?? '').trim();
    if (kind === 'patient' || kind === 'control' || kind === 'unknown') { where.push('m.kind = ?'); args.push(kind); }
    if (req.query.linkId) { where.push('m.link_id = ?'); args.push(Number(req.query.linkId)); }
    const from = day(req.query.from);
    const to = day(req.query.to);
    if (from) { where.push('date(m.received_at) >= ?'); args.push(from); }
    if (to) { where.push('date(m.received_at) <= ?'); args.push(to); }
    if (req.query.search) {
      const like = `%${String(req.query.search).toLowerCase()}%`;
      where.push(`(LOWER(IFNULL(m.sample_id, '')) LIKE ? OR LOWER(IFNULL(m.lot_number, '')) LIKE ?
        OR LOWER(IFNULL(m.instrument_name, '')) LIKE ? OR LOWER(IFNULL(l.name, '')) LIKE ?)`);
      args.push(like, like, like, like);
    }
    const clause = `WHERE ${where.join(' AND ')}`;

    const rows = db.prepare(`SELECT m.id, m.sample_id, m.lot_number, m.kind, m.received_at, m.instrument_run_at,
          m.instrument_name, m.result_count, l.name AS link_name, e.name AS equipment_name, s.name AS section_name,
          x.status AS mw_status,
          (SELECT COUNT(*) FROM mw_deliveries d WHERE d.message_id = x.id AND d.state = 'delivered') AS delivered
        FROM instrument_messages m
        LEFT JOIN instrument_links l ON l.id = m.link_id
        LEFT JOIN equipment_items e ON e.id = l.equipment_id
        LEFT JOIN sections s ON s.id = l.section_id
        LEFT JOIN mw_messages x ON x.instrument_message_id = m.id
        ${clause} ORDER BY m.received_at DESC, m.id DESC LIMIT ? OFFSET ?`).all(...args, limit, offset) as any[];

    const total = Number((db.prepare(`SELECT COUNT(*) AS n FROM instrument_messages m
        LEFT JOIN instrument_links l ON l.id = m.link_id ${clause}`).get(...args) as any)?.n ?? 0);

    const sources = db.prepare(`SELECT DISTINCT l.id, l.name FROM instrument_messages m
        JOIN instrument_links l ON l.id = m.link_id ORDER BY l.name`).all() as any[];

    res.json({ total, rows, sources });
  });

  /* The vocabulary and the template, for the designer. */
  router.get('/reference', requirePermission(F, 'view'), (_req, res) => {
    res.json({
      papers: PAPER_SIZES.map(key => ({ key, label: key })),
      headerStyles: HEADER_STYLES.map(key => ({ key, label: HEADER_STYLE_LABELS[key] })),
      densities: DENSITIES.map(key => ({ key, label: DENSITY_LABELS[key] })),
      fonts: FONT_CHOICES.map(f => ({ key: f.key, label: f.label })),
      columns: REPORT_COLUMNS.map(key => ({ key, label: REPORT_COLUMN_LABELS[key], required: REQUIRED_COLUMNS.includes(key) })),
    });
  });

  /* ======================================================================
     The appearance
     ====================================================================== */
  router.get('/templates', requirePermission(F, 'view'), (_req, res) => {
    const db = getDb();
    const rows = db.prepare('SELECT * FROM rf_report_templates ORDER BY is_default DESC, id').all() as any[];
    if (!rows.length) return res.json([{ ...loadTemplate(db, null), templateCode: 'DEFAULT', isDefault: true, id: null }]);
    res.json(rows.map(row => loadTemplate(db, row.template_code)));
  });

  function templatePayload(body: any) {
    const columns = Array.isArray(body?.columns)
      ? (body.columns as string[]).filter(c => (REPORT_COLUMNS as readonly string[]).includes(c)) as ReportColumn[]
      : DEFAULT_TEMPLATE.columns;
    for (const required of REQUIRED_COLUMNS) if (!columns.includes(required)) columns.unshift(required);

    const logo = typeof body?.logoDataUri === 'string' ? body.logoDataUri.trim() : null;
    return {
      name: text(body?.name, 120) ?? 'Laboratory report',
      organisation: text(body?.organisation, 160),
      facility: text(body?.facility, 160),
      addressLine: text(body?.addressLine, 200),
      contactLine: text(body?.contactLine, 200),
      reportTitle: text(body?.reportTitle, 80),
      footerText: text(body?.footerText, 400),
      // A crest is an image or it is nothing: anything else in this column
      // would be rendered into a page as a source URL.
      logoDataUri: logo && /^data:image\/(png|jpeg|jpg|gif|svg\+xml);base64,/i.test(logo) && logo.length < 900_000 ? logo : null,
      accentColour: /^#[0-9a-fA-F]{6}$/.test(String(body?.accentColour ?? '')) ? String(body.accentColour) : DEFAULT_TEMPLATE.accentColour,
      textColour: /^#[0-9a-fA-F]{6}$/.test(String(body?.textColour ?? '')) ? String(body.textColour) : DEFAULT_TEMPLATE.textColour,
      headerStyle: oneOf(body?.headerStyle, HEADER_STYLES, 'centred'),
      font: oneOf(body?.font, FONT_CHOICES.map(f => f.key) as unknown as readonly string[], 'serif'),
      paper: oneOf(body?.paper, PAPER_SIZES, 'A4'),
      density: oneOf(body?.density, DENSITIES, 'comfortable'),
      marginMm: Math.min(30, Math.max(5, Number(body?.marginMm ?? 13) || 13)),
      columns: JSON.stringify(columns),
      showLogo: body?.showLogo === false ? 0 : 1,
      showFlagLegend: body?.showFlagLegend === false ? 0 : 1,
      showInstrumentMessages: body?.showInstrumentMessages === false ? 0 : 1,
      showSignature: body?.showSignature === false ? 0 : 1,
      signatureLine: text(body?.signatureLine, 80) ?? 'Authorised by',
      showDeliveryState: body?.showDeliveryState ? 1 : 0,
      watermark: text(body?.watermark, 40),
      disclaimer: text(body?.disclaimer, 500),
    };
  }

  /** Save the appearance. The default template is created on first save. */
  router.put('/templates/:code', requirePermission(F, 'edit'), (req, res) => {
    const db = getDb();
    const code = String(req.params.code ?? 'DEFAULT').toUpperCase().slice(0, 40);
    const payload = templatePayload(req.body);
    const existing = db.prepare('SELECT id FROM rf_report_templates WHERE template_code = ?').get(code) as any;

    if (existing) {
      db.prepare(`UPDATE rf_report_templates SET name = ?, organisation = ?, facility = ?, address_line = ?,
          contact_line = ?, report_title = ?, footer_text = ?, logo_data_uri = ?, accent_colour = ?, text_colour = ?,
          header_style = ?, font = ?, paper = ?, density = ?, margin_mm = ?, columns = ?, show_logo = ?,
          show_flag_legend = ?, show_instrument_messages = ?, show_signature = ?, signature_line = ?,
          show_delivery_state = ?, watermark = ?, disclaimer = ?,
          updated_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .run(payload.name, payload.organisation, payload.facility, payload.addressLine, payload.contactLine,
          payload.reportTitle, payload.footerText, payload.logoDataUri, payload.accentColour, payload.textColour,
          payload.headerStyle, payload.font, payload.paper, payload.density, payload.marginMm, payload.columns,
          payload.showLogo, payload.showFlagLegend, payload.showInstrumentMessages, payload.showSignature,
          payload.signatureLine, payload.showDeliveryState, payload.watermark,
          payload.disclaimer, req.user!.id, existing.id);
    } else {
      db.prepare(`INSERT INTO rf_report_templates
          (template_code, name, organisation, facility, address_line, contact_line, report_title, footer_text,
           logo_data_uri, accent_colour, text_colour, header_style, font, paper, density, margin_mm, columns,
           show_logo, show_flag_legend, show_instrument_messages, show_signature, signature_line,
           show_delivery_state, watermark, disclaimer, is_default, created_by)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(code, payload.name, payload.organisation, payload.facility, payload.addressLine, payload.contactLine,
          payload.reportTitle, payload.footerText, payload.logoDataUri, payload.accentColour, payload.textColour,
          payload.headerStyle, payload.font, payload.paper, payload.density, payload.marginMm, payload.columns,
          payload.showLogo, payload.showFlagLegend, payload.showInstrumentMessages, payload.showSignature,
          payload.signatureLine, payload.showDeliveryState, payload.watermark,
          payload.disclaimer, code === 'DEFAULT' ? 1 : 0, req.user!.id);
    }

    audit(req, { action: 'update', entity: 'rf_report_templates', entityId: code, newValue: { name: payload.name, paper: payload.paper } });
    res.json(loadTemplate(db, code));
  });

  /* ======================================================================
     One report
     ====================================================================== */
  router.get('/:id', numericOnly, requirePermission(F, 'view'), (req, res) => {
    const db = getDb();
    const report = collectReport(db, Number(req.params.id));
    if (!report) return res.status(404).json({ error: 'That transmission is not on the record.' });
    res.json({ report, template: loadTemplate(db, text(req.query.template, 40)) });
  });

  /** The report as a page: the viewer embeds it, and the browser prints it. */
  router.get('/:id/print', numericOnly, requirePermission(F, 'print'), (req, res) => {
    const db = getDb();
    const report = collectReport(db, Number(req.params.id));
    if (!report) return res.status(404).send('That transmission is not on the record.');
    const template = loadTemplate(db, text(req.query.template, 40));
    const html = renderReportDocument([report], template, {
      autoprint: req.query.autoprint === '1',
      toolbar: req.query.toolbar !== '0',
      printedBy: req.user?.username ?? null,
    });
    audit(req, { action: 'print', entity: 'instrument_messages', entityId: report.id, newValue: { sample: report.sampleId } });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  });

  /** Several, in one document — a morning's run printed in one pass. */
  router.get('/print', requirePermission(F, 'print'), (req, res) => {
    const db = getDb();
    const wanted = ids(req.query.ids);
    if (!wanted.length) return res.status(400).send('Choose at least one transmission to print.');
    const reports = wanted.map(id => collectReport(db, id)).filter(Boolean) as NonNullable<ReturnType<typeof collectReport>>[];
    if (!reports.length) return res.status(404).send('None of those transmissions is on the record.');
    const template = loadTemplate(db, text(req.query.template, 40));
    audit(req, { action: 'print', entity: 'instrument_messages', newValue: { count: reports.length } });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(renderReportDocument(reports, template, {
      autoprint: req.query.autoprint === '1', toolbar: req.query.toolbar !== '0', printedBy: req.user?.username ?? null,
    }));
  });

  /** The same report as a Word file, built from the same HTML. */
  router.get('/export.docx', requirePermission(F, 'export'), async (req, res) => {
    const db = getDb();
    const wanted = ids(req.query.ids);
    if (!wanted.length) return res.status(400).json({ error: 'Choose at least one transmission to export.' });
    const reports = wanted.map(id => collectReport(db, id)).filter(Boolean) as NonNullable<ReturnType<typeof collectReport>>[];
    if (!reports.length) return res.status(404).json({ error: 'None of those transmissions is on the record.' });

    const template = loadTemplate(db, text(req.query.template, 40));
    const html = renderReportDocument(reports, template, { toolbar: false });
    const filename = reportFilename(reports, 'docx');
    const temporary = path.join(os.tmpdir(), `sechlims-report-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.docx`);
    try {
      await buildDocxFromHtml(temporary, html, filename.replace(/\.docx$/, ''));
      const buffer = fs.readFileSync(temporary);
      audit(req, { action: 'export', entity: 'instrument_messages', newValue: { format: 'docx', count: reports.length } });
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.end(buffer);
    } catch (error) {
      res.status(500).json({ error: `The Word file could not be built: ${(error as Error).message}` });
    } finally {
      try { fs.unlinkSync(temporary); } catch { /* a temporary file that is already gone */ }
    }
  });

  /** One row per parameter, so a batch can be worked on as data. */
  router.get('/export.xlsx', requirePermission(F, 'export'), (req, res) => {
    const db = getDb();
    const wanted = ids(req.query.ids);
    if (!wanted.length) return res.status(400).json({ error: 'Choose at least one transmission to export.' });
    const reports = wanted.map(id => collectReport(db, id)).filter(Boolean) as NonNullable<ReturnType<typeof collectReport>>[];
    if (!reports.length) return res.status(404).json({ error: 'None of those transmissions is on the record.' });
    audit(req, { action: 'export', entity: 'instrument_messages', newValue: { format: 'xlsx', count: reports.length } });
    sendWorkbook(res, buildWorkbook(REPORT_HEADERS, reportRows(reports), 'LAB RESULTS'), reportFilename(reports, 'xlsx'));
  });

  return router;
}
