/**
 * Staff Self-Service module (Phase 2 · high priority).
 *
 * Every authenticated staff member manages their own employment information from
 * the phone: profile & contact, emergency contacts, professional licences,
 * documents/certificates (upload), leave requests, clock in/out, duty roster,
 * training history & upcoming requirements, competency records, organisational
 * announcements and electronic acknowledgements. Submissions flow through the
 * Host's existing role-based approval workflows.
 */
import { useEffect, useState } from 'react';
import { api, getApiBaseOverride, setApiBaseOverride, isNativeApp } from '../src/services/api';
import type { ApiUser } from '../shared/types/api';
import { submit } from './net';
import { Back, Field, Ico, ICO, Result, s, today, type Msg } from './ui';
import { getPosition, deviceInfo, compressImage } from './native';
import { SignaturePad, uploadSignatureImage } from './Signature';

type Row = Record<string, unknown>;
type View = 'hub' | 'profile' | 'leave' | 'roster' | 'licences' | 'training' | 'competency' | 'announcements' | 'declarations' | 'documents' | 'settings' | 'password';

const IC = {
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM4 21a8 8 0 0 1 16 0',
  cal: 'M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z',
  clock: 'M12 8v4l3 2M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z',
  badge: 'M12 2 4 6v6c0 5 8 10 8 10s8-5 8-10V6Z',
  book: 'M4 4h11a3 3 0 0 1 3 3v13a2.5 2.5 0 0 0-2.5-2.5H4ZM4 4v13.5A2.5 2.5 0 0 0 6.5 20H20',
  award: 'M12 15a6 6 0 1 0 0-12 6 6 0 0 0 0 12ZM8.2 13.5 7 22l5-3 5 3-1.2-8.5',
  mega: 'M3 11v2a1 1 0 0 0 1 1h3l5 4V6L7 10H4a1 1 0 0 0-1 1ZM16 9a3 3 0 0 1 0 6',
  pen: 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z',
  doc: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8ZM14 2v6h6',
  lock: 'M5 11h14a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2ZM8 11V7a4 4 0 0 1 8 0v4',
  gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z',
  logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
};

function initials(name?: string) {
  if (!name) return '–';
  const p = name.trim().split(/\s+/);
  return ((p[0]?.[0] ?? '') + (p[1]?.[0] ?? '')).toUpperCase() || '–';
}

