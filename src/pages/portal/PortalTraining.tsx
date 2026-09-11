import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle, BookOpenCheck, CalendarClock, CheckCircle2, Cpu, ExternalLink, GraduationCap,
  Loader2, Lock, Paperclip, Pencil, PenLine, Plus, Printer, Repeat, Target, Trash2, Upload, X, XCircle,
} from 'lucide-react';
import { api, errorText } from '../../services/api';
import { openPrintable } from '../../services/xlsx';
import { downloadFileById, dueTone, titleCase, usePortal } from './portalData';
import { uploadPersonalFile } from './PortalTaskDrawer';
import type { StaffCpdRecord } from '../../../shared/types/api';
import TextField from '../../components/ui/TextField';
import TrainingRecordPanel from '../../components/training/TrainingRecordPanel';
import {
  trainerDisplayName, trainingIsLocked, attendedInPerson, recurrenceSummary,
  TRAINING_STATUS_LABELS, TRAINING_STATUS_TONES, TRAINING_CATEGORY_LABELS,
  ATTENDANCE_STATUS_LABELS, TRAINING_OUTCOME_LABELS, TRAINING_OUTCOME_TONES,
} from '../../../shared/constants/training';

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
  title: string; provider: string; trainerName: string; trainingType: string;
  startDate: string; endDate: string; hours: string; location: string; description: string;
};

const emptyForm: CpdForm = {
  title: '', provider: '', trainerName: '', trainingType: 'external_course',
  startDate: '', endDate: '', hours: '', location: '', description: '',
};

const outcomeTone = (outcome?: string | null) => {
  const o = String(outcome ?? '').toLowerCase();
  if (o.includes('competent') && !o.includes('not')) return 'done';
  if (o.includes('not') || o.includes('fail')) return 'overdue';
  return 'pending';
};

/** One row of my own training, as the portal needs to act on it. */
type MySession = {
  id: number; training_number: string; title: string; description: string | null;
  category: string | null; training_format: string | null; delivery_mode: string;
  trainer_type: string; trainer_name: string | null;
  external_trainer_name: string | null; external_trainer_organisation: string | null;
  provider: string | null; objectives: string | null;
  training_date: string; end_date: string | null; start_time: string | null; end_time: string | null;
  duration_hours: number | null; location: string | null; status: string; training_mode: string;
  frequency: string; frequency_interval_days: number | null;
  postponed_from_date: string | null; postponement_reason: string | null; cancellation_reason: string | null;
  remedial_for_event_id: number | null; closed_at: string | null;
  section_name: string | null; equipment_name: string | null; equipment_number: string | null;
  attendance_id: number; attendance_status: string; outcome: string | null; hours: number | null;
  signed_at: string | null; sheet_designation: string | null; remarks: string | null;
};

type MySessions = { sessions: MySession[]; awaitingSignature: number; hasSignatureOnFile: boolean };

