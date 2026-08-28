import { useRef, useState } from 'react';
import { AlertTriangle, FileBadge, Loader2, Paperclip, Pencil, Plus, Trash2, Upload, X } from 'lucide-react';
import { api, errorText } from '../../services/api';
import { downloadFileById, isOverdue, titleCase, usePortal } from './portalData';
import { uploadPersonalFile } from './PortalTaskDrawer';
import type { StaffDocument } from '../../../shared/types/api';

/**
 * My documents — the certificates, licences and records on this person's file,
 * and the ones they put there themselves.
 *
 * A staff file used to be something done TO a member of staff: they handed a
 * certificate to somebody in Personnel Management and hoped it was filed. The
 * result was files that were empty for months and a person who renewed a
 * practising licence with nowhere to record it.
 *
 * They can now add to their own file directly, and the line is drawn where it
 * belongs: adding is theirs, verifying is not. Everything uploaded here starts
 * as `pending` and says so, and once Personnel Management has verified it, it
 * becomes evidence and stops being editable from this screen — a verified
 * record whose subject can still quietly change the dates is not evidence of
 * anything. Documents the register placed on the file are read-only here from
 * the start.
 */
const DOC_TYPES = ['CV', 'Qualification', 'Licence', 'Certificate', 'Contract', 'Job description', 'ID', 'Reference', 'Other'];

type DocForm = {
  id?: number;
  documentType: string;
  title: string;
  issueDate: string;
  expiryDate: string;
  remarks: string;
};

const emptyForm: DocForm = { documentType: 'Certificate', title: '', issueDate: '', expiryDate: '', remarks: '' };

/** A document the person added themselves and that nobody has verified yet. */
const isMineToEdit = (d: StaffDocument & { source?: string }) =>
  d.source === 'self' && d.verification_status !== 'verified';