export function SelfServiceScreen({ user, onLogout }: { user: ApiUser; onLogout: () => void }) {
  const [view, setView] = useState<View>('hub');
  const [me, setMe] = useState<Row | null>(null);
  const [counts, setCounts] = useState<{ ann: number; decl: number }>({ ann: 0, decl: 0 });

  useEffect(() => {
    api<Row>('/mobile/me').then(setMe).catch(() => setMe({ staffLinked: false }));
    api<Row[]>('/mobile/announcements').then(a => setCounts(c => ({ ...c, ann: a.filter(x => !x.read_at).length }))).catch(() => undefined);
  }, []);
  useEffect(() => {
    const decl = ((me?.declarations as Row[]) ?? []).filter(d => s(d.status) === 'pending').length;
    setCounts(c => ({ ...c, decl }));
  }, [me]);

  if (view !== 'hub') {
    const back = () => setView('hub');
    return (
      <div className="m-screen">
        {view === 'profile' && <ProfileEditor me={me} onBack={back} onSaved={() => api<Row>('/mobile/me').then(setMe)} />}
        {view === 'leave' && <LeaveView onBack={back} />}
        {view === 'roster' && <RosterView duties={(me?.duties as Row[]) ?? []} onBack={back} />}
        {view === 'licences' && <LicencesView me={me} onBack={back} onSaved={() => api<Row>('/mobile/me').then(setMe)} />}
        {view === 'documents' && <DocumentsUpload onBack={back} onSaved={() => api<Row>('/mobile/me').then(setMe)} docs={(me?.documents as Row[]) ?? []} />}
        {view === 'training' && <TrainingView me={me} onBack={back} />}
        {view === 'competency' && <CompetencyView records={(me?.competency as Row[]) ?? []} onBack={back} />}
        {view === 'announcements' && <AnnouncementsView onBack={back} onRead={() => api<Row[]>('/mobile/announcements').then(a => setCounts(c => ({ ...c, ann: a.filter(x => !x.read_at).length })))} />}
        {view === 'declarations' && <DeclarationsView records={(me?.declarations as Row[]) ?? []} onBack={back} onSigned={() => api<Row>('/mobile/me').then(setMe)} />}
        {view === 'settings' && <SettingsView onBack={back} />}
        {view === 'password' && <ChangePasswordView onBack={back} />}
      </div>
    );
  }

  const staff = (me?.staff as Row) ?? {};
  const linked = me?.staffLinked !== false;
  const tiles: { key: View; label: string; icon: string; badge?: number }[] = [
    { key: 'profile', label: 'My profile', icon: IC.user },
    { key: 'leave', label: 'Leave', icon: IC.cal },
    { key: 'roster', label: 'Duty roster', icon: IC.clock },
    { key: 'licences', label: 'Licences', icon: IC.badge },
    { key: 'documents', label: 'Documents', icon: IC.doc },
    { key: 'training', label: 'Training', icon: IC.book },
    { key: 'competency', label: 'Competency', icon: IC.award },
    { key: 'announcements', label: 'Announcements', icon: IC.mega, badge: counts.ann },
    { key: 'declarations', label: 'Sign forms', icon: IC.pen, badge: counts.decl },
    { key: 'password', label: 'Password', icon: IC.lock },
    { key: 'settings', label: 'Notifications', icon: IC.gear },
  ];

  return (
    <div className="m-screen">
      <div className="m-me-head">
        <span className="m-avatar big">{initials(s(staff.full_name) || user.fullName)}</span>
        <div>
          <div className="m-me-name">{s(staff.full_name) || user.fullName}</div>
          <div className="m-me-role">{s(staff.designation) || s(staff.job_title) || user.roleName || 'Laboratory staff'}</div>
        </div>
      </div>

      {linked && <ClockCard />}

      {!linked && <p className="m-empty">Your login isn’t linked to a staff profile yet. Ask your administrator to link your account to unlock full self-service.</p>}

      <div className="m-section-h">Self-service</div>
      <div className="m-grid">
        {tiles.map(t => (
          <button key={t.key} className="m-cell" onClick={() => setView(t.key)}>
            <span className="m-cell-ic"><Ico d={t.icon} size={22} /></span>
            <span className="m-cell-l">{t.label}</span>
            {t.badge ? <span className="m-badge">{t.badge}</span> : null}
          </button>
        ))}
      </div>

      <button className="m-btn danger block" onClick={onLogout}><Ico d={IC.logout} size={18} /> Sign out</button>
      <p className="m-hint" style={{ textAlign: 'center' }}>SECH_LIMS Staff Companion · by Nickland</p>
    </div>
  );
}

/* ── Clock in / out ─────────────────────────────────────────────────────── */
function ClockCard() {
  const [status, setStatus] = useState<'in' | 'out'>('out');
  const [recent, setRecent] = useState<Row[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);

  function load() { api<{ status: 'in' | 'out'; recent: Row[] }>('/mobile/me/clock').then(r => { setStatus(r.status); setRecent(r.recent ?? []); }).catch(() => undefined); }
  useEffect(load, []);

  async function toggle() {
    setBusy(true); setMsg(null);
    const next = status === 'in' ? 'out' : 'in';
    const coords = await getPosition();
    try {
      await api('/mobile/me/clock', { method: 'POST', body: JSON.stringify({ eventType: next, latitude: coords?.latitude, longitude: coords?.longitude, accuracy: coords?.accuracy, deviceInfo: deviceInfo() }) });
      setStatus(next); setMsg({ kind: 'ok', msg: `Clocked ${next === 'in' ? 'in' : 'out'} at ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.` }); load();
    } catch (e) { setMsg({ kind: 'err', msg: (e as Error).message }); } finally { setBusy(false); }
  }

  return (
    <div className="m-clock">
      <div className="m-clock-row">
        <div>
          <div className="m-clock-state">{status === 'in' ? 'On duty' : 'Off duty'}</div>
          <div className="m-clock-sub">{recent[0] ? `Last: ${s(recent[0].event_type) === 'in' ? 'in' : 'out'} · ${fmtTime(recent[0].event_at)}` : 'No record yet today'}</div>
        </div>
        <button className={`m-btn ${status === 'in' ? 'danger' : 'primary'} small`} disabled={busy} onClick={toggle} style={{ margin: 0 }}>
          <Ico d={IC.clock} size={16} /> {busy ? '…' : status === 'in' ? 'Clock out' : 'Clock in'}
        </button>
      </div>
      <Result r={msg} />
    </div>
  );
}
function fmtTime(v: unknown) { const t = Date.parse(String(v).replace(' ', 'T')); return Number.isNaN(t) ? s(v) : new Date(t).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); }