export default function PortalTraining() {
  const { tasks, cpd, reload, setError, setNotice } = usePortal();
  const competency = tasks?.upcomingCompetency ?? [];

  /* My own sessions, with everything needed to act on them.
     The portal used to show only a read-only list of what had been booked, so
     the two things a member of staff actually needs to do about training —
     signing the attendance sheet, and printing the report for a session they
     attended — were impossible from here. */
  const [mine, setMine] = useState<MySessions | null>(null);
  const loadMine = useCallback(async () => {
    try { setMine(await api<MySessions>('/personnel/my-training-sessions')); }
    catch { setMine({ sessions: [], awaitingSignature: 0, hasSignatureOnFile: false }); }
  }, []);
  useEffect(() => { void loadMine(); }, [loadMine]);

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
      trainerName: r.trainer_name || '',
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
        trainerName: form.trainerName.trim() || null,
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
      {/* ---- Everything, wherever it was recorded ----
          Training given on an instrument and entered in Equipment Management is
          this person's training and was previously invisible to them; it is
          here now, alongside the sessions the laboratory booked and the courses
          they entered themselves. */}
      <TrainingRecordPanel title="My whole training file" />

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
              {/* You know who taught it. There was nowhere to say so, which
                  meant the one kind of record that always has a real outside
                  trainer behind it was also the one that could not name them. */}
              <label><span>Who taught it?</span><TextField value={form.trainerName} onValue={nextValue => setForm({ ...form, trainerName: nextValue })} placeholder="The trainer's name, if you have it" /></label>
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

      {/* ---- My sessions: what is coming, and what I owe a signature to ---- */}
      <MyTrainingSessions data={mine} onChanged={async () => { await loadMine(); await reload(); }}
        setError={setError} setNotice={setNotice} />

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

/* ============================================================================
   My training sessions
   ----------------------------------------------------------------------------
   WHAT THIS FIXES. The portal could show a member of staff a list of training
   that had been booked for them, and nothing else — so the two things they
   actually have to do about training could not be done here at all:

     SIGN THE ATTENDANCE SHEET. Training sessions are signed for, like every
     other sheet in this laboratory. The sheet went round on paper and somebody
     typed the result in, which means the system held a claim that a person
     attended with nothing from that person behind it. They sign it themselves
     now, with the signature on their own record, and the meaning of what they
     are signing is stated above the button.

     HAVE THE EVIDENCE. A closed session is this person's training record, and
     somebody asked at interview or at registration renewal for proof of it had
     to go and ask Personnel Management to print it. They can print the report
     for any session they attended.

   And a session that has been postponed or called off says so here, rather than
   the person turning up to a room with nobody in it.
   ========================================================================= */
function MyTrainingSessions({ data, onChanged, setError, setNotice }: {
  data: MySessions | null;
  onChanged: () => Promise<void>;
  setError: (m: string | null) => void;
  setNotice: (m: string | null) => void;
}) {
  const [busy, setBusy] = useState<number | null>(null);

  if (!data) {
    return (
      <section className="portal-panel">
        <div className="pp-head"><div><h3><GraduationCap size={16} /> My training sessions</h3></div></div>
        <p className="muted"><Loader2 size={14} className="pd-spin" /> Reading your sessions…</p>
      </section>
    );
  }

  const sessions = data.sessions;
  // Still to happen, as opposed to on the record. A postponed session is
  // upcoming: it has a date and the person is still expected at it.
  const upcoming = sessions.filter(s => ['planned', 'in_progress', 'postponed'].includes(s.status));
  const toSign = sessions.filter(s => attendedInPerson(s.attendance_status) && !s.signed_at && s.status !== 'cancelled');
  const done = sessions.filter(s => trainingIsLocked(s.status) || s.status === 'completed');

  async function sign(session: MySession) {
    setBusy(session.attendance_id);
    setError(null);
    try {
      await api(`/personnel/training/${session.id}/attendance/${session.attendance_id}/sign`, {
        method: 'POST', body: JSON.stringify({}),
      });
      setNotice(`You have signed the attendance sheet for ${session.training_number}.`);
      await onChanged();
    } catch (e) { setError(errorText(e)); }
    finally { setBusy(null); }
  }

  async function printReport(session: MySession) {
    try { await openPrintable(`/personnel/training/${session.id}/print`); }
    catch (e) { setError(errorText(e)); }
  }

  return (
    <>
      {/* The one thing the portal owes this person an action on. It is a banner
          rather than a column in a table because an unsigned attendance sheet is
          an outstanding piece of work, and the register cannot close without it. */}
      {toSign.length > 0 && (
        <section className="portal-panel pt-sign-call">
          <div className="pp-head">
            <div>
              <h3><PenLine size={16} /> {toSign.length === 1 ? 'A training attendance sheet needs your signature'
                : `${toSign.length} training attendance sheets need your signature`}</h3>
              <p>
                You were marked present at these sessions. Signing attests that you attended — the same signature you
                use everywhere else in the system, taken from your own record.
              </p>
            </div>
          </div>
          {!data.hasSignatureOnFile && (
            <p className="pd-error">
              <AlertTriangle size={14} /> You have no signature on file yet, so you cannot sign. Add one under
              My Record → Replace signature, then come back.
            </p>
          )}
          <ul className="pt-sign-list">
            {toSign.map(session => (
              <li key={session.attendance_id}>
                <div>
                  <strong>{session.title}</strong>
                  <div className="muted pr-sub">
                    {session.training_number} · {session.training_date}
                    {session.sheet_designation ? ` · signing as ${session.sheet_designation}` : ''}
                    {session.hours ? ` · ${session.hours} h credited` : ''}
                  </div>
                </div>
                <button type="button" disabled={busy === session.attendance_id || !data.hasSignatureOnFile}
                  onClick={() => void sign(session)}>
                  {busy === session.attendance_id
                    ? <><Loader2 size={14} className="pd-spin" /> Signing…</>
                    : <><PenLine size={14} /> Sign the sheet</>}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="portal-panel">
        <div className="pp-head">
          <div>
            <h3><GraduationCap size={16} /> Training coming up for me</h3>
            <p>
              Sessions the laboratory has scheduled you for. You are sent a notice when one is booked and again the day
              before. Whoever runs the session marks who attended; you sign the sheet yourself.
            </p>
          </div>
          {upcoming.length > 0 && <span className="pp-count">{upcoming.length}</span>}
        </div>
        {upcoming.length === 0 ? (
          <p className="muted">No training is scheduled for you.</p>
        ) : (
          <ul className="pt-session-list">
            {upcoming.map(session => {
              const due = dueTone(session.training_date);
              const series = recurrenceSummary(session.frequency, session.frequency_interval_days);
              return (
                <li key={session.id} className={`pt-session status-${session.status}`}>
                  <div className="pt-session-main">
                    <strong>{session.title}</strong>
                    <span className={`badge tone-${TRAINING_STATUS_TONES[session.status] ?? 'muted'}`}>
                      {TRAINING_STATUS_LABELS[session.status] ?? session.status}
                    </span>
                    {session.remedial_for_event_id && (
                      <span className="badge tone-warn">Individual retraining arranged for you</span>
                    )}
                  </div>
                  <div className="pt-session-meta">
                    <span><CalendarClock size={12} /> {session.training_date}
                      {session.start_time ? ` at ${session.start_time}` : ''}</span>
                    {due && <span className={due.tone}>{due.text}</span>}
                    <span>{trainerDisplayName(session)}</span>
                    {session.delivery_mode === 'external' && <span><ExternalLink size={12} /> External</span>}
                    {session.location && <span>{session.location}</span>}
                    {session.duration_hours ? <span>{session.duration_hours} h</span> : null}
                    {series && <span><Repeat size={12} /> {series}</span>}
                    {session.equipment_name && <span><Cpu size={12} /> {session.equipment_name}</span>}
                    {session.category && <span>{TRAINING_CATEGORY_LABELS[session.category] ?? session.category}</span>}
                    <span className="badge">{ATTENDANCE_STATUS_LABELS[session.attendance_status] ?? 'Invited'}</span>
                  </div>
                  {session.objectives && <p className="pt-session-note"><Target size={12} /> {session.objectives}</p>}
                  {/* A session that has moved says so here. Turning up to an
                      empty room because the change was only recorded in the
                      register is exactly what this prevents. */}
                  {session.status === 'postponed' && session.postponed_from_date && (
                    <p className="pt-session-note"><CalendarClock size={12} /> Moved from {session.postponed_from_date}
                      {session.postponement_reason ? ` — ${session.postponement_reason}` : ''}</p>
                  )}
                  {session.postponed_from_date && session.status === 'planned' && (
                    <p className="pt-session-note"><CalendarClock size={12} /> This session was moved from
                      {` ${session.postponed_from_date}`}
                      {session.postponement_reason ? ` — ${session.postponement_reason}` : ''}</p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="portal-panel">
        <div className="pp-head">
          <div>
            <h3><CheckCircle2 size={16} /> Training I have attended</h3>
            <p>
              Sessions that have been held. Once a senior role has reviewed and closed one it is part of your
              permanent record, and you can print its report — the session and the signed attendance sheet together.
            </p>
          </div>
          {done.length > 0 && <span className="pp-count">{done.length}</span>}
        </div>
        {done.length === 0 ? (
          <p className="muted">Nothing yet.</p>
        ) : (
          <table className="data-table">
            <thead><tr><th>When</th><th>Training</th><th>My attendance</th><th>Outcome</th><th>Hours</th><th>Record</th></tr></thead>
            <tbody>
              {done.map(session => (
                <tr key={session.id}>
                  <td>{session.training_date}</td>
                  <td>
                    {session.title}
                    <div className="muted pr-sub">{session.training_number}
                      {session.cancellation_reason ? ' · called off' : ''}</div>
                  </td>
                  <td>
                    <span className="badge">{ATTENDANCE_STATUS_LABELS[session.attendance_status] ?? session.attendance_status}</span>
                    {session.signed_at
                      ? <div className="muted pr-sub"><PenLine size={10} /> signed {String(session.signed_at).slice(0, 10)}</div>
                      : attendedInPerson(session.attendance_status)
                        ? <div className="pr-sub overdue">not signed</div> : null}
                  </td>
                  <td>
                    {session.outcome && session.outcome !== 'not_assessed'
                      ? <span className={`badge tone-${TRAINING_OUTCOME_TONES[session.outcome] ?? 'muted'}`}>
                          {TRAINING_OUTCOME_LABELS[session.outcome] ?? session.outcome}</span>
                      : <span className="muted">—</span>}
                  </td>
                  <td>{session.hours ?? '—'}</td>
                  <td>
                    {/* Their own evidence, printable by them. Asking Personnel
                        Management for a copy of training you sat through is the
                        sort of thing that sends people back to photocopies. */}
                    {trainingIsLocked(session.status) ? (
                      <button type="button" className="link-button" onClick={() => void printReport(session)}>
                        <Printer size={11} /> Training report
                      </button>
                    ) : (
                      <span className="muted" title="Not yet reviewed and closed, so it is not part of your record yet">
                        awaiting closure
                      </span>
                    )}
                    {session.status === 'closed' && <div className="muted pr-sub"><Lock size={10} /> closed record</div>}
                    {session.status === 'cancelled' && <div className="muted pr-sub"><XCircle size={10} /> called off</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
