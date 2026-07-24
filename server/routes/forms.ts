/**
 * Dynamic Digital Forms Engine API (Phase 2).
 *
 * Administrators author forms as JSON templates (sections → fields); staff fill
 * them on mobile. New operational forms (checklists, inspection sheets, logs)
 * are created without any application update — the client renders whatever the
 * template describes and this route validates + stores submissions.
 *
 *   GET    /api/forms/templates                 → list active templates
 *   GET    /api/forms/templates/:key            → one template (full schema)
 *   POST   /api/forms/templates                 → create a template
 *   PUT    /api/forms/templates/:id             → update a template (bumps version)
 *   POST   /api/forms/templates/:id/toggle      → activate/deactivate
 *   POST   /api/forms/submissions               → submit answers for a template
 *   GET    /api/forms/submissions               → list submissions (filterable)
 *   GET    /api/forms/submissions/:id           → one submission
 *
 * Supported field types: heading, text, textarea, number, date, time, datetime,
 * dropdown, multichoice, checkbox, passfail, rating, signature, photo, qr.
 */
import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { requirePermission } from '../middleware/permissions.js';
import { getDb } from '../db/database.js';
import { audit } from '../services/auditService.js';
import { recordSignature } from '../services/signatureService.js';
import { generateRecordNumber } from '../utils/recordNumber.js';
import { getCurrentStaffId, parseIntNullable } from './routeHelpers.js';

interface FormField {
  key: string;
  label: string;
  type: string;
  required?: boolean;
  options?: string[];
  max?: number;
  min?: number;
  pattern?: string;
  showIf?: { field: string; equals: unknown };
}
interface FormSection { title?: string; fields: FormField[] }
interface FormSchema { sections: FormSection[] }

const DISPLAY_ONLY = new Set(['heading']);
const CHOICE_TYPES = new Set(['dropdown', 'multichoice']);

function parseSchema(raw: string): FormSchema {
  const parsed = JSON.parse(raw) as FormSchema;
  if (!parsed || !Array.isArray(parsed.sections)) throw new Error('schema must have a sections array');
  return parsed;
}

/** Validate answers against a schema; returns collected errors ([] = valid). */
function validateAnswers(schema: FormSchema, answers: Record<string, unknown>): string[] {
  const errors: string[] = [];
  const isEmpty = (v: unknown) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
  const visible = (f: FormField) => !f.showIf || answers[f.showIf.field] === f.showIf.equals;

  for (const section of schema.sections) {
    for (const f of section.fields ?? []) {
      if (DISPLAY_ONLY.has(f.type) || !visible(f)) continue;
      const v = answers[f.key];
      if (f.required && isEmpty(v)) { errors.push(`"${f.label}" is required`); continue; }
      if (isEmpty(v)) continue;
      switch (f.type) {
        case 'number':
        case 'rating': {
          const n = Number(v);
          if (!Number.isFinite(n)) errors.push(`"${f.label}" must be a number`);
          else if (f.min !== undefined && n < f.min) errors.push(`"${f.label}" must be ≥ ${f.min}`);
          else if (f.max !== undefined && n > f.max) errors.push(`"${f.label}" must be ≤ ${f.max}`);
          break;
        }
        case 'passfail':
          if (!['pass', 'fail', 'na', true, false].includes(v as never)) errors.push(`"${f.label}" must be pass/fail`);
          break;
        case 'dropdown':
          if (f.options && !f.options.includes(String(v))) errors.push(`"${f.label}" has an invalid selection`);
          break;
        case 'multichoice':
          if (f.options && Array.isArray(v) && !v.every(x => f.options!.includes(String(x)))) errors.push(`"${f.label}" has an invalid selection`);
          break;
        case 'text':
        case 'textarea':
          if (f.pattern && !new RegExp(f.pattern).test(String(v))) errors.push(`"${f.label}" is not in the expected format`);
          break;
        default:
          break;
      }
    }
  }
  return errors;
}

/** Derive an overall pass/fail result from any passfail/checkbox fields. */
function deriveResult(schema: FormSchema, answers: Record<string, unknown>): string | null {
  let sawGate = false; let failed = false;
  for (const section of schema.sections) {
    for (const f of section.fields ?? []) {
      if (f.type === 'passfail' && answers[f.key] !== undefined) {
        sawGate = true;
        if (answers[f.key] === 'fail' || answers[f.key] === false) failed = true;
      }
    }
  }
  return sawGate ? (failed ? 'fail' : 'pass') : null;
}

