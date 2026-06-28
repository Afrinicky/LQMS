/**
 * Dennis AI Quality Assistant — service layer (Phases 2-6).
 *
 * All Dennis logic lives behind this service: offline document indexing,
 * permission-scoped keyword/semantic search, source-grounded answers, module
 * helpers, real alerts, settings and activity logging. Routes and UI never call
 * AI providers directly — they call these functions, which enforce the safety
 * rules (assistant-only, source citations, redaction before any online call).
 */
import path from 'node:path';
import { uploadRoot, evidenceRoot } from '../db/database.js';
import { resolvePermission } from './permissionResolver.js';
import { extractDocument } from '../utils/documentExtract.js';
import {
  DENNIS_NOTICE, chunkText, cosineSim, redact,
  localChat, localEmbed, onlineChat, testProvider,
  type DennisProviderSettings, type Redaction,
} from '../utils/dennisEngine.js';

export { DENNIS_NOTICE } from '../utils/dennisEngine.js';

// Kept for backwards compatibility with the Phase AI-1 placeholder endpoint.
export function createDennisPlaceholder(action: string) {
  return {
    output: `This is a placeholder Dennis response for ${action}. Future phases will use approved SECH_LIMS records and configured offline/online AI workflows.`,
    notice: DENNIS_NOTICE,
    sources: [] as Array<{ title: string; version?: string; status?: string; section?: string }>,
    mode: 'offline-placeholder',
  };
}

// ── Settings ─────────────────────────────────────────────────────────────────
export function rawSettings(db: any): Record<string, string> {
  const rows = db.prepare('SELECT setting_key, setting_value FROM dennis_settings').all() as Array<{ setting_key: string; setting_value: string }>;
  const out: Record<string, string> = {};
  for (const r of rows) out[r.setting_key] = r.setting_value;
  return out;
}
export function providerSettings(db: any): DennisProviderSettings {
  const s = rawSettings(db);
  const b = (k: string) => s[k] === 'true';
  return {
    localEnabled: b('dennis.local.enabled'), localProvider: s['dennis.local.provider'] || 'ollama',
    localEndpoint: s['dennis.local.endpoint'] || 'http://localhost:11434', localChatModel: s['dennis.local.chatModel'] || 'llama3.1',
    localEmbedModel: s['dennis.local.embedModel'] || 'nomic-embed-text',
    onlineEnabled: b('dennis.online.enabled'), onlineProvider: s['dennis.online.provider'] || 'anthropic',
    onlineEndpoint: s['dennis.online.endpoint'] || '', onlineModel: s['dennis.online.model'] || 'claude-sonnet-4-6',
    onlineApiKey: s['dennis.online.apiKey'] || '',
  };
}
// Settings for the UI, with the API key masked (never returned in the clear).
export function maskedSettings(db: any): Record<string, string> {
  const s = rawSettings(db);
  if (s['dennis.online.apiKey']) s['dennis.online.apiKey'] = '••••••••' + s['dennis.online.apiKey'].slice(-4);
  return s;
}
export function updateSettings(db: any, kv: Record<string, string>, userId: number) {
  const stmt = db.prepare(`INSERT INTO dennis_settings (setting_key, setting_value, updated_by, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value, updated_by = excluded.updated_by, updated_at = CURRENT_TIMESTAMP`);
  const tx = db.transaction(() => {
    for (const [k, v] of Object.entries(kv)) {
      if (!k.startsWith('dennis.')) continue;
      // Never overwrite a stored key with the masked placeholder.
      if (k === 'dennis.online.apiKey' && /^•+/.test(String(v))) continue;
      stmt.run(k, String(v), userId);
    }
  });
  tx();
}

// ── Permission scope ─────────────────────────────────────────────────────────
// Elevated users (can edit/approve Dennis) may see all document statuses and
// access levels; everyone else sees only current/approved, non-confidential docs.
export function permissionScope(userId: number): { elevated: boolean } {
  const can = (a: string) => { try { return resolvePermission(userId, 'dennis', a).allowed; } catch { return false; } };
  return { elevated: can('approve') || can('edit') };
}
function visibleDoc(doc: { status?: string; access_level?: string }, elevated: boolean): boolean {
  if (elevated) return true;
  const status = (doc.status || '').toLowerCase();
  const access = (doc.access_level || 'internal').toLowerCase();
  return ['current', 'approved', 'active'].includes(status) && ['public', 'internal', ''].includes(access);
}

