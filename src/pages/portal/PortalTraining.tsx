import { useRef, useState } from 'react';
import { AlertTriangle, BookOpenCheck, GraduationCap, Loader2, Paperclip, Pencil, Plus, Target, Trash2, Upload, X } from 'lucide-react';
import { api, errorText } from '../../services/api';
import { downloadFileById, dueTone, titleCase, usePortal } from './portalData';
import { uploadPersonalFile } from './PortalTaskDrawer';
import type { StaffCpdRecord } from '../../../shared/types/api';
import TextField from '../../components/ui/TextField';

/**
 * My training and competency — the evidence that this person is competent to
 * do the work they are rostered to do.
 *
 * Two sources, deliberately shown apart. The laboratory runs training events
 * and competency assessments and owns those records; they are read-only here,
 * because a person marking their own competency assessment complete is exactly
 * what the record exists to prevent.
 *
 * The rest of a career happens outside that register — a weekend course, a
 * webinar, a qualification taken in one's own time — and had nowhere to go, so
 * at appraisal it did not exist. That is what the top panel is for. It is a
 * declaration, and reads as one until Personnel Management verifies it against
 * the certificate.
 */
const CPD_TYPES = [
  { key: 'external_course', label: 'External course' },
  { key: 'conference', label: 'Conference' },
  { key: 'webinar', label: 'Webinar' },
  { key: 'workshop', label: 'Workshop' },
  { key: 'qualification', label: 'Qualification' },
  { key: 'in_house', label: 'In-house session' },
  { key: 'self_study', label: 'Self study' },
  { key: 'other', label: 'Other' },
];

type CpdForm = {
  id?: number;
  title: string; provider: string; trainingType: string;
  startDate: string; endDate: string; hours: string; location: string; description: string;
};

const emptyForm: CpdForm = {
  title: '', provider: '', trainingType: 'external_course',
  startDate: '', endDate: '', hours: '', location: '', description: '',
};

const outcomeTone = (outcome?: string | null) => {
  const o = String(outcome ?? '').toLowerCase();
  if (o.includes('competent') && !o.includes('not')) return 'done';
  if (o.includes('not') || o.includes('fail')) return 'overdue';
  return 'pending';
};