export function formsRoutes() {
  const router = Router();

  // ── Templates ──
  router.get('/templates', requireAuth, (req, res) => {
    const db = getDb();
    const includeInactive = req.query.all === '1';
    const category = req.query.category ? String(req.query.category) : null;
    let q = 'SELECT id, template_key, title, category, description, module_key, version, requires_signature, is_active, updated_at FROM form_templates';
    const where: string[] = []; const params: unknown[] = [];
    if (!includeInactive) where.push('is_active = 1');
    if (category) { where.push('category = ?'); params.push(category); }
    if (where.length) q += ` WHERE ${where.join(' AND ')}`;
    q += ' ORDER BY category, title';
    res.json(db.prepare(q).all(...params));
  });

  router.get('/templates/:key', requireAuth, (req, res) => {
    const db = getDb();
    const row = /^\d+$/.test(req.params.key)
      ? db.prepare('SELECT * FROM form_templates WHERE id = ?').get(req.params.key)
      : db.prepare('SELECT * FROM form_templates WHERE template_key = ?').get(req.params.key);
    if (!row) return res.status(404).json({ error: 'Template not found' });
    const t = row as { schema_json: string };
    res.json({ ...row, schema: JSON.parse(t.schema_json) });
  });

  router.post('/templates', requirePermission('records_reports', 'create'), (req, res) => {
    const { templateKey, title, category, description, moduleKey, schema, requiresSignature } = req.body ?? {};
    if (!templateKey || !title || !schema) return res.status(400).json({ error: 'templateKey, title and schema are required' });
    let schemaStr: string;
    try { schemaStr = JSON.stringify(parseSchema(typeof schema === 'string' ? schema : JSON.stringify(schema))); }
    catch (e) { return res.status(400).json({ error: (e as Error).message }); }
    const db = getDb();
    if (db.prepare('SELECT 1 FROM form_templates WHERE template_key = ?').get(templateKey)) return res.status(409).json({ error: 'A template with that key already exists' });
    const result = db.prepare(`INSERT INTO form_templates (template_key, title, category, description, module_key, schema_json, requires_signature, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(templateKey, title, category ?? null, description ?? null, moduleKey ?? null, schemaStr, requiresSignature ? 1 : 0, req.user!.id);
    const id = Number(result.lastInsertRowid);
    audit(req, { action: 'create', entity: 'form_templates', entityId: id, newValue: { templateKey, title } });
    res.status(201).json({ id, templateKey });
  });

  router.put('/templates/:id', requirePermission('records_reports', 'edit'), (req, res) => {
    const db = getDb();
    const existing = db.prepare('SELECT * FROM form_templates WHERE id = ?').get(req.params.id) as { version: number } | undefined;
    if (!existing) return res.status(404).json({ error: 'Template not found' });
    const { title, category, description, moduleKey, schema, requiresSignature } = req.body ?? {};
    let schemaStr: string | null = null;
    if (schema !== undefined) {
      try { schemaStr = JSON.stringify(parseSchema(typeof schema === 'string' ? schema : JSON.stringify(schema))); }
      catch (e) { return res.status(400).json({ error: (e as Error).message }); }
    }
    db.prepare(`UPDATE form_templates SET title = COALESCE(?, title), category = COALESCE(?, category), description = COALESCE(?, description), module_key = COALESCE(?, module_key), schema_json = COALESCE(?, schema_json), requires_signature = COALESCE(?, requires_signature), version = version + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(title ?? null, category ?? null, description ?? null, moduleKey ?? null, schemaStr, requiresSignature === undefined ? null : (requiresSignature ? 1 : 0), schemaStr ? 1 : 0, req.params.id);
    audit(req, { action: 'update', entity: 'form_templates', entityId: req.params.id, newValue: req.body });
    res.json({ ok: true });
  });

  router.post('/templates/:id/toggle', requirePermission('records_reports', 'edit'), (req, res) => {
    const db = getDb();
    const t = db.prepare('SELECT is_active FROM form_templates WHERE id = ?').get(req.params.id) as { is_active: number } | undefined;
    if (!t) return res.status(404).json({ error: 'Template not found' });
    const next = t.is_active ? 0 : 1;
    db.prepare('UPDATE form_templates SET is_active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(next, req.params.id);
    audit(req, { action: 'toggle', entity: 'form_templates', entityId: req.params.id, newValue: { is_active: next } });
    res.json({ ok: true, isActive: next });
  });

  // ── Submissions ──
  router.post('/submissions', requireAuth, (req, res) => {
    const { templateKey, answers, signatureImageFileId, meaning } = req.body ?? {};
    if (!templateKey || !answers || typeof answers !== 'object') return res.status(400).json({ error: 'templateKey and answers are required' });
    const db = getDb();
    const template = db.prepare('SELECT * FROM form_templates WHERE template_key = ? AND is_active = 1').get(templateKey) as
      { id: number; template_key: string; title: string; version: number; schema_json: string; requires_signature: number; module_key: string | null } | undefined;
    if (!template) return res.status(404).json({ error: 'Template not found or inactive' });

    let schema: FormSchema;
    try { schema = parseSchema(template.schema_json); } catch (e) { return res.status(500).json({ error: (e as Error).message }); }
    const errors = validateAnswers(schema, answers as Record<string, unknown>);
    if (errors.length) return res.status(400).json({ error: errors.join('; '), errors });

    const staffId = getCurrentStaffId(req);
    const createdAt = new Date().toISOString();
    const submissionNumber = generateRecordNumber(db, 'form_submissions', 'FORM', createdAt);
    const result = deriveResult(schema, answers as Record<string, unknown>);
    const insert = db.prepare(`INSERT INTO form_submissions
        (submission_number, template_id, template_key, template_version, answers_json, result, status, submitted_by_staff_id, submitted_by_user_id, department_id, section_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 'submitted', ?, ?, ?, ?, ?)`)
      .run(submissionNumber, template.id, template.template_key, template.version, JSON.stringify(answers), result, staffId, req.user!.id,
        parseIntNullable(req.body.departmentId), parseIntNullable(req.body.sectionId), createdAt);
    const id = Number(insert.lastInsertRowid);

    // Electronic signature when the template requires one.
    if (template.requires_signature) {
      const sig = recordSignature(req, {
        moduleKey: template.module_key ?? 'records_reports', recordType: 'form_submission', recordId: id,
        purpose: `form:${template.template_key}`, meaning: meaning ?? `Completion of ${template.title}`, signatureImageFileId: signatureImageFileId ?? null,
      });
      db.prepare('UPDATE form_submissions SET signature_id = ? WHERE id = ?').run(sig.id, id);
    }

    audit(req, { action: 'submit', entity: 'form_submissions', entityId: id, newValue: { templateKey, submissionNumber, result } });
    res.status(201).json({ id, submissionNumber, result });
  });

  router.get('/submissions', requireAuth, (req, res) => {
    const db = getDb();
    const where: string[] = []; const params: unknown[] = [];
    if (req.query.templateKey) { where.push('fs.template_key = ?'); params.push(String(req.query.templateKey)); }
    if (req.query.mine === '1') { where.push('fs.submitted_by_user_id = ?'); params.push(req.user!.id); }
    if (req.query.result) { where.push('fs.result = ?'); params.push(String(req.query.result)); }
    let q = `SELECT fs.id, fs.submission_number, fs.template_key, fs.result, fs.status, fs.created_at, ft.title AS template_title, s.full_name AS submitted_by
      FROM form_submissions fs JOIN form_templates ft ON ft.id = fs.template_id LEFT JOIN staff s ON s.id = fs.submitted_by_staff_id`;
    if (where.length) q += ` WHERE ${where.join(' AND ')}`;
    q += ' ORDER BY fs.created_at DESC LIMIT 200';
    res.json(db.prepare(q).all(...params));
  });

  router.get('/submissions/:id', requireAuth, (req, res) => {
    const db = getDb();
    const row = db.prepare(`SELECT fs.*, ft.title AS template_title, ft.schema_json, s.full_name AS submitted_by
      FROM form_submissions fs JOIN form_templates ft ON ft.id = fs.template_id LEFT JOIN staff s ON s.id = fs.submitted_by_staff_id WHERE fs.id = ?`).get(req.params.id) as
      { answers_json: string; schema_json: string } | undefined;
    if (!row) return res.status(404).json({ error: 'Submission not found' });
    res.json({ ...row, answers: JSON.parse(row.answers_json), schema: JSON.parse(row.schema_json) });
  });

  return router;
}
