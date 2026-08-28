import { Suspense, lazy, useRef, useState } from 'react';
import {
  AlertTriangle, BadgeCheck, BriefcaseBusiness, IdCard, KeyRound, Link2, Loader2, Lock,
  Pencil, PenLine, ShieldCheck, Trash2, UserRound, X,
} from 'lucide-react';
import { ChangePasswordModal } from '../../components/ChangePasswordModal';
import { titleCase, usePortal, type SelfEditableProfile } from './portalData';
import type { JobDescriptionDoc } from '../../../shared/types/api';
import { errorText } from '../../services/api';

// The controlled-document window, borrowed so a job description is read here
// exactly as it is read in Document Control — same version, same watermark,
// same record. Lazy, so My Record does not carry it for everyone.
const DocumentViewer = lazy(() => import('../DocumentControlPage').then(m => ({ default: m.DocumentViewer })));

/**
 * My record — the working file the laboratory holds on this person.
 *
 * ISO 15189 expects a personnel record for every member of staff: identity,
 * qualifications, registration, appointment, authorisations. It used to be
 * readable only by whoever held the personnel register, which meant the one
 * person it is actually about could not check it — and could not correct it
 * when it was wrong.
 *
 * They can now. What they may change is the half of the file they are the best
 * source for: how to reach them, who to call in an emergency, their licence,
 * their qualifications, their photograph. What they may not change is the half
 * that decides consequences — post, unit, staff number, appointment, category.
 * Those stay with Personnel Management, are shown here as read-only, and say
 * so, because a field you cannot edit and are not told why is worse than one
 * that is simply absent.
 *
 * The server enforces exactly the same split; this screen only draws it.
 */

/** Shown, never editable here — and each says who does own it. */
function ManagedFact({ label, value }: { label: string; value?: string | null }) {
  if (!value) return null;
  return (
    <div className="pr-managed">
      <dt>{label} <Lock size={10} /></dt>
      <dd>{value}</dd>
    </div>
  );
}

