import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, CalendarClock, CalendarRange, ShieldAlert } from 'lucide-react';
import { useDutyReminders } from '../../hooks/useDutyReminders';
import { dueTone, usePortal } from './portalData';

/**
 * My schedule — when this person is working, and what falls due while they are.
 *
 * The duty roster is published for the whole laboratory, which is exactly why
 * a member of staff struggles to find their own line in it. This is only their
 * line: the shifts they are on, the bench they are on today, the rosters they
 * personally owe, and the review-calendar items naming them.
 */
export default function PortalSchedule() {
  const navigate = useNavigate();
  const { tasks, calendar, profile } = usePortal();
  const { data } = useDutyReminders();

  const staffId = (profile?.staff as { id?: number } | null)?.id ?? null;
  const mineOnCalendar = useMemo(
    () => (staffId ? calendar.filter(c => c.responsible_staff_id === staffId && c.status !== 'completed' && c.status !== 'cancelled') : [])
      .sort((a, b) => String(a.due_date).localeCompare(String(b.due_date))),
    [calendar, staffId],
  );
  const owedSchedules = (data?.scheduleTasks ?? []).filter(t => t.isMine);
  const duties = tasks?.upcomingDuties ?? [];
  const duty = data?.duty;

  return (
    <div className="portal-stack">
      <section className="portal-panel">
        <div className="pp-head">
          <div>
            <h3><CalendarClock size={16} /> Where I am today</h3>
            <p>Your shift and bench as the published roster has it.</p>
          </div>
        </div>
        {duty?.onDuty ? (
          <div className="ps-today">
            <span className="ps-today-pill on">On duty</span>
            <strong>{[duty.shiftLabel, duty.sectionName, duty.benchName ? `${duty.benchName} bench` : null].filter(Boolean).join(' · ')}</strong>
            {(duty.rosterCarriedForward || duty.benchCarriedForward) && (
              <span className="ps-carry" title="No schedule was prepared for this month, so last month's is still running.">
                <ShieldAlert size={12} /> carried forward
              </span>
            )}
          </div>
        ) : (
          <div className="ps-today">
            <span className="ps-today-pill off">Not on the roster</span>
            <span className="muted">
              You are not rostered today{duty?.sectionName ? ` for ${duty.sectionName}` : ''}.
            </span>
          </div>
        )}
      </section>

      {owedSchedules.length > 0 && (
        <section className="portal-panel pp-warn">
          <div className="pp-head">
            <div>
              <h3><CalendarRange size={16} /> Rosters and schedules you owe</h3>
              <p>Your colleagues cannot see next month until you publish it.</p>
            </div>
            <span className="pp-count crit">{owedSchedules.length}</span>
          </div>
          <ul className="pt-list">
            {owedSchedules.map(t => (
              <li key={`${t.kind}:${t.month}:${t.sectionId ?? 0}`} className="pt-row sev-warn">
                <span className="pt-rail warn" />
                <button type="button" className="pt-row-main" onClick={() => navigate(t.actionUrl)}>
                  <span className="pt-row-title">{t.message}</span>
                  <span className="pt-row-meta">
                    <span className={`badge ${t.status === 'overdue' ? 'overdue' : t.status === 'carried_forward' ? 'warning' : 'due-soon'}`}>
                      {t.status === 'overdue' ? 'Late' : t.status === 'carried_forward' ? 'Review' : 'Due'}
                    </span>
                    <span>{t.month}</span>
                  </span>
                </button>
                <div className="pt-row-side">
                  <button type="button" className="pt-open" onClick={() => navigate(t.actionUrl)}>Open <ArrowRight size={13} /></button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="portal-panel">
        <div className="pp-head">
          <div>
            <h3>My upcoming duties</h3>
            <p>Every shift assigned to you on a published or approved roster.</p>
          </div>
          {duties.length > 0 && <span className="pp-count">{duties.length}</span>}
        </div>
        {duties.length === 0 ? (
          <p className="muted">No future shift is assigned to you yet.</p>
        ) : (
          <table className="data-table">
            <thead><tr><th>Date</th><th>Shift</th><th>Hours</th><th>Role</th><th>Roster</th></tr></thead>
            <tbody>
              {duties.map(d => (
                <tr key={d.id}>
                  <td>{d.duty_date}</td>
                  <td>{d.shift_name || '—'}</td>
                  <td>{d.start_time || '—'} – {d.end_time || '—'}</td>
                  <td>{d.duty_role || '—'}</td>
                  <td>{d.roster_number || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="portal-panel">
        <div className="pp-head">
          <div>
            <h3>Reviews due from me</h3>
            <p>Items on the laboratory&rsquo;s review calendar that name you as responsible.</p>
          </div>
          {mineOnCalendar.length > 0 && <span className="pp-count">{mineOnCalendar.length}</span>}
        </div>
        {mineOnCalendar.length === 0 ? (
          <p className="muted">Nothing on the review calendar is waiting on you.</p>
        ) : (
          <ul className="pt-list">
            {mineOnCalendar.map(c => {
              const due = dueTone(c.due_date);
              return (
                <li key={c.id} className={`pt-row${due?.tone === 'crit' ? ' sev-crit' : ''}`}>
                  <span className={`pt-rail ${due?.tone === 'crit' ? 'crit' : 'info'}`} />
                  <div className="pt-row-main static">
                    <span className="pt-row-title">{c.title}</span>
                    <span className="pt-row-meta">
                      <span className="badge">{String(c.item_type).replace(/_/g, ' ')}</span>
                      <span>{String(c.module_key).replace(/_/g, ' ')}</span>
                      {due && <span className={`pt-due ${due.tone}`}>{due.text}</span>}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
