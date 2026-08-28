import { GraduationCap, Target } from 'lucide-react';
import { dueTone, titleCase, usePortal } from './portalData';

/**
 * My training and competency — the evidence that this person is competent to do
 * the work they are rostered to do.
 *
 * ISO 15189 asks for that evidence per person; the registers hold it per
 * laboratory. Reading your own history should not require the right to read
 * everybody's, so these come from the self-scoped routes and show one file.
 */
const outcomeTone = (outcome?: string | null) => {
  const o = String(outcome ?? '').toLowerCase();
  if (o.includes('competent') && !o.includes('not')) return 'done';
  if (o.includes('not') || o.includes('fail')) return 'overdue';
  return 'pending';
};

export default function PortalTraining() {
  const { tasks } = usePortal();
  const training = tasks?.upcomingTraining ?? [];
  const competency = tasks?.upcomingCompetency ?? [];

  return (
    <div className="portal-stack">
      <section className="portal-panel">
        <div className="pp-head">
          <div>
            <h3><GraduationCap size={16} /> My training</h3>
            <p>Training events you are down to attend. Attendance is recorded against your file.</p>
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
            <p>Assessments planned or under way for you, and who is assessing.</p>
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
