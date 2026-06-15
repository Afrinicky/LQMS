import { FormEvent, useEffect, useState } from 'react';
import PageHeader from '../components/ui/PageHeader';
import { ChartCard, DonutChart, BarMeter, CHART_COLORS } from '../components/ui';
import { useModules } from '../hooks/useModules';
import { api, API_BASE, getToken } from '../services/api';
import DisabledModule from '../components/DisabledModule';
import type {
  Section, Department, Staff, Position,
  DocumentRecord, DocumentAttestation, DocumentControlSummary, DistributionInboxEntry
} from '../../shared/types/api';

const statusBadgeClass = (status?: string) => `badge ${status ? status.toLowerCase().replace(/\s+/g, '-') : 'unknown'}`;
const formatBadge = (status?: string) => <span className={statusBadgeClass(status)}>{status ? status.replace(/_/g, ' ') : 'Unknown'}</span>;
const tabBar = (active: string, tabs: string[], onChange: (name: string) => void) =>
  <div className="tabs">{tabs.map(name => <button key={name} type="button" className={active === name ? 'active' : ''} onClick={() => onChange(name)}>{name}</button>)}</div>;

const DOCUMENT_TYPES = ['SOP', 'Policy', 'Manual', 'Form', 'Register', 'Log', 'Tracker', 'Job Aid', 'Other'];
const ACCESS_LEVELS = ['public', 'internal', 'restricted', 'confidential'];
const REVIEW_OUTCOMES = ['no_change', 'minor_revision', 'major_revision', 'obsolete'];
const TARGET_TYPES = ['staff', 'position', 'section', 'department'];

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

const emptyDocForm = { documentCode: '', title: '', documentType: 'SOP', departmentId: '', sectionId: '', ownerStaffId: '', reviewFrequencyMonths: '12', nextReviewDate: '', accessLevel: 'internal', isControlled: true, fileId: '', versionNumber: '1.0', revisionSummary: '', effectiveDate: '' };
const emptyVersionForm = { versionNumber: '', revisionSummary: '', fileId: '', effectiveDate: '' };
const emptyReviewForm = { reviewDate: '', reviewOutcome: 'no_change', reviewNotes: '', nextReviewDate: '', actionRequired: false };
const emptyAttestForm = { targetType: 'staff', staffIds: [] as number[], positionId: '', sectionId: '', departmentId: '', dueDate: '', notes: '' };
const emptyPrintForm = { printPurpose: '', controlledCopy: false, copyNumber: '', watermark: '' };