export default function PortalTraining() {
  const { tasks, cpd, reload, setError, setNotice } = usePortal();
  const training = tasks?.upcomingTraining ?? [];
  const competency = tasks?.upcomingCompetency ?? [];

  const [form, setForm] = useState<CpdForm | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const totalHours = cpd.reduce((sum, r) => sum + (Number(r.hours) || 0), 0);

  function startAdd() { setForm({ ...emptyForm }); setFile(null); setProblem(null); }
  function startEdit(r: StaffCpdRecord) {
    setForm({
      id: r.id,
      title: r.title,
      provider: r.provider || '',
      trainingType: r.training_type || 'external_course',
      startDate: r.start_date || '',
      endDate: r.end_date || '',
      hours: r.hours === null || r.hours === undefined ? '' : String(r.hours),
      location: r.location || '',
      description: r.description || '',
    });
    setFile(null); setProblem(null);
  }

  async function save() {
    if (!form) return;
    if (!form.title.trim()) { setProblem('What was the training called?'); return; }
    setBusy(true); setProblem(null);
    try {
      const fileId = file ? await uploadPersonalFile(file, 'cpd_certificate') : undefined;
      const body = JSON.stringify({
        title: form.title.trim(),
        provider: form.provider.trim() || null,
        trainingType: form.trainingType,
        startDate: form.startDate || null,
        endDate: form.endDate || null,
        hours: form.hours === '' ? null : form.hours,
        location: form.location.trim() || null,
        description: form.description.trim() || null,
        fileId,
      });
      if (form.id) await api(`/personnel/my-training/${form.id}`, { method: 'PUT', body });
      else await api('/personnel/my-training', { method: 'POST', body });
      await reload();
      setNotice(form.id ? 'Training record updated.' : 'Training added to your record.');
      setForm(null); setFile(null);
    } catch (e) { setProblem((e as Error).message); }
    finally { setBusy(false); }
  }

  async function remove(r: StaffCpdRecord) {
    if (!window.confirm(`Remove "${r.title}" from your training record?`)) return;
    try { await api(`/personnel/my-training/${r.id}`, { method: 'DELETE' }); await reload(); setNotice('Training record removed.'); }
    catch (e) { setError(errorText(e)); }
  }

  return (
    <div className="portal-stack">
      {/* ---- What I have done, recorded by me ---- */}
      <section className="portal-panel">
        <div className="pp-head">
          <div>
            <h3><BookOpenCheck size={16} /> Training I have done</h3>
            <p>
              Courses, conferences and qualifications you completed outside the laboratory's own
              training register. Attach the certificate and Personnel Management will verify it.
            </p>
          </div>
          <div className="pp-head-actions">
            {cpd.length > 0 && <span className="pp-count">{cpd.length}{totalHours > 0 ? ` · ${totalHours}h` : ''}</span>}
            <button type="button" onClick={startAdd}><Plus size={14} /> Add training</button>
          </div>
        </div>

        {form && (
          <div className="pf-form">
            <div className="pf-form-head">
              <h4>{form.id ? 'Change this record' : 'Add training to my record'}</h4>
              <button type="button" className="pd-close" onClick={() => setForm(null)} aria-label="Cancel"><X size={16} /></button>
            </div>
            <div className="pf-grid">
              <label className="pf-wide">
                <span>What was it called?</span>
                <TextField value={form.title} onValue={nextValue => setForm({ ...form, title: nextValue })}
                  placeholder="e.g. ISO 15189:2022 internal auditor course" />
              </label>
              <label>
                <span>Kind</span>
                <select value={form.trainingType} onChange={e => setForm({ ...form, trainingType: e.target.value })}>
                  {CPD_TYPES.map(t => <option key={t.key} value={t.key}>{t.label}</option>)}
                </select>
              </label>
              <label><span>Who ran it?</span><TextField value={form.provider} onValue={nextValue => setForm({ ...form, provider: nextValue })} placeholder="Provider or institution" /></label>
              <label><span>Started</span><input type="date" value={form.startDate} onChange={e => setForm({ ...form, startDate: e.target.value })} /></label>
              <label><span>Finished</span><input type="date" value={form.endDate} onChange={e => setForm({ ...form, endDate: e.target.value })} /></label>
              <label><span>Hours</span><input type="number" min={0} step="0.5" value={form.hours} onChange={e => setForm({ ...form, hours: e.target.value })} placeholder="e.g. 8" /></label>
              <label><span>Where</span><TextField value={form.location} onValue={nextValue => setForm({ ...form, location: nextValue })} placeholder="Online, Accra, …" /></label>
              <label className="pf-wide">
                <span>What did it cover?</span>
                <TextField as="textarea" rows={3} value={form.description} onValue={nextValue => setForm({ ...form, description: nextValue })}
                  placeholder="A line or two — this is what your appraiser reads." />
              </label>
              <label className="pf-wide">
                <span>{form.id ? 'Replace the certificate (optional)' : 'Certificate (optional)'}</span>
                <input ref={fileInput} type="file" accept=".pdf,image/*,.doc,.docx" onChange={e => setFile(e.target.files?.[0] ?? null)} />
                {file && <small className="pd-hint"><Paperclip size={11} /> {file.name}</small>}
              </label>
            </div>
            {problem && <p className="pd-error"><AlertTriangle size={14} /> {problem}</p>}
            <div className="pf-form-foot">
              <button type="button" disabled={busy} onClick={() => void save()}>
                {busy ? <><Loader2 size={14} className="pd-spin" /> Saving…</> : <><Upload size={14} /> {form.id ? 'Save changes' : 'Add to my record'}</>}
              </button>
              <button type="button" className="secondary" onClick={() => setForm(null)}>Cancel</button>
            </div>
          </div>
        )}

        {cpd.length === 0 ? (
          <p className="muted">Nothing recorded yet. Anything you have done that the laboratory did not run belongs here.</p>
        ) : (
          <table className="data-table">
            <thead><tr><th>When</th><th>Training</th><th>Kind</th><th>Hours</th><th>Status</th><th /></tr></thead>
            <tbody>
              {cpd.map(r => {
                const editable = r.verification_status !== 'verified';
                return (
                  <tr key={r.id}>
                    <td>{r.end_date || r.start_date || '—'}</td>
                    <td>
                      {r.title}
                      <div className="muted pr-sub">{[r.provider, r.location].filter(Boolean).join(' · ') || '—'}</div>
                    </td>
                    <td>{CPD_TYPES.find(t => t.key === r.training_type)?.label ?? titleCase(r.training_type)}</td>
                    <td>{r.hours ?? '—'}</td>
                    <td>
                      <span className={`badge ${r.verification_status === 'verified' ? 'verified' : 'pending'}`}>
                        {r.verification_status === 'verified' ? 'verified' : 'declared'}
                      </span>
                      {r.verified_by_name && <div className="muted pr-sub">by {r.verified_by_name}</div>}
                    </td>
                    <td className="pr-actions-cell">
                      {r.file_id && (
                        <button type="button" className="link-button"
                          onClick={() => downloadFileById(r.file_id!, r.file_name || r.title).catch(e => setError(errorText(e)))}>
                          Certificate
                        </button>
                      )}
                      {editable && <button type="button" className="link-button" onClick={() => startEdit(r)}><Pencil size={11} /> Edit</button>}
                      {editable && <button type="button" className="link-button danger" onClick={() => void remove(r)}><Trash2 size={11} /> Remove</button>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      {/* ---- What the laboratory has scheduled for me ---- */}
      <section className="portal-panel">
        <div className="pp-head">
          <div>
            <h3><GraduationCap size={16} /> Training booked for me</h3>
            <p>Events the laboratory has scheduled. Attendance is recorded against your file by whoever runs them.</p>
          </div>
          {training.length > 0 && <span className="pp-count">{training.length}</span>}
        </div>
        {training.length === 0 ? (
          <p className="muted">No training is scheduled for you.</p>
        ) : (
          <table className="data-table">
            <thead><tr><th>Date</th><th>Training</th><th>Type</th><th>Where</th><th>My attendance</th></tr></thead>
            <tbody>
              {training.map(t => {
                const due = dueTone(t.training_date);
                return (
                  <tr key={t.id}>
                    <td>{t.training_date}{due && <div className={`pr-sub ${due.tone}`}>{due.text}</div>}</td>
                    <td>{t.title}<div className="muted pr-sub">{t.training_number}</div></td>
                    <td>{titleCase(t.training_type)}</td>
                    <td>{t.location || '—'}</td>
                    <td><span className="badge">{titleCase(t.attendance_status) || 'Invited'}</span></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      <section className="portal-panel">
        <div className="pp-head">
          <div>
            <h3><Target size={16} /> My competency assessments</h3>
            <p>Assessments planned or under way for you, and who is assessing. Only your assessor can record the outcome.</p>
          </div>
          {competency.length > 0 && <span className="pp-count">{competency.length}</span>}
        </div>
        {competency.length === 0 ? (
          <p className="muted">No competency assessment is planned for you.</p>
        ) : (
          <table className="data-table">
            <thead><tr><th>Due</th><th>Activity</th><th>Method</th><th>Assessor</th><th>Status</th><th>Outcome</th></tr></thead>
            <tbody>
              {competency.map(c => {
                const due = dueTone(c.assessment_date);
                return (
                  <tr key={c.id}>
                    <td>{c.assessment_date}{due && <div className={`pr-sub ${due.tone}`}>{due.text}</div>}</td>
                    <td>{c.activity}<div className="muted pr-sub">{c.competency_number}</div></td>
                    <td>{titleCase(c.assessment_method)}</td>
                    <td>{c.assessor_name || '—'}</td>
                    <td><span className="badge">{titleCase(c.status)}</span></td>
                    <td>{c.outcome ? <span className={`badge ${outcomeTone(c.outcome)}`}>{c.outcome}</span> : '—'}</td>
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
