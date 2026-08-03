import { Router } from 'express';
import { getDb } from '../db/database.js';
import { requirePermission } from '../middleware/permissions.js';
import {
  createDennisPlaceholder, maskedSettings, updateSettings, rawSettings,
  indexDocument, indexAllApproved, indexStats, searchDennis, askDennis,
  moduleHelper, computeAlerts, testConnection, redactPreview, logActivity,
  analyzeSop,
} from '../services/dennisService.js';

export function dennisRoutes() {
  const router = Router();

  // -------- Activity log --------
  router.get('/activity-log', requirePermission('dennis', 'view'), (_req, res) => {
    const rows = getDb().prepare(`SELECT l.id, l.created_at AS dateTime, l.user_id AS userId, u.full_name AS userName, l.module, l.current_page AS currentPage,
        l.action, l.dennis_mode AS aiMode, l.provider, l.status, l.record_id AS recordId, l.source_document_ids AS sourceDocumentIds, l.error_message AS errorMessage,
        l.online_used AS onlineUsed, l.redaction_applied AS redactionApplied, l.document_name AS documentName, l.task_type AS taskType
      FROM dennis_activity_logs l LEFT JOIN users u ON u.id = l.user_id ORDER BY l.id DESC LIMIT 200`).all();
    res.json({ rows });
  });

  // -------- Settings --------
  router.get('/settings', requirePermission('dennis', 'view'), (_req, res) => {
    res.json({ settings: maskedSettings(getDb()) });
  });
  router.put('/settings', requirePermission('dennis', 'edit'), (req, res) => {
    const kv = (req.body && typeof req.body === 'object' ? req.body.settings ?? req.body : {}) as Record<string, string>;
    updateSettings(getDb(), kv, req.user!.id);
    logActivity(getDb(), { userId: req.user!.id, module: 'dennis', action: 'settings_update', status: 'ok' });
    res.json({ ok: true, settings: maskedSettings(getDb()) });
  });
  router.post('/test-connection', requirePermission('dennis', 'edit'), async (req, res) => {
    const which = req.body?.which === 'online' ? 'online' : 'local';
    res.json(await testConnection(getDb(), which));
  });

  // -------- Indexing (DENNIS-2) --------
  router.get('/index-stats', requirePermission('dennis', 'view'), (_req, res) => res.json(indexStats(getDb())));
  router.post('/index/:id', requirePermission('dennis', 'edit'), (req, res) => {
    res.json(indexDocument(getDb(), Number(req.params.id), req.user!.id));
  });
  router.post('/index-all', requirePermission('dennis', 'edit'), (req, res) => {
    res.json(indexAllApproved(getDb(), req.user!.id));
  });

  // -------- Search & Ask (DENNIS-2/3) --------
  router.get('/search', requirePermission('dennis', 'view'), (req, res) => {
    const results = searchDennis(getDb(), {
      q: String(req.query.q || ''), module: req.query.module ? String(req.query.module) : undefined,
      documentType: req.query.documentType ? String(req.query.documentType) : undefined,
      status: req.query.status ? String(req.query.status) : undefined,
      currentOnly: req.query.currentOnly === 'true', userId: req.user!.id,
    });
    logActivity(getDb(), { userId: req.user!.id, module: 'dennis', action: 'search', status: 'ok', detail: String(req.query.q || '').slice(0, 120), sourceDocumentIds: results.map(r => r.sourceDocumentId).filter(Boolean) as number[] });
    res.json({ results });
  });
  router.post('/ask', requirePermission('dennis', 'view'), async (req, res) => {
    try {
      const out = await askDennis(getDb(), { question: String(req.body?.question || ''), context: req.body?.context, userId: req.user!.id, allowOnline: !!req.body?.allowOnline, confirmed: !!req.body?.confirmed });
      res.json(out);
    } catch (e) { res.status(500).json({ error: e instanceof Error ? e.message : 'Dennis failed to answer' }); }
  });

  // -------- Module helpers (DENNIS-5) --------
  router.post('/helper', requirePermission('dennis', 'view'), async (req, res) => {
    try {
      const out = await moduleHelper(getDb(), {
        module: String(req.body?.module || 'general'), task: String(req.body?.task || 'summarize'),
        recordId: req.body?.recordId ?? null, inputText: req.body?.inputText ?? '', userId: req.user!.id,
        allowOnline: !!req.body?.allowOnline, confirmed: !!req.body?.confirmed,
      });
      res.json(out);
    } catch (e) { res.status(500).json({ error: e instanceof Error ? e.message : 'Dennis helper failed' }); }
  });
  router.post('/suggestions/:id/accept', requirePermission('dennis', 'view'), (req, res) => {
    const db = getDb();
    db.prepare('UPDATE dennis_suggestions SET accepted = ? WHERE id = ?').run(req.body?.accepted === false ? 0 : 1, req.params.id);
    logActivity(db, { userId: req.user!.id, module: 'dennis', action: req.body?.accepted === false ? 'suggestion_rejected' : 'suggestion_accepted', status: 'ok', recordId: String(req.params.id) });
    res.json({ ok: true });
  });

  // -------- SOP / document analysis (online-capable, gated) --------
  router.post('/sop-analyze', requirePermission('dennis', 'view'), async (req, res) => {
    try {
      const b = req.body || {};
      const out = await analyzeSop(getDb(), {
        task: String(b.task || 'summarize'),
        documentId: b.documentId != null ? Number(b.documentId) : undefined,
        versionId: b.versionId != null ? Number(b.versionId) : undefined,
        fileId: b.fileId != null ? Number(b.fileId) : undefined,
        text: b.text != null ? String(b.text) : undefined,
        name: b.name != null ? String(b.name) : undefined,
        compareDocumentId: b.compareDocumentId != null ? Number(b.compareDocumentId) : undefined,
        compareVersionId: b.compareVersionId != null ? Number(b.compareVersionId) : undefined,
        compareFileId: b.compareFileId != null ? Number(b.compareFileId) : undefined,
        compareText: b.compareText != null ? String(b.compareText) : undefined,
        userId: req.user!.id,
        confirmed: !!b.confirmed,
      });
      res.json(out);
    } catch (e) { res.status(500).json({ error: e instanceof Error ? e.message : 'SOP analysis failed' }); }
  });

  // -------- Alerts (DENNIS) --------
  router.get('/alerts', requirePermission('dennis', 'view'), (_req, res) => res.json({ alerts: computeAlerts(getDb()) }));

  // -------- Redaction preview (DENNIS-6) --------
  router.post('/redact-preview', requirePermission('dennis', 'view'), (req, res) => res.json(redactPreview(String(req.body?.text || ''))));

  // -------- Phase AI-1 placeholder (kept) --------
  router.post('/placeholder', requirePermission('dennis', 'view'), (req, res) => {
    res.json(createDennisPlaceholder(String(req.body?.action ?? 'Dennis request')));
  });

  void rawSettings;
  return router;
}
