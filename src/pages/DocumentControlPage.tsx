import { FormEvent, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import PageHeader from '../components/ui/PageHeader';
import { ChartCard, DonutChart, BarMeter, CHART_COLORS } from '../components/ui';
import { useModules } from '../hooks/useModules';
import { api, API_BASE, getToken } from '../services/api';
import type { OfficeFileChangedPayload } from '../services/api';
import DisabledModule from '../components/DisabledModule';
import type {
  Section, Department, Staff, Position,
  DocumentRecord, DocumentAttestation, DocumentControlSummary, DistributionInboxEntry, VersionContent,
  RecordRegisterEntry, RetentionScheduleRule, RecordReviewLogEntry, RecordDestructionEntry, RecordBackupEntry, RecordControlSummary, DocumentComment
} from '../../shared/types/api';

const statusBadgeClass = (status?: string) => `badge ${status ? status.toLowerCase().replace(/\s+/g, '-') : 'unknown'}`;
const formatBadge = (status?: string) => <span className={statusBadgeClass(status)}>{status ? status.replace(/_/g, ' ') : 'Unknown'}</span>;
const tabBar = (active: string, tabs: string[], onChange: (name: string) => void) =>
  <div className="tabs">{tabs.map(name => <button key={name} type="button" className={active === name ? 'active' : ''} onClick={() => onChange(name)}>{name}</button>)}</div>;

const DOCUMENT_TYPES = ['SOP', 'Policy', 'Manual', 'Form', 'Register', 'Log', 'Tracker', 'Job Aid', 'Quality Manual', 'Handbook', 'Safety Manual', 'Other'];
const ACCESS_LEVELS = ['public', 'internal', 'restricted', 'confidential'];
const REVIEW_OUTCOMES = ['no_change', 'minor_revision', 'major_revision', 'obsolete'];
const TARGET_TYPES = ['staff', 'position', 'section', 'department'];
// SECHPO026 §5.1.6 — coding schemes the auto-generator understands.
const RECORD_CATEGORIES = ['pre_examination', 'examination', 'post_examination', 'quality', 'support', 'other'];
const RECORD_FORMATS = ['electronic', 'paper', 'both'];
const CONFIDENTIALITY = ['public', 'internal', 'restricted', 'confidential'];
const DESTRUCTION_METHODS = ['shredding', 'incineration', 'secure_deletion', 'media_destruction'];
const BACKUP_TYPES = ['incremental', 'full', 'archive'];
const RESTORE_STATUSES = ['', 'not_tested', 'passed', 'failed'];
const FOLLOW_UP_STATUSES = ['open', 'in_progress', 'completed', 'escalated'];
// Lifecycle order used by the workflow stepper.
const LIFECYCLE = ['draft', 'under_review', 'reviewed', 'current', 'obsolete'];

function useLookups() {
  const [staff, setStaff] = useState<Staff[]>([]);
  const [sections, setSections] = useState<Section[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [positions, setPositions] = useState<Position[]>([]);
  useEffect(() => {
    api<Staff[]>('/staff').then(setStaff).catch(() => setStaff([]));
    api<Section[]>('/sections').then(setSections).catch(() => setSections([]));
    api<Department[]>('/departments').then(setDepartments).catch(() => setDepartments([]));
    api<Position[]>('/positions').then(setPositions).catch(() => setPositions([]));
  }, []);
  return { staff, sections, departments, positions };
}

function staffName(staffList: Staff[], id?: number | null) {
  if (!id) return '—';
  return staffList.find(s => s.id === id)?.fullName || `Staff #${id}`;
}

// Fetch a protected file as an object URL so it can be embedded in an <iframe>/
// <embed> (which cannot send the Authorization header on their own).
async function fetchBlobUrl(path: string): Promise<string> {
  const token = getToken();
  const r = await fetch(`${API_BASE}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : undefined });
  if (!r.ok) throw new Error('Could not load the file.');
  return URL.createObjectURL(await r.blob());
}

const emptyDocForm = { documentCode: '', title: '', documentType: 'SOP', sectionCategory: '', departmentId: '', sectionId: '', ownerStaffId: '', reviewFrequencyMonths: '12', nextReviewDate: '', accessLevel: 'internal', isControlled: true, fileId: '', versionNumber: '1.0', revisionSummary: '', effectiveDate: '' };
const emptyVersionForm = { versionNumber: '', revisionSummary: '', fileId: '', effectiveDate: '' };
const emptyReviewForm = { reviewDate: '', reviewOutcome: 'no_change', reviewNotes: '', nextReviewDate: '', actionRequired: false };
const emptyAttestForm = { targetType: 'staff', staffIds: [] as number[], positionId: '', sectionId: '', departmentId: '', dueDate: '', notes: '' };
const emptyPrintForm = { printPurpose: '', controlledCopy: false, copyNumber: '', watermark: '' };

export function DocumentControlPage() {
  const { isEnabled } = useModules();
  const { staff, sections, departments, positions } = useLookups();
  const [tab, setTab] = useState('Dashboard');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [summary, setSummary] = useState<DocumentControlSummary | null>(null);
  const [documents, setDocuments] = useState<DocumentRecord[]>([]);
  const [reviewsDue, setReviewsDue] = useState<DocumentRecord[]>([]);
  const [pendingAttestations, setPendingAttestations] = useState<DocumentAttestation[]>([]);
  const [inbox, setInbox] = useState<DistributionInboxEntry[]>([]);
  const [selectedDoc, setSelectedDoc] = useState<DocumentRecord | null>(null);
  const [viewer, setViewer] = useState<{ docId: number; versionId: number; attestationId?: number; workflowStatus?: string } | null>(null);
  const [registerFilter, setRegisterFilter] = useState('');

  const [docForm, setDocForm] = useState(emptyDocForm);
  const [versionForm, setVersionForm] = useState(emptyVersionForm);
  const [reviewForm, setReviewForm] = useState(emptyReviewForm);
  const [attestForm, setAttestForm] = useState(emptyAttestForm);
  const [printForm, setPrintForm] = useState(emptyPrintForm);
  const [obsoleteReason, setObsoleteReason] = useState('');
  const [newDocFile, setNewDocFile] = useState<File | null>(null);
  const [versionFile, setVersionFile] = useState<File | null>(null);

  // Bulk import
  const emptyBulkForm = { documentType: 'SOP', sectionId: '', sectionCategory: '', ownerStaffId: '', reviewFrequencyMonths: '12', accessLevel: 'internal', isControlled: true, codeMode: 'filename', codePrefix: 'SECHPO' };
  const [bulkForm, setBulkForm] = useState(emptyBulkForm);
  const [bulkFiles, setBulkFiles] = useState<File[]>([]);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkResults, setBulkResults] = useState<{ name: string; ok: boolean; message: string }[]>([]);

  async function load() {
    try {
      const [sum, docs, due, att, ib] = await Promise.all([
        api<DocumentControlSummary>('/dashboard/document-control-summary').catch(() => null),
        api<DocumentRecord[]>('/documents'),
        api<DocumentRecord[]>('/documents/reviews/due').catch(() => []),
        api<DocumentAttestation[]>('/documents/attestations/pending').catch(() => []),
        api<DistributionInboxEntry[]>('/documents/distribution/inbox').catch(() => [])
      ]);
      if (sum) setSummary(sum);
      setDocuments(docs); setReviewsDue(due); setPendingAttestations(att); setInbox(ib);
    } catch (e) { setError((e as Error).message); }
  }
  useEffect(() => { if (isEnabled('documents')) void load(); }, [isEnabled]);
  if (!isEnabled('documents')) return <DisabledModule />;

  function flash(msg: string) { setNotice(msg); setError(null); setTimeout(() => setNotice(null), 5000); }

  async function uploadFileIfAny(file: File | null): Promise<string | null> {
    if (!file) return null;
    const fd = new FormData();
    fd.append('file', file);
    const token = getToken();
    const response = await fetch(`${API_BASE}/files`, { method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : undefined, body: fd });
    if (!response.ok) throw new Error((await response.json().catch(() => ({ error: response.statusText }))).error ?? response.statusText);
    const data = await response.json();
    return String(data.id);
  }

  async function autoGenerateCode() {
    try {
      const params = new URLSearchParams({ type: docForm.documentType });
      if (docForm.sectionCategory) params.set('sectionCode', docForm.sectionCategory);
      const r = await api<{ code: string }>(`/documents/next-code?${params.toString()}`);
      setDocForm(f => ({ ...f, documentCode: r.code }));
    } catch (e) { setError((e as Error).message); }
  }

  // When a file is chosen for a new document, read its title and number from the
  // document itself (same behaviour as bulk import) and pre-fill the form. The
  // file is uploaded once here and reused on submit.
  async function onPickNewDocFile(file: File | null) {
    setNewDocFile(file);
    if (!file) return;
    const baseName = file.name.replace(/\.[^.]+$/, '');
    const fnCode = deriveCode(file.name) || '';
    const fnTitle = baseName.replace(/^\s*SECH[A-Z]*\s?-?\s?\d+[A-Z]?\s*/i, '').replace(/[_-]+/g, ' ').trim() || baseName;
    // Instant filename-based fill (works even before the content is read).
    setDocForm(f => ({ ...f, documentCode: f.documentCode || fnCode, title: f.title.trim() ? f.title : fnTitle }));
    try {
      const fileId = await uploadFileIfAny(file);
      if (!fileId) return;
      const g = await api<{ titleGuess?: string; documentCodeGuess?: string }>('/documents/extract-preview', { method: 'POST', body: JSON.stringify({ fileId }) });
      setNewDocFile(null); // already uploaded — avoid re-uploading on submit
      setDocForm(f => ({
        ...f,
        fileId,
        documentCode: (g.documentCodeGuess || f.documentCode || fnCode || '').toString(),
        title: f.title.trim() && f.title !== fnTitle ? f.title : (g.titleGuess || fnTitle),
      }));
      flash('Title and document number read from the uploaded file. Review and adjust if needed.');
    } catch { /* keep filename-based fill */ }
  }

  async function submitDoc(e: FormEvent) {
    e.preventDefault(); setError(null);
    try {
      const uploadedFileId = await uploadFileIfAny(newDocFile);
      const payload = { ...docForm, fileId: uploadedFileId ?? docForm.fileId };
      const created = await api<{ id: number; documentCode: string }>('/documents', { method: 'POST', body: JSON.stringify(payload) });
      setDocForm(emptyDocForm); setNewDocFile(null);
      await load(); setTab('Document Register');
      flash(`Document created as ${created.documentCode}. It is now in Draft — submit it for review when ready.`);
    } catch (e) { setError((e as Error).message); }
  }

  // Derive "SECHPO026" from "SECHPO026 Document Control Procedure.pdf".
  function deriveCode(name: string): string | null {
    const cleaned = name.replace(/\.[a-z0-9]+$/i, ' ');
    const m = cleaned.match(/\bSECH(?:SOP[A-Z]{0,3}|PO|F|ML|QM|HB|SM)\s?-?\s?\d{1,4}[A-Z]?\b/i) || cleaned.match(/\b[A-Z]{2,6}[-\s]?\d{2,4}[A-Z]?\b/);
    return m ? m[0].replace(/\s+/g, '').toUpperCase() : null;
  }

  async function submitBulk(e: FormEvent) {
    e.preventDefault(); setError(null);
    if (!bulkFiles.length) { setError('Choose one or more files to import.'); return; }
    setBulkBusy(true);
    const results: { name: string; ok: boolean; message: string }[] = [];
    const prefix = bulkForm.codePrefix.trim();
    // Seed the running sequence from existing codes sharing the prefix.
    let seq = documents.reduce((max, d) => {
      const m = d.document_code && prefix && d.document_code.startsWith(prefix) ? Number((d.document_code.slice(prefix.length).match(/^\d+/) || [0])[0]) : NaN;
      return Number.isFinite(m) && m > max ? m : max;
    }, 0);
    const usedCodes = new Set(documents.map(d => d.document_code).filter(Boolean) as string[]);
    for (const file of bulkFiles) {
      const baseName = file.name.replace(/\.[^.]+$/, '');
      const derived = deriveCode(file.name);
      // Title: strip a leading document code from the filename if present.
      const title = baseName.replace(/^\s*SECH[A-Z]*\s?-?\s?\d+[A-Z]?\s*/i, '').replace(/[_-]+/g, ' ').trim() || baseName;
      let documentCode = '';
      if (bulkForm.codeMode === 'filename' && derived) documentCode = derived;
      if (!documentCode) { do { seq += 1; documentCode = `${prefix}${String(seq).padStart(3, '0')}`; } while (usedCodes.has(documentCode)); }
      usedCodes.add(documentCode);
      try {
        const fileId = await uploadFileIfAny(file);
        await api('/documents', { method: 'POST', body: JSON.stringify({
          documentCode, title, documentType: bulkForm.documentType,
          sectionId: bulkForm.sectionId || null, sectionCategory: bulkForm.sectionCategory || null, ownerStaffId: bulkForm.ownerStaffId || null,
          reviewFrequencyMonths: bulkForm.reviewFrequencyMonths || null, accessLevel: bulkForm.accessLevel,
          isControlled: bulkForm.isControlled, fileId, versionNumber: '1.0', revisionSummary: 'Bulk import',
        }) });
        results.push({ name: file.name, ok: true, message: `Created as ${documentCode}${derived === documentCode ? ' (from filename)' : ''}` });
      } catch (err) {
        results.push({ name: file.name, ok: false, message: err instanceof Error ? err.message : 'Failed' });
      }
      setBulkResults([...results]);
    }
    setBulkBusy(false);
    setBulkFiles([]);
    await load();
  }

  async function openDoc(id: number) {
    try { setSelectedDoc(await api<DocumentRecord>(`/documents/${id}`)); setTab('Document Register'); }
    catch (e) { setError((e as Error).message); }
  }

  async function submitVersion(e: FormEvent) {
    e.preventDefault(); setError(null);
    if (!selectedDoc) return;
    try {
      const uploadedFileId = await uploadFileIfAny(versionFile);
      const payload = { ...versionForm, fileId: uploadedFileId ?? versionForm.fileId };
      await api(`/documents/${selectedDoc.id}/versions`, { method: 'POST', body: JSON.stringify(payload) });
      setVersionForm(emptyVersionForm); setVersionFile(null);
      await openDoc(selectedDoc.id); await load();
    } catch (e) { setError((e as Error).message); }
  }

  async function submitReview(e: FormEvent) {
    e.preventDefault(); setError(null);
    if (!selectedDoc) return;
    try {
      await api(`/documents/${selectedDoc.id}/review`, { method: 'POST', body: JSON.stringify(reviewForm) });
      setReviewForm(emptyReviewForm);
      await openDoc(selectedDoc.id); await load();
      flash('Review recorded. The document is now Reviewed and ready for approval by the Laboratory Manager.');
    } catch (e) { setError((e as Error).message); }
  }

  async function submitAttest(e: FormEvent) {
    e.preventDefault(); setError(null);
    if (!selectedDoc) return;
    try {
      const payload: any = { targetType: attestForm.targetType, dueDate: attestForm.dueDate || null, notes: attestForm.notes };
      if (attestForm.targetType === 'staff') payload.staffIds = attestForm.staffIds;
      if (attestForm.targetType === 'position') payload.positionId = attestForm.positionId;
      if (attestForm.targetType === 'section') payload.sectionId = attestForm.sectionId;
      if (attestForm.targetType === 'department') payload.departmentId = attestForm.departmentId;
      await api(`/documents/${selectedDoc.id}/assign-attestation`, { method: 'POST', body: JSON.stringify(payload) });
      setAttestForm(emptyAttestForm);
      await openDoc(selectedDoc.id); await load();
    } catch (e) { setError((e as Error).message); }
  }

  async function distributeAll(docId: number) {
    try {
      const r = await api<{ assigned: number }>(`/documents/${docId}/distribute-all`, { method: 'POST', body: JSON.stringify({}) });
      await openDoc(docId); await load();
      flash(`Distributed to ${r.assigned} staff member(s) for attestation. It now appears in their inbox, notifications and dashboard.`);
    } catch (e) { setError((e as Error).message); }
  }

  async function signAttestation(attestationId: number, documentId: number) {
    try {
      await api(`/documents/${documentId}/attest`, { method: 'POST', body: JSON.stringify({ attestationId }) });
      await load(); if (selectedDoc?.id === documentId) await openDoc(documentId);
      flash('Attestation signed. Thank you — your acknowledgement is recorded against this document.');
    } catch (e) { setError((e as Error).message); }
  }

  async function submitPrint(e: FormEvent) {
    e.preventDefault(); setError(null);
    if (!selectedDoc) return;
    try {
      await api(`/documents/${selectedDoc.id}/print-log`, { method: 'POST', body: JSON.stringify(printForm) });
      setPrintForm(emptyPrintForm);
      await openDoc(selectedDoc.id);
    } catch (e) { setError((e as Error).message); }
  }

  async function submitDoc_obsolete() {
    if (!selectedDoc) return;
    if (!obsoleteReason) return setError('Provide an obsolete reason first.');
    try {
      await api(`/documents/${selectedDoc.id}/mark-obsolete`, { method: 'POST', body: JSON.stringify({ obsoleteReason }) });
      setObsoleteReason('');
      await openDoc(selectedDoc.id); await load();
    } catch (e) { setError((e as Error).message); }
  }

  async function submitForReview() {
    if (!selectedDoc) return;
    try { await api(`/documents/${selectedDoc.id}/submit-review`, { method: 'POST', body: JSON.stringify({}) }); await openDoc(selectedDoc.id); await load(); flash('Submitted for review. An authorised reviewer can now record their review.'); }
    catch (e) { setError((e as Error).message); }
  }

  async function approveDoc() {
    if (!selectedDoc) return;
    try { const r = await api<{ distributed: number }>(`/documents/${selectedDoc.id}/approve`, { method: 'POST', body: JSON.stringify({}) }); await openDoc(selectedDoc.id); await load(); flash(`Approved and issued as the current version. Automatically distributed to ${r.distributed} staff for attestation.`); }
    catch (e) { setError((e as Error).message); }
  }

  // Drive a lifecycle transition from the workflow viewer (status-badge click).
  async function workflowAction(docId: number, action: string) {
    if (action === 'submit') await api(`/documents/${docId}/submit-review`, { method: 'POST', body: JSON.stringify({}) });
    else if (action === 'accept') await api(`/documents/${docId}/review`, { method: 'POST', body: JSON.stringify({ reviewDate: new Date().toISOString().slice(0, 10), reviewOutcome: 'no_change' }) });
    else if (action === 'approve') await api(`/documents/${docId}/approve`, { method: 'POST', body: JSON.stringify({}) });
    await load();
    if (selectedDoc?.id === docId) await openDoc(docId);
    flash(action === 'approve' ? 'Approved and published to all staff for attestation.' : action === 'accept' ? 'Review accepted — the document has moved to approval.' : 'Accepted — the document has moved to review.');
  }

  // A clickable status badge that opens the stage-aware workflow (preview +
  // edit + comment + the single transition for that stage).
  function statusCell(d: DocumentRecord) {
    if (!['draft', 'under_review', 'reviewed'].includes(d.status)) return formatBadge(d.status);
    return <button type="button" className={statusBadgeClass(d.status)} title="Open workflow — preview, edit, comment, then accept/approve"
      style={{ cursor: 'pointer', border: 'none', font: 'inherit' }}
      onClick={() => setViewer({ docId: d.id, versionId: d.current_version_id || 0, workflowStatus: d.status })}>
      {d.status.replace(/_/g, ' ')} ▸
    </button>;
  }

  async function markVersionObsolete(versionId: number) {
    if (!selectedDoc) return;
    const reason = prompt('Reason for marking this version obsolete?');
    if (!reason) return;
    try {
      await api(`/documents/${selectedDoc.id}/versions/${versionId}/mark-obsolete`, { method: 'POST', body: JSON.stringify({ obsoleteReason: reason }) });
      await openDoc(selectedDoc.id); await load();
    } catch (e) { setError((e as Error).message); }
  }

  function openPrintPreview(versionId?: number) {
    if (!selectedDoc) return;
    const purpose = prompt('Print purpose (e.g. reference, training, controlled distribution)?') || '';
    const copyNumber = prompt('Copy number (leave blank for uncontrolled)?') || '';
    const watermark = copyNumber ? 'CONTROLLED COPY' : 'UNCONTROLLED COPY';
    const url = new URL(`${API_BASE}/documents/${selectedDoc.id}/print-render`, window.location.origin);
    if (versionId) url.searchParams.set('versionId', String(versionId));
    if (copyNumber) url.searchParams.set('copyNumber', copyNumber);
    if (purpose) url.searchParams.set('purpose', purpose);
    url.searchParams.set('watermark', watermark);
    const token = getToken();
    if (token) {
      fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } })
        .then(r => r.text())
        .then(html => {
          const w = window.open('', '_blank');
          if (w) { w.document.write(html); w.document.close(); }
        })
        .catch(e => setError((e as Error).message));
    }
  }

  const tabs = ['Dashboard', 'Document Register', 'New Document', 'Bulk Import', 'Review Queue', 'Approval Queue', 'Reviews Due', 'Attestations', 'My Inbox', 'Obsolete', 'Record Control'];
  const obsoleteDocs = documents.filter(d => d.status === 'obsolete');
  const reviewQueue = documents.filter(d => d.status === 'under_review');
  const approvalQueue = documents.filter(d => d.status === 'reviewed');
  const filteredRegister = documents.filter(d => d.status !== 'obsolete').filter(d => {
    if (!registerFilter.trim()) return true;
    const q = registerFilter.toLowerCase();
    return (d.document_code || '').toLowerCase().includes(q) || d.title.toLowerCase().includes(q) || (d.document_type || '').toLowerCase().includes(q) || d.status.toLowerCase().includes(q);
  });

  const queueRow = (d: DocumentRecord) => <tr key={d.id}>
    <td>{d.document_code || '—'}</td><td>{d.title}</td><td>{d.document_type || '—'}</td>
    <td>{staffName(staff, d.owner_staff_id)}</td><td>{statusCell(d)}</td>
    <td><button onClick={() => openDoc(d.id)}>Open</button></td>
  </tr>;

  return <div className="module-page">
    <PageHeader eyebrow="Documents &amp; Records" title="Document &amp; Record Control" subtitle="Controlled documents and records — creation, review, approval, attestation, retention and disposal (ISO 15189 §8.3 / §8.4)." />
    {tabBar(tab, tabs, setTab)}
    {error && <div className="error">{error}</div>}
    {notice && <div className="banner-success" style={{ background: '#e8f6ee', border: '1px solid #58b27a', color: '#1c6b3e', padding: '8px 12px', borderRadius: 6, margin: '8px 0' }}>{notice}</div>}

    {viewer && <DocumentViewer key={`${viewer.docId}-${viewer.versionId}`} docId={viewer.docId} versionId={viewer.versionId} attestationId={viewer.attestationId}
      workflowStatus={viewer.workflowStatus} onWorkflowAction={(action: string) => workflowAction(viewer.docId, action)}
      documents={documents}
      onClose={() => setViewer(null)} onAttest={signAttestation} onSaved={() => { if (selectedDoc?.id === viewer.docId) openDoc(viewer.docId); }} onError={setError} />}

    {tab === 'Dashboard' && (summary ? <>
      <div className="cards">
        <div className="card"><h4>Current documents</h4><p className="metric">{summary.currentDocuments}</p></div>
        <div className="card"><h4>Drafts</h4><p className="metric">{summary.drafts}</p></div>
        <div className="card"><h4>In review</h4><p className="metric">{reviewQueue.length}</p></div>
        <div className="card"><h4>Awaiting approval</h4><p className="metric">{approvalQueue.length}</p></div>
        <div className="card"><h4>Due review (30d)</h4><p className="metric">{summary.dueReviews}</p></div>
        <div className="card"><h4>Overdue reviews</h4><p className="metric">{summary.overdueReviews}</p></div>
        <div className="card"><h4>Pending attestations</h4><p className="metric">{summary.pendingAttestations}</p></div>
        <div className="card"><h4>Obsolete documents</h4><p className="metric">{summary.obsoleteDocuments}</p></div>
      </div>
      <div className="grid cols-2" style={{ marginTop: 18 }}>
        <ChartCard title="Document lifecycle" subtitle="Controlled set by current state">
          <DonutChart centerLabel="Documents" data={[
            { label: 'Current', value: summary.currentDocuments, color: CHART_COLORS[1] },
            { label: 'Drafts', value: summary.drafts, color: CHART_COLORS[0] },
            { label: 'In review', value: reviewQueue.length, color: CHART_COLORS[2] },
            { label: 'Awaiting approval', value: approvalQueue.length, color: CHART_COLORS[5] },
            { label: 'Obsolete', value: summary.obsoleteDocuments, color: CHART_COLORS[7] },
          ]} />
        </ChartCard>
        <ChartCard title="Review &amp; attestation load" subtitle="Outstanding controlled-document actions">
          <BarMeter data={[
            { label: 'Due review (30d)', value: summary.dueReviews, color: CHART_COLORS[2] },
            { label: 'Overdue reviews', value: summary.overdueReviews, color: CHART_COLORS[3] },
            { label: 'Pending attestations', value: summary.pendingAttestations, color: CHART_COLORS[4] },
          ]} />
        </ChartCard>
      </div>
    </> : <p>Loading summary…</p>)}

    {tab === 'Document Register' && <>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10 }}>
        <input placeholder="Search code, title, type, status…" value={registerFilter} onChange={e => setRegisterFilter(e.target.value)} style={{ minWidth: 320 }} />
        <span className="muted">{filteredRegister.length} document(s)</span>
      </div>
      <table className="data-table"><thead><tr><th>Code</th><th>Title</th><th>Type</th><th>Section</th><th>Owner</th><th>Status</th><th>Next review</th><th>Actions</th></tr></thead><tbody>
        {filteredRegister.map(d => <tr key={d.id}>
          <td>{d.document_code || '—'}</td><td>{d.title}</td><td>{d.document_type || '—'}</td>
          <td>{sections.find(s => s.id === d.section_id)?.name || '—'}</td>
          <td>{staffName(staff, d.owner_staff_id)}</td>
          <td>{statusCell(d)}</td><td>{d.next_review_date || '—'}</td>
          <td style={{ whiteSpace: 'nowrap' }}>
            <button onClick={() => openDoc(d.id)}>Open</button>{' '}
            {d.current_version_id && <button className="secondary" onClick={() => setViewer({ docId: d.id, versionId: d.current_version_id! })}>View</button>}
          </td>
        </tr>)}
      </tbody></table>
      {selectedDoc && <DocumentDetailPanel doc={selectedDoc} staff={staff} positions={positions} sections={sections} departments={departments}
        versionForm={versionForm} setVersionForm={setVersionForm} versionFile={versionFile} setVersionFile={setVersionFile} submitVersion={submitVersion}
        reviewForm={reviewForm} setReviewForm={setReviewForm} submitReview={submitReview}
        attestForm={attestForm} setAttestForm={setAttestForm} submitAttest={submitAttest}
        printForm={printForm} setPrintForm={setPrintForm} submitPrint={submitPrint}
        obsoleteReason={obsoleteReason} setObsoleteReason={setObsoleteReason} submitObsolete={submitDoc_obsolete}
        submitForReview={submitForReview} approveDoc={approveDoc} distributeAll={() => distributeAll(selectedDoc.id)}
        onSignAttestation={signAttestation} onMarkVersionObsolete={markVersionObsolete} onPrintPreview={openPrintPreview}
        onView={(vid: number) => setViewer({ docId: selectedDoc.id, versionId: vid })}
        onCodeSaved={() => openDoc(selectedDoc.id)} onError={setError}
        onClose={() => setSelectedDoc(null)} />}
    </>}

    {tab === 'New Document' && <form className="form-grid" onSubmit={submitDoc}>
      <label>Document code (leave blank to auto-generate)
        <span style={{ display: 'flex', gap: 6 }}>
          <input value={docForm.documentCode} onChange={e => setDocForm({ ...docForm, documentCode: e.target.value })} placeholder="e.g. SECHPO026 — or Auto-generate" />
          <button type="button" className="secondary" onClick={autoGenerateCode}>Auto</button>
        </span>
      </label>
      <label>Title<input value={docForm.title} onChange={e => setDocForm({ ...docForm, title: e.target.value })} required /></label>
      <label>Document type<select value={docForm.documentType} onChange={e => setDocForm({ ...docForm, documentType: e.target.value })} required>{DOCUMENT_TYPES.map(t => <option key={t} value={t}>{t}</option>)}</select></label>
      <label>Section code (for SOP numbering, e.g. HA, MB)<input value={docForm.sectionCategory} onChange={e => setDocForm({ ...docForm, sectionCategory: e.target.value })} placeholder="e.g. HA for Haematology" /></label>
      <label>Department<select value={docForm.departmentId} onChange={e => setDocForm({ ...docForm, departmentId: e.target.value })}><option value="">—</option>{departments.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label>
      <label>Section<select value={docForm.sectionId} onChange={e => setDocForm({ ...docForm, sectionId: e.target.value })}><option value="">—</option>{sections.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
      <label>Owner / author<select value={docForm.ownerStaffId} onChange={e => setDocForm({ ...docForm, ownerStaffId: e.target.value })}><option value="">—</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label>
      <label>Review frequency (months)<input type="number" min={1} value={docForm.reviewFrequencyMonths} onChange={e => setDocForm({ ...docForm, reviewFrequencyMonths: e.target.value })} /></label>
      <label>Next review date<input type="date" value={docForm.nextReviewDate} onChange={e => setDocForm({ ...docForm, nextReviewDate: e.target.value })} /></label>
      <label>Access level<select value={docForm.accessLevel} onChange={e => setDocForm({ ...docForm, accessLevel: e.target.value })}>{ACCESS_LEVELS.map(a => <option key={a} value={a}>{a}</option>)}</select></label>
      <label><input type="checkbox" checked={docForm.isControlled} onChange={e => setDocForm({ ...docForm, isControlled: e.target.checked })} /> Controlled document</label>
      <label>Initial version number<input value={docForm.versionNumber} onChange={e => setDocForm({ ...docForm, versionNumber: e.target.value })} /></label>
      <label>Revision summary<input value={docForm.revisionSummary} onChange={e => setDocForm({ ...docForm, revisionSummary: e.target.value })} /></label>
      <label>Effective date<input type="date" value={docForm.effectiveDate} onChange={e => setDocForm({ ...docForm, effectiveDate: e.target.value })} /></label>
      <label>File upload (PDF/Word — title, number &amp; content are read automatically)<input type="file" accept=".pdf,.doc,.docx,.txt,.md,.rtf,.odt" onChange={e => onPickNewDocFile(e.target.files?.[0] ?? null)} /></label>
      <button type="submit">Create document (Draft)</button>
    </form>}

    {tab === 'Bulk Import' && <div className="card">
      <h3 style={{ marginTop: 0 }}>Bulk import documents</h3>
      <p className="muted" style={{ marginTop: 0 }}>Import many SOPs, policies, forms or registers at once. Each file becomes a controlled document (Draft) and its full content is read for in-app viewing. Document numbers are taken from the file name when present (e.g. <em>“SECHPO026 Document Control Procedure”</em> → <strong>SECHPO026</strong>), otherwise auto-numbered from the prefix.</p>
      <form className="form-grid" onSubmit={submitBulk}>
        <label>Document type<select value={bulkForm.documentType} onChange={e => setBulkForm({ ...bulkForm, documentType: e.target.value })}>{DOCUMENT_TYPES.map(t => <option key={t} value={t}>{t}</option>)}</select></label>
        <label>Numbering<select value={bulkForm.codeMode} onChange={e => setBulkForm({ ...bulkForm, codeMode: e.target.value })}>
          <option value="filename">From file name (fallback to prefix)</option>
          <option value="prefix">Always auto-number from prefix</option>
        </select></label>
        <label>Code prefix (fallback)<input value={bulkForm.codePrefix} onChange={e => setBulkForm({ ...bulkForm, codePrefix: e.target.value })} placeholder="e.g. SECHPO" /></label>
        <label>Section code (SOP numbering)<input value={bulkForm.sectionCategory} onChange={e => setBulkForm({ ...bulkForm, sectionCategory: e.target.value })} placeholder="e.g. HA" /></label>
        <label>Section (applied to all)<select value={bulkForm.sectionId} onChange={e => setBulkForm({ ...bulkForm, sectionId: e.target.value })}><option value="">—</option>{sections.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
        <label>Owner staff (applied to all)<select value={bulkForm.ownerStaffId} onChange={e => setBulkForm({ ...bulkForm, ownerStaffId: e.target.value })}><option value="">—</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label>
        <label>Review frequency (months)<input type="number" min={1} value={bulkForm.reviewFrequencyMonths} onChange={e => setBulkForm({ ...bulkForm, reviewFrequencyMonths: e.target.value })} /></label>
        <label>Access level<select value={bulkForm.accessLevel} onChange={e => setBulkForm({ ...bulkForm, accessLevel: e.target.value })}>{ACCESS_LEVELS.map(a => <option key={a} value={a}>{a}</option>)}</select></label>
        <label><input type="checkbox" checked={bulkForm.isControlled} onChange={e => setBulkForm({ ...bulkForm, isControlled: e.target.checked })} /> Controlled documents</label>
        <label>Files<input type="file" multiple accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,.odt,.ods,.rtf,.md" onChange={e => setBulkFiles(Array.from(e.target.files ?? []))} /></label>
        <button type="submit" disabled={bulkBusy}>{bulkBusy ? `Importing… (${bulkResults.filter(r => r.ok).length}/${bulkFiles.length || bulkResults.length})` : `Import ${bulkFiles.length || ''} document${bulkFiles.length === 1 ? '' : 's'}`}</button>
      </form>
      {bulkResults.length > 0 && <table className="data-table" style={{ marginTop: 16 }}><thead><tr><th>File</th><th>Result</th></tr></thead><tbody>
        {bulkResults.map((r, i) => <tr key={i}><td>{r.name}</td><td>{r.ok ? <span className="badge approved">{r.message}</span> : <span className="badge error">{r.message}</span>}</td></tr>)}
      </tbody></table>}
    </div>}

    {tab === 'Review Queue' && <>
      <p className="muted">Documents submitted for review. An authorised reviewer (technical staff / Quality Manager) opens each, reads it, and records a review — which advances it to <em>Reviewed</em> for approval.</p>
      <table className="data-table"><thead><tr><th>Code</th><th>Title</th><th>Type</th><th>Owner</th><th>Status</th><th></th></tr></thead><tbody>
        {reviewQueue.map(queueRow)}{reviewQueue.length === 0 && <tr><td colSpan={6} className="muted">Nothing awaiting review.</td></tr>}
      </tbody></table>
    </>}

    {tab === 'Approval Queue' && <>
      <p className="muted">Documents that have been reviewed and are awaiting approval by the Laboratory Manager (or authorised approver). Approving issues the document as the current controlled version and distributes it to all staff for attestation.</p>
      <table className="data-table"><thead><tr><th>Code</th><th>Title</th><th>Type</th><th>Reviewed by</th><th>Status</th><th></th></tr></thead><tbody>
        {approvalQueue.map(d => <tr key={d.id}>
          <td>{d.document_code || '—'}</td><td>{d.title}</td><td>{d.document_type || '—'}</td>
          <td>{staffName(staff, d.reviewed_by_staff_id)}</td><td>{statusCell(d)}</td>
          <td><button onClick={() => openDoc(d.id)}>Open</button></td>
        </tr>)}{approvalQueue.length === 0 && <tr><td colSpan={6} className="muted">Nothing awaiting approval.</td></tr>}
      </tbody></table>
    </>}

    {tab === 'Reviews Due' && <table className="data-table"><thead><tr><th>Code</th><th>Title</th><th>Type</th><th>Owner</th><th>Status</th><th>Next review</th><th></th></tr></thead><tbody>
      {reviewsDue.map(d => <tr key={d.id}>
        <td>{d.document_code || '—'}</td><td>{d.title}</td><td>{d.document_type || '—'}</td>
        <td>{staffName(staff, d.owner_staff_id)}</td><td>{statusCell(d)}</td>
        <td>{d.next_review_date || '—'}</td>
        <td><button onClick={() => openDoc(d.id)}>Open</button></td>
      </tr>)}{reviewsDue.length === 0 && <tr><td colSpan={7} className="muted">No reviews due.</td></tr>}
    </tbody></table>}

    {tab === 'Attestations' && <table className="data-table"><thead><tr><th>Document</th><th>Version</th><th>Staff</th><th>Status</th><th>Due</th><th></th></tr></thead><tbody>
      {pendingAttestations.map(a => <tr key={a.id}>
        <td>{a.document_code || '—'} — {a.title}</td>
        <td>{a.version_number || '—'}</td>
        <td>{a.staff_name || staffName(staff, a.staff_id)}</td>
        <td>{formatBadge(a.status)}</td><td>{a.due_date || '—'}</td>
        <td><button onClick={() => signAttestation(a.id, a.document_id!)}>Sign</button></td>
      </tr>)}{pendingAttestations.length === 0 && <tr><td colSpan={6} className="muted">No pending attestations.</td></tr>}
    </tbody></table>}

    {tab === 'My Inbox' && <>
      <p className="muted">Controlled documents distributed to you. Open each to read it, then attest. Your attestation is recorded against the document and appears on its printed attestation list.</p>
      <table className="data-table"><thead><tr><th>Document</th><th>Version</th><th>Attestation status</th><th>Due</th><th>Signed</th><th>Actions</th></tr></thead><tbody>
        {inbox.map(e => <tr key={e.id}>
          <td>{e.document_code || '—'} — {e.title}</td>
          <td>{e.version_number || '—'}</td>
          <td>{formatBadge(e.attestation_status)}</td>
          <td>{e.due_date || e.attestation_due || '—'}</td>
          <td>{e.attested_at || '—'}</td>
          <td style={{ whiteSpace: 'nowrap' }}>
            <button onClick={() => setViewer({ docId: e.document_id, versionId: e.document_version_id || 0, attestationId: e.attestation_id })}>Read &amp; attest</button>
            {e.attestation_id && e.attestation_status !== 'signed' && <button className="secondary" onClick={() => signAttestation(e.attestation_id!, e.document_id)}>Quick sign</button>}
          </td>
        </tr>)}
      </tbody></table>
      {inbox.length === 0 && <p>Your inbox is empty.</p>}
    </>}

    {tab === 'Obsolete' && <table className="data-table"><thead><tr><th>Code</th><th>Title</th><th>Type</th><th>Reason</th><th></th></tr></thead><tbody>
      {obsoleteDocs.map(d => <tr key={d.id}>
        <td>{d.document_code || '—'}</td><td>{d.title}</td><td>{d.document_type || '—'}</td>
        <td>{d.obsolete_reason || '—'}</td>
        <td><button onClick={() => openDoc(d.id)}>Open</button></td>
      </tr>)}{obsoleteDocs.length === 0 && <tr><td colSpan={5} className="muted">No obsolete documents.</td></tr>}
    </tbody></table>}

    {tab === 'Record Control' && <RecordControl staff={staff} sections={sections} departments={departments} documents={documents} onError={setError} />}
  </div>;
}

// ============================================================================
// In-app document viewer / editor
// ============================================================================
// Word-like reader: a scrollable white "page" plus a functional Table of
// Contents built from the document's own headings. Clicking a section scrolls
// to it. Used for both the in-app content and the rendered Word original.
function DocReader({ html, zoom, height }: { html: string; zoom: number; height: string }) {
  const pageRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [toc, setToc] = useState<Array<{ id: string; text: string; level: number }>>([]);
  const [active, setActive] = useState<string>('');

  useEffect(() => {
    const root = pageRef.current;
    if (!root) { setToc([]); return; }
    const hs = Array.from(root.querySelectorAll('h1,h2,h3,h4')) as HTMLElement[];
    const items = hs.map((h, i) => {
      const text = (h.textContent || '').replace(/\s+/g, ' ').trim();
      if (!text) return null;
      const id = h.id || `doc-h-${i}`;
      h.id = id;
      return { id, text: text.slice(0, 90), level: Number(h.tagName[1]) || 2 };
    }).filter(Boolean) as Array<{ id: string; text: string; level: number }>;
    setToc(items);
  }, [html]);

  function go(id: string) {
    const el = pageRef.current?.querySelector(`#${(window.CSS && CSS.escape) ? CSS.escape(id) : id}`) as HTMLElement | null;
    const scroller = scrollRef.current;
    if (el && scroller) { scroller.scrollTo({ top: Math.max(0, el.offsetTop - 12), behavior: 'smooth' }); setActive(id); }
  }

  return <div className="doc-reader" style={{ height }}>
    {toc.length > 0 && <nav className="doc-toc">
      <div className="doc-toc-head">Contents</div>
      {toc.map(t => <button key={t.id} type="button" className={`doc-toc-item lvl-${Math.min(t.level, 4)}${active === t.id ? ' active' : ''}`} title={t.text} onClick={() => go(t.id)}>{t.text}</button>)}
    </nav>}
    <div className="doc-scroll" ref={scrollRef}>
      <div ref={pageRef} className="doc-content doc-page" style={{ zoom }} dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  </div>;
}

// ============================================================================
// In-app document viewer / editor
// ============================================================================
// SOP / document AI analysis tools. These are the ONLY place Dennis may use the
// online AI provider — and only in Hybrid / Online-drafting mode, after redaction,
// and only when the content is classified as SOP/document (not patient/operational
// data). Everything else in the app stays on the offline Ollama model.
type SopResult = { output: string; mode: string; provider: string; onlineUsed: boolean; redactionApplied: boolean; sensitive: boolean; reasons: string[]; warning?: string; documentName: string; error?: string };
const SOP_ACTIONS: Array<{ task: string; label: string }> = [
  { task: 'summarize', label: 'Summarise SOP' },
  { task: 'responsibilities', label: 'Extract responsibilities' },
  { task: 'records_forms', label: 'Extract required records/forms' },
  { task: 'missing_sections', label: 'Identify missing sections' },
  { task: 'checklist', label: 'Implementation checklist' },
  { task: 'training_notes', label: 'Staff training notes' },
  { task: 'quiz', label: 'Competency questions' },
  { task: 'improve_wording', label: 'Improve SOP wording' },
  { task: 'compare', label: 'Compare SOPs' },
];
function SopTools({ docId, versionId, documents }: { docId: number; versionId: number; documents?: DocumentRecord[] }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<SopResult | null>(null);
  const [compareId, setCompareId] = useState('');
  const [confirm, setConfirm] = useState<{ task: string } | null>(null);

  async function run(task: string, confirmed = false) {
    if (task === 'compare' && !compareId) { setResult({ output: '', mode: 'none', provider: 'none', onlineUsed: false, redactionApplied: false, sensitive: false, reasons: [], documentName: '', error: 'Choose a second document to compare against.' }); return; }
    setBusy(task); setConfirm(null);
    try {
      const body: Record<string, unknown> = { task, documentId: docId, versionId, confirmed };
      if (task === 'compare') body.compareDocumentId = Number(compareId);
      const r = await api<SopResult & { output: string }>('/dennis/sop-analyze', { method: 'POST', body: JSON.stringify(body) });
      if (r.output === 'CONFIRM_ONLINE') { setConfirm({ task }); setResult(null); }
      else setResult(r);
    } catch (e) { setResult({ output: '', mode: 'error', provider: 'none', onlineUsed: false, redactionApplied: false, sensitive: false, reasons: [], documentName: '', error: (e as Error).message }); }
    finally { setBusy(null); }
  }

  const others = (documents || []).filter(d => d.id !== docId);
  return <div style={{ marginTop: 12, padding: 12, background: '#0f1830', border: '1px solid #24365e', borderRadius: 8 }}>
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
      <strong style={{ color: '#cdd9f0', fontSize: 13 }}>🤖 SOP analysis with Dennis</strong>
      <button className="secondary" onClick={() => setOpen(o => !o)}>{open ? 'Hide' : 'Show tools'}</button>
    </div>
    {open && <>
      <p style={{ fontSize: 11.5, color: '#8fa3c8', margin: '6px 0 8px' }}>Offline Ollama runs these by default. If you enable Hybrid mode with an online provider, Dennis may use it for stronger SOP understanding — only after redaction, and never when patient/operational data is detected.</p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
        {SOP_ACTIONS.map(a => <button key={a.task} className="secondary" disabled={!!busy} onClick={() => run(a.task)}>{busy === a.task ? 'Working…' : a.label}</button>)}
      </div>
      {others.length > 0 && <label style={{ fontSize: 12, color: '#9fb2d6' }}>Compare with:&nbsp;
        <select value={compareId} onChange={e => setCompareId(e.target.value)}><option value="">— choose document —</option>{others.map(d => <option key={d.id} value={d.id}>{d.document_code ? `${d.document_code} — ` : ''}{d.title}</option>)}</select>
      </label>}
      {confirm && <div style={{ marginTop: 8, padding: 10, background: '#3a2a12', border: '1px solid #6b4e1f', borderRadius: 6, color: '#f3d9a6', fontSize: 12.5 }}>
        Online AI may send this document's text outside the hospital network. Use only for SOPs and non-patient documents. Continue?
        <div style={{ marginTop: 6, display: 'flex', gap: 8 }}><button onClick={() => run(confirm.task, true)}>Yes, use online AI</button><button className="secondary" onClick={() => setConfirm(null)}>Cancel</button></div>
      </div>}
      {result && <div style={{ marginTop: 8 }}>
        {result.error ? <div className="error">{result.error}</div> : <>
          <div style={{ fontSize: 11.5, color: '#9fb2d6', marginBottom: 4, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <span className="badge">{result.mode}{result.provider && result.provider !== 'none' ? ` · ${result.provider}` : ''}</span>
            {result.onlineUsed ? <span className="badge warning">online · redacted</span> : <span className="badge">offline · on-premises</span>}
            <span>Review before use.</span>
          </div>
          {result.warning && <div className="warning" style={{ margin: '4px 0' }}>⚠ {result.warning}</div>}
          <pre style={{ whiteSpace: 'pre-wrap', background: '#0c1428', border: '1px solid #24365e', borderRadius: 6, padding: 12, color: '#dbe6fb', fontSize: 12.5, maxHeight: '38vh', overflow: 'auto' }}>{result.output}</pre>
          <button className="secondary" onClick={() => navigator.clipboard?.writeText(result.output)}>Copy</button>
        </>}
      </div>}
    </>}
  </div>;
}

// Word-style formatting ribbon for the in-app document editor. Uses the browser's
// rich-text editing (execCommand) on the contentEditable page — no extra deps, and
// the formatting is saved back into the controlled document HTML.
const WORD_FONTS = ['Calibri', 'Arial', 'Times New Roman', 'Georgia', 'Verdana', 'Tahoma', 'Cambria', 'Courier New'];
const WORD_SIZES: Array<[string, string]> = [['1', '8'], ['2', '10'], ['3', '12'], ['4', '14'], ['5', '18'], ['6', '24'], ['7', '36']];
function WordToolbar({ editorRef }: { editorRef: { current: HTMLDivElement | null } }) {
  const exec = (cmd: string, value?: string) => {
    editorRef.current?.focus();
    try { document.execCommand('styleWithCSS', false, 'true'); } catch { /* not supported */ }
    try { document.execCommand(cmd, false, value); } catch { /* command unsupported */ }
  };
  const block = (tag: string) => exec('formatBlock', tag);
  const insertTable = () => {
    const rows = Math.min(40, Math.max(1, Number(prompt('Number of rows?', '2')) || 0));
    const cols = Math.min(20, Math.max(1, Number(prompt('Number of columns?', '2')) || 0));
    if (!rows || !cols) return;
    let html = '<table class="docx-table"><tbody>';
    for (let r = 0; r < rows; r++) { html += '<tr>'; for (let c = 0; c < cols; c++) html += '<td>&nbsp;</td>'; html += '</tr>'; }
    html += '</tbody></table><p><br/></p>';
    exec('insertHTML', html);
  };
  const insertLink = () => { const url = prompt('Link URL (https://…):'); if (url) exec('createLink', url); };
  const B = ({ cmd, val, title, children }: { cmd: string; val?: string; title: string; children: React.ReactNode }) =>
    <button type="button" className="wt-btn" title={title} onMouseDown={e => e.preventDefault()} onClick={() => exec(cmd, val)}>{children}</button>;
  return <div className="word-toolbar">
    <div className="wt-group">
      <B cmd="undo" title="Undo">↶</B><B cmd="redo" title="Redo">↷</B>
    </div>
    <div className="wt-group">
      <select className="wt-select" title="Paragraph style" defaultValue="" onMouseDown={e => e.stopPropagation()} onChange={e => { block(e.target.value || 'P'); e.target.value = ''; }}>
        <option value="">Style</option><option value="P">Normal</option><option value="H1">Heading 1</option><option value="H2">Heading 2</option><option value="H3">Heading 3</option><option value="PRE">Preformatted</option>
      </select>
      <select className="wt-select" title="Font" defaultValue="" onMouseDown={e => e.stopPropagation()} onChange={e => { if (e.target.value) exec('fontName', e.target.value); e.target.value = ''; }}>
        <option value="">Font</option>{WORD_FONTS.map(f => <option key={f} value={f}>{f}</option>)}
      </select>
      <select className="wt-select" title="Font size" defaultValue="" onMouseDown={e => e.stopPropagation()} onChange={e => { if (e.target.value) exec('fontSize', e.target.value); e.target.value = ''; }}>
        <option value="">Size</option>{WORD_SIZES.map(([v, pt]) => <option key={v} value={v}>{pt}pt</option>)}
      </select>
    </div>
    <div className="wt-group">
      <B cmd="bold" title="Bold"><b>B</b></B><B cmd="italic" title="Italic"><i>I</i></B><B cmd="underline" title="Underline"><u>U</u></B><B cmd="strikeThrough" title="Strikethrough"><s>S</s></B>
      <label className="wt-btn" title="Text colour">A<input type="color" className="wt-color" onMouseDown={e => e.stopPropagation()} onChange={e => exec('foreColor', e.target.value)} /></label>
      <label className="wt-btn" title="Highlight" style={{ background: '#fff3a3' }}>▰<input type="color" className="wt-color" onMouseDown={e => e.stopPropagation()} onChange={e => exec('hiliteColor', e.target.value)} /></label>
    </div>
    <div className="wt-group">
      <B cmd="insertUnorderedList" title="Bulleted list">•≣</B><B cmd="insertOrderedList" title="Numbered list">1≣</B>
      <B cmd="outdent" title="Decrease indent">⇤</B><B cmd="indent" title="Increase indent">⇥</B>
    </div>
    <div className="wt-group">
      <B cmd="justifyLeft" title="Align left">⮈</B><B cmd="justifyCenter" title="Centre">≡</B><B cmd="justifyRight" title="Align right">⮊</B><B cmd="justifyFull" title="Justify">☰</B>
    </div>
    <div className="wt-group">
      <button type="button" className="wt-btn" title="Insert table" onMouseDown={e => e.preventDefault()} onClick={insertTable}>▦</button>
      <button type="button" className="wt-btn" title="Insert link" onMouseDown={e => e.preventDefault()} onClick={insertLink}>🔗</button>
      <B cmd="insertHorizontalRule" title="Horizontal line">―</B>
      <B cmd="removeFormat" title="Clear formatting">⌫</B>
    </div>
  </div>;
}

function DocumentViewer(props: { docId: number; versionId: number; attestationId?: number; workflowStatus?: string; documents?: DocumentRecord[]; onWorkflowAction?: (action: string) => Promise<void>; onClose: () => void; onAttest: (attId: number, docId: number) => void; onSaved: () => void; onError: (m: string) => void }) {
  const { docId, versionId, attestationId, workflowStatus, documents, onWorkflowAction, onClose, onAttest, onSaved, onError } = props;
  // Tracks which version is actually being viewed/edited. Starts at the version
  // the caller opened, but is advanced in-place when an "Open in Microsoft
  // Office" sync lands a new version, so the viewer reflects the saved edits
  // immediately instead of requiring the user to close and reopen the document.
  const [activeVersionId, setActiveVersionId] = useState(versionId);
  useEffect(() => setActiveVersionId(versionId), [versionId]);
  const [content, setContent] = useState<VersionContent | null>(null);
  const [mode, setMode] = useState<'content' | 'original'>('content');
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [exportBusy, setExportBusy] = useState<'download' | 'save' | null>(null);
  const [officeWatch, setOfficeWatch] = useState<{ watchId: string; fileName: string } | null>(null);
  const [officeStatus, setOfficeStatus] = useState<string | null>(null);
  const [fileUrl, setFileUrl] = useState<string | null>(null);
  const [maximized, setMaximized] = useState(true);
  const [minimized, setMinimized] = useState(false);
  const [winPos, setWinPos] = useState<{ x: number; y: number } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [comments, setComments] = useState<DocumentComment[]>([]);
  const [newComment, setNewComment] = useState('');
  const editorRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const dragOffset = useRef({ x: 0, y: 0 });

  // Drag-to-reposition the viewer window by its header, like any desktop
  // document/PDF viewer. Disabled while maximized (nowhere to drag to).
  function startWinDrag(e: ReactPointerEvent<HTMLElement>) {
    if (maximized) return;
    if ((e.target as HTMLElement).closest('button,select,input,a')) return;
    const rect = cardRef.current?.getBoundingClientRect();
    if (!rect) return;
    dragging.current = true;
    dragOffset.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    setWinPos({ x: rect.left, y: rect.top });
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  function moveWinDrag(e: ReactPointerEvent<HTMLElement>) {
    if (!dragging.current) return;
    const w = cardRef.current?.offsetWidth || 600;
    const h = cardRef.current?.offsetHeight || 400;
    const x = Math.min(Math.max(0, e.clientX - dragOffset.current.x), Math.max(0, window.innerWidth - Math.min(w, window.innerWidth)));
    const y = Math.min(Math.max(0, e.clientY - dragOffset.current.y), Math.max(0, window.innerHeight - Math.min(h, window.innerHeight)));
    setWinPos({ x, y });
  }
  function stopWinDrag(e: ReactPointerEvent<HTMLElement>) {
    dragging.current = false;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* already released */ }
  }

  const loadComments = () => api<DocumentComment[]>(`/documents/${docId}/comments`).then(setComments).catch(() => {});
  useEffect(() => { void loadComments(); }, [docId]);

  async function addComment() {
    if (!newComment.trim()) return;
    setBusy(true);
    try { await api(`/documents/${docId}/comments`, { method: 'POST', body: JSON.stringify({ comment: newComment, stage: workflowStatus, documentVersionId: activeVersionId }) }); setNewComment(''); await loadComments(); }
    catch (e) { onError((e as Error).message); } finally { setBusy(false); }
  }
  async function doWorkflow(action: string) {
    if (!onWorkflowAction) return;
    setBusy(true);
    try { await onWorkflowAction(action); onClose(); }
    catch (e) { onError((e as Error).message); } finally { setBusy(false); }
  }
  const WF: Record<string, { label: string; action: string }> = {
    draft: { label: 'Accept & submit for review →', action: 'submit' },
    under_review: { label: 'Accept review & send for approval →', action: 'accept' },
    reviewed: { label: 'Approve & publish to all staff →', action: 'approve' },
  };
  const wf = workflowStatus ? WF[workflowStatus] : undefined;

  useEffect(() => {
    let url: string | null = null;
    api<VersionContent>(`/documents/${docId}/versions/${activeVersionId}/content`)
      .then(c => {
        setContent(c);
        const pdfish = c.file_mime === 'application/pdf' || /\.pdf$/i.test(c.file_name || '');
        const imgish = (c.file_mime || '').startsWith('image/');
        // Faithful formats render natively, so open the original by default;
        // otherwise show the in-app (rich HTML) content.
        if (c.file_id && (pdfish || imgish || !c.content_html)) setMode('original');
        if (c.file_id) fetchBlobUrl(`/files/${c.file_id}/raw`).then(u => { url = u; setFileUrl(u); }).catch(() => {});
      })
      .catch(e => onError((e as Error).message));
    return () => { if (url) URL.revokeObjectURL(url); };
  }, [docId, activeVersionId]);

  async function reExtract() {
    setBusy(true);
    try { await api(`/documents/${docId}/versions/${activeVersionId}/re-extract`, { method: 'POST', body: JSON.stringify({}) }); const c = await api<VersionContent>(`/documents/${docId}/versions/${activeVersionId}/content`); setContent(c); }
    catch (e) { onError((e as Error).message); } finally { setBusy(false); }
  }
  async function saveContent() {
    if (!editorRef.current) return;
    setBusy(true);
    try {
      await api(`/documents/${docId}/versions/${activeVersionId}/content`, { method: 'PUT', body: JSON.stringify({ contentHtml: editorRef.current.innerHTML, contentText: editorRef.current.innerText }) });
      const c = await api<VersionContent>(`/documents/${docId}/versions/${activeVersionId}/content`); setContent(c);
      setEditing(false); onSaved();
    } catch (e) { onError((e as Error).message); } finally { setBusy(false); }
  }

  // Build a real .docx from the in-app edited content and download it straight away.
  async function downloadAsWord() {
    setExportBusy('download');
    try {
      const r = await api<{ fileId: number; originalName: string }>(`/documents/${docId}/versions/${activeVersionId}/export-docx`, { method: 'POST', body: JSON.stringify({}) });
      const url = await fetchBlobUrl(`/files/${r.fileId}/download`);
      const a = document.createElement('a'); a.href = url; a.download = r.originalName; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    } catch (e) { onError((e as Error).message); } finally { setExportBusy(null); }
  }
  // Build a real .docx and attach it as the document's newest version, so the
  // in-app edits round-trip into the official record as an openable Word file.
  async function saveAsWordVersion() {
    setExportBusy('save');
    try {
      await api(`/documents/${docId}/versions/${activeVersionId}/export-docx/save-as-version`, { method: 'POST', body: JSON.stringify({}) });
      onSaved(); onClose();
    } catch (e) { onError((e as Error).message); } finally { setExportBusy(null); }
  }

  // "Open in Microsoft Office" — Electron-only. Opens the stored file with the
  // OS's default application (Word/Excel/etc.) and watches it for saves; each
  // save is delivered back here and uploaded as a new document version.
  async function openInOffice() {
    if (!content?.file_id || !window.sechLims?.openInOffice) return;
    setOfficeStatus('Opening…');
    try {
      const meta = await api<{ storage_area: string; stored_name: string; original_name: string }>(`/files/${content.file_id}/meta`);
      const result = await window.sechLims.openInOffice({
        storageArea: meta.storage_area, storedName: meta.stored_name, originalName: meta.original_name || content.file_name || 'document',
        docId, versionId: activeVersionId,
      });
      if (!result.ok) { setOfficeStatus(null); onError(result.error || 'Could not open the file in its default application.'); return; }
      setOfficeWatch({ watchId: result.watchId!, fileName: meta.original_name || content.file_name || 'document' });
      setOfficeStatus(`Watching “${meta.original_name || content.file_name}” — saving it in Office will sync it back here automatically as a new version.`);
    } catch (e) { setOfficeStatus(null); onError((e as Error).message); }
  }
  function stopOfficeWatchNow() {
    if (officeWatch) window.sechLims?.stopOfficeWatch?.(officeWatch.watchId);
    setOfficeWatch(null); setOfficeStatus(null);
  }
  // Manual fallback: forces the main process to re-read the scratch file right
  // now instead of waiting for the automatic watch/poll, for cases where the
  // user wants an immediate confirmation that a save landed.
  async function checkOfficeNow() {
    if (!officeWatch || !window.sechLims?.checkOfficeNow) return;
    setOfficeStatus('Checking for a saved change…');
    const r = await window.sechLims.checkOfficeNow(officeWatch.watchId);
    if (!r.ok) { setOfficeStatus(r.error || 'Could not check for changes.'); return; }
  }
  useEffect(() => {
    if (!window.sechLims?.onOfficeFileChanged) return;
    const unsubscribe = window.sechLims.onOfficeFileChanged(async (payload: OfficeFileChangedPayload) => {
      if (!officeWatch || payload.watchId !== officeWatch.watchId) return;
      setOfficeStatus('Saved in Office — syncing back to SECH_LIMS…');
      try {
        const fd = new FormData();
        fd.append('file', new Blob([new Uint8Array(payload.bytes)], { type: payload.mimeGuess || 'application/octet-stream' }), payload.originalName);
        const token = getToken();
        const fr = await fetch(`${API_BASE}/files`, { method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : undefined, body: fd });
        if (!fr.ok) throw new Error((await fr.json().catch(() => ({ error: fr.statusText }))).error ?? fr.statusText);
        const fdata = await fr.json();
        const stamp = new Date().toISOString().slice(11, 19).replace(/:/g, '');
        const nextVersionNumber = `office-sync-${stamp}`;
        const created = await api<{ id: number }>(`/documents/${docId}/versions`, { method: 'POST', body: JSON.stringify({ versionNumber: nextVersionNumber, fileId: fdata.id, revisionSummary: 'Synced automatically from Microsoft Office' }) });
        setOfficeStatus(`Synced as a new version (${nextVersionNumber}) — now viewing the saved edits.`);
        setActiveVersionId(created.id);
        onSaved();
      } catch (e) { setOfficeStatus(null); onError((e as Error).message); }
    });
    return unsubscribe;
  }, [officeWatch, docId]);
  // Stop watching when the viewer closes, so the main process doesn't keep a
  // file watcher open for a document the user is no longer looking at.
  useEffect(() => () => { if (officeWatch) window.sechLims?.stopOfficeWatch?.(officeWatch.watchId); }, [officeWatch]);

  const isPdf = content?.file_mime === 'application/pdf' || /\.pdf$/i.test(content?.file_name || '');
  const isImage = (content?.file_mime || '').startsWith('image/');
  const WORD_MIMES = ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/msword'];
  const SPREADSHEET_MIMES = ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.ms-excel'];
  // The "Download as Word" / "Save as new Word version" export only makes sense
  // for an actual Word source file, or for content authored in-app with no
  // original file at all (nothing else to conflict with). Anything else
  // (spreadsheets, PDFs, images, plain text) keeps its own native format.
  const isWordSource = !content?.file_id || WORD_MIMES.includes(content?.file_mime || '') || /\.docx?$/i.test(content?.file_name || '');
  const isSpreadsheet = SPREADSHEET_MIMES.includes(content?.file_mime || '') || /\.xlsx?$|\.xlsm$/i.test(content?.file_name || '');

  const contentH = maximized ? '80vh' : '56vh';
  const originalH = maximized ? '86vh' : '64vh';
  const zoomPct = Math.round(zoom * 100);
  const zoomControls = <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
    <button className="secondary" title="Zoom out" onClick={() => setZoom(z => Math.max(0.5, +(z - 0.1).toFixed(2)))}>−</button>
    <span style={{ minWidth: 44, textAlign: 'center', fontSize: 12 }}>{zoomPct}%</span>
    <button className="secondary" title="Zoom in" onClick={() => setZoom(z => Math.min(3, +(z + 0.1).toFixed(2)))}>+</button>
    <button className="secondary" title="Reset zoom" onClick={() => setZoom(1)}>Fit</button>
  </span>;

  if (minimized) {
    return <div style={{ position: 'fixed', right: 16, bottom: 16, zIndex: 1000 }}>
      <button className="secondary" onClick={() => setMinimized(false)} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 16px', boxShadow: '0 4px 18px rgba(0,0,0,.4)' }}>
        📄 {content?.file_name || content?.version_label || 'Document'} — Restore
      </button>
    </div>;
  }

  // Fullscreen (maximized): true edge-to-edge, no backdrop padding, no drag.
  // Windowed: a normal floating card the header can drag anywhere on screen.
  const cardStyle: CSSProperties = maximized
    ? { width: '100vw', height: '100vh', maxWidth: '100vw', margin: 0, borderRadius: 0, position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column', overflow: 'auto' }
    : winPos
      ? { width: 'min(1100px, 96vw)', maxWidth: '98vw', margin: 0, position: 'fixed', left: winPos.x, top: winPos.y }
      : { width: 'min(1100px, 96vw)', maxWidth: '98vw', margin: 0 };

  return <div style={{ position: 'fixed', inset: 0, background: maximized ? 'transparent' : 'rgba(8,16,32,0.55)', zIndex: 1000, display: 'flex', justifyContent: 'center', alignItems: maximized ? 'stretch' : (winPos ? 'flex-start' : 'flex-start'), padding: maximized ? 0 : '3vh 2vw', overflow: maximized ? 'hidden' : 'auto', pointerEvents: maximized ? 'none' : 'auto' }} onClick={onClose}>
    <div ref={cardRef} className="card" style={{ ...cardStyle, pointerEvents: 'auto' }} onClick={e => e.stopPropagation()}
      onPointerMove={moveWinDrag} onPointerUp={stopWinDrag} onPointerCancel={stopWinDrag}>
      <style>{`.doc-content table.docx-table,.doc-content table{border-collapse:collapse;width:100%;margin:8px 0;font-size:12px}
.doc-content table td,.doc-content table th{border:1px solid #c9d2e0;padding:5px 8px;vertical-align:top;text-align:left}
.doc-content h1{font-size:18px;margin:14px 0 6px}
.doc-content h2{font-size:16px;color:#1B3A6B;margin:14px 0 6px;border-bottom:1px solid #e2e8f0;padding-bottom:3px}
.doc-content h3{font-size:14px;color:#243b63;margin:12px 0 4px}
.doc-content h4,.doc-content h5,.doc-content h6{font-size:13px;color:#33415a;margin:10px 0 4px}
.doc-content p{margin:5px 0}.doc-content ul{margin:6px 0 6px 22px}.doc-content li{margin:2px 0}
.doc-content img{max-width:100%;height:auto}.doc-content .docx-img{text-align:center;margin:10px 0}
.doc-content .docx-diagram{border:1px dashed #b9c4d6;border-radius:6px;padding:8px 12px;margin:10px 0;background:#f8fafc}
.doc-reader{display:flex;border:1px solid #e2e8f0;border-radius:6px;overflow:hidden}
.doc-toc{width:236px;flex:none;overflow:auto;background:#0f1830;border-right:1px solid #24365e;padding:10px 8px}
.doc-toc-head{font-size:10.5px;letter-spacing:.12em;text-transform:uppercase;color:#7c8db0;padding:2px 8px 8px}
.doc-toc-item{display:block;width:100%;text-align:left;background:none;border:0;box-shadow:none;color:#c2cde3;cursor:pointer;font-size:12.5px;line-height:1.3;padding:5px 8px;border-radius:6px;white-space:normal}
.doc-toc-item:hover{background:rgba(255,255,255,.06);color:#fff}
.doc-toc-item.active{background:var(--accent-soft,rgba(47,107,255,.16));color:#fff}
.doc-toc-item.lvl-1{font-weight:700}.doc-toc-item.lvl-2{padding-left:8px}.doc-toc-item.lvl-3{padding-left:18px;font-size:12px;color:#9fb0cf}.doc-toc-item.lvl-4{padding-left:28px;font-size:11.5px;color:#8295b5}
.doc-scroll{flex:1;overflow:auto;background:#525659;padding:18px;min-width:0}
.doc-page{background:#fff;color:#111;max-width:820px;margin:0 auto;padding:34px 44px;box-shadow:0 2px 14px rgba(0,0,0,.45);line-height:1.55;border-radius:2px}
@media (max-width:760px){.doc-toc{display:none}}
.word-editor{border:1px solid #24365e;border-radius:6px;overflow:hidden}
.word-toolbar{display:flex;flex-wrap:wrap;gap:6px;align-items:center;padding:6px 8px;background:#16243f;border-bottom:1px solid #24365e}
.word-toolbar .wt-group{display:flex;align-items:center;gap:2px;padding:0 6px;border-right:1px solid #2a3c63}
.word-toolbar .wt-group:last-child{border-right:0}
.wt-btn{position:relative;min-width:26px;height:26px;padding:0 6px;display:inline-flex;align-items:center;justify-content:center;background:#0f1d38;border:1px solid #2c416f;border-radius:5px;color:#dbe6fb;cursor:pointer;font-size:13px;line-height:1;box-shadow:none}
.wt-btn:hover{background:#1d3257;border-color:#3a5694}
.wt-color{position:absolute;inset:0;opacity:0;cursor:pointer;width:100%;height:100%}
.wt-select{height:26px;background:#0f1d38;border:1px solid #2c416f;border-radius:5px;color:#dbe6fb;font-size:12px;padding:0 4px;cursor:pointer}
.doc-page[contenteditable="true"]{cursor:text}
.doc-page[contenteditable="true"]:focus{outline:none}`}</style>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap', cursor: maximized ? 'default' : 'move', touchAction: 'none' }}
        onPointerDown={startWinDrag} title={maximized ? undefined : 'Drag to move the window'}>
        <h3 style={{ margin: 0, fontSize: 15 }}>{content ? `${content.version_label || content.version_number || 'Version'} · ${content.file_name || 'Controlled content'}` : 'Loading…'}</h3>
        <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
          {zoomControls}
          <button className="secondary" title="Minimize" onClick={() => setMinimized(true)}>Minimize</button>
          <button className="secondary" title={maximized ? 'Restore window' : 'Maximize to fill the screen'} onClick={() => setMaximized(m => !m)}>{maximized ? 'Restore' : 'Maximize'}</button>
          <button className="secondary" title="Close" onClick={onClose}>Close</button>
        </span>
      </div>
      <div className="tabs" style={{ marginTop: 10 }}>
        <button type="button" className={mode === 'content' ? 'active' : ''} onClick={() => setMode('content')}>In-app content</button>
        {content?.file_id && <button type="button" className={mode === 'original' ? 'active' : ''} onClick={() => setMode('original')}>Original file</button>}
      </div>

      {content && <div style={{ fontSize: 12, color: '#667', margin: '6px 0' }}>
        {content.extraction_method && content.extraction_method !== 'none' ? <>Read by SECH_LIMS ({content.extraction_method}{content.page_count ? `, ${content.page_count} pages` : ''}). </> : 'No content was automatically read. '}
        {content.content_updated_at && <>Last edited {String(content.content_updated_at).slice(0, 16).replace('T', ' ')}{content.content_updated_by_name ? ` by ${content.content_updated_by_name}` : ''}. </>}
      </div>}

      {content?.file_id && window.sechLims?.openInOffice && <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', margin: '0 0 8px', padding: '8px 10px', background: officeWatch ? '#13301f' : '#0f1830', border: `1px solid ${officeWatch ? '#225c3a' : '#24365e'}`, borderRadius: 6 }}>
        {!officeWatch
          ? <button className="secondary" onClick={openInOffice} disabled={officeStatus === 'Opening…'} title="Open the stored file in Microsoft Word/Excel/etc. and sync saves back automatically">{officeStatus === 'Opening…' ? 'Opening…' : 'Open in Microsoft Office'}</button>
          : <>
              <button className="secondary" onClick={checkOfficeNow} title="Force an immediate check for a saved change, instead of waiting for it to be detected automatically">Check now</button>
              <button className="secondary" onClick={stopOfficeWatchNow}>Stop watching</button>
            </>}
        {officeStatus && <span style={{ fontSize: 12, color: '#a8c7b6' }}>{officeStatus}</span>}
        {officeWatch && <span style={{ fontSize: 11.5, color: '#7c8db0' }}>If Word shows “Protected View”, click “Enable Editing” there first — changes can’t be saved until you do.</span>}
      </div>}

      {mode === 'content' && content && <div>
        <div style={{ display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
          {!editing && <button onClick={() => setEditing(true)}>Edit content</button>}
          {editing && <button onClick={saveContent} disabled={busy}>{busy ? 'Saving…' : 'Save content'}</button>}
          {editing && <button className="secondary" onClick={() => setEditing(false)}>Cancel</button>}
          {content.file_id && <button className="secondary" onClick={reExtract} disabled={busy}>{busy ? 'Reading…' : 'Re-read from file'}</button>}
          <button className="secondary" title="Ask the Dennis AI assistant about this document" onClick={() => window.dispatchEvent(new CustomEvent('dennis:ask', { detail: { question: `Summarise and explain this document: ${content.file_name || content.version_label || 'the open document'}` } }))}>Ask Dennis</button>
          {content.file_id && <a className="badge" href={`${API_BASE}/files/${content.file_id}/download`} onClick={ev => { ev.preventDefault(); fetchBlobUrl(`/files/${content.file_id}/download`).then(u => { const a = document.createElement('a'); a.href = u; a.download = content.file_name || 'document'; a.click(); }); }} style={{ cursor: 'pointer' }}>Download original</a>}
          {!!content.content_html && isWordSource && <button className="secondary" title="Build a real .docx from the in-app content and download it" onClick={downloadAsWord} disabled={!!exportBusy}>{exportBusy === 'download' ? 'Building…' : 'Download as Word (.docx)'}</button>}
          {!!content.content_html && isWordSource && <button className="secondary" title="Build a real .docx and attach it as the document's newest version" onClick={saveAsWordVersion} disabled={!!exportBusy}>{exportBusy === 'save' ? 'Saving…' : 'Save as new Word version'}</button>}
        </div>
        {editing
          ? <div className="word-editor">
              {!isSpreadsheet && <WordToolbar editorRef={editorRef} />}
              <div className="doc-scroll" style={{ height: contentH }}>
                <div ref={editorRef} className="doc-content doc-page" contentEditable suppressContentEditableWarning dangerouslySetInnerHTML={{ __html: content.content_html || `<p>${(content.content_text || '').replace(/\n/g, '<br/>')}</p>` || '<p>Type the controlled document content here…</p>' }}
                  style={{ zoom, outline: 'none', minHeight: '60%' }} />
              </div>
            </div>
          : (content.content_html
              ? <DocReader html={content.content_html} zoom={zoom} height={contentH} />
              : (content.content_text
                  ? <pre style={{ whiteSpace: 'pre-wrap', border: '1px solid #e2e8f0', borderRadius: 6, padding: 16, height: contentH, overflow: 'auto', background: '#fff', color: '#111', zoom }}>{content.content_text}</pre>
                  : <p className="muted">No readable content was captured. Use “Edit content” to author it in-app, or open the original file.</p>))}
      </div>}

      {mode === 'original' && (isPdf || isImage
        ? <div style={{ height: originalH, border: '1px solid #e2e8f0', borderRadius: 6, overflow: 'auto', background: '#525659' }}>
            {!fileUrl ? <p style={{ color: '#fff', padding: 16 }}>Loading file…</p>
              : isPdf ? <iframe title="document" src={fileUrl} style={{ width: `${100 / zoom}%`, height: `${100 / zoom}%`, border: 'none', zoom }} />
              : <div style={{ minHeight: '100%', overflow: 'auto', textAlign: 'center' }}><img src={fileUrl} alt={content?.file_name} style={{ width: `${zoomPct}%`, maxWidth: 'none' }} /></div>}
          </div>
        : content?.content_html
          ? <div>
              <p className="muted" style={{ fontSize: 12, margin: '0 0 8px' }}>
                {isWordSource
                  ? 'Faithful rendering of the Word document (headings, tables, colours, shading, lists and images preserved), with a clickable Contents panel. Use “Download original” to open the exact .docx in Word.'
                  : isSpreadsheet
                    ? 'Preview of every worksheet as a table. Use “Download original” to open the exact spreadsheet in Excel.'
                    : 'Best-effort preview of the file’s content. Use “Download original” to open the exact file in its native application.'}
              </p>
              <DocReader html={content.content_html} zoom={zoom} height={originalH} />
            </div>
          : <div style={{ height: '40vh', border: '1px solid #e2e8f0', borderRadius: 6, background: '#525659', color: '#fff', padding: 24 }}>
              <p>This file type cannot be previewed inline ({content?.file_mime || 'unknown type'}) and no readable content was captured.</p>
              {fileUrl && <a className="badge" style={{ cursor: 'pointer' }} onClick={() => { const a = document.createElement('a'); a.href = fileUrl; a.download = content?.file_name || 'document'; a.click(); }}>Download file</a>}
            </div>)}

      {content && <SopTools docId={docId} versionId={activeVersionId} documents={documents} />}

      {/* Workflow stage: comments + the single stage-appropriate transition. */}
      {workflowStatus && <div style={{ marginTop: 12, padding: 12, background: '#0f1830', border: '1px solid #24365e', borderRadius: 8 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <span style={{ color: '#cdd9f0', fontSize: 13 }}>
            Stage: {formatBadge(workflowStatus)} · {workflowStatus === 'draft' ? 'Preview, edit if needed, then accept to send for review.' : workflowStatus === 'under_review' ? 'Reviewer: preview, edit/comment, then accept to send for approval.' : workflowStatus === 'reviewed' ? 'Approver: preview, edit/comment, then approve to publish to all staff.' : workflowStatus === 'current' ? 'Published — visible to all staff for attestation.' : 'Obsolete.'}
          </span>
          {wf && <button onClick={() => doWorkflow(wf.action)} disabled={busy}>{busy ? 'Working…' : wf.label}</button>}
        </div>
        <div style={{ marginTop: 10 }}>
          <div style={{ display: 'flex', gap: 8 }}>
            <input value={newComment} onChange={e => setNewComment(e.target.value)} placeholder="Add a comment for the drafter / reviewer / approver…" style={{ flex: 1 }} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addComment(); } }} />
            <button className="secondary" onClick={addComment} disabled={busy || !newComment.trim()}>Comment</button>
          </div>
          {comments.length > 0 && <ul style={{ listStyle: 'none', padding: 0, margin: '8px 0 0', maxHeight: 140, overflow: 'auto' }}>
            {comments.map(c => <li key={c.id} style={{ fontSize: 12, color: '#c2cde3', padding: '4px 0', borderBottom: '1px solid #1c2a4a' }}>
              <strong>{c.author_name || 'Staff'}</strong> <span style={{ color: '#7c8db0' }}>· {c.stage || ''} · {String(c.created_at).slice(0, 16).replace('T', ' ')}</span><br />{c.comment}
            </li>)}
          </ul>}
        </div>
      </div>}

      {attestationId && <div style={{ marginTop: 12, padding: 12, background: '#f1f5f9', borderRadius: 6, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
        <span><strong>Attestation:</strong> By signing you confirm you have read and understood this controlled document.</span>
        <button onClick={() => { onAttest(attestationId, docId); onClose(); }}>I have read &amp; understood — Attest</button>
      </div>}
    </div>
  </div>;
}

// ============================================================================
// Document detail panel
// ============================================================================
function WorkflowStepper({ status }: { status: string }) {
  const labels: Record<string, string> = { draft: 'Draft', under_review: 'Under review', reviewed: 'Reviewed', current: 'Approved / Current', obsolete: 'Obsolete' };
  const activeIdx = LIFECYCLE.indexOf(status === 'approved' ? 'current' : status);
  return <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', margin: '6px 0 12px' }}>
    {LIFECYCLE.map((s, i) => <span key={s} style={{ padding: '3px 10px', borderRadius: 14, fontSize: 12, fontWeight: 600,
      background: i <= activeIdx && activeIdx >= 0 ? (s === 'obsolete' ? '#fde2e1' : '#dceafe') : '#eef2f7',
      color: i <= activeIdx && activeIdx >= 0 ? (s === 'obsolete' ? '#a4341f' : '#1B3A6B') : '#94a3b8',
      border: i === activeIdx ? '1px solid #1B3A6B' : '1px solid transparent' }}>{i + 1}. {labels[s]}</span>)}
  </div>;
}

function DocumentDetailPanel(props: any) {
  const { doc, staff, positions, sections, departments,
    versionForm, setVersionForm, versionFile, setVersionFile, submitVersion,
    reviewForm, setReviewForm, submitReview,
    attestForm, setAttestForm, submitAttest,
    printForm, setPrintForm, submitPrint,
    obsoleteReason, setObsoleteReason, submitObsolete,
    submitForReview, approveDoc, distributeAll, onSignAttestation, onMarkVersionObsolete, onPrintPreview, onView, onCodeSaved, onError, onClose } = props;
  const [codeEdit, setCodeEdit] = useState(doc.document_code || '');
  useEffect(() => { setCodeEdit(doc.document_code || ''); }, [doc.id, doc.document_code]);

  async function saveCode() {
    try { await api(`/documents/${doc.id}`, { method: 'PUT', body: JSON.stringify({ documentCode: codeEdit }) }); onCodeSaved(); }
    catch (e) { onError((e as Error).message); }
  }
  const signedCount = (doc.attestations || []).filter((a: any) => a.status === 'signed').length;
  const pendingCount = (doc.attestations || []).filter((a: any) => a.status !== 'signed').length;

  return <div className="card" style={{ marginTop: 16 }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
      <h3 style={{ margin: 0 }}>{doc.document_code || '—'} — {doc.title}</h3>
      <button className="secondary" onClick={onClose}>Close panel</button>
    </div>
    <WorkflowStepper status={doc.status} />
    <p style={{ margin: '4px 0' }}>Type: {doc.document_type || '—'} | Status: {formatBadge(doc.status)} | Access: {doc.access_level || '—'} | Controlled: {doc.is_controlled ? 'Yes' : 'No'}</p>
    <p style={{ margin: '4px 0' }}>Owner: {staffName(staff, doc.owner_staff_id)} | Section: {sections.find((s: any) => s.id === doc.section_id)?.name || '—'} | Next review: {doc.next_review_date || '—'}</p>
    <p style={{ margin: '4px 0' }}>Reviewed by: {staffName(staff, doc.reviewed_by_staff_id)} | Approved by: {staffName(staff, doc.approved_by_staff_id)} {doc.approved_at ? `on ${String(doc.approved_at).slice(0, 10)}` : ''}</p>

    {/* Update document number (ISO 15189 §8.3 — unique document identification) */}
    <div style={{ display: 'flex', gap: 6, alignItems: 'center', margin: '8px 0' }}>
      <label style={{ margin: 0 }}>Document number</label>
      <input value={codeEdit} onChange={e => setCodeEdit(e.target.value)} style={{ maxWidth: 220 }} />
      <button className="secondary" onClick={saveCode} disabled={codeEdit === (doc.document_code || '')}>Update number</button>
    </div>

    {/* Lifecycle actions, shown contextually */}
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
      {doc.current_version_id && <button onClick={() => onView(doc.current_version_id)}>View / edit content</button>}
      {doc.status === 'draft' && <button onClick={submitForReview}>Submit for review →</button>}
      {(doc.status === 'reviewed' || doc.status === 'under_review') && <button onClick={approveDoc}>Approve &amp; issue →</button>}
      {(doc.status === 'current' || doc.status === 'approved') && <button onClick={distributeAll}>Distribute to all staff for attestation</button>}
      <button className="secondary" onClick={() => onPrintPreview(doc.current_version_id)}>Print preview</button>
    </div>
    {(doc.status === 'current' || doc.status === 'approved') && <p className="muted" style={{ fontSize: 12, marginTop: 6 }}>{signedCount} attested · {pendingCount} pending</p>}

    <h4>Versions</h4>
    <table className="data-table"><thead><tr><th>Version</th><th>Status</th><th>Effective</th><th>Approved</th><th>Summary</th><th>Actions</th></tr></thead><tbody>
      {(doc.versions || []).map((v: any) => <tr key={v.id}>
        <td>{v.version_number || v.version_label}{doc.current_version_id === v.id ? ' (current)' : ''}</td>
        <td>{formatBadge(v.status)}</td><td>{v.effective_date || '—'}</td><td>{v.approved_at ? String(v.approved_at).slice(0, 10) : '—'}</td><td>{v.revision_summary || '—'}</td>
        <td style={{ whiteSpace: 'nowrap' }}>
          <button onClick={() => onView(v.id)}>View</button>{' '}
          <button className="secondary" onClick={() => onPrintPreview(v.id)}>Print</button>{' '}
          {v.status !== 'obsolete' && <button className="secondary" onClick={() => onMarkVersionObsolete(v.id)}>Obsolete</button>}
        </td>
      </tr>)}
    </tbody></table>
    <form className="form-grid" onSubmit={submitVersion}>
      <label>New version number<input value={versionForm.versionNumber} onChange={(e: any) => setVersionForm({ ...versionForm, versionNumber: e.target.value })} required /></label>
      <label>Revision summary<input value={versionForm.revisionSummary} onChange={(e: any) => setVersionForm({ ...versionForm, revisionSummary: e.target.value })} /></label>
      <label>Effective date<input type="date" value={versionForm.effectiveDate} onChange={(e: any) => setVersionForm({ ...versionForm, effectiveDate: e.target.value })} /></label>
      <label>File<input type="file" accept=".pdf,.doc,.docx,.txt,.md,.rtf,.odt" onChange={(e: any) => setVersionFile(e.target.files?.[0] ?? null)} /></label>
      <button type="submit">Add version</button>
    </form>

    <h4>Reviews</h4>
    <table className="data-table"><thead><tr><th>Date</th><th>Outcome</th><th>Notes</th><th>Next review</th><th>Reviewer</th></tr></thead><tbody>
      {(doc.reviews || []).map((r: any) => <tr key={r.id}><td>{r.review_date}</td><td>{formatBadge(r.review_outcome)}</td><td>{r.review_notes || '—'}</td><td>{r.next_review_date || '—'}</td><td>{staffName(staff, r.reviewed_by_staff_id)}</td></tr>)}
      {(doc.reviews || []).length === 0 && <tr><td colSpan={5} className="muted">No reviews recorded.</td></tr>}
    </tbody></table>
    {(doc.status === 'under_review' || doc.status === 'draft' || doc.status === 'reviewed') && <form className="form-grid" onSubmit={submitReview}>
      <label>Review date<input type="date" value={reviewForm.reviewDate} onChange={(e: any) => setReviewForm({ ...reviewForm, reviewDate: e.target.value })} required /></label>
      <label>Outcome<select value={reviewForm.reviewOutcome} onChange={(e: any) => setReviewForm({ ...reviewForm, reviewOutcome: e.target.value })}>{REVIEW_OUTCOMES.map(o => <option key={o} value={o}>{o.replace(/_/g, ' ')}</option>)}</select></label>
      <label>Notes<textarea value={reviewForm.reviewNotes} onChange={(e: any) => setReviewForm({ ...reviewForm, reviewNotes: e.target.value })} /></label>
      <label>Next review date<input type="date" value={reviewForm.nextReviewDate} onChange={(e: any) => setReviewForm({ ...reviewForm, nextReviewDate: e.target.value })} /></label>
      <label><input type="checkbox" checked={reviewForm.actionRequired} onChange={(e: any) => setReviewForm({ ...reviewForm, actionRequired: e.target.checked })} /> Action required</label>
      <button type="submit">Record review</button>
    </form>}

    <h4>Attestations ({signedCount} signed)</h4>
    <table className="data-table"><thead><tr><th>Staff</th><th>Version</th><th>Status</th><th>Due</th><th>Signed</th><th></th></tr></thead><tbody>
      {(doc.attestations || []).map((a: any) => <tr key={a.id}><td>{a.staff_name || staffName(staff, a.staff_id)}</td><td>{a.version_number || '—'}</td><td>{formatBadge(a.status)}</td><td>{a.due_date || '—'}</td><td>{a.attested_at ? String(a.attested_at).slice(0, 10) : '—'}</td><td>{a.status !== 'signed' && <button onClick={() => onSignAttestation(a.id, doc.id)}>Sign</button>}</td></tr>)}
      {(doc.attestations || []).length === 0 && <tr><td colSpan={6} className="muted">No attestations assigned yet. Approve the document or use “Distribute to all staff”.</td></tr>}
    </tbody></table>
    <form className="form-grid" onSubmit={submitAttest}>
      <label>Target<select value={attestForm.targetType} onChange={(e: any) => setAttestForm({ ...attestForm, targetType: e.target.value })}>{TARGET_TYPES.map(t => <option key={t} value={t}>{t}</option>)}</select></label>
      {attestForm.targetType === 'staff' && <label>Staff (Ctrl-click for multi)<select multiple size={Math.min(8, Math.max(3, staff.length))} value={attestForm.staffIds.map(String)} onChange={(e: any) => setAttestForm({ ...attestForm, staffIds: Array.from(e.target.selectedOptions).map((o: any) => Number(o.value)) })}>{staff.map((s: any) => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label>}
      {attestForm.targetType === 'position' && <label>Position<select value={attestForm.positionId} onChange={(e: any) => setAttestForm({ ...attestForm, positionId: e.target.value })}><option value="">—</option>{positions.map((p: any) => <option key={p.id} value={p.id}>{p.title}</option>)}</select></label>}
      {attestForm.targetType === 'section' && <label>Section<select value={attestForm.sectionId} onChange={(e: any) => setAttestForm({ ...attestForm, sectionId: e.target.value })}><option value="">—</option>{sections.map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>}
      {attestForm.targetType === 'department' && <label>Department<select value={attestForm.departmentId} onChange={(e: any) => setAttestForm({ ...attestForm, departmentId: e.target.value })}><option value="">—</option>{departments.map((d: any) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label>}
      <label>Due date<input type="date" value={attestForm.dueDate} onChange={(e: any) => setAttestForm({ ...attestForm, dueDate: e.target.value })} /></label>
      <label>Notes<input value={attestForm.notes} onChange={(e: any) => setAttestForm({ ...attestForm, notes: e.target.value })} /></label>
      <button type="submit">Assign attestations</button>
    </form>

    <h4>Print logs</h4>
    <table className="data-table"><thead><tr><th>Date</th><th>By</th><th>Purpose</th><th>Controlled</th><th>Copy #</th><th>Watermark</th></tr></thead><tbody>
      {(doc.printLogs || []).map((p: any) => <tr key={p.id}><td>{p.print_date}</td><td>{p.printed_by_name || staffName(staff, p.printed_by_staff_id)}</td><td>{p.print_purpose || '—'}</td><td>{p.controlled_copy ? 'Yes' : 'No'}</td><td>{p.copy_number || '—'}</td><td>{p.watermark || '—'}</td></tr>)}
      {(doc.printLogs || []).length === 0 && <tr><td colSpan={6} className="muted">No prints logged.</td></tr>}
    </tbody></table>
    <form className="form-grid" onSubmit={submitPrint}>
      <label>Purpose<input value={printForm.printPurpose} onChange={(e: any) => setPrintForm({ ...printForm, printPurpose: e.target.value })} /></label>
      <label><input type="checkbox" checked={printForm.controlledCopy} onChange={(e: any) => setPrintForm({ ...printForm, controlledCopy: e.target.checked })} /> Controlled copy</label>
      <label>Copy #<input value={printForm.copyNumber} onChange={(e: any) => setPrintForm({ ...printForm, copyNumber: e.target.value })} /></label>
      <label>Watermark<input value={printForm.watermark} onChange={(e: any) => setPrintForm({ ...printForm, watermark: e.target.value })} /></label>
      <button type="submit">Log print</button>
    </form>

    {doc.status !== 'obsolete' && <div style={{ marginTop: 16 }}>
      <h4>Mark obsolete</h4>
      <label>Reason<input value={obsoleteReason} onChange={(e: any) => setObsoleteReason(e.target.value)} /></label>{' '}
      <button onClick={submitObsolete}>Mark obsolete</button>
    </div>}
  </div>;
}

// ============================================================================
// RECORD CONTROL (SECHPO051 — Control of Records Procedure)
// ============================================================================
function RecordControl({ staff, sections, departments, documents, onError }: { staff: Staff[]; sections: Section[]; departments: Department[]; documents: DocumentRecord[]; onError: (m: string) => void }) {
  const [sub, setSub] = useState('Dashboard');
  const [summary, setSummary] = useState<RecordControlSummary | null>(null);
  const [register, setRegister] = useState<RecordRegisterEntry[]>([]);
  const [schedule, setSchedule] = useState<RetentionScheduleRule[]>([]);
  const [reviewLog, setReviewLog] = useState<RecordReviewLogEntry[]>([]);
  const [destruction, setDestruction] = useState<RecordDestructionEntry[]>([]);
  const [backups, setBackups] = useState<RecordBackupEntry[]>([]);

  const emptyReg = { title: '', recordCategory: 'examination', recordFormat: 'electronic', sectionId: '', responsibleStaffId: '', storageLocation: '', retentionScheduleId: '', retentionPeriod: '', confidentiality: 'internal', linkedDocumentId: '', dateCreated: '', disposalDueDate: '', notes: '' };
  const emptyRev = { reviewDate: '', recordCategory: '', sectionId: '', recordsReviewed: '', findings: '', nonconformitiesIdentified: '', actionRequired: false, responsibleStaffId: '', targetCompletionDate: '', followUpStatus: 'open' };
  const emptyDes = { itemType: 'record', recordRegisterId: '', description: '', recordCategory: '', dateDestroyed: '', method: 'shredding', retentionVerified: false, confidentialityEnsured: true, authorizedByStaffId: '', witnessStaffId: '', notes: '' };
  const emptyBkp = { backupDate: '', backupType: 'incremental', scope: '', storageLocation: '', offsite: false, performedByStaffId: '', integrityVerified: false, restoreTestStatus: '', restoreTestDate: '', notes: '' };
  const [regForm, setRegForm] = useState(emptyReg);
  const [revForm, setRevForm] = useState(emptyRev);
  const [desForm, setDesForm] = useState(emptyDes);
  const [bkpForm, setBkpForm] = useState(emptyBkp);

  async function loadAll() {
    try {
      const [sm, rg, sc, rl, dl, bl] = await Promise.all([
        api<RecordControlSummary>('/documents/records/summary').catch(() => null),
        api<RecordRegisterEntry[]>('/documents/records/register'),
        api<RetentionScheduleRule[]>('/documents/records/retention-schedule'),
        api<RecordReviewLogEntry[]>('/documents/records/review-log'),
        api<RecordDestructionEntry[]>('/documents/records/destruction-log'),
        api<RecordBackupEntry[]>('/documents/records/backup-log'),
      ]);
      if (sm) setSummary(sm);
      setRegister(rg); setSchedule(sc); setReviewLog(rl); setDestruction(dl); setBackups(bl);
    } catch (e) { onError((e as Error).message); }
  }
  useEffect(() => { void loadAll(); }, []);

  async function submit(path: string, body: unknown, reset: () => void) {
    try { await api(`/documents/records/${path}`, { method: 'POST', body: JSON.stringify(body) }); reset(); await loadAll(); }
    catch (e) { onError((e as Error).message); }
  }

  const subs = ['Dashboard', 'Record Register', 'Retention Schedule', 'Review Log', 'Destruction Log', 'Backup & Archive'];
  return <div>
    <p className="muted" style={{ marginTop: 0 }}>Control of Records (SECHPO051) — creation, identification, storage, review, retention and disposal of laboratory records (ISO 15189 §8.4).</p>
    {tabBar(sub, subs, setSub)}

    {sub === 'Dashboard' && summary && <div className="cards">
      <div className="card"><h4>Active records</h4><p className="metric">{summary.activeRecords}</p></div>
      <div className="card"><h4>Archived</h4><p className="metric">{summary.archivedRecords}</p></div>
      <div className="card"><h4>Disposal due</h4><p className="metric">{summary.disposalDue}</p></div>
      <div className="card"><h4>Retention rules</h4><p className="metric">{summary.retentionRules}</p></div>
      <div className="card"><h4>Reviews this month</h4><p className="metric">{summary.reviewsThisMonth}</p></div>
      <div className="card"><h4>Open review actions</h4><p className="metric">{summary.openReviewActions}</p></div>
      <div className="card"><h4>Destructions this year</h4><p className="metric">{summary.destructionsThisYear}</p></div>
      <div className="card"><h4>Backups this month</h4><p className="metric">{summary.backupsThisMonth}</p></div>
      <div className="card"><h4>Failed restore tests</h4><p className="metric">{summary.failedRestoreTests}</p></div>
    </div>}

    {sub === 'Record Register' && <>
      <table className="data-table"><thead><tr><th>Code</th><th>Title</th><th>Category</th><th>Format</th><th>Section</th><th>Responsible</th><th>Retention</th><th>Confidentiality</th><th>Status</th></tr></thead><tbody>
        {register.map(r => <tr key={r.id}>
          <td>{r.record_code || '—'}</td><td>{r.title}</td><td>{(r.record_category || '—').replace(/_/g, ' ')}</td><td>{r.record_format}</td>
          <td>{r.section_name || '—'}</td><td>{r.responsible_name || '—'}</td><td>{r.retention_period || '—'}</td><td>{formatBadge(r.confidentiality)}</td><td>{formatBadge(r.status)}</td>
        </tr>)}{register.length === 0 && <tr><td colSpan={9} className="muted">No records registered yet.</td></tr>}
      </tbody></table>
      <h4>Register a controlled record</h4>
      <form className="form-grid" onSubmit={e => { e.preventDefault(); submit('register', regForm, () => setRegForm(emptyReg)); }}>
        <label>Title<input value={regForm.title} onChange={e => setRegForm({ ...regForm, title: e.target.value })} required /></label>
        <label>Category<select value={regForm.recordCategory} onChange={e => setRegForm({ ...regForm, recordCategory: e.target.value })}>{RECORD_CATEGORIES.map(c => <option key={c} value={c}>{c.replace(/_/g, ' ')}</option>)}</select></label>
        <label>Format<select value={regForm.recordFormat} onChange={e => setRegForm({ ...regForm, recordFormat: e.target.value })}>{RECORD_FORMATS.map(f => <option key={f} value={f}>{f}</option>)}</select></label>
        <label>Section<select value={regForm.sectionId} onChange={e => setRegForm({ ...regForm, sectionId: e.target.value })}><option value="">—</option>{sections.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
        <label>Responsible person<select value={regForm.responsibleStaffId} onChange={e => setRegForm({ ...regForm, responsibleStaffId: e.target.value })}><option value="">—</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label>
        <label>Retention rule<select value={regForm.retentionScheduleId} onChange={e => { const r = schedule.find(x => String(x.id) === e.target.value); setRegForm({ ...regForm, retentionScheduleId: e.target.value, retentionPeriod: r?.retention_period || regForm.retentionPeriod }); }}><option value="">—</option>{schedule.map(s => <option key={s.id} value={s.id}>{s.record_type} ({s.retention_period})</option>)}</select></label>
        <label>Retention period<input value={regForm.retentionPeriod} onChange={e => setRegForm({ ...regForm, retentionPeriod: e.target.value })} placeholder="e.g. 5 years" /></label>
        <label>Storage location<input value={regForm.storageLocation} onChange={e => setRegForm({ ...regForm, storageLocation: e.target.value })} /></label>
        <label>Confidentiality<select value={regForm.confidentiality} onChange={e => setRegForm({ ...regForm, confidentiality: e.target.value })}>{CONFIDENTIALITY.map(c => <option key={c} value={c}>{c}</option>)}</select></label>
        <label>Linked document<select value={regForm.linkedDocumentId} onChange={e => setRegForm({ ...regForm, linkedDocumentId: e.target.value })}><option value="">—</option>{documents.map(d => <option key={d.id} value={d.id}>{d.document_code || ''} {d.title}</option>)}</select></label>
        <label>Date created<input type="date" value={regForm.dateCreated} onChange={e => setRegForm({ ...regForm, dateCreated: e.target.value })} /></label>
        <label>Disposal due date<input type="date" value={regForm.disposalDueDate} onChange={e => setRegForm({ ...regForm, disposalDueDate: e.target.value })} /></label>
        <label>Notes<input value={regForm.notes} onChange={e => setRegForm({ ...regForm, notes: e.target.value })} /></label>
        <button type="submit">Add record</button>
      </form>
    </>}

    {sub === 'Retention Schedule' && <>
      <p className="muted">Record retention schedule (SECHPO051 Appendix A), GHS / legally aligned. Seeded with the laboratory's standard retention periods.</p>
      <table className="data-table"><thead><tr><th>S/N</th><th>Record type</th><th>Retention period</th><th>Storage medium</th><th>Responsible</th><th>Extended</th></tr></thead><tbody>
        {schedule.map(s => <tr key={s.id}><td>{s.sn ?? '—'}</td><td>{s.record_type}</td><td>{s.retention_period}</td><td>{s.storage_medium || '—'}</td><td>{s.responsible_role || '—'}</td><td>{s.extended_retention ? 'Yes' : '—'}</td></tr>)}
      </tbody></table>
      <h4>Add a retention rule</h4>
      <form className="form-grid" onSubmit={e => { e.preventDefault(); const f = e.currentTarget as any; submit('retention-schedule', { recordType: f.recordType.value, retentionPeriod: f.retentionPeriod.value, storageMedium: f.storageMedium.value, responsibleRole: f.responsibleRole.value, extendedRetention: f.extendedRetention.checked }, () => f.reset()); }}>
        <label>Record type<input name="recordType" required /></label>
        <label>Retention period<input name="retentionPeriod" required placeholder="e.g. 5 years" /></label>
        <label>Storage medium<input name="storageMedium" placeholder="Paper / Electronic" /></label>
        <label>Responsible role<input name="responsibleRole" placeholder="e.g. Quality Manager" /></label>
        <label><input type="checkbox" name="extendedRetention" /> Extended retention (high-risk)</label>
        <button type="submit">Add rule</button>
      </form>
    </>}

    {sub === 'Review Log' && <>
      <p className="muted">Quality &amp; Technical Records Review Log (SECHPO051 §5.7) — routine documented review of records.</p>
      <table className="data-table"><thead><tr><th>No.</th><th>Date</th><th>Category</th><th>Section</th><th>Findings</th><th>NC</th><th>Action</th><th>Follow-up</th><th>Reviewer</th></tr></thead><tbody>
        {reviewLog.map(r => <tr key={r.id}><td>{r.review_number || '—'}</td><td>{r.review_date}</td><td>{r.record_category}</td><td>{r.section_name || '—'}</td><td>{r.findings || '—'}</td><td>{r.nonconformities_identified || '—'}</td><td>{r.action_required ? 'Yes' : '—'}</td><td>{formatBadge(r.follow_up_status)}</td><td>{r.reviewer_name || '—'}</td></tr>)}
        {reviewLog.length === 0 && <tr><td colSpan={9} className="muted">No reviews logged.</td></tr>}
      </tbody></table>
      <h4>Record a review</h4>
      <form className="form-grid" onSubmit={e => { e.preventDefault(); submit('review-log', revForm, () => setRevForm(emptyRev)); }}>
        <label>Review date<input type="date" value={revForm.reviewDate} onChange={e => setRevForm({ ...revForm, reviewDate: e.target.value })} required /></label>
        <label>Record category<input value={revForm.recordCategory} onChange={e => setRevForm({ ...revForm, recordCategory: e.target.value })} required placeholder="e.g. Quality control records" /></label>
        <label>Section<select value={revForm.sectionId} onChange={e => setRevForm({ ...revForm, sectionId: e.target.value })}><option value="">—</option>{sections.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
        <label>Records reviewed<input value={revForm.recordsReviewed} onChange={e => setRevForm({ ...revForm, recordsReviewed: e.target.value })} /></label>
        <label>Findings<textarea value={revForm.findings} onChange={e => setRevForm({ ...revForm, findings: e.target.value })} /></label>
        <label>Nonconformities identified<textarea value={revForm.nonconformitiesIdentified} onChange={e => setRevForm({ ...revForm, nonconformitiesIdentified: e.target.value })} /></label>
        <label><input type="checkbox" checked={revForm.actionRequired} onChange={e => setRevForm({ ...revForm, actionRequired: e.target.checked })} /> Action required</label>
        <label>Responsible person<select value={revForm.responsibleStaffId} onChange={e => setRevForm({ ...revForm, responsibleStaffId: e.target.value })}><option value="">—</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label>
        <label>Target completion<input type="date" value={revForm.targetCompletionDate} onChange={e => setRevForm({ ...revForm, targetCompletionDate: e.target.value })} /></label>
        <label>Follow-up status<select value={revForm.followUpStatus} onChange={e => setRevForm({ ...revForm, followUpStatus: e.target.value })}>{FOLLOW_UP_STATUSES.map(s => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}</select></label>
        <button type="submit">Log review</button>
      </form>
    </>}

    {sub === 'Destruction Log' && <>
      <p className="muted">Document &amp; Record Destruction Form (SECHF0047, SECHPO051 §5.6) — authorised disposal of records and documents.</p>
      <table className="data-table"><thead><tr><th>No.</th><th>Type</th><th>Description</th><th>Date destroyed</th><th>Method</th><th>Authorised by</th><th>Witness</th></tr></thead><tbody>
        {destruction.map(d => <tr key={d.id}><td>{d.destruction_number || '—'}</td><td>{d.item_type}</td><td>{d.description}</td><td>{d.date_destroyed}</td><td>{(d.method || '—').replace(/_/g, ' ')}</td><td>{d.authorized_by_name || '—'}</td><td>{d.witness_name || '—'}</td></tr>)}
        {destruction.length === 0 && <tr><td colSpan={7} className="muted">No destructions recorded.</td></tr>}
      </tbody></table>
      <h4>Record a destruction</h4>
      <form className="form-grid" onSubmit={e => { e.preventDefault(); submit('destruction-log', desForm, () => setDesForm(emptyDes)); }}>
        <label>Item type<select value={desForm.itemType} onChange={e => setDesForm({ ...desForm, itemType: e.target.value })}><option value="record">Record</option><option value="document">Document</option></select></label>
        <label>From register (optional)<select value={desForm.recordRegisterId} onChange={e => setDesForm({ ...desForm, recordRegisterId: e.target.value })}><option value="">—</option>{register.map(r => <option key={r.id} value={r.id}>{r.record_code} {r.title}</option>)}</select></label>
        <label>Description<input value={desForm.description} onChange={e => setDesForm({ ...desForm, description: e.target.value })} required /></label>
        <label>Date destroyed<input type="date" value={desForm.dateDestroyed} onChange={e => setDesForm({ ...desForm, dateDestroyed: e.target.value })} required /></label>
        <label>Method<select value={desForm.method} onChange={e => setDesForm({ ...desForm, method: e.target.value })}>{DESTRUCTION_METHODS.map(m => <option key={m} value={m}>{m.replace(/_/g, ' ')}</option>)}</select></label>
        <label>Authorised by<select value={desForm.authorizedByStaffId} onChange={e => setDesForm({ ...desForm, authorizedByStaffId: e.target.value })}><option value="">—</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label>
        <label>Witness<select value={desForm.witnessStaffId} onChange={e => setDesForm({ ...desForm, witnessStaffId: e.target.value })}><option value="">—</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label>
        <label><input type="checkbox" checked={desForm.retentionVerified} onChange={e => setDesForm({ ...desForm, retentionVerified: e.target.checked })} /> Retention period verified expired</label>
        <label><input type="checkbox" checked={desForm.confidentialityEnsured} onChange={e => setDesForm({ ...desForm, confidentialityEnsured: e.target.checked })} /> Confidentiality ensured</label>
        <label>Notes<input value={desForm.notes} onChange={e => setDesForm({ ...desForm, notes: e.target.value })} /></label>
        <button type="submit">Record destruction</button>
      </form>
    </>}

    {sub === 'Backup & Archive' && <>
      <p className="muted">Backup &amp; Archive Log (SECHPO051 §5.4) — electronic record backups, off-site copies, and restoration testing.</p>
      <table className="data-table"><thead><tr><th>No.</th><th>Date</th><th>Type</th><th>Scope</th><th>Location</th><th>Off-site</th><th>Integrity</th><th>Restore test</th></tr></thead><tbody>
        {backups.map(b => <tr key={b.id}><td>{b.backup_number || '—'}</td><td>{b.backup_date}</td><td>{b.backup_type || '—'}</td><td>{b.scope || '—'}</td><td>{b.storage_location || '—'}</td><td>{b.offsite ? 'Yes' : '—'}</td><td>{b.integrity_verified ? 'Verified' : '—'}</td><td>{b.restore_test_status ? formatBadge(b.restore_test_status) : '—'}</td></tr>)}
        {backups.length === 0 && <tr><td colSpan={8} className="muted">No backups logged.</td></tr>}
      </tbody></table>
      <h4>Log a backup</h4>
      <form className="form-grid" onSubmit={e => { e.preventDefault(); submit('backup-log', bkpForm, () => setBkpForm(emptyBkp)); }}>
        <label>Backup date<input type="date" value={bkpForm.backupDate} onChange={e => setBkpForm({ ...bkpForm, backupDate: e.target.value })} required /></label>
        <label>Type<select value={bkpForm.backupType} onChange={e => setBkpForm({ ...bkpForm, backupType: e.target.value })}>{BACKUP_TYPES.map(t => <option key={t} value={t}>{t}</option>)}</select></label>
        <label>Scope<input value={bkpForm.scope} onChange={e => setBkpForm({ ...bkpForm, scope: e.target.value })} placeholder="e.g. LHIMS database" /></label>
        <label>Storage location<input value={bkpForm.storageLocation} onChange={e => setBkpForm({ ...bkpForm, storageLocation: e.target.value })} /></label>
        <label>Performed by<select value={bkpForm.performedByStaffId} onChange={e => setBkpForm({ ...bkpForm, performedByStaffId: e.target.value })}><option value="">—</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label>
        <label>Restore test status<select value={bkpForm.restoreTestStatus} onChange={e => setBkpForm({ ...bkpForm, restoreTestStatus: e.target.value })}>{RESTORE_STATUSES.map(s => <option key={s} value={s}>{s ? s.replace(/_/g, ' ') : '—'}</option>)}</select></label>
        <label>Restore test date<input type="date" value={bkpForm.restoreTestDate} onChange={e => setBkpForm({ ...bkpForm, restoreTestDate: e.target.value })} /></label>
        <label><input type="checkbox" checked={bkpForm.offsite} onChange={e => setBkpForm({ ...bkpForm, offsite: e.target.checked })} /> Off-site copy</label>
        <label><input type="checkbox" checked={bkpForm.integrityVerified} onChange={e => setBkpForm({ ...bkpForm, integrityVerified: e.target.checked })} /> Integrity verified</label>
        <label>Notes<input value={bkpForm.notes} onChange={e => setBkpForm({ ...bkpForm, notes: e.target.value })} /></label>
        <button type="submit">Log backup</button>
      </form>
    </>}
  </div>;
}