/* ── Profile & emergency contacts ───────────────────────────────────────── */
function ProfileEditor({ me, onBack, onSaved }: { me: Row | null; onBack: () => void; onSaved: () => void }) {
  const staff = (me?.staff as Row) ?? {};
  const [phone, setPhone] = useState(s(staff.phone));
  const [email, setEmail] = useState(s(staff.email));
  const [ec, setEc] = useState(s(staff.emergency_contact));
  const [ecPhone, setEcPhone] = useState(s(staff.emergency_contact_phone));
  const [ecRel, setEcRel] = useState(s(staff.emergency_contact_relation));
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<Msg>(null);

  async function save() {
    setBusy(true); setRes(null);
    try {
      await api('/mobile/me/contact', { method: 'PUT', body: JSON.stringify({ phone, email, emergencyContact: ec, emergencyContactPhone: ecPhone, emergencyContactRelation: ecRel }) });
      setRes({ kind: 'ok', msg: 'Profile updated.' }); onSaved();
    } catch (e) { setRes({ kind: 'err', msg: (e as Error).message }); } finally { setBusy(false); }
  }

  return (
    <>
      <Back onBack={onBack} />
      <div className="m-screen-h">My profile</div>
      <div className="m-card" style={{ marginBottom: 4 }}>
        <div className="m-kv"><span>Name</span><strong>{s(staff.full_name) || '—'}</strong></div>
        <div className="m-kv"><span>Employee no.</span><strong>{s(staff.employee_no) || '—'}</strong></div>
        <div className="m-kv"><span>Section</span><strong>{s(staff.section_name) || '—'}</strong></div>
      </div>
      <div className="m-form">
        <div className="m-section-h">Contact</div>
        <Field label="Phone"><input value={phone} onChange={e => setPhone(e.target.value)} inputMode="tel" /></Field>
        <Field label="Email"><input value={email} onChange={e => setEmail(e.target.value)} inputMode="email" autoCapitalize="none" /></Field>
        <div className="m-section-h">Emergency contact</div>
        <Field label="Contact name"><input value={ec} onChange={e => setEc(e.target.value)} /></Field>
        <Field label="Contact phone"><input value={ecPhone} onChange={e => setEcPhone(e.target.value)} inputMode="tel" /></Field>
        <Field label="Relationship"><input value={ecRel} onChange={e => setEcRel(e.target.value)} /></Field>
        <button className="m-btn primary block" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save changes'}</button>
        <Result r={res} />
      </div>
    </>
  );
}