export default function PortalDocuments() {
  const { documents, reload, setError, setNotice } = usePortal();
  const [form, setForm] = useState<DocForm | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const expired = documents.filter(d => isOverdue(d.expiry_date)).length;

  function startAdd() { setForm({ ...emptyForm }); setFile(null); setProblem(null); }
  function startEdit(d: StaffDocument) {
    setForm({
      id: d.id,
      documentType: d.document_type || 'Other',
      title: d.title,
      issueDate: d.issue_date || '',
      expiryDate: d.expiry_date || '',
      remarks: d.remarks || '',
    });
    setFile(null);
    setProblem(null);
  }

  async function save() {
    if (!form) return;
    if (!form.title.trim()) { setProblem('Give the document a title so you can find it later.'); return; }
    setBusy(true); setProblem(null);
    try {
      const fileId = file ? await uploadPersonalFile(file, 'staff_document') : undefined;
      const body = JSON.stringify({
        documentType: form.documentType,
        title: form.title.trim(),
        issueDate: form.issueDate || null,
        expiryDate: form.expiryDate || null,
        remarks: form.remarks.trim() || null,
        fileId,
      });
      if (form.id) await api(`/personnel/my-documents/${form.id}`, { method: 'PUT', body });
      else await api('/personnel/my-documents', { method: 'POST', body });
      await reload();
      setNotice(form.id ? 'Document updated.' : 'Document added to your file. Personnel Management will verify it.');
      setForm(null); setFile(null);
    } catch (e) { setProblem((e as Error).message); }
    finally { setBusy(false); }
  }

  async function remove(d: StaffDocument) {
    if (!window.confirm(`Remove "${d.title}" from your file? This cannot be undone.`)) return;
    try { await api(`/personnel/my-documents/${d.id}`, { method: 'DELETE' }); await reload(); setNotice('Document removed.'); }
    catch (e) { setError(errorText(e)); }
  }

  return (
    <div className="portal-stack">
      <section className="portal-panel">
        <div className="pp-head">
          <div>
            <h3><FileBadge size={16} /> My documents</h3>
            <p>
              Everything on your staff file. Add your own certificates and licences here — Personnel
              Management verifies them, and a verified document is then theirs to change, not yours.
            </p>
          </div>
          <div className="pp-head-actions">
            {documents.length > 0 && <span className={`pp-count${expired ? ' crit' : ''}`}>{documents.length}</span>}
            <button type="button" onClick={startAdd}><Plus size={14} /> Add a document</button>
          </div>
        </div>

        {expired > 0 && (
          <p className="pp-inline-warn">
            <AlertTriangle size={13} /> {expired === 1 ? 'One document has expired' : `${expired} documents have expired`} — upload
            the renewed copy and Personnel Management will verify it.
          </p>
        )}

        {form && (
          <div className="pf-form">
            <div className="pf-form-head">
              <h4>{form.id ? 'Change this document' : 'Add a document to my file'}</h4>
              <button type="button" className="pd-close" onClick={() => setForm(null)} aria-label="Cancel"><X size={16} /></button>
            </div>
            <div className="pf-grid">
              <label>
                <span>Type</span>
                <select value={form.documentType} onChange={e => setForm({ ...form, documentType: e.target.value })}>
                  {DOC_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
              </label>
              <label className="pf-wide">
                <span>Title</span>
                <input value={form.title} onChange={e => setForm({ ...form, title: e.target.value })}
                  placeholder="e.g. BSc Medical Laboratory Science — University of Ghana" />
              </label>
              <label><span>Issued</span><input type="date" value={form.issueDate} onChange={e => setForm({ ...form, issueDate: e.target.value })} /></label>
              <label><span>Expires</span><input type="date" value={form.expiryDate} onChange={e => setForm({ ...form, expiryDate: e.target.value })} /></label>
              <label className="pf-wide"><span>Remarks</span><input value={form.remarks} onChange={e => setForm({ ...form, remarks: e.target.value })} placeholder="Optional" /></label>
              <label className="pf-wide">
                <span>{form.id ? 'Replace the file (optional)' : 'The file'}</span>
                <input ref={fileInput} type="file" accept=".pdf,image/*,.doc,.docx"
                  onChange={e => setFile(e.target.files?.[0] ?? null)} />
                {file && <small className="pd-hint"><Paperclip size={11} /> {file.name}</small>}
              </label>
            </div>
            {problem && <p className="pd-error"><AlertTriangle size={14} /> {problem}</p>}
            <div className="pf-form-foot">
              <button type="button" disabled={busy} onClick={() => void save()}>
                {busy ? <><Loader2 size={14} className="pd-spin" /> Saving…</> : <><Upload size={14} /> {form.id ? 'Save changes' : 'Add to my file'}</>}
              </button>
              <button type="button" className="secondary" onClick={() => setForm(null)}>Cancel</button>
            </div>
          </div>
        )}

        {documents.length === 0 ? (
          <p className="muted">No documents are on your file yet. Add your qualifications, licence and certificates above.</p>
        ) : (
          <table className="data-table">
            <thead><tr><th>Type</th><th>Title</th><th>Issued</th><th>Expires</th><th>Status</th><th /></tr></thead>
            <tbody>
              {documents.map(d => {
                const mine = isMineToEdit(d as StaffDocument & { source?: string });
                return (
                  <tr key={d.id}>
                    <td>{titleCase(d.document_type)}</td>
                    <td>
                      {d.title}
                      {(d as { source?: string }).source === 'self' && <div className="muted pr-sub">added by you</div>}
                    </td>
                    <td>{d.issue_date || '—'}</td>
                    <td className={isOverdue(d.expiry_date) ? 'pr-expired' : ''}>{d.expiry_date || 'No expiry'}</td>
                    <td>{d.verification_status ? <span className={`badge ${d.verification_status}`}>{d.verification_status}</span> : '—'}</td>
                    <td className="pr-actions-cell">
                      {d.file_id && (
                        <button type="button" className="link-button"
                          onClick={() => downloadFileById(d.file_id!, d.file_name || d.title).catch(e => setError(errorText(e)))}>
                          Download
                        </button>
                      )}
                      {mine && <button type="button" className="link-button" onClick={() => startEdit(d)}><Pencil size={11} /> Edit</button>}
                      {mine && <button type="button" className="link-button danger" onClick={() => void remove(d)}><Trash2 size={11} /> Remove</button>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