// ── Activity logging ─────────────────────────────────────────────────────────
export function logActivity(db: any, e: { userId?: number | null; module?: string; action: string; mode?: string; provider?: string; status?: string; currentPage?: string; recordId?: string | null; sourceDocumentIds?: number[]; error?: string | null; detail?: string }) {
  try {
    db.prepare(`INSERT INTO dennis_activity_logs (user_id, module, action, dennis_mode, provider, status, current_page, record_id, source_document_ids, error_message, detail)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      e.userId ?? null, e.module ?? 'dennis', e.action, e.mode ?? 'offline', e.provider ?? null, e.status ?? 'ok',
      e.currentPage ?? null, e.recordId ?? null, e.sourceDocumentIds?.length ? JSON.stringify(e.sourceDocumentIds) : null, e.error ?? null, e.detail ?? null);
  } catch { /* logging must never break the request */ }
}

// ── Indexing ─────────────────────────────────────────────────────────────────
function versionText(db: any, doc: any): { text: string; sections: Array<{ heading: string; body: string }> } {
  const v = doc.current_version_id ? db.prepare('SELECT * FROM document_versions WHERE id = ?').get(doc.current_version_id) as any : null;
  let text = (v?.content_text as string) || '';
  let sections: Array<{ heading: string; body: string }> = [];
  try { sections = v?.content_sections ? JSON.parse(v.content_sections) : []; } catch { sections = []; }
  // If the document module never extracted text, read the attached file now.
  if ((!text || text.length < 20) && v?.file_id) {
    const file = db.prepare('SELECT * FROM files WHERE id = ?').get(v.file_id) as any;
    if (file) {
      const root = file.storage_area === 'evidence' ? evidenceRoot : uploadRoot;
      const r = extractDocument(path.join(root, file.stored_name), file.original_name, file.mime_type);
      text = r.text; sections = r.sections;
    }
  }
  return { text, sections };
}

export function indexDocument(db: any, sourceDocId: number, userId: number): { ok: boolean; status: string; chunks: number; error?: string } {
  const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(sourceDocId) as any;
  if (!doc) return { ok: false, status: 'failed', chunks: 0, error: 'Source document not found' };
  const v = doc.current_version_id ? db.prepare('SELECT version_number, effective_date FROM document_versions WHERE id = ?').get(doc.current_version_id) as any : null;
  // Upsert the dennis_documents row.
  const existing = db.prepare('SELECT id FROM dennis_documents WHERE source_document_id = ?').get(sourceDocId) as any;
  let denId: number;
  const base = {
    title: doc.title, document_type: doc.document_type, version: v?.version_number ?? null, status: doc.status,
    source_version_id: doc.current_version_id ?? null, document_code: doc.document_code ?? null, section_id: doc.section_id ?? null,
    access_level: doc.access_level ?? 'internal', effective_date: v?.effective_date ?? null, next_review_date: doc.next_review_date ?? null,
  };
  if (existing) {
    denId = existing.id;
    db.prepare(`UPDATE dennis_documents SET title=?, document_type=?, version=?, status=?, source_version_id=?, document_code=?, section_id=?, access_level=?, approval_status=?, effective_date=?, next_review_date=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
      .run(base.title, base.document_type, base.version, base.status, base.source_version_id, base.document_code, base.section_id, base.access_level, base.status, base.effective_date, base.next_review_date, denId);
    db.prepare('DELETE FROM dennis_chunk_fts WHERE dennis_document_id = ?').run(denId);
    db.prepare('DELETE FROM dennis_document_chunks WHERE document_id = ?').run(denId);
  } else {
    const r = db.prepare(`INSERT INTO dennis_documents (title, module, document_type, source_record_id, version, status, source_document_id, source_version_id, document_code, section_id, access_level, approval_status, effective_date, next_review_date) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(base.title, 'documents', base.document_type, String(sourceDocId), base.version, base.status, sourceDocId, base.source_version_id, base.document_code, base.section_id, base.access_level, base.status, base.effective_date, base.next_review_date);
    denId = Number(r.lastInsertRowid);
  }

  const { text, sections } = versionText(db, doc);
  const searchable = [doc.document_code, doc.title, doc.document_type, text].filter(Boolean).join('\n');
  if (!text || text.replace(/\s/g, '').length < 20) {
    const err = 'Text extraction not available for scanned document in this phase.';
    db.prepare("UPDATE dennis_documents SET searchable_text=?, indexing_status='skipped', indexing_error=?, indexed_by=?, indexed_at=CURRENT_TIMESTAMP, last_indexed_at=CURRENT_TIMESTAMP, chunk_count=0, word_count=0 WHERE id=?")
      .run(searchable, err, userId, denId);
    logActivity(db, { userId, module: 'documents', action: 'index_skipped', status: 'skipped', recordId: String(sourceDocId), error: err });
    return { ok: false, status: 'skipped', chunks: 0, error: err };
  }
  const chunks = chunkText(text, sections);
  const insChunk = db.prepare('INSERT INTO dennis_document_chunks (document_id, source_document_id, chunk_text, chunk_index, section_heading, word_count) VALUES (?,?,?,?,?,?)');
  const insFts = db.prepare('INSERT INTO dennis_chunk_fts (chunk_text, chunk_id, dennis_document_id) VALUES (?,?,?)');
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  const tx = db.transaction(() => {
    for (const ch of chunks) {
      const cr = insChunk.run(denId, sourceDocId, ch.text, ch.index, ch.heading, ch.wordCount);
      insFts.run(ch.text, Number(cr.lastInsertRowid), denId);
    }
    db.prepare("UPDATE dennis_documents SET searchable_text=?, indexing_status='indexed', indexing_error=NULL, indexed_by=?, indexed_at=CURRENT_TIMESTAMP, last_indexed_at=CURRENT_TIMESTAMP, chunk_count=?, word_count=? WHERE id=?")
      .run(searchable, userId, chunks.length, wordCount, denId);
  });
  tx();
  logActivity(db, { userId, module: 'documents', action: 'index', status: 'ok', recordId: String(sourceDocId), sourceDocumentIds: [sourceDocId], detail: `${chunks.length} chunks` });
  return { ok: true, status: 'indexed', chunks: chunks.length };
}

export function indexAllApproved(db: any, userId: number): { indexed: number; skipped: number; failed: number; total: number } {
  const docs = db.prepare("SELECT id FROM documents WHERE status IN ('current','approved') ORDER BY id").all() as Array<{ id: number }>;
  const res = { indexed: 0, skipped: 0, failed: 0, total: docs.length };
  for (const d of docs) {
    try {
      const r = indexDocument(db, d.id, userId);
      if (r.status === 'indexed') res.indexed++; else if (r.status === 'skipped') res.skipped++; else res.failed++;
    } catch (e) {
      res.failed++;
      try { db.prepare("UPDATE dennis_documents SET indexing_status='failed', indexing_error=? WHERE source_document_id=?").run(e instanceof Error ? e.message : 'index error', d.id); } catch { /* ignore */ }
    }
  }
  logActivity(db, { userId, module: 'documents', action: 'index_all', status: 'ok', detail: JSON.stringify(res) });
  return res;
}

// ── Search ───────────────────────────────────────────────────────────────────
function ftsQuery(q: string): string {
  const m = q.match(/[A-Za-z0-9]+/g);
  const tokens = (m ? Array.from(m) : []).filter(t => t.length > 1).slice(0, 12);
  if (!tokens.length) return '';
  return tokens.map(t => `"${t}"*`).join(' OR ');
}
export type SearchResult = { dennisDocumentId: number; sourceDocumentId: number | null; title: string; documentCode: string | null; documentType: string | null; module: string | null; version: string | null; status: string | null; sectionHeading: string | null; excerpt: string; score: number; indexedAt: string | null };

export function searchDennis(db: any, opts: { q: string; module?: string; documentType?: string; status?: string; currentOnly?: boolean; userId: number; limit?: number }): SearchResult[] {
  const match = ftsQuery(opts.q);
  if (!match) return [];
  const { elevated } = permissionScope(opts.userId);
  const limit = Math.min(opts.limit ?? 30, 100);
  const rows = db.prepare(`
    SELECT f.chunk_id AS chunkId, f.dennis_document_id AS denId, rank AS score,
           snippet(dennis_chunk_fts, 0, '〔', '〕', ' … ', 18) AS excerpt
    FROM dennis_chunk_fts f WHERE dennis_chunk_fts MATCH ? ORDER BY rank LIMIT 300`).all(match) as Array<{ chunkId: number; denId: number; score: number; excerpt: string }>;
  const byDoc = new Map<number, { score: number; excerpt: string; chunkId: number }>();
  for (const r of rows) { if (!byDoc.has(r.denId)) byDoc.set(r.denId, { score: r.score, excerpt: r.excerpt, chunkId: r.chunkId }); }
  const out: SearchResult[] = [];
  for (const [denId, best] of byDoc) {
    const d = db.prepare('SELECT * FROM dennis_documents WHERE id = ?').get(denId) as any;
    if (!d) continue;
    if (!visibleDoc(d, elevated)) continue;
    if (opts.module && (d.module || '') !== opts.module) continue;
    if (opts.documentType && (d.document_type || '') !== opts.documentType) continue;
    if (opts.status && (d.status || '') !== opts.status) continue;
    if (opts.currentOnly && !['current', 'approved'].includes((d.status || '').toLowerCase())) continue;
    const ch = db.prepare('SELECT section_heading FROM dennis_document_chunks WHERE id = ?').get(best.chunkId) as any;
    out.push({
      dennisDocumentId: denId, sourceDocumentId: d.source_document_id ?? null, title: d.title, documentCode: d.document_code ?? null,
      documentType: d.document_type ?? null, module: d.module ?? null, version: d.version ?? null, status: d.status ?? null,
      sectionHeading: ch?.section_heading ?? null, excerpt: best.excerpt, score: best.score, indexedAt: d.last_indexed_at ?? d.indexed_at ?? null,
    });
  }
  out.sort((a, b) => a.score - b.score); // bm25: lower is better
  return out.slice(0, limit);
}

// ── Source-grounded answers ────────────────────────────────────────────────
function citation(r: SearchResult): string {
  return `${r.title}${r.documentCode ? ` (${r.documentCode})` : ''}${r.version ? `, v${r.version}` : ''}${r.sectionHeading ? `, section: ${r.sectionHeading}` : ''}`;
}

export async function askDennis(db: any, opts: { question: string; context?: any; userId: number; allowOnline?: boolean; confirmed?: boolean }): Promise<{ answer: string; sources: Array<{ title: string; documentCode: string | null; version: string | null; section: string | null; sourceDocumentId: number | null; status: string | null; excerpt: string }>; mode: string; notice: string }> {
  const q = (opts.question || '').trim();
  if (!q) return { answer: 'Please type a question for Dennis.', sources: [], mode: 'none', notice: DENNIS_NOTICE };
  const results = searchDennis(db, { q, userId: opts.userId, limit: 6, currentOnly: false });
  const sources = results.map(r => ({ title: r.title, documentCode: r.documentCode, version: r.version, section: r.sectionHeading, sourceDocumentId: r.sourceDocumentId, status: r.status, excerpt: r.excerpt }));

  if (!results.length) {
    logActivity(db, { userId: opts.userId, module: 'dennis', action: 'ask', status: 'no_result', currentPage: opts.context?.currentRoute, detail: q.slice(0, 120) });
    return { answer: 'I could not find a matching approved document for your question. Try different keywords, or ask the Quality Manager to confirm whether the relevant document has been indexed.', sources: [], mode: 'offline', notice: DENNIS_NOTICE };
  }

  const fullChunks = results.map(r => {
    const c = db.prepare('SELECT chunk_text FROM dennis_document_chunks WHERE document_id = ? ORDER BY chunk_index LIMIT 1').get(r.dennisDocumentId) as any;
    return { cite: citation(r), text: (c?.chunk_text || r.excerpt).slice(0, 1200) };
  });
  const contextBlock = fullChunks.map((c, i) => `[${i + 1}] ${c.cite}\n${c.text}`).join('\n\n');
  const settings = providerSettings(db);
  const mode = rawSettings(db)['dennis.mode'] || 'Offline only';
  const system = 'You are Dennis, a laboratory quality management assistant for SECH_LIMS. Answer ONLY from the provided approved-document excerpts. If the excerpts do not contain the answer, say you do not have enough source text. Be concise. Never invent facts, never make compliance decisions.';
  const userPrompt = `Question: ${q}\n\nApproved document excerpts:\n${contextBlock}\n\nGive a short answer grounded only in these excerpts.`;

  let answerBody = ''; let usedMode = 'offline-extractive'; let provider = 'none';
  const wantOnline = !!opts.allowOnline && settings.onlineEnabled && !!settings.onlineApiKey && mode !== 'Offline only';
  try {
    if (wantOnline) {
      if (rawSettings(db)['dennis.online.confirmRequired'] === 'true' && !opts.confirmed) {
        return { answer: 'CONFIRM_ONLINE', sources, mode: 'awaiting-confirmation', notice: DENNIS_NOTICE };
      }
      const red = redact(`${q}\n${contextBlock}`);
      answerBody = await onlineChat(settings, system, `Question: ${q}\n\nApproved document excerpts (redacted):\n${red.redacted}\n\nGive a short answer grounded only in these excerpts.`);
      usedMode = 'online'; provider = settings.onlineProvider;
    } else if (settings.localEnabled && mode !== 'Online only') {
      answerBody = await localChat(settings, [{ role: 'system', content: system }, { role: 'user', content: userPrompt }]);
      usedMode = 'local'; provider = settings.localProvider;
    }
  } catch (e) {
    logActivity(db, { userId: opts.userId, module: 'dennis', action: 'ask', status: 'provider_error', provider, error: e instanceof Error ? e.message : 'provider error' });
    answerBody = '';
  }

  if (!answerBody.trim()) {
    answerBody = `Based on the approved documents I found, the most relevant passage is:\n\n“${results[0].excerpt.replace(/[〔〕]/g, '')}”\n\nReview the cited sources below for the full, authoritative text.`;
  }
  const sourceList = results.map((r, i) => `${i + 1}. ${citation(r)} — status: ${r.status ?? 'n/a'}`).join('\n');
  const answer = `Based on the approved documents I found:\n\n${answerBody.trim()}\n\nSources:\n${sourceList}`;
  logActivity(db, { userId: opts.userId, module: 'dennis', action: 'ask', status: 'ok', mode: usedMode, provider, currentPage: opts.context?.currentRoute, sourceDocumentIds: results.map(r => r.sourceDocumentId).filter(Boolean) as number[], detail: q.slice(0, 120) });
  return { answer, sources, mode: usedMode, notice: DENNIS_NOTICE };
}

// ── Module helpers (read-only drafting support) ───────────────────────────────
function gatherContext(db: any, moduleKey: string, recordId?: string | null): string {
  if (!recordId) return '';
  const id = Number(recordId);
  const safe = (fn: () => any): any => { try { return fn(); } catch { return null; } };
  const fmt = (o: any) => o ? Object.entries(o).filter(([, v]) => v !== null && v !== '' && v !== undefined).map(([k, v]) => `${k}: ${v}`).join('\n') : '';
  switch (moduleKey) {
    case 'capa': case 'nc_capa': return fmt(safe(() => db.prepare('SELECT capa_number, title, problem_summary, root_cause, corrective_action, preventive_action, status, due_date FROM capa_records WHERE id = ?').get(id)));
    case 'nonconformities': return fmt(safe(() => db.prepare('SELECT nc_number, title, description, category, severity, immediate_correction, status FROM nonconforming_events WHERE id = ?').get(id)));
    case 'risks': return fmt(safe(() => db.prepare('SELECT risk_number, risk_area, risk_description, cause, consequence, existing_controls, mitigation_plan, risk_level, status FROM risks WHERE id = ?').get(id)));
    case 'complaints': case 'customer_focus': return fmt(safe(() => db.prepare('SELECT complaint_number, title, description, category, investigation_summary, root_cause, status FROM complaints WHERE id = ?').get(id)));
    case 'equipment': return fmt(safe(() => db.prepare('SELECT equipment_number, name, manufacturer, model, status, calibration_due_date, next_service_due FROM equipment_items WHERE id = ?').get(id)));
    default: return '';
  }
}

const HELPER_TASKS: Record<string, string> = {
  improve_nc: 'Rewrite the nonconformity description so it is clear, factual and complete (what, where, when, impact). Do not invent details.',
  root_causes: 'Suggest 3-5 plausible root cause hypotheses (5-Whys / fishbone categories) the team can investigate. Mark them as hypotheses.',
  corrective_action: 'Suggest specific corrective actions addressing the likely root cause. Keep them practical and verifiable.',
  preventive_action: 'Suggest preventive actions to stop recurrence across similar processes.',
  follow_up: 'Draft a follow-up plan with responsible roles and check points (no personal names).',
  effectiveness: 'Suggest how to verify the effectiveness of the corrective action (evidence, metric, timeframe).',
  summarize: 'Summarise this record concisely for a quality report.',
  audit_questions: 'Suggest internal audit questions relevant to this area against ISO 15189.',
  audit_evidence: 'Suggest the objective evidence an auditor should request.',
  finding_wording: 'Help word an audit finding clearly (requirement, evidence, gap). Do not assign a final grade.',
  risk_suggest: 'Suggest risks, causes, consequences, existing controls and mitigation actions for this area.',
  explain_sop: 'Explain this document in simple language for staff training. Keep it faithful to the source.',
  quiz: 'Generate 5 short training quiz questions (with answers) from this document.',
  report: 'Draft a clear quality report section from the provided data.',
};

export async function moduleHelper(db: any, opts: { module: string; task: string; recordId?: string | null; inputText?: string; userId: number; allowOnline?: boolean; confirmed?: boolean }): Promise<{ draft: string; sources: any[]; mode: string; notice: string }> {
  const instruction = HELPER_TASKS[opts.task] || 'Provide a helpful, source-aware draft for review.';
  const recordContext = gatherContext(db, opts.module, opts.recordId);
  const query = `${opts.module} ${opts.inputText || ''} ${recordContext}`.slice(0, 300);
  const docs = searchDennis(db, { q: query, userId: opts.userId, limit: 3 });
  const sources = docs.map(r => ({ title: r.title, documentCode: r.documentCode, version: r.version, section: r.sectionHeading, sourceDocumentId: r.sourceDocumentId }));
  const settings = providerSettings(db);
  const mode = rawSettings(db)['dennis.mode'] || 'Offline only';
  const grounding = docs.map((r, i) => `[${i + 1}] ${citation(r)}: ${r.excerpt.replace(/[〔〕]/g, '')}`).join('\n');
  const system = 'You are Dennis, a SECH_LIMS quality assistant. You draft and suggest only — you never finalise official actions (no approvals, no closing records). Ground suggestions in the provided record and approved documents. Do not invent facts. Do not include patient or donor identifiers.';
  const userPrompt = `Task: ${instruction}\n\nRecord context:\n${recordContext || '(none provided)'}\n\nUser notes:\n${opts.inputText || '(none)'}\n\nRelated approved documents:\n${grounding || '(none indexed)'}`;

  let draft = ''; let usedMode = 'offline-template'; let provider = 'none';
  const wantOnline = !!opts.allowOnline && settings.onlineEnabled && !!settings.onlineApiKey && mode !== 'Offline only';
  try {
    if (wantOnline) {
      if (rawSettings(db)['dennis.online.confirmRequired'] === 'true' && !opts.confirmed) return { draft: 'CONFIRM_ONLINE', sources, mode: 'awaiting-confirmation', notice: DENNIS_NOTICE };
      const red = redact(userPrompt);
      draft = await onlineChat(settings, system, red.redacted); usedMode = 'online'; provider = settings.onlineProvider;
    } else if (settings.localEnabled && mode !== 'Online only') {
      draft = await localChat(settings, [{ role: 'system', content: system }, { role: 'user', content: userPrompt }]); usedMode = 'local'; provider = settings.localProvider;
    }
  } catch (e) {
    logActivity(db, { userId: opts.userId, module: opts.module, action: `helper_${opts.task}`, status: 'provider_error', provider, error: e instanceof Error ? e.message : 'provider error' });
    draft = '';
  }
  if (!draft.trim()) {
    draft = `Draft suggestion (${instruction})\n\n` +
      (recordContext ? `Based on this record:\n${recordContext}\n\n` : '') +
      (grounding ? `Relevant approved documents:\n${grounding}\n\n` : '') +
      `• [Dennis offline draft] Use the record details and the cited documents above to complete this ${opts.task.replace(/_/g, ' ')}. ` +
      `Enable a local or online AI provider in Dennis Settings for a fuller automatically-written draft.\n\nThis remains a draft until an authorised user reviews and applies it.`;
  }
  try {
    db.prepare('INSERT INTO dennis_suggestions (user_id, module, source_record_id, suggestion_type, input_text, dennis_output, accepted) VALUES (?,?,?,?,?,?,0)')
      .run(opts.userId, opts.module, opts.recordId ?? null, opts.task, opts.inputText ?? null, draft);
  } catch { /* ignore */ }
  logActivity(db, { userId: opts.userId, module: opts.module, action: `helper_${opts.task}`, status: 'ok', mode: usedMode, provider, recordId: opts.recordId ?? null, sourceDocumentIds: docs.map(d => d.sourceDocumentId).filter(Boolean) as number[] });
  return { draft, sources, mode: usedMode, notice: DENNIS_NOTICE };
}

// ── Real alerts (read-only, computed from existing modules) ───────────────────
export function computeAlerts(db: any): Array<{ title: string; module: string; count: number; priority: string }> {
  const today = new Date().toISOString().slice(0, 10);
  const soon = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
  const week = new Date(Date.now() + 7 * 864e5).toISOString();
  const nowIso = new Date().toISOString();
  const c = (sql: string, ...p: unknown[]): number => { try { return (db.prepare(sql).get(...p) as any).c; } catch { return -1; } };
  const defs: Array<{ title: string; module: string; count: number; priority: string }> = [
    { title: 'Overdue CAPA', module: 'nc_capa', count: c("SELECT COUNT(*) c FROM capa_records WHERE status != 'closed' AND due_date IS NOT NULL AND due_date < ?", today), priority: 'High' },
    { title: 'SOP review due (30d)', module: 'documents', count: c("SELECT COUNT(*) c FROM documents WHERE next_review_date IS NOT NULL AND next_review_date >= ? AND next_review_date <= ? AND status != 'obsolete'", today, soon), priority: 'Medium' },
    { title: 'Expired / overdue SOP reviews', module: 'documents', count: c("SELECT COUNT(*) c FROM documents WHERE next_review_date IS NOT NULL AND next_review_date < ? AND status != 'obsolete'", today), priority: 'High' },
    { title: 'Documents pending approval', module: 'documents', count: c("SELECT COUNT(*) c FROM documents WHERE status IN ('under_review','reviewed')"), priority: 'Medium' },
    { title: 'Calibration due', module: 'equipment', count: c("SELECT COUNT(*) c FROM equipment_items WHERE COALESCE(next_calibration_due, calibration_due_date) IS NOT NULL AND COALESCE(next_calibration_due, calibration_due_date) <= ?", nowIso), priority: 'Medium' },
    { title: 'Maintenance due', module: 'equipment', count: c("SELECT COUNT(*) c FROM equipment_items WHERE COALESCE(next_maintenance_due, next_service_due) IS NOT NULL AND COALESCE(next_maintenance_due, next_service_due) <= ?", nowIso), priority: 'Medium' },
    { title: 'Expiring blood units (7d)', module: 'blood_bank_handover', count: c("SELECT COUNT(*) c FROM blood_units WHERE current_status = 'available' AND expiry_date > ? AND expiry_date <= ?", nowIso, week), priority: 'High' },
    { title: 'Expiring reagents (30d)', module: 'supplier_inventory', count: c("SELECT COUNT(*) c FROM inventory_items WHERE expiry_date IS NOT NULL AND expiry_date > ? AND expiry_date <= ?", today, soon), priority: 'Medium' },
    { title: 'Pending document attestations', module: 'documents', count: c("SELECT COUNT(*) c FROM document_attestations WHERE status IN ('pending','overdue')"), priority: 'Low' },
  ];
  return defs.filter(d => d.count > 0);
}

export async function testConnection(db: any, which: 'local' | 'online') {
  return testProvider(providerSettings(db), which);
}
export function redactPreview(text: string): Redaction { return redact(text); }
export function indexStats(db: any) {
  const s = (sql: string) => { try { return (db.prepare(sql).get() as any).c; } catch { return 0; } };
  return {
    totalIndexed: s("SELECT COUNT(*) c FROM dennis_documents WHERE indexing_status = 'indexed'"),
    skipped: s("SELECT COUNT(*) c FROM dennis_documents WHERE indexing_status = 'skipped'"),
    failed: s("SELECT COUNT(*) c FROM dennis_documents WHERE indexing_status = 'failed'"),
    notIndexed: s("SELECT COUNT(*) c FROM documents WHERE status IN ('current','approved') AND id NOT IN (SELECT COALESCE(source_document_id,0) FROM dennis_documents)"),
    chunks: s('SELECT COUNT(*) c FROM dennis_document_chunks'),
  };
}
void cosineSim; void localEmbed;