export function DocumentControlPage() {
  const { isEnabled } = useModules();
  const { staff, sections, departments, positions } = useLookups();
  const [tab, setTab] = useState('Dashboard');
  const [error, setError] = useState<string | null>(null);

  const [summary, setSummary] = useState<DocumentControlSummary | null>(null);
  const [documents, setDocuments] = useState<DocumentRecord[]>([]);
  const [reviewsDue, setReviewsDue] = useState<DocumentRecord[]>([]);
  const [pendingAttestations, setPendingAttestations] = useState<DocumentAttestation[]>([]);
  const [inbox, setInbox] = useState<DistributionInboxEntry[]>([]);
  const [selectedDoc, setSelectedDoc] = useState<DocumentRecord | null>(null);

  const [docForm, setDocForm] = useState(emptyDocForm);
  const [versionForm, setVersionForm] = useState(emptyVersionForm);
  const [reviewForm, setReviewForm] = useState(emptyReviewForm);
  const [attestForm, setAttestForm] = useState(emptyAttestForm);
  const [printForm, setPrintForm] = useState(emptyPrintForm);
  const [obsoleteReason, setObsoleteReason] = useState('');
  const [newDocFile, setNewDocFile] = useState<File | null>(null);
  const [versionFile, setVersionFile] = useState<File | null>(null);

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

  async function submitDoc(e: FormEvent) {
    e.preventDefault(); setError(null);
    try {
      const uploadedFileId = await uploadFileIfAny(newDocFile);
      const payload = { ...docForm, fileId: uploadedFileId ?? docForm.fileId };
      await api('/documents', { method: 'POST', body: JSON.stringify(payload) });
      setDocForm(emptyDocForm); setNewDocFile(null);
      await load(); setTab('Document Register');
    } catch (e) { setError((e as Error).message); }
  }

  async function openDoc(id: number) {
    try { setSelectedDoc(await api<DocumentRecord>(`/documents/${id}`)); }
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

  async function signAttestation(attestationId: number, documentId: number) {
    try {
      await api(`/documents/${documentId}/attest`, { method: 'POST', body: JSON.stringify({ attestationId }) });
      await load(); if (selectedDoc?.id === documentId) await openDoc(documentId);
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
    try { await api(`/documents/${selectedDoc.id}/submit-review`, { method: 'POST', body: JSON.stringify({}) }); await openDoc(selectedDoc.id); await load(); }
    catch (e) { setError((e as Error).message); }
  }

  async function approveDoc() {
    if (!selectedDoc) return;
    try { await api(`/documents/${selectedDoc.id}/approve`, { method: 'POST', body: JSON.stringify({}) }); await openDoc(selectedDoc.id); await load(); }
    catch (e) { setError((e as Error).message); }
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

  const tabs = ['Dashboard', 'Document Register', 'New Document', 'Versions', 'Reviews Due', 'Pending Attestations', 'My Inbox', 'Print Logs', 'Obsolete Documents', 'Reports'];
  const obsoleteDocs = documents.filter(d => d.status === 'obsolete');

  return <div className="module-page">
    <PageHeader eyebrow="Documents &amp; SOPs" title="Document Control" subtitle="Controlled documents, versions, reviews, and attestations." />
    {tabBar(tab, tabs, setTab)}
    {error && <div className="error">{error}</div>}

    {tab === 'Dashboard' && (summary ? <div className="cards">
      <div className="card"><h4>Current documents</h4><p className="metric">{summary.currentDocuments}</p></div>
      <div className="card"><h4>Drafts</h4><p className="metric">{summary.drafts}</p></div>
      <div className="card"><h4>Due review (30d)</h4><p className="metric">{summary.dueReviews}</p></div>
      <div className="card"><h4>Overdue reviews</h4><p className="metric">{summary.overdueReviews}</p></div>
      <div className="card"><h4>Pending attestations</h4><p className="metric">{summary.pendingAttestations}</p></div>
      <div className="card"><h4>Obsolete documents</h4><p className="metric">{summary.obsoleteDocuments}</p></div>
    </div> : <p>Loading summary…</p>)}
    {tab === 'Dashboard' && summary && <div className="grid cols-2" style={{ marginTop: 18 }}>
      <ChartCard title="Document lifecycle" subtitle="Controlled set by current state">
        <DonutChart centerLabel="Documents" data={[
          { label: 'Current', value: summary.currentDocuments, color: CHART_COLORS[1] },
          { label: 'Drafts', value: summary.drafts, color: CHART_COLORS[0] },
          { label: 'Obsolete', value: summary.obsoleteDocuments, color: CHART_COLORS[7] },
        ]} />
      </ChartCard>
      <ChartCard title="Review & attestation load" subtitle="Outstanding controlled-document actions">
        <BarMeter data={[
          { label: 'Due review (30d)', value: summary.dueReviews, color: CHART_COLORS[2] },
          { label: 'Overdue reviews', value: summary.overdueReviews, color: CHART_COLORS[3] },
          { label: 'Pending attestations', value: summary.pendingAttestations, color: CHART_COLORS[4] },
        ]} />
      </ChartCard>
    </div>}

    {tab === 'Document Register' && <>
      <table className="data-table"><thead><tr><th>Code</th><th>Title</th><th>Type</th><th>Section</th><th>Owner</th><th>Status</th><th>Next review</th><th>Actions</th></tr></thead><tbody>
        {documents.filter(d => d.status !== 'obsolete').map(d => <tr key={d.id}>
          <td>{d.document_code || '—'}</td><td>{d.title}</td><td>{d.document_type || '—'}</td>
          <td>{sections.find(s => s.id === d.section_id)?.name || '—'}</td>
          <td>{staffName(staff, d.owner_staff_id)}</td>
          <td>{formatBadge(d.status)}</td><td>{d.next_review_date || '—'}</td>
          <td><button onClick={() => openDoc(d.id)}>Open</button></td>
        </tr>)}
      </tbody></table>
      {selectedDoc && <DocumentDetailPanel doc={selectedDoc} staff={staff} positions={positions} sections={sections} departments={departments}
        versionForm={versionForm} setVersionForm={setVersionForm} versionFile={versionFile} setVersionFile={setVersionFile} submitVersion={submitVersion}
        reviewForm={reviewForm} setReviewForm={setReviewForm} submitReview={submitReview}
        attestForm={attestForm} setAttestForm={setAttestForm} submitAttest={submitAttest}
        printForm={printForm} setPrintForm={setPrintForm} submitPrint={submitPrint}
        obsoleteReason={obsoleteReason} setObsoleteReason={setObsoleteReason} submitObsolete={submitDoc_obsolete}
        submitForReview={submitForReview} approveDoc={approveDoc}
        onSignAttestation={signAttestation} onMarkVersionObsolete={markVersionObsolete} onPrintPreview={openPrintPreview}
        onClose={() => setSelectedDoc(null)} />}
    </>}

    {tab === 'New Document' && <form className="form-grid" onSubmit={submitDoc}>
      <label>Document code<input value={docForm.documentCode} onChange={e => setDocForm({ ...docForm, documentCode: e.target.value })} required placeholder="e.g. SOP-HEM-001" /></label>
      <label>Title<input value={docForm.title} onChange={e => setDocForm({ ...docForm, title: e.target.value })} required /></label>
      <label>Document type<select value={docForm.documentType} onChange={e => setDocForm({ ...docForm, documentType: e.target.value })} required>{DOCUMENT_TYPES.map(t => <option key={t} value={t}>{t}</option>)}</select></label>
      <label>Department<select value={docForm.departmentId} onChange={e => setDocForm({ ...docForm, departmentId: e.target.value })}><option value="">—</option>{departments.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label>
      <label>Section<select value={docForm.sectionId} onChange={e => setDocForm({ ...docForm, sectionId: e.target.value })}><option value="">—</option>{sections.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
      <label>Owner staff<select value={docForm.ownerStaffId} onChange={e => setDocForm({ ...docForm, ownerStaffId: e.target.value })}><option value="">—</option>{staff.map(s => <option key={s.id} value={s.id}>{s.fullName}</option>)}</select></label>
      <label>Review frequency (months)<input type="number" min={1} value={docForm.reviewFrequencyMonths} onChange={e => setDocForm({ ...docForm, reviewFrequencyMonths: e.target.value })} /></label>
      <label>Next review date<input type="date" value={docForm.nextReviewDate} onChange={e => setDocForm({ ...docForm, nextReviewDate: e.target.value })} /></label>
      <label>Access level<select value={docForm.accessLevel} onChange={e => setDocForm({ ...docForm, accessLevel: e.target.value })}>{ACCESS_LEVELS.map(a => <option key={a} value={a}>{a}</option>)}</select></label>
      <label><input type="checkbox" checked={docForm.isControlled} onChange={e => setDocForm({ ...docForm, isControlled: e.target.checked })} /> Controlled document</label>
      <label>Initial version number<input value={docForm.versionNumber} onChange={e => setDocForm({ ...docForm, versionNumber: e.target.value })} /></label>
      <label>Revision summary<input value={docForm.revisionSummary} onChange={e => setDocForm({ ...docForm, revisionSummary: e.target.value })} /></label>
      <label>Effective date<input type="date" value={docForm.effectiveDate} onChange={e => setDocForm({ ...docForm, effectiveDate: e.target.value })} /></label>
      <label>File upload (optional)<input type="file" onChange={e => setNewDocFile(e.target.files?.[0] ?? null)} /></label>
      <button type="submit">Create document</button>
    </form>}

    {tab === 'Versions' && <>
      <p>Open a document from the register to view, add, approve, or mark its versions obsolete.</p>
      <table className="data-table"><thead><tr><th>Code</th><th>Title</th><th>Current version</th><th>Status</th><th></th></tr></thead><tbody>
        {documents.map(d => <tr key={d.id}>
          <td>{d.document_code || '—'}</td><td>{d.title}</td>
          <td>{d.versions?.find(v => v.id === d.current_version_id)?.version_number || (d.current_version_id ? `#${d.current_version_id}` : '—')}</td>
          <td>{formatBadge(d.status)}</td>
          <td><button onClick={() => { openDoc(d.id); setTab('Document Register'); }}>Open</button></td>
        </tr>)}
      </tbody></table>
    </>}

    {tab === 'Reviews Due' && <table className="data-table"><thead><tr><th>Code</th><th>Title</th><th>Type</th><th>Owner</th><th>Status</th><th>Next review</th><th></th></tr></thead><tbody>
      {reviewsDue.map(d => <tr key={d.id}>
        <td>{d.document_code || '—'}</td><td>{d.title}</td><td>{d.document_type || '—'}</td>
        <td>{staffName(staff, d.owner_staff_id)}</td><td>{formatBadge(d.status)}</td>
        <td>{d.next_review_date || '—'}</td>
        <td><button onClick={() => { openDoc(d.id); setTab('Document Register'); }}>Open</button></td>
      </tr>)}
    </tbody></table>}

    {tab === 'Pending Attestations' && <table className="data-table"><thead><tr><th>Document</th><th>Version</th><th>Staff</th><th>Status</th><th>Due</th><th></th></tr></thead><tbody>
      {pendingAttestations.map(a => <tr key={a.id}>
        <td>{a.document_code || '—'} — {a.title}</td>
        <td>{a.version_number || '—'}</td>
        <td>{a.staff_name || staffName(staff, a.staff_id)}</td>
        <td>{formatBadge(a.status)}</td><td>{a.due_date || '—'}</td>
        <td><button onClick={() => signAttestation(a.id, a.document_id!)}>Sign</button></td>
      </tr>)}
    </tbody></table>}

    {tab === 'My Inbox' && <>
      <p>Controlled documents distributed to your staff record. Sign each attestation as you read the document.</p>
      <table className="data-table"><thead><tr><th>Document</th><th>Version</th><th>Distribution status</th><th>Attestation status</th><th>Due</th><th>Signed</th><th>Actions</th></tr></thead><tbody>
        {inbox.map(e => <tr key={e.id}>
          <td>{e.document_code || '—'} — {e.title}</td>
          <td>{e.version_number || '—'}</td>
          <td>{formatBadge(e.status)}</td>
          <td>{formatBadge(e.attestation_status)}</td>
          <td>{e.due_date || e.attestation_due || '—'}</td>
          <td>{e.attested_at || '—'}</td>
          <td>
            <button onClick={() => openDoc(e.document_id)}>Open</button>
            {e.attestation_id && e.attestation_status !== 'signed' && <button onClick={() => signAttestation(e.attestation_id!, e.document_id)}>Sign</button>}
          </td>
        </tr>)}
      </tbody></table>
      {inbox.length === 0 && <p>Your inbox is empty.</p>}
    </>}

    {tab === 'Print Logs' && <p>Print logs are recorded per document. Open a document from the register, click <em>Print preview</em> to render a watermarked cover sheet, then use the <em>Log print</em> form to capture the print event in the audit trail.</p>}

    {tab === 'Obsolete Documents' && <table className="data-table"><thead><tr><th>Code</th><th>Title</th><th>Type</th><th>Reason</th><th></th></tr></thead><tbody>
      {obsoleteDocs.map(d => <tr key={d.id}>
        <td>{d.document_code || '—'}</td><td>{d.title}</td><td>{d.document_type || '—'}</td>
        <td>{d.obsolete_reason || '—'}</td>
        <td><button onClick={() => { openDoc(d.id); setTab('Document Register'); }}>Open</button></td>
      </tr>)}
    </tbody></table>}

    {tab === 'Reports' && <p>Document control reports (attestation completion rate, review compliance over time, print log audit) will be added in a later phase.</p>}
  </div>;
}

function DocumentDetailPanel(props: any) {
  const { doc, staff, positions, sections, departments,
    versionForm, setVersionForm, versionFile, setVersionFile, submitVersion,
    reviewForm, setReviewForm, submitReview,
    attestForm, setAttestForm, submitAttest,
    printForm, setPrintForm, submitPrint,
    obsoleteReason, setObsoleteReason, submitObsolete,
    submitForReview, approveDoc, onSignAttestation, onMarkVersionObsolete, onPrintPreview, onClose } = props;
  return <div className="card" style={{ marginTop: 16 }}>
    <h3>{doc.document_code || '—'} — {doc.title}</h3>
    <p>Type: {doc.document_type || '—'} | Status: {formatBadge(doc.status)} | Access: {doc.access_level || '—'} | Controlled: {doc.is_controlled ? 'Yes' : 'No'}</p>
    <p>Owner: {staffName(staff, doc.owner_staff_id)} | Section: {sections.find((s: any) => s.id === doc.section_id)?.name || '—'} | Next review: {doc.next_review_date || '—'}</p>

    <div style={{ marginTop: 8 }}>
      {doc.status === 'draft' && <button onClick={submitForReview}>Submit for review</button>}
      {(doc.status === 'under_review' || doc.status === 'draft' || doc.status === 'approved') && <button onClick={approveDoc}>Approve current version</button>}
      <button onClick={() => onPrintPreview(doc.current_version_id)}>Print preview</button>
      <button className="secondary" onClick={onClose}>Close panel</button>
    </div>

    <h4>Versions</h4>
    <table className="data-table"><thead><tr><th>Version</th><th>Status</th><th>Effective</th><th>Approved</th><th>Summary</th><th>Actions</th></tr></thead><tbody>
      {(doc.versions || []).map((v: any) => <tr key={v.id}>
        <td>{v.version_number || v.version_label}{doc.current_version_id === v.id ? ' (current)' : ''}</td>
        <td>{formatBadge(v.status)}</td><td>{v.effective_date || '—'}</td><td>{v.approved_at || '—'}</td><td>{v.revision_summary || '—'}</td>
        <td>
          <button onClick={() => onPrintPreview(v.id)}>Print preview</button>
          {v.status !== 'obsolete' && <button onClick={() => onMarkVersionObsolete(v.id)}>Mark obsolete</button>}
        </td>
      </tr>)}
    </tbody></table>
    <form className="form-grid" onSubmit={submitVersion}>
      <label>New version number<input value={versionForm.versionNumber} onChange={(e: any) => setVersionForm({ ...versionForm, versionNumber: e.target.value })} required /></label>
      <label>Revision summary<input value={versionForm.revisionSummary} onChange={(e: any) => setVersionForm({ ...versionForm, revisionSummary: e.target.value })} /></label>
      <label>Effective date<input type="date" value={versionForm.effectiveDate} onChange={(e: any) => setVersionForm({ ...versionForm, effectiveDate: e.target.value })} /></label>
      <label>File<input type="file" onChange={(e: any) => setVersionFile(e.target.files?.[0] ?? null)} /></label>
      <button type="submit">Add version</button>
    </form>

    <h4>Reviews</h4>
    <table className="data-table"><thead><tr><th>Date</th><th>Outcome</th><th>Notes</th><th>Next review</th><th>Reviewer</th></tr></thead><tbody>
      {(doc.reviews || []).map((r: any) => <tr key={r.id}><td>{r.review_date}</td><td>{formatBadge(r.review_outcome)}</td><td>{r.review_notes || '—'}</td><td>{r.next_review_date || '—'}</td><td>{staffName(staff, r.reviewed_by_staff_id)}</td></tr>)}
    </tbody></table>
    <form className="form-grid" onSubmit={submitReview}>
      <label>Review date<input type="date" value={reviewForm.reviewDate} onChange={(e: any) => setReviewForm({ ...reviewForm, reviewDate: e.target.value })} required /></label>
      <label>Outcome<select value={reviewForm.reviewOutcome} onChange={(e: any) => setReviewForm({ ...reviewForm, reviewOutcome: e.target.value })}>{REVIEW_OUTCOMES.map(o => <option key={o} value={o}>{o.replace(/_/g, ' ')}</option>)}</select></label>
      <label>Notes<textarea value={reviewForm.reviewNotes} onChange={(e: any) => setReviewForm({ ...reviewForm, reviewNotes: e.target.value })} /></label>
      <label>Next review date<input type="date" value={reviewForm.nextReviewDate} onChange={(e: any) => setReviewForm({ ...reviewForm, nextReviewDate: e.target.value })} /></label>
      <label><input type="checkbox" checked={reviewForm.actionRequired} onChange={(e: any) => setReviewForm({ ...reviewForm, actionRequired: e.target.checked })} /> Action required</label>
      <button type="submit">Record review</button>
    </form>

    <h4>Attestations</h4>
    <table className="data-table"><thead><tr><th>Staff</th><th>Version</th><th>Status</th><th>Due</th><th>Signed</th><th></th></tr></thead><tbody>
      {(doc.attestations || []).map((a: any) => <tr key={a.id}><td>{a.staff_name || staffName(staff, a.staff_id)}</td><td>{a.version_number || '—'}</td><td>{formatBadge(a.status)}</td><td>{a.due_date || '—'}</td><td>{a.attested_at || '—'}</td><td>{a.status !== 'signed' && <button onClick={() => onSignAttestation(a.id, doc.id)}>Sign</button>}</td></tr>)}
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

    {doc.links && doc.links.length > 0 && <>
      <h4>Linked records</h4>
      <ul>{doc.links.map((l: any) => <li key={l.id}>{l.source_module_key}/{l.source_record_type}#{l.source_record_id} → {l.target_module_key}/{l.target_record_type}#{l.target_record_id}{l.notes ? ` — ${l.notes}` : ''}</li>)}</ul>
    </>}
  </div>;
}