export function LinkStaffPrompt() {
  const { suggestions, linkStaff, setError } = usePortal();
  return (
    <section className="portal-panel pp-warn">
      <div className="pp-head">
        <div>
          <h3><Link2 size={16} /> Your account is not linked to a staff record</h3>
          <p>
            Until it is linked, the laboratory cannot route your duties, documents or declarations to
            you — the portal has nobody to fetch them for.
          </p>
        </div>
      </div>
      {suggestions && suggestions.suggestions.length > 0 ? (
        <table className="data-table">
          <thead><tr><th>Staff record</th><th>Email</th><th>Section</th><th /></tr></thead>
          <tbody>
            {suggestions.suggestions.map(s => (
              <tr key={s.id}>
                <td>{s.full_name}{s.employee_no ? ` (${s.employee_no})` : ''}</td>
                <td>{s.email || '—'}</td>
                <td>{s.section_name || '—'}</td>
                <td>
                  {s.already_taken
                    ? <em className="muted">linked to another user</em>
                    : <button type="button" onClick={() => linkStaff(s.id).catch(e => setError(errorText(e)))}>This is me</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="muted">
          No staff record matches your name or sign-in address. Ask a System Administrator to create
          your staff record and link it to your account.
        </p>
      )}
    </section>
  );
}

/* ----------------------------------------------------------------------------
   The passport photograph
   ------------------------------------------------------------------------- */
function PhotoPanel() {
  const { photoUrl, staff, uploadPhoto, removePhoto, setError } = usePortal();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function choose(file: File) {
    setBusy(true); setProblem(null);
    try { await uploadPhoto(file); }
    catch (e) { setProblem((e as Error).message); }
    finally { setBusy(false); if (input.current) input.current.value = ''; }
  }

  return (
    <div className="pr-photo">
      <div className="pr-photo-frame">
        {photoUrl
          ? <img src={photoUrl} alt="Your profile picture" />
          : <span className="pr-photo-empty"><UserRound size={30} /><small>No photograph</small></span>}
      </div>
      <div className="pr-photo-side">
        <h4>My photograph</h4>
        <p className="muted">
          Passport size. Pick any picture — it is cropped to passport proportions here before it is
          saved, so a phone photograph is fine. Up to 2&nbsp;MB.
        </p>
        <input ref={input} type="file" accept="image/*" hidden
          onChange={e => { const f = e.target.files?.[0]; if (f) void choose(f); }} />
        <div className="pr-btns">
          <button type="button" className="secondary" disabled={busy || !staff} onClick={() => input.current?.click()}>
            {busy ? <><Loader2 size={14} className="pd-spin" /> Saving…</> : <>{photoUrl ? 'Replace picture' : 'Add a picture'}</>}
          </button>
          {photoUrl && (
            <button type="button" className="secondary" disabled={busy}
              onClick={() => removePhoto().catch(e => setError(errorText(e)))}>
              <Trash2 size={14} /> Remove
            </button>
          )}
        </div>
        {problem && <p className="pd-error"><AlertTriangle size={13} /> {problem}</p>}
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------------------
   My job description
   ------------------------------------------------------------------------- */

/**
 * The description of the job this person actually holds.
 *
 * It is not a copy kept on the staff file — it is the controlled document
 * itself, read from the register, opened in document control's own viewer.
 * That matters more than it sounds: a job description that exists twice is a
 * job description that will eventually say two different things, and the one
 * the member of staff reads will be the stale one.
 *
 * So this panel holds no content of its own. It says which document applies,
 * which version is in force, and opens it. When a new version is issued, what
 * is read here changes with it, because it is the same document.
 */
function JobDescriptionPanel() {
  const { jobDescriptions, setError } = usePortal();
  const [reading, setReading] = useState<JobDescriptionDoc | null>(null);

  return (
    <section className="portal-panel">
      <div className="pp-head">
        <div>
          <h3><BriefcaseBusiness size={16} /> My job description</h3>
          <p>
            What your post is responsible for, as the laboratory has approved it. This is the
            controlled document itself — when a new version is issued, this is the new version.
          </p>
        </div>
        {jobDescriptions.length > 0 && <span className="pp-count">{jobDescriptions.length}</span>}
      </div>

      {jobDescriptions.length === 0 ? (
        <p className="muted">
          No job description has been issued for your post yet. They are uploaded as controlled
          documents under Documents &amp; Records and appear here as soon as they are approved.
        </p>
      ) : (
        <ul className="pjd-list">
          {jobDescriptions.map(d => (
            <li key={d.id}>
              <div className="pjd-main">
                <span className="pjd-title">{d.title}</span>
                <span className="pjd-meta">
                  {d.document_code && <span className="badge">{d.document_code}</span>}
                  <span>{d.applies_to_staff_id ? 'Issued to you by name' : `For the post of ${d.position_title ?? '—'}`}</span>
                  {d.version_number && <span>v{d.version_number}</span>}
                  {d.effective_date && <span>effective {d.effective_date}</span>}
                  <span className={`badge ${d.status}`}>{String(d.status).replace(/_/g, ' ')}</span>
                </span>
              </div>
              {/* A description registered but not yet given a file has nothing
                  to open. Offering "Read it" and then showing an empty window
                  is worse than saying so on the row. */}
              {d.current_version_id
                ? <button type="button" className="pt-open" onClick={() => setReading(d)}>Read it</button>
                : <span className="muted pjd-nofile">No file attached yet</span>}
            </li>
          ))}
        </ul>
      )}

      {reading && (
        <Suspense fallback={<div className="portal-drawer-wrap"><div className="portal-drawer"><p className="muted">Opening the document…</p></div></div>}>
          <DocumentViewer
            docId={reading.id}
            versionId={Number(reading.current_version_id ?? 0)}
            onClose={() => setReading(null)}
            onAttest={() => setReading(null)}
            onSaved={() => undefined}
            onError={setError}
          />
        </Suspense>
      )}
    </section>
  );
}

/* ----------------------------------------------------------------------------
   The details this person maintains
   ------------------------------------------------------------------------- */
type EditForm = Required<{ [K in keyof SelfEditableProfile]: string }>;

const GENDERS = ['', 'Female', 'Male', 'Other', 'Prefer not to say'];
const ID_TYPES = ['', 'Ghana Card', 'Passport', 'Voter ID', 'Driver licence', 'Other'];

export default function PortalRecord() {
  const { profile, staff, hasSignature, signatureUrl, uploadSignature, saveProfile, setError } = usePortal();
  const [showPassword, setShowPassword] = useState(false);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<EditForm | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const sigInput = useRef<HTMLInputElement>(null);

  const positions = profile?.positions ?? [];
  const authorizations = profile?.authorizations ?? [];

  function startEdit() {
    setForm({
      phone: staff?.phone ?? '',
      email: staff?.email ?? '',
      dateOfBirth: staff?.date_of_birth ?? '',
      gender: staff?.gender ?? '',
      nationalIdType: staff?.national_id_type ?? '',
      nationalIdNumber: staff?.national_id_number ?? '',
      emergencyContact: staff?.emergency_contact ?? '',
      emergencyContactPhone: staff?.emergency_contact_phone ?? '',
      emergencyContactRelation: staff?.emergency_contact_relation ?? '',
      qualifications: staff?.qualifications ?? '',
      professionalRegulator: staff?.professional_regulator ?? '',
      professionalLicence: staff?.professional_licence ?? '',
      licenceExpiryDate: staff?.licence_expiry_date ?? '',
    });
    setProblem(null);
    setEditing(true);
  }

  async function save() {
    if (!form) return;
    setBusy(true); setProblem(null);
    try { await saveProfile(form); setEditing(false); setForm(null); }
    catch (e) { setProblem((e as Error).message); }
    finally { setBusy(false); }
  }

  const set = (k: keyof EditForm) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setForm(f => (f ? { ...f, [k]: e.target.value } : f));

  return (
    <div className="portal-stack">
      {!staff && <LinkStaffPrompt />}

      <section className="portal-panel">
        <div className="pp-head">
          <div>
            <h3><IdCard size={16} /> My personnel record</h3>
            <p>
              Your own file. The details you are the best source for are yours to keep current; the
              ones marked with a padlock are Personnel Management&rsquo;s to change.
            </p>
          </div>
          {staff && !editing && (
            <button type="button" onClick={startEdit}><Pencil size={14} /> Edit my details</button>
          )}
        </div>

        <PhotoPanel />

        {editing && form ? (
          <div className="pf-form">
            <div className="pf-form-head">
              <h4>My details</h4>
              <button type="button" className="pd-close" onClick={() => { setEditing(false); setForm(null); }} aria-label="Cancel"><X size={16} /></button>
            </div>

            <h5 className="pf-legend">How to reach me</h5>
            <div className="pf-grid">
              <label><span>Phone</span><input value={form.phone} onChange={set('phone')} placeholder="e.g. 024 000 0000" /></label>
              <label><span>Email</span><input type="email" value={form.email} onChange={set('email')} /></label>
            </div>

            <h5 className="pf-legend">In an emergency, call</h5>
            <div className="pf-grid">
              <label><span>Name</span><input value={form.emergencyContact} onChange={set('emergencyContact')} /></label>
              <label><span>Phone</span><input value={form.emergencyContactPhone} onChange={set('emergencyContactPhone')} /></label>
              <label><span>Relationship</span><input value={form.emergencyContactRelation} onChange={set('emergencyContactRelation')} placeholder="Spouse, parent, sibling…" /></label>
            </div>

            <h5 className="pf-legend">Personal</h5>
            <div className="pf-grid">
              <label><span>Date of birth</span><input type="date" value={form.dateOfBirth} onChange={set('dateOfBirth')} /></label>
              <label>
                <span>Gender</span>
                <select value={form.gender} onChange={set('gender')}>
                  {GENDERS.map(g => <option key={g || 'none'} value={g}>{g || '—'}</option>)}
                </select>
              </label>
              <label>
                <span>ID type</span>
                <select value={form.nationalIdType} onChange={set('nationalIdType')}>
                  {ID_TYPES.map(t => <option key={t || 'none'} value={t}>{t || '—'}</option>)}
                </select>
              </label>
              <label><span>ID number</span><input value={form.nationalIdNumber} onChange={set('nationalIdNumber')} /></label>
            </div>

            <h5 className="pf-legend">Professional standing</h5>
            <div className="pf-grid">
              <label className="pf-wide">
                <span>Qualifications</span>
                <textarea rows={2} value={form.qualifications} onChange={set('qualifications')}
                  placeholder="e.g. BSc Medical Laboratory Science; MSc Clinical Microbiology" />
              </label>
              <label><span>Regulator</span><input value={form.professionalRegulator} onChange={set('professionalRegulator')} placeholder="e.g. AHPC" /></label>
              <label><span>Licence number</span><input value={form.professionalLicence} onChange={set('professionalLicence')} /></label>
              <label><span>Licence expires</span><input type="date" value={form.licenceExpiryDate} onChange={set('licenceExpiryDate')} /></label>
            </div>
            <p className="pd-hint">
              Renewed your licence? Update the number and date here, then put the new certificate on
              <strong> My Documents</strong> so Personnel Management can verify it.
            </p>

            {problem && <p className="pd-error"><AlertTriangle size={14} /> {problem}</p>}
            <div className="pf-form-foot">
              <button type="button" disabled={busy} onClick={() => void save()}>
                {busy ? <><Loader2 size={14} className="pd-spin" /> Saving…</> : 'Save my details'}
              </button>
              <button type="button" className="secondary" onClick={() => { setEditing(false); setForm(null); }}>Cancel</button>
            </div>
          </div>
        ) : (
          <div className="pr-grid">
            <div className="pr-facts">
              <h4>Identity</h4>
              <dl>
                <ManagedFact label="Full name" value={staff?.full_name ?? profile?.user.fullName} />
                <ManagedFact label="Staff ID" value={staff?.employee_no} />
                <ManagedFact label="Sign-in name" value={(profile?.user as { username?: string } | undefined)?.username} />
                <div><dt>Date of birth</dt><dd>{staff?.date_of_birth || '—'}</dd></div>
                <div><dt>Gender</dt><dd>{staff?.gender || '—'}</dd></div>
                <div><dt>ID</dt><dd>{[staff?.national_id_type, staff?.national_id_number].filter(Boolean).join(' · ') || '—'}</dd></div>
              </dl>
            </div>

            <div className="pr-facts">
              <h4>Post</h4>
              <dl>
                <ManagedFact label="Designation" value={staff?.designation ?? staff?.job_title} />
                <ManagedFact label="Section / unit" value={staff?.section_name} />
                <ManagedFact label="Category" value={titleCase(staff?.personnel_category) || undefined} />
                <ManagedFact label="Appointment" value={[staff?.appointment_type, staff?.appointment_date].filter(Boolean).join(' · ') || undefined} />
                <ManagedFact label="Access profile" value={(profile?.user as { roleName?: string } | undefined)?.roleName} />
              </dl>
            </div>

            <div className="pr-facts">
              <h4>How to reach me</h4>
              <dl>
                <div><dt>Phone</dt><dd>{staff?.phone || '—'}</dd></div>
                <div><dt>Email</dt><dd>{staff?.email || '—'}</dd></div>
                <div><dt>Emergency contact</dt><dd>{staff?.emergency_contact || '—'}</dd></div>
                <div><dt>Emergency phone</dt><dd>{staff?.emergency_contact_phone || '—'}</dd></div>
                <div><dt>Relationship</dt><dd>{staff?.emergency_contact_relation || '—'}</dd></div>
              </dl>
            </div>

            <div className="pr-facts">
              <h4>Professional standing</h4>
              <dl>
                <div><dt>Qualifications</dt><dd>{staff?.qualifications || '—'}</dd></div>
                <div><dt>Regulator</dt><dd>{staff?.professional_regulator || '—'}</dd></div>
                <div><dt>Licence</dt><dd>{staff?.professional_licence || '—'}</dd></div>
                <div><dt>Licence expires</dt><dd>{staff?.licence_expiry_date || '—'}</dd></div>
              </dl>
            </div>
          </div>
        )}
      </section>

      <div className="portal-two">
        <section className="portal-panel">
          <div className="pp-head">
            <div>
              <h3><UserRound size={16} /> My positions</h3>
              <p>Every post you hold on the organogram. Your access profile follows your primary position, so this is management&rsquo;s to set.</p>
            </div>
          </div>
          {positions.length === 0 ? (
            <p className="muted">No position has been assigned to you yet.</p>
          ) : (
            <ul className="pr-chips">
              {positions.map((p, i) => (
                <li key={`${p.title}-${i}`} className={p.is_active ? '' : 'inactive'}>
                  <strong>{p.title}</strong>
                  <span>{titleCase(p.assignment_type)}{p.is_active ? '' : ' · inactive'}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="portal-panel">
          <div className="pp-head">
            <div>
              <h3><ShieldCheck size={16} /> My technical authorisations</h3>
              <p>What you are authorised to perform, review, verify or approve at the bench. Granted from a completed competency assessment.</p>
            </div>
          </div>
          {authorizations.length === 0 ? (
            <p className="muted">No technical authorisation is recorded for you.</p>
          ) : (
            <table className="data-table">
              <thead><tr><th>Area</th><th>Level</th><th>Expires</th></tr></thead>
              <tbody>
                {authorizations.map(a => (
                  <tr key={a.id}>
                    <td>{titleCase(a.module_key)}</td>
                    <td>{a.level}</td>
                    <td>{a.expires_at || 'No expiry'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>

      <JobDescriptionPanel />

      <section className="portal-panel">
        <div className="pp-head">
          <div>
            <h3><PenLine size={16} /> My signature and sign-in</h3>
            <p>Your signature is applied wherever you sign a record, so it is worth keeping current.</p>
          </div>
        </div>
        <div className="pr-signature">
          <div className="pr-sig-box">
            {signatureUrl
              ? <img src={signatureUrl} alt="Your signature as held on file" />
              : <span className="pr-sig-empty">No signature on file</span>}
          </div>
          <div className="pr-sig-actions">
            <p className={hasSignature ? 'pr-ok' : 'pr-todo'}>
              {hasSignature ? <><BadgeCheck size={14} /> On file and in use</> : 'Records you sign will show your typed name until you add one.'}
            </p>
            <input ref={sigInput} type="file" accept="image/*" hidden
              onChange={e => {
                const f = e.target.files?.[0];
                if (f) uploadSignature(f).catch(err => setError(errorText(err)));
                if (sigInput.current) sigInput.current.value = '';
              }} />
            <div className="pr-btns">
              <button type="button" className="secondary" onClick={() => sigInput.current?.click()}>
                <PenLine size={14} /> {hasSignature ? 'Replace signature' : 'Upload signature'}
              </button>
              <button type="button" className="secondary" onClick={() => setShowPassword(true)}>
                <KeyRound size={14} /> Change password
              </button>
            </div>
          </div>
        </div>
      </section>

      {showPassword && <ChangePasswordModal onClose={() => setShowPassword(false)} />}
    </div>
  );
}