/* ── Leave ──────────────────────────────────────────────────────────────── */
function LeaveView({ onBack }: { onBack: () => void }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [leaveType, setLeaveType] = useState('annual');
  const [start, setStart] = useState(today());
  const [end, setEnd] = useState(today());
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<Msg>(null);

  function load() { api<Row[]>('/mobile/me/leave').then(setRows).catch(() => setRows([])); }
  useEffect(load, []);

  async function apply() {
    if (end < start) { setRes({ kind: 'err', msg: 'End date cannot be before the start date.' }); return; }
    setBusy(true); setRes(null);
    try {
      const out = await submit('/mobile/me/leave', { leaveType, startDate: start, endDate: end, reason }, `Leave · ${leaveType}`);
      if (out.queued) setRes({ kind: 'queued', msg: 'Saved offline — will submit when back online.' });
      else { setRes({ kind: 'ok', msg: 'Leave request submitted for approval.' }); setReason(''); load(); }
    } catch (e) { setRes({ kind: 'err', msg: (e as Error).message }); } finally { setBusy(false); }
  }

  return (
    <>
      <Back onBack={onBack} />
      <div className="m-screen-h">Leave</div>
      <div className="m-form">
        <Field label="Type">
          <select value={leaveType} onChange={e => setLeaveType(e.target.value)}>
            {['annual', 'sick', 'compassionate', 'maternity', 'study', 'unpaid', 'other'].map(t => <option key={t} value={t}>{t[0].toUpperCase() + t.slice(1)}</option>)}
          </select>
        </Field>
        <div className="m-two">
          <Field label="From"><input type="date" value={start} onChange={e => setStart(e.target.value)} /></Field>
          <Field label="To"><input type="date" value={end} onChange={e => setEnd(e.target.value)} /></Field>
        </div>
        <Field label="Reason (optional)"><textarea rows={2} value={reason} onChange={e => setReason(e.target.value)} /></Field>
        <button className="m-btn primary block" disabled={busy} onClick={apply}>{busy ? 'Submitting…' : 'Request leave'}</button>
        <Result r={res} />
      </div>
      <div className="m-section-h" style={{ marginTop: 14 }}>My requests</div>
      {rows === null && <p className="m-empty">Loading…</p>}
      {rows && rows.length === 0 && <p className="m-empty">No leave requests yet.</p>}
      <div className="m-list">
        {(rows ?? []).map((r, i) => (
          <div className="m-item" key={i}>
            <div className="m-item-body">
              <div className="m-item-title">{s(r.leave_type)} · {s(r.start_date)} → {s(r.end_date)}</div>
              <div className="m-item-meta"><StatusChip status={s(r.status)} />{r.decision_notes ? <span className="m-due">{s(r.decision_notes)}</span> : null}</div>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

/* ── Roster / schedule ──────────────────────────────────────────────────── */
function RosterView({ duties, onBack }: { duties: Row[]; onBack: () => void }) {
  return (
    <>
      <Back onBack={onBack} />
      <div className="m-screen-h">Duty roster</div>
      {duties.length === 0 && <p className="m-empty">No upcoming duties published.</p>}
      <div className="m-list">
        {duties.map((d, i) => (
          <div className="m-item" key={i}>
            <span className="m-item-ic"><Ico d={IC.clock} size={18} /></span>
            <div className="m-item-body">
              <div className="m-item-title">{s(d.duty_date)}{d.shift_name ? ` · ${s(d.shift_name)}` : ''}</div>
              <div className="m-item-meta">
                {(d.start_time || d.end_time) ? <span className="m-chip">{s(d.start_time)}–{s(d.end_time)}</span> : null}
                {d.duty_role ? <span className="m-due">{s(d.duty_role)}</span> : null}
                {d.roster_number ? <span className="m-due">{s(d.roster_number)}</span> : null}
              </div>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

/* ── Licences ───────────────────────────────────────────────────────────── */
function LicencesView({ me, onBack, onSaved }: { me: Row | null; onBack: () => void; onSaved: () => void }) {
  const staff = (me?.staff as Row) ?? {};
  const [licence, setLicence] = useState(s(staff.professional_licence));
  const [regulator, setRegulator] = useState(s(staff.professional_regulator));
  const [expiry, setExpiry] = useState(s(staff.licence_expiry_date));
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<Msg>(null);
  const auths = (me?.authorizations as Row[]) ?? [];

  async function save() {
    setBusy(true); setRes(null);
    try {
      await api('/mobile/me/contact', { method: 'PUT', body: JSON.stringify({ professionalLicence: licence, professionalRegulator: regulator, licenceExpiryDate: expiry }) });
      setRes({ kind: 'ok', msg: 'Licence details updated.' }); onSaved();
    } catch (e) { setRes({ kind: 'err', msg: (e as Error).message }); } finally { setBusy(false); }
  }

  return (
    <>
      <Back onBack={onBack} />
      <div className="m-screen-h">Professional licences</div>
      <div className="m-form">
        <Field label="Regulator"><input value={regulator} onChange={e => setRegulator(e.target.value)} placeholder="e.g. Allied Health Professions Council" /></Field>
        <Field label="Licence number"><input value={licence} onChange={e => setLicence(e.target.value)} /></Field>
        <Field label="Expiry date"><input type="date" value={expiry} onChange={e => setExpiry(e.target.value)} /></Field>
        <button className="m-btn primary block" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save licence'}</button>
        <Result r={res} />
      </div>
      <p className="m-hint">To upload a renewed licence certificate, use <strong>Documents</strong>. It is submitted for verification.</p>
      {auths.length > 0 && <>
        <div className="m-section-h" style={{ marginTop: 14 }}>Technical authorisations</div>
        <div className="m-list">
          {auths.map((a, i) => (
            <div className="m-item" key={i}>
              <div className="m-item-body">
                <div className="m-item-title">{s(a.module_key)} · {s(a.level)}</div>
                {a.expires_at ? <div className="m-item-meta"><span className="m-due">Expires {s(a.expires_at)}</span></div> : null}
              </div>
            </div>
          ))}
        </div>
      </>}
    </>
  );
}

/* ── Documents upload ───────────────────────────────────────────────────── */
function DocumentsUpload({ docs, onBack, onSaved }: { docs: Row[]; onBack: () => void; onSaved: () => void }) {
  const [title, setTitle] = useState('');
  const [docType, setDocType] = useState('certificate');
  const [expiry, setExpiry] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<Msg>(null);

  async function upload() {
    if (!title.trim()) { setRes({ kind: 'err', msg: 'Enter a title.' }); return; }
    if (!file) { setRes({ kind: 'err', msg: 'Choose a file to upload.' }); return; }
    setBusy(true); setRes(null);
    try {
      const compact = await compressImage(file);
      const fd = new FormData();
      fd.append('file', compact); fd.append('title', title); fd.append('documentType', docType);
      if (expiry) fd.append('expiryDate', expiry);
      await api('/mobile/me/documents', { method: 'POST', body: fd });
      setRes({ kind: 'ok', msg: 'Uploaded and submitted for verification.' }); setTitle(''); setFile(null); setExpiry(''); onSaved();
    } catch (e) { setRes({ kind: 'err', msg: (e as Error).message }); } finally { setBusy(false); }
  }

  return (
    <>
      <Back onBack={onBack} />
      <div className="m-screen-h">My documents</div>
      <div className="m-form">
        <Field label="Title"><input value={title} onChange={e => setTitle(e.target.value)} placeholder="e.g. Practising licence 2026" /></Field>
        <Field label="Type">
          <select value={docType} onChange={e => setDocType(e.target.value)}>
            {['certificate', 'licence', 'id_document', 'qualification', 'contract', 'other'].map(t => <option key={t} value={t}>{t.replace('_', ' ')}</option>)}
          </select>
        </Field>
        <Field label="Expiry (optional)"><input type="date" value={expiry} onChange={e => setExpiry(e.target.value)} /></Field>
        <label className="m-photobtn">
          <Ico d={IC.doc} size={18} /> {file ? file.name : 'Choose file'}
          <input type="file" accept="image/*,application/pdf" style={{ display: 'none' }} onChange={e => setFile(e.target.files?.[0] ?? null)} />
        </label>
        <button className="m-btn primary block" disabled={busy} onClick={upload}>{busy ? 'Uploading…' : 'Upload document'}</button>
        <Result r={res} />
      </div>
      <div className="m-section-h" style={{ marginTop: 14 }}>My records</div>
      {docs.length === 0 && <p className="m-empty">No documents on file yet.</p>}
      <div className="m-list">
        {docs.map((d, i) => (
          <div className="m-item" key={i}>
            <span className="m-item-ic"><Ico d={IC.doc} size={18} /></span>
            <div className="m-item-body">
              <div className="m-item-title">{s(d.title)}</div>
              <div className="m-item-meta"><StatusChip status={s(d.verification_status)} />{d.expiry_date ? <span className="m-due">Expires {s(d.expiry_date)}</span> : null}</div>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

/* ── Training ───────────────────────────────────────────────────────────── */
function TrainingView({ me, onBack }: { me: Row | null; onBack: () => void }) {
  const upcoming = (me?.upcomingTraining as Row[]) ?? [];
  const history = (me?.training as Row[]) ?? [];
  return (
    <>
      <Back onBack={onBack} />
      <div className="m-screen-h">Training</div>
      <div className="m-section-h">Upcoming requirements</div>
      {upcoming.length === 0 && <p className="m-empty">No upcoming training scheduled.</p>}
      <div className="m-list">
        {upcoming.map((t, i) => (
          <div className="m-item" key={i}><span className="m-item-ic alert"><Ico d={IC.book} size={18} /></span>
            <div className="m-item-body"><div className="m-item-title">{s(t.title)}</div><div className="m-item-meta"><span className="m-chip">{s(t.training_type) || 'training'}</span><span className="m-due">{s(t.training_date)}</span></div></div>
          </div>
        ))}
      </div>
      <div className="m-section-h" style={{ marginTop: 14 }}>History</div>
      {history.length === 0 && <p className="m-empty">No training history recorded.</p>}
      <div className="m-list">
        {history.map((t, i) => (
          <div className="m-item muted" key={i}><span className="m-item-ic ok"><Ico d={ICO.check} size={18} /></span>
            <div className="m-item-body"><div className="m-item-title">{s(t.title)}</div><div className="m-item-meta"><span className="m-chip">{s(t.attendance_status)}</span><span className="m-due">{s(t.training_date)}</span></div></div>
          </div>
        ))}
      </div>
    </>
  );
}

/* ── Competency ─────────────────────────────────────────────────────────── */
function CompetencyView({ records, onBack }: { records: Row[]; onBack: () => void }) {
  return (
    <>
      <Back onBack={onBack} />
      <div className="m-screen-h">Competency records</div>
      {records.length === 0 && <p className="m-empty">No competency assessments recorded.</p>}
      <div className="m-list">
        {records.map((r, i) => (
          <div className="m-item" key={i}><span className="m-item-ic"><Ico d={IC.award} size={18} /></span>
            <div className="m-item-body">
              <div className="m-item-title">{s(r.activity)}</div>
              <div className="m-item-meta">
                {r.outcome ? <StatusChip status={s(r.outcome)} /> : <span className="m-chip">{s(r.status)}</span>}
                <span className="m-due">{s(r.assessment_date)}</span>
                {r.next_assessment_due ? <span className="m-due">Next: {s(r.next_assessment_due)}</span> : null}
              </div>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

/* ── Announcements ──────────────────────────────────────────────────────── */
function AnnouncementsView({ onBack, onRead }: { onBack: () => void; onRead: () => void }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  function load() { api<Row[]>('/mobile/announcements').then(setRows).catch(() => setRows([])); }
  useEffect(load, []);

  async function mark(a: Row, acknowledge: boolean) {
    try { await api(`/mobile/announcements/${s(a.id)}/read`, { method: 'POST', body: JSON.stringify({ acknowledge }) }); load(); onRead(); } catch { /* ignore */ }
  }

  return (
    <>
      <Back onBack={onBack} />
      <div className="m-screen-h">Announcements</div>
      {rows === null && <p className="m-empty">Loading…</p>}
      {rows && rows.length === 0 && <p className="m-empty">No announcements right now.</p>}
      <div className="m-list">
        {(rows ?? []).map((a, i) => {
          const pr = s(a.priority);
          return (
            <div className={`m-item alert ${pr === 'critical' ? 'crit' : pr === 'high' ? 'warn' : ''} ${a.read_at ? 'muted' : ''}`} key={i} onClick={() => { if (!a.read_at) mark(a, false); }}>
              <span className="m-item-ic alert"><Ico d={IC.mega} size={18} /></span>
              <div className="m-item-body">
                <div className="m-item-title">{s(a.title)}</div>
                {a.body ? <div className="m-qtext" style={{ padding: 0, marginTop: 4 }}>{s(a.body)}</div> : null}
                <div className="m-ackrow">
                  {a.category ? <span className="m-chip">{s(a.category)}</span> : null}
                  {a.requires_acknowledgement && !a.acknowledged_at
                    ? <button className="m-btn small primary" onClick={e => { e.stopPropagation(); mark(a, true); }}>Acknowledge</button>
                    : a.acknowledged_at ? <span className="m-tag ok">Acknowledged</span> : null}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

/* ── Declarations / sign forms ──────────────────────────────────────────── */
function DeclarationsView({ records, onBack, onSigned }: { records: Row[]; onBack: () => void; onSigned: () => void }) {
  const [active, setActive] = useState<Row | null>(null);
  const [sig, setSig] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<Msg>(null);
  const pending = records.filter(r => s(r.status) === 'pending');
  const signed = records.filter(r => s(r.status) !== 'pending');

  async function sign() {
    if (!active) return;
    if (!sig) { setRes({ kind: 'err', msg: 'Please sign in the box.' }); return; }
    setBusy(true); setRes(null);
    try {
      const fileId = await uploadSignatureImage(sig);
      await api(`/mobile/me/declarations/${s(active.id)}/sign`, { method: 'POST', body: JSON.stringify({ signatureImageFileId: fileId }) });
      setRes({ kind: 'ok', msg: 'Signed.' }); setActive(null); setSig(null); onSigned();
    } catch (e) { setRes({ kind: 'err', msg: (e as Error).message }); } finally { setBusy(false); }
  }

  if (active) return (
    <>
      <Back onBack={() => setActive(null)} />
      <div className="m-screen-h">{s(active.title)}</div>
      <div className="m-card" style={{ padding: 16 }}>
        <div className="m-me-role">{s(active.declaration_type)}</div>
        <p className="m-qtext" style={{ padding: 0, marginTop: 8 }}>By signing you confirm you have read and agree to this declaration.</p>
      </div>
      <div className="m-form">
        <label className="m-lbl">Signature</label>
        <SignaturePad onChange={setSig} />
        <button className="m-btn primary block" disabled={busy} onClick={sign}><Ico d={IC.pen} size={16} /> {busy ? 'Signing…' : 'Sign electronically'}</button>
        <Result r={res} />
      </div>
    </>
  );

  return (
    <>
      <Back onBack={onBack} />
      <div className="m-screen-h">Forms to sign</div>
      {pending.length === 0 && <p className="m-empty">Nothing awaiting your signature. ✅</p>}
      <div className="m-list">
        {pending.map((d, i) => (
          <button className="m-item tappable" key={i} onClick={() => { setActive(d); setSig(null); setRes(null); }}>
            <span className="m-item-ic alert"><Ico d={IC.pen} size={18} /></span>
            <div className="m-item-body"><div className="m-item-title">{s(d.title)}</div><div className="m-item-meta"><span className="m-chip">{s(d.declaration_type)}</span></div></div>
            <span className="m-chevron">›</span>
          </button>
        ))}
      </div>
      {signed.length > 0 && <>
        <div className="m-section-h" style={{ marginTop: 14 }}>Signed</div>
        <div className="m-list">
          {signed.map((d, i) => (
            <div className="m-item muted" key={i}><span className="m-item-ic ok"><Ico d={ICO.check} size={18} /></span>
              <div className="m-item-body"><div className="m-item-title">{s(d.title)}</div><div className="m-item-meta"><span className="m-tag ok">{s(d.status)}</span>{d.signed_at ? <span className="m-due">{s(d.signed_at)}</span> : null}</div></div>
            </div>
          ))}
        </div>
      </>}
    </>
  );
}

/* ── Notification settings + push registration ──────────────────────────── */
function SettingsView({ onBack }: { onBack: () => void }) {
  const [prefs, setPrefs] = useState<Row[]>([]);
  const [devices, setDevices] = useState<Row[]>([]);
  const [msg, setMsg] = useState<Msg>(null);

  function load() {
    api<Row[]>('/push/preferences').then(setPrefs).catch(() => setPrefs([]));
    api<Row[]>('/push/subscriptions').then(setDevices).catch(() => setDevices([]));
  }
  useEffect(load, []);

  const global = prefs.find(p => !p.module_key);
  const inApp = global ? global.in_app_enabled !== 0 : true;

  async function toggleInApp() {
    try { await api('/push/preferences', { method: 'PUT', body: JSON.stringify({ moduleKey: null, inAppEnabled: !inApp }) }); load(); }
    catch (e) { setMsg({ kind: 'err', msg: (e as Error).message }); }
  }

  return (
    <>
      <Back onBack={onBack} />
      <div className="m-screen-h">Notifications</div>
      <div className="m-card">
        <label className="m-toggle">
          <span>In-app notifications</span>
          <input type="checkbox" checked={inApp} onChange={toggleInApp} />
        </label>
      </div>
      <p className="m-hint">Push notifications to this device turn on automatically once the secure (HTTPS) tunnel or native app is available. The framework is already prepared.</p>
      {isNativeApp() && (
        <>
          <div className="m-section-h" style={{ marginTop: 14 }}>Host connection</div>
          <div className="m-card">
            <div className="m-kv"><span>Connected to</span><strong>{(getApiBaseOverride() ?? '—').replace(/^https?:\/\//, '')}</strong></div>
          </div>
          <button className="m-btn ghost block" style={{ marginTop: 10 }} onClick={() => { setApiBaseOverride(null); window.location.reload(); }}>Change Host address</button>
        </>
      )}
      <div className="m-section-h" style={{ marginTop: 12 }}>Registered devices</div>
      {devices.length === 0 && <p className="m-empty">No push devices registered yet.</p>}
      <div className="m-list">
        {devices.map((d, i) => (
          <div className="m-item" key={i}><div className="m-item-body"><div className="m-item-title">{s(d.platform)} device</div><div className="m-item-meta"><span className="m-due">{s(d.device_info).slice(0, 50)}</span></div></div></div>
        ))}
      </div>
      <Result r={msg} />
    </>
  );
}

/* ── Change password ────────────────────────────────────────────────────── */
function ChangePasswordView({ onBack }: { onBack: () => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<Msg>(null);

  async function save() {
    setRes(null);
    if (!current) { setRes({ kind: 'err', msg: 'Enter your current password.' }); return; }
    if (next.length < 8) { setRes({ kind: 'err', msg: 'New password must be at least 8 characters.' }); return; }
    if (next !== confirm) { setRes({ kind: 'err', msg: 'The new passwords do not match.' }); return; }
    if (next === current) { setRes({ kind: 'err', msg: 'Choose a password different from your current one.' }); return; }
    setBusy(true);
    try {
      await api('/auth/change-password', { method: 'POST', body: JSON.stringify({ currentPassword: current, newPassword: next }) });
      setRes({ kind: 'ok', msg: 'Password changed. Use it next time you sign in.' });
      setCurrent(''); setNext(''); setConfirm('');
    } catch (e) { setRes({ kind: 'err', msg: (e as Error).message }); } finally { setBusy(false); }
  }

  const inputType = show ? 'text' : 'password';
  return (
    <>
      <Back onBack={onBack} />
      <div className="m-screen-h">Change password</div>
      <p className="m-hint" style={{ marginTop: 0 }}>Set your own password after signing in with the one your administrator gave you.</p>
      <div className="m-form">
        <Field label="Current password"><input type={inputType} value={current} onChange={e => setCurrent(e.target.value)} autoComplete="current-password" autoCapitalize="none" /></Field>
        <Field label="New password" hint="At least 8 characters."><input type={inputType} value={next} onChange={e => setNext(e.target.value)} autoComplete="new-password" autoCapitalize="none" /></Field>
        <Field label="Confirm new password"><input type={inputType} value={confirm} onChange={e => setConfirm(e.target.value)} autoComplete="new-password" autoCapitalize="none" /></Field>
        <label className="m-toggle"><span>Show passwords</span><input type="checkbox" checked={show} onChange={e => setShow(e.target.checked)} /></label>
        <button className="m-btn primary block" disabled={busy} onClick={save}><Ico d={IC.lock} size={16} /> {busy ? 'Saving…' : 'Update password'}</button>
        <Result r={res} />
      </div>
    </>
  );
}

function StatusChip({ status }: { status: string }) {
  const st = status.toLowerCase();
  const cls = ['approved', 'verified', 'signed', 'competent', 'passed'].some(x => st.includes(x)) ? 'ok'
    : ['rejected', 'not_yet', 'failed', 'expired'].some(x => st.includes(x)) ? 'danger'
    : ['pending', 'returned', 'planned', 'in_progress'].some(x => st.includes(x)) ? 'warn' : '';
  return <span className={`m-tag ${cls}`}>{status.replace(/_/g, ' ') || '—'}</span>;
}
