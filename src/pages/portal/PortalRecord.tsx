import { useRef, useState } from 'react';
import { BadgeCheck, IdCard, KeyRound, Link2, PenLine, ShieldCheck, UserRound } from 'lucide-react';
import { ChangePasswordModal } from '../../components/ChangePasswordModal';
import { titleCase, usePortal } from './portalData';

/**
 * My record — the working file the laboratory holds on this person.
 *
 * ISO 15189 expects a personnel record for every member of staff: identity,
 * qualifications, registration, appointment, authorisations. It used to be
 * readable only by whoever held the personnel register, which meant the one
 * person it is actually about could not check it. This is their copy: theirs
 * to read, with the two things they maintain themselves — signature and
 * password — sitting beside it.
 */
function Facts({ title, rows }: { title: string; rows: Array<[string, React.ReactNode]> }) {
  const shown = rows.filter(([, v]) => v !== null && v !== undefined && v !== '' && v !== '—');
  if (shown.length === 0) return null;
  return (
    <div className="pr-facts">
      <h4>{title}</h4>
      <dl>
        {shown.map(([label, value]) => (
          <div key={label}><dt>{label}</dt><dd>{value}</dd></div>
        ))}
      </dl>
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
                    : <button type="button" onClick={() => linkStaff(s.id).catch(e => setError((e as Error).message))}>This is me</button>}
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

export default function PortalRecord() {
  const { profile, staff, hasSignature, signatureUrl, uploadSignature, setError } = usePortal();
  const [showPassword, setShowPassword] = useState(false);
  const sigInput = useRef<HTMLInputElement>(null);

  const positions = profile?.positions ?? [];
  const authorizations = profile?.authorizations ?? [];

  return (
    <div className="portal-stack">
      {!staff && <LinkStaffPrompt />}

      <section className="portal-panel">
        <div className="pp-head">
          <div>
            <h3><IdCard size={16} /> My personnel record</h3>
            <p>What the laboratory holds about you. Ask Personnel Management to correct anything that is wrong.</p>
          </div>
        </div>

        <div className="pr-grid">
          <Facts title="Identity" rows={[
            ['Full name', staff?.full_name ?? profile?.user.fullName ?? '—'],
            ['Staff ID', staff?.employee_no],
            ['Sign-in name', (profile?.user as { username?: string } | undefined)?.username],
            ['Access profile', (profile?.user as { roleName?: string } | undefined)?.roleName],
          ]} />
          <Facts title="Post" rows={[
            ['Designation', staff?.designation ?? staff?.job_title],
            ['Section / unit', staff?.section_name],
            ['Category', titleCase(staff?.personnel_category)],
            ['Appointment', [staff?.appointment_type, staff?.appointment_date].filter(Boolean).join(' · ')],
          ]} />
          <Facts title="Contact" rows={[
            ['Email', staff?.email],
            ['Phone', staff?.phone],
            ['Emergency contact', staff?.emergency_contact],
          ]} />
          <Facts title="Professional standing" rows={[
            ['Qualifications', staff?.qualifications],
            ['Regulator', staff?.professional_regulator],
            ['Licence number', staff?.professional_licence],
            ['Staff file', staff?.staff_file_location],
          ]} />
        </div>
      </section>

      <div className="portal-two">
        <section className="portal-panel">
          <div className="pp-head">
            <div>
              <h3><UserRound size={16} /> My positions</h3>
              <p>Every post you hold on the organogram. Your access profile follows your primary position.</p>
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
              <p>What you are authorised to perform, review, verify or approve at the bench.</p>
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
                if (f) uploadSignature(f).catch(err => setError((err as Error).message));
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
